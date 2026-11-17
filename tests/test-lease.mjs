import test from 'tape-six';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  DEAD,
  contextOf,
  fakeServer,
  git,
  hookEnv,
  host,
  makeRepo,
  removeAll,
  runHook,
  scratch,
  slashed
} from './helpers.mjs';
import {hashOf} from '../plugins/program-clerk/scripts/lib/common.mjs';

const S1 = 'aaaa1111beef';
const S2 = 'bbbb2222beef';
const ME1 = `${host}/aaaa1111`;
const ME2 = `${host}/bbbb2222`;
const ROLE = 'repo:github.com/example/zz-lease-test';

const escaped = text => text.replace(/[.^$*+?()[\]{}|\\/]/g, '\\$&');
const start = (cwd, session_id, extra = {}) => ({session_id, cwd, ...extra});
const edit = (file, session_id, cwd, extra = {}) => ({
  tool_name: 'Edit',
  tool_input: {file_path: file},
  session_id,
  cwd,
  ...extra
});
const after = (cwd, session_id, extra = {}) => ({session_id, cwd, tool_name: 'Read', ...extra});

const leaseDir = home => join(home, 'cache', 'program-clerk', 'lease');
const stampOf = (home, resource) => join(leaseDir(home), hashOf(resource) + '.renew');
const holderFileOf = (home, resource) => join(leaseDir(home), hashOf(resource));
const safe = holder => holder.replace(/[^A-Za-z0-9._-]/g, '_');
const tokenFileOf = (home, holder, resource) =>
  join(home, 'state', 'program-clerk', 'tokens', safe(holder), hashOf(resource));
const markerOf = (home, holder) =>
  join(home, 'state', 'program-clerk', 'pending-release', safe(holder));

/** The settings note's answer to the folder query, with `leases` set or none. */
const settingsRoute = leases => ({
  'POST /notes/query': ({json}) =>
    json?.folder === 'program-clerk'
      ? {
          body: {
            folder: 'program-clerk',
            items:
              leases === undefined
                ? []
                : [{path: 'program-clerk/settings.md', frontmatter: {type: 'meta', leases}}],
            total: leases === undefined ? 0 : 1
          }
        }
      : {body: {items: []}}
});

test('every hook fails open on what it cannot know', async t => {
  const home = scratch();
  const nonRepo = join(home, 'plain');
  mkdirSync(nonRepo);
  const none = hookEnv(home, null);
  const dead = hookEnv(home, DEAD);

  let r = await runHook('lease-claim.mjs', start(nonRepo, S1), none);
  t.deepEqual([r.code, r.stdout], [0, ''], 'claim: no key is silent');
  r = await runHook('lease-release.mjs', start(nonRepo, S1), none);
  t.deepEqual([r.code, r.stdout], [0, ''], 'release: no key is silent');
  t.notOk(existsSync(markerOf(home, ME1)), 'release: no key leaves no marker');
  r = await runHook('lease-gate.mjs', edit(join(nonRepo, 'x'), S1, nonRepo), none);
  t.equal(r.code, 0, 'gate: no key allows');
  r = await runHook('after-tool.mjs', after(nonRepo, S1), none);
  t.deepEqual([r.code, r.stdout], [0, ''], 'after a tool: no key is silent');

  r = await runHook('after-tool.mjs', after(nonRepo, S1, {agent_id: 'sub-1'}), dead);
  t.deepEqual([r.code, r.stdout], [0, ''], 'after a tool: a sub-agent is silent');
  r = await runHook('after-tool.mjs', after(nonRepo, S1), dead);
  t.deepEqual([r.code, r.stdout], [0, ''], 'after a tool: a folder outside a checkout is silent');
  r = await runHook('lease-claim.mjs', start(nonRepo, S1), dead);
  t.deepEqual([r.code, r.stdout], [0, ''], 'claim: a folder outside a checkout is silent');

  const repo = makeRepo(join(home, 'repo'));
  r = await runHook('lease-claim.mjs', start(repo, S1, {agent_id: 'sub-1'}), dead);
  t.deepEqual([r.code, r.stdout], [0, ''], 'claim: a sub-agent is silent');
  r = await runHook('lease-claim.mjs', start(repo, S1), dead);
  t.deepEqual([r.code, r.stdout], [0, ''], 'claim: an unreachable server is silent');

  r = await runHook('lease-release.mjs', start(repo, S1), dead);
  t.deepEqual([r.code, r.stdout], [0, ''], 'release: an unreachable server is silent');
  t.equal(
    readFileSync(markerOf(home, ME1), 'utf8'),
    ME1,
    'release: it leaves a marker naming the holder'
  );
  removeAll(home);
});

