import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, realpathSync} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export const HOOKS = new URL('../plugins/program-clerk/scripts/hooks/', import.meta.url);

export const host = hostname().split('.')[0];

export const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'pc-test-')));

export const removeAll = dir => rmSync(dir, {recursive: true, force: true});

export const slashed = path => path.replace(/\\/g, '/');

export const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid'
    }
  }).trim();

/** A repository at `dir` with one commit and, unless null, an origin. */
export const makeRepo = (dir, remote = 'git@github.com:example/zz-lease-test.git') => {
  git(tmpdir(), 'init', '-q', dir);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  return slashed(realpathSync(dir));
};

/** Environment for a hook: its own state folders, the server, and the key; nothing inherited. */
export const hookEnv = (home, base, extra = {}) => {
  const env = {...process.env};
  for (const name of Object.keys(env))
    if (/^(PROGRAM_CLERK_|CLAUDE_PLUGIN_OPTION_|XDG_)/.test(name)) delete env[name];
  return {
    ...env,
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    PROGRAM_CLERK_RETRY_DELAYS: '20 20',
    ...(base === null ? {} : {PROGRAM_CLERK_URL: base, PROGRAM_CLERK_KEY: 'test-key'}),
    ...extra
  };
};

/** Starts a hook as Claude Code does, the payload on stdin. */
export const runHook = (name, payload, env, args = []) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(name, HOOKS)), ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
    child.stdin.end(JSON.stringify(payload));
  });

export const contextOf = stdout => {
  try {
    return JSON.parse(stdout).hookSpecificOutput.additionalContext;
  } catch {
    return '';
  }
};

// The lease rules the hooks meet, as the server keeps them: a claim by the holder with its token
// renews, a takeover_after lease yields only after that long unrenewed, a side lease yields to rank.
const leaseRoutes = (leases, now) => ({
  'GET /leases': ({url}) => {
    const resource = url.searchParams.get('resource');
    const prefix = url.searchParams.get('prefix');
    const items = [...leases.values()]
      .filter(l => (resource ? l.resource === resource : l.resource.startsWith(prefix ?? '')))
      .map(({token, ...lease}) => lease);
    return {body: {count: items.length, items}};
  },
  'POST /leases/claim': ({json}) => {
    const current = leases.get(json.resource);
    const fresh = () => {
      const lease = {
        resource: json.resource,
        holder: json.holder,
        holder_kind: json.kind ?? 'agent',
        rank: json.rank ?? null,
        takeover_after: json.takeover_after ?? null,
        priority: null,
        claimed_at: new Date(now()).toISOString(),
        renewed_at: new Date(now()).toISOString(),
        expires_at: new Date(now() + 3 * 3600000 + 60000).toISOString(),
        token: randomUUID()
      };
      leases.set(json.resource, lease);
      const {token, ...shown} = lease;
      return {lease: shown, token};
    };
    if (!current) {
      const {lease, token} = fresh();
      return {body: {status: 'claimed', lease, claim_token: token}};
    }
    const {token, ...shown} = current;
    if (current.holder === json.holder) {
      if (json.claim_token !== token)
        return {status: 409, body: {code: 'claim_token_mismatch', details: {current: shown}}};
      current.renewed_at = new Date(now()).toISOString();
      return {body: {status: 'renewed', lease: shown, claim_token: token}};
    }
    const idle = now() - Date.parse(current.renewed_at);
    const yields =
      current.holder_kind !== 'human' &&
      (current.takeover_after != null
        ? idle > current.takeover_after * 1000 && (json.rank ?? 0) >= (current.rank ?? 0)
        : (json.rank ?? 0) > (current.rank ?? 0));
    if (!yields) return {status: 409, body: {code: 'claimed_by_other', details: {current: shown}}};
    const {lease, token: next} = fresh();
    return {body: {status: 'preempted', lease, claim_token: next, prior: shown}};
  },
  'POST /leases/renew': ({json}) => {
    const current = leases.get(json.resource);
    if (!current) return {status: 404, body: {code: 'lease_not_found'}};
    if (current.holder !== json.holder || current.token !== json.claim_token)
      return {status: 409, body: {code: 'claim_token_mismatch'}};
    current.renewed_at = new Date(now()).toISOString();
    return {body: {status: 'ok'}};
  },
  'POST /leases/release': ({json}) => {
    const current = leases.get(json.resource);
    if (!current) return {status: 404, body: {code: 'lease_not_found'}};
    if (current.holder !== json.holder || current.token !== json.claim_token)
      return {status: 409, body: {code: 'not_holder'}};
    leases.delete(json.resource);
    return {body: {status: 'released'}};
  }
});

/**
 * A stand-in for the API: lease routes by default, `routes` ('METHOD /path' → handler or answer)
 * over them, 404 elsewhere. Records every request.
 */
export const fakeServer = async (routes = {}) => {
  const leases = new Map();
  const state = {now: () => Date.now()};
  const requests = [];
  const all = {...leaseRoutes(leases, () => state.now()), ...routes};
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      // a text body
    }
    requests.push({
      method: req.method,
      path: url.pathname,
      url: req.url,
      auth: req.headers.authorization,
      agent: req.headers['user-agent'],
      body,
      json
    });
    const route = all[`${req.method} ${url.pathname}`];
    const answer =
      typeof route === 'function' ? await route({req, url, body, json}) : (route ?? null);
    const status = answer ? (answer.status ?? 200) : 404;
    const out = answer ? (answer.body ?? {}) : {code: 'route_not_found'};
    res.writeHead(status, {'content-type': 'application/json', ...(answer?.headers ?? {})});
    res.end(typeof out === 'string' ? out : JSON.stringify(out));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // A test that fails before its close() still ends.
  server.unref();
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    leases,
    state,
    routes: all,
    holderOf: resource => leases.get(resource)?.holder ?? '',
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
      })
  };
};

// A port just freed, so a connection is refused; fetch will not dial port 9 at all.
export const DEAD = await new Promise(resolve => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const {port} = server.address();
    server.close(() => resolve(`http://127.0.0.1:${port}`));
  });
});