test('a refused claim is said once, and the edit still goes through', async t => {
  const home = scratch();
  const repo = makeRepo(join(home, 'repo'));
  const key = `${ROLE}@${host}:${repo}`;

  let server = await fakeServer({'POST /leases/claim': {status: 401, body: {}}});
  let r = await runHook('lease-claim.mjs', start(repo, S1), hookEnv(home, server.base));
  t.equal(r.code, 0);
  t.matchString(
    r.stdout,
    new RegExp(`^\\[pc\\] lease: ${escaped(key)} — not claimed: the server answered HTTP 401`),
    'the claim names the key and the status'
  );
  t.matchString(r.stdout, /holds no lease/);
  await server.close();

  server = await fakeServer({
    'POST /leases/claim': {status: 400, body: {code: 'bad_request', error: 'rank must be a number'}}
  });
  const env = hookEnv(home, server.base);
  r = await runHook('after-tool.mjs', after(repo, S1), env);
  t.matchString(
    contextOf(r.stdout),
    /not claimed: the server answered HTTP 400 \(bad_request\)/,
    'a refused re-claim reaches the context'
  );
  r = await runHook('after-tool.mjs', after(repo, S1), env);
  t.deepEqual([r.code, r.stdout], [0, ''], 'said once, not on every tool call');
  r = await runHook('lease-gate.mjs', edit(join(repo, 'x'), S1, repo), env);
  t.equal(r.code, 0, 'the gate still allows the edit');
  await server.close();
  removeAll(home);
});

test("a refused lookup is said at that call's end, once a window; a restart is silent", async t => {
  const home = scratch();
  const repo = makeRepo(join(home, 'repo'));
  const key = `${ROLE}@${host}:${repo}`;
  const refuse = {status: 429, headers: {'retry-after': '1'}, body: {code: 'too_many_requests'}};
  let server = await fakeServer({
    'GET /leases': refuse,
    'POST /leases/claim': refuse,
    'POST /notes/query': refuse,
    'GET /system/notices': refuse
  });
  const env = hookEnv(home, server.base);
  const elsewhere = slashed(home);

  let r = await runHook('lease-gate.mjs', edit(join(repo, 'x'), 'feedfacecafe', elsewhere), env);
  t.deepEqual([r.code, r.stdout], [0, ''], 'the edit goes through silently');
  r = await runHook('after-tool.mjs', after(elsewhere, 'feedfacecafe'), env);
  t.equal(
    contextOf(r.stdout).split(/\r?\n/)[0],
    `[pc] lease: the check of ${key} was refused (HTTP 429, too_many_requests), so this edit went through unchecked, as when Program Clerk is unreachable. If another session holds ${key}, move the change to a worktree and a handoff addressed to it. Said once per 15 minutes a checkout.`
  );
  r = await runHook('after-tool.mjs', after(elsewhere, 'feedfacecafe'), env);
  t.equal(contextOf(r.stdout), '', 'said once');
  await runHook('lease-gate.mjs', edit(join(repo, 'x'), 'feedfacecafe', elsewhere), env);
  r = await runHook('after-tool.mjs', after(elsewhere, 'feedfacecafe'), env);
  t.equal(contextOf(r.stdout), '', 'a second refusal in the window stays unsaid');

  await runHook('lease-gate.mjs', edit(join(repo, 'x'), 'abad1deacafe', elsewhere), env);
  r = await runHook('after-tool.mjs', after(elsewhere, 'abad1deacafe'), env);
  t.matchString(contextOf(r.stdout), /was refused/, 'another session hears its own');

  await runHook(
    'lease-gate.mjs',
    edit(join(repo, 'x'), 'c0ffeecafe00', elsewhere, {agent_id: 'sub-1'}),
    env
  );
  r = await runHook('after-tool.mjs', after(elsewhere, 'c0ffeecafe00'), env);
  t.equal(contextOf(r.stdout), '', "a sub-agent's refusal is not its parent's");
  r = await runHook('after-tool.mjs', after(elsewhere, 'c0ffeecafe00', {agent_id: 'sub-1'}), env);
  t.matchString(contextOf(r.stdout), /was refused/, 'a sub-agent hears its own');
  await server.close();

  for (const status of [502, 503, 504]) {
    server = await fakeServer({
      'GET /leases': {status, body: {code: 'tenant_unavailable'}},
      'POST /notes/query': {status, body: {}}
    });
    const session = `0dd0${status}cafe`;
    const env = hookEnv(home, server.base);
    await runHook('lease-gate.mjs', edit(join(repo, 'x'), session, elsewhere), env);
    r = await runHook('after-tool.mjs', after(elsewhere, session), env);
    t.deepEqual([r.code, r.stdout], [0, ''], `a ${status} during a restart is silent`);
    await server.close();
  }
  await runHook(
    'lease-gate.mjs',
    edit(join(repo, 'x'), 'deadbeefcafe', elsewhere),
    hookEnv(home, DEAD)
  );
  r = await runHook('after-tool.mjs', after(elsewhere, 'deadbeefcafe'), hookEnv(home, DEAD));
  t.deepEqual([r.code, r.stdout], [0, ''], 'an unreachable server is silent');
  removeAll(home);
});

test('two sessions in one checkout: the first holds it, the second is subordinate', async t => {
  const home = scratch();
  const repo = makeRepo(join(home, 'repo'));
  const key = `${ROLE}@${host}:${repo}`;
  const server = await fakeServer(settingsRoute(undefined));
  const env = hookEnv(home, server.base);

  let r = await runHook('lease-claim.mjs', start(repo, S1), env);
  t.matchString(
    r.stdout,
    new RegExp(`claimed \\(cwd\\) as ${ME1} \\(TTL 3h\\)`),
    'session 1 claims'
  );
  t.matchString(
    r.stdout,
    /Leases are keyed by checkout .*: the default, with no setting in program-clerk\/settings\.md\.$/m,
    'the mode and its source are said'
  );
  t.equal(server.holderOf(key), ME1, 'the server shows session 1 holding the checkout key');
  const lease = server.leases.get(key);
  t.deepEqual(
    [lease.rank, lease.takeover_after, lease.priority],
    [10, 3600, null],
    'rank 10, an hour to take over, no priority'
  );
  t.ok(readFileSync(tokenFileOf(home, ME1, key), 'utf8').length > 0, 'the claim token is kept');

  r = await runHook('lease-claim.mjs', start(repo, S1), env);
  t.matchString(r.stdout, new RegExp(`renewed \\(cwd\\) as ${ME1}`), 'a second claim renews');

  const tokenFile = tokenFileOf(home, ME1, key);
  const token = readFileSync(tokenFile, 'utf8');
  writeFileSync(tokenFile, '');
  r = await runHook('lease-claim.mjs', start(repo, S1), env);
  t.matchString(r.stdout, /whose token this machine no longer has/, 'a lost token is said');
  t.doesNotMatchString(r.stdout, /SUBORDINATE/, 'and not read as another holder');
  writeFileSync(tokenFile, token);

  writeFileSync(stampOf(home, key), '0');
  r = await runHook('lease-gate.mjs', edit(join(repo, 'a.txt'), S1, repo), env);
  t.equal(r.code, 0, "the holder's own edit is allowed");
  t.ok(
    server.requests.some(q => q.path === '/leases/renew' && q.json?.claim_token === token),
    'and renews with the token'
  );

  r = await runHook('lease-claim.mjs', start(repo, S2), env);
  t.matchString(
    r.stdout,
    new RegExp(`held by ${ME1} \\(cwd, since`),
    'session 2 is told who holds it'
  );
  t.matchString(r.stdout, /SUBORDINATE/);
  t.matchString(
    r.stdout,
    new RegExp(`handoff to "${escaped(ROLE)}"`),
    'its handoffs go to the repository'
  );
  removeAll(leaseDir(home));
  r = await runHook('lease-gate.mjs', edit(join(repo, 'a.txt'), S2, repo), env);
  t.equal(r.code, 2, "session 2's edit is blocked");
  t.matchString(r.stderr, new RegExp(`held by ${ME1}`));
  t.matchString(
    r.stderr,
    new RegExp(`to: "${escaped(ROLE)}"`),
    'the block names the handoff address'
  );

  await runHook('lease-release.mjs', start(repo, S2), env);
  t.equal(server.holderOf(key), ME1, "session 2's release leaves session 1's lease");
  await runHook('lease-release.mjs', start(repo, S1), env);
  t.equal(server.holderOf(key), '', "session 1's release clears it");
  t.notOk(existsSync(tokenFileOf(home, ME1, key)), 'and drops the token');
  t.notOk(existsSync(markerOf(home, ME1)), 'a release that finishes leaves no marker');

  await server.close();
  removeAll(home);
});

test('the gate and the after-tool hook keep a session lease alive', async t => {
  const home = scratch();
  const repo = makeRepo(join(home, 'repo'));
  const key = `${ROLE}@${host}:${repo}`;
  const server = await fakeServer(settingsRoute(undefined));
  const env = hookEnv(home, server.base);
  const elsewhere = slashed(home);

  await runHook('lease-claim.mjs', start(repo, S1), env);
  server.leases.clear();
  removeAll(leaseDir(home));

  let r = await runHook('lease-gate.mjs', edit(join(repo, 'a.txt'), S1, repo), env);
  t.deepEqual([r.code, server.holderOf(key)], [0, ME1], 'an edit re-claims an unheld own checkout');

  server.leases.clear();
  removeAll(leaseDir(home));
  r = await runHook('lease-gate.mjs', edit(join(repo, 'a.txt'), 'cccc3333beef', elsewhere), env);
  t.deepEqual(
    [r.code, server.holderOf(key)],
    [0, ''],
    'an unheld checkout outside the cwd is allowed, never claimed'
  );

  r = await runHook('after-tool.mjs', after(repo, S1), env);
  t.deepEqual(
    [r.stdout, server.holderOf(key)],
    ['', ME1],
    'a tool call re-claims an unheld own checkout silently'
  );
  t.ok(existsSync(stampOf(home, key)), 'and stamps the renewal');

  r = await runHook('after-tool.mjs', after(repo, S1), hookEnv(home, DEAD));
  t.deepEqual([r.code, r.stdout], [0, ''], 'a fresh stamp needs no server');

  writeFileSync(stampOf(home, key), '0');
  removeAll(holderFileOf(home, key));
  const renews = () => server.requests.filter(q => q.path === '/leases/renew').length;
  const before = renews();
  r = await runHook('after-tool.mjs', after(repo, S1), env);
  t.ok(Number(readFileSync(stampOf(home, key), 'utf8')) > 0, 'a stale stamp renews and advances');
  t.equal(renews(), before + 1, 'one renew sent');
  t.equal(server.holderOf(key), ME1);

  await runHook('lease-claim.mjs', start(repo, S2), env);
  removeAll(stampOf(home, key));
  removeAll(holderFileOf(home, key));
  r = await runHook('after-tool.mjs', after(repo, S2), env);
  t.deepEqual(
    [r.stdout, server.holderOf(key)],
    ['', ME1],
    "a second session's tool call is a silent no-op"
  );
  t.ok(existsSync(stampOf(home, key)), 'that stamps its check');

  server.leases.clear();
  removeAll(leaseDir(home));
  r = await runHook('after-tool.mjs', after(repo, S2, {agent_id: 'sub-1'}), env);
  t.equal(server.holderOf(key), '', "a sub-agent's tool call never claims");

  await server.close();
  removeAll(home);
});

test('a stranded release is finished by the next session, and a lost lease is said once', async t => {
  const home = scratch();
  const repo = makeRepo(join(home, 'repo'));
  const key = `${ROLE}@${host}:${repo}`;
  const server = await fakeServer(settingsRoute(undefined));
  const env = hookEnv(home, server.base);

  await runHook('lease-claim.mjs', start(repo, S1), env);
  await runHook('lease-release.mjs', start(repo, S1), hookEnv(home, DEAD));
  t.ok(existsSync(markerOf(home, ME1)), 'a release that reached nothing leaves its marker');
  t.equal(server.holderOf(key), ME1, 'and the lease');
  let r = await runHook('lease-claim.mjs', start(repo, S2), env);
  t.matchString(
    r.stdout,
    new RegExp(`claimed \\(cwd\\) as ${ME2}`),
    'the next session releases it and claims'
  );
  t.notOk(existsSync(markerOf(home, ME1)), 'and drops the marker');
  await runHook('lease-release.mjs', start(repo, S2), env);
  t.equal(readdirSync(join(home, 'state', 'program-clerk', 'pending-release')).length, 0);

  await runHook('lease-claim.mjs', start(repo, S1), env);
  server.leases.clear();
  await runHook('lease-claim.mjs', start(repo, S2), env);
  t.equal(server.holderOf(key), ME2, 'the lease passed to session 2');
  writeFileSync(holderFileOf(home, key), JSON.stringify({at: 0, holder: ME1, kind: 'agent'}));
  writeFileSync(stampOf(home, key), '0');
  r = await runHook('after-tool.mjs', after(repo, S1), env);
  t.matchString(
    contextOf(r.stdout),
    new RegExp(`now held by ${ME2}.*SUBORDINATE`),
    'session 1 is told once'
  );
  writeFileSync(stampOf(home, key), '0');
  r = await runHook('after-tool.mjs', after(repo, S1), env);
  t.equal(contextOf(r.stdout), '', 'and not again');

  await server.close();
  removeAll(home);
});

test('the account setting picks the key: checkout by default, repository when set', async t => {
  const home = scratch();
  const one = makeRepo(join(home, 'one'));
  const two = makeRepo(join(home, 'two'));
  let server = await fakeServer(settingsRoute('repository'));
  let env = hookEnv(home, server.base);

  let r = await runHook('lease-claim.mjs', start(one, S1), env);
  t.matchString(
    r.stdout,
    new RegExp(`^\\[pc\\] lease: ${escaped(ROLE)} — claimed`),
    'repository mode keys by the remote alone'
  );
  t.matchString(
    r.stdout,
    /Leases are keyed by repository: the account's setting in program-clerk\/settings\.md\.$/m
  );
  r = await runHook('lease-claim.mjs', start(two, S2), env);
  t.matchString(r.stdout, /SUBORDINATE/, 'a second clone is subordinate in repository mode');

  const worktree = join(home, 'wt');
  git(one, 'worktree', 'add', '-q', worktree, '-b', 'wt-test');
  r = await runHook('lease-gate.mjs', edit(join(worktree, 'a.txt'), S2, slashed(home)), env);
  t.equal(r.code, 0, "a linked worktree of the leased repository is the protocol's path");
  await runHook('lease-release.mjs', start(one, S1), env);
  await runHook('lease-release.mjs', start(two, S2), env);
  await server.close();

  removeAll(join(home, 'cache'));
  server = await fakeServer(settingsRoute(undefined));
  env = hookEnv(home, server.base);
  r = await runHook('lease-claim.mjs', start(one, S1), env);
  t.matchString(r.stdout, new RegExp(`claimed \\(cwd\\) as ${ME1}`));
  r = await runHook('lease-claim.mjs', start(two, S2), env);
  t.matchString(
    r.stdout,
    new RegExp(`claimed \\(cwd\\) as ${ME2}`),
    'in checkout mode each clone has its own holder'
  );
  t.equal(server.holderOf(`${ROLE}@${host}:${one}`), ME1);
  t.equal(server.holderOf(`${ROLE}@${host}:${two}`), ME2);
  r = await runHook('lease-gate.mjs', edit(join(two, 'a.txt'), S1, one), env);
  t.equal(r.code, 2, "an edit into another session's clone is blocked");
  await server.close();
  removeAll(home);
});

test('the mode: kept for the session, the last read when unreadable, a bad value said', async t => {
  const home = scratch();
  const repo = makeRepo(join(home, 'repo'));
  const server = await fakeServer(settingsRoute('repository'));
  const env = hookEnv(home, server.base);
  const answer = routes => Object.assign(server.routes, routes);
  let r = await runHook('lease-claim.mjs', start(repo, S1), env);
  t.matchString(r.stdout, /keyed by repository: the account's setting/);

  answer(settingsRoute(undefined));
  server.requests.length = 0;
  r = await runHook('lease-claim.mjs', start(repo, S1, {source: 'compact'}), env);
  t.matchString(r.stdout, /keyed by repository/, 'a session keeps the mode it started with');
  t.notOk(
    server.requests.some(q => q.path === '/notes/query'),
    'and reads no setting again'
  );

  answer({'POST /notes/query': {status: 500, body: {}}});
  r = await runHook('lease-claim.mjs', start(repo, S2), env);
  t.matchString(
    r.stdout,
    /keyed by repository: the last value read on this machine/,
    'an unreadable setting uses the last one read'
  );

  answer(settingsRoute('per-branch'));
  r = await runHook('lease-claim.mjs', start(repo, 'dddd4444beef'), env);
  t.matchString(
    r.stdout,
    /leases: "per-branch" in program-clerk\/settings\.md is neither checkout nor repository; the last value read/,
    'a value it does not know is said'
  );

  const fresh = scratch();
  answer({'POST /notes/query': {status: 500, body: {}}});
  r = await runHook('lease-claim.mjs', start(repo, 'eeee5555beef'), hookEnv(fresh, server.base));
  t.matchString(
    r.stdout,
    /keyed by checkout .*: the default, since the setting could not be read\.$/m,
    'with nothing read before, the default'
  );
  await server.close();
  removeAll(fresh);
  removeAll(home);
});

test('a checkout with no remote is keyed by its host and path in either mode', async t => {
  const home = scratch();
  const repo = makeRepo(join(home, 'local'), null);
  const server = await fakeServer(settingsRoute('repository'));
  const r = await runHook('lease-claim.mjs', start(repo, S1), hookEnv(home, server.base));
  t.equal(server.holderOf(`repo:${host}:${repo}`), ME1);
  t.matchString(r.stdout, new RegExp(`claimed \\(cwd\\) as ${ME1}`));
  await server.close();
  removeAll(home);
});

test('the plugin option is the key, and PROGRAM_CLERK_KEY when the option is empty', async t => {
  const home = scratch();
  const repo = makeRepo(join(home, 'repo'));
  const server = await fakeServer(settingsRoute(undefined));
  await runHook(
    'lease-claim.mjs',
    start(repo, S1),
    hookEnv(home, server.base, {CLAUDE_PLUGIN_OPTION_KEY: 'from-option'})
  );
  t.ok(server.requests.length > 0);
  t.ok(
    server.requests.every(q => q.auth === 'Bearer from-option'),
    'the option wins'
  );
  server.requests.length = 0;
  await runHook(
    'lease-claim.mjs',
    start(repo, S2),
    hookEnv(home, server.base, {CLAUDE_PLUGIN_OPTION_KEY: ''})
  );
  t.ok(server.requests.length > 0);
  t.ok(
    server.requests.every(q => q.auth === 'Bearer test-key'),
    'the variable stands in'
  );
  await server.close();
  removeAll(home);
});
