// `/wrap`'s script: the log's body, its line in the month of sessions, and the baseline, in order.

import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'tape-six';
import {logOf, run} from '../plugins/program-clerk/scripts/lib/wrap.mjs';
import {fakeServer, host, makeRepo, removeAll, scratch} from './helpers.mjs';

const SESSION = '0123abcd-4567-89ef-0123-456789abcdef';
const LOG =
  'title: Built the thing\nsummary: The thing is built. One question is open.\n---\nDid it.\n\n## Open\n\n- Is it right?\n';
const noVersions = async () => [];
// Late in the person's day, which in UTC may be the next one; the log is named by theirs.
const NOW = new Date(2026, 10, 17, 23, 30, 5);
const DAY = '2026-11-17';

const setUp = async (routes = {}) => {
  const dir = scratch();
  const top = makeRepo(join(dir, 'proj'));
  const file = join(dir, 'log.txt');
  writeFileSync(file, LOG);
  const server = await fakeServer(routes);
  const env = {
    PROGRAM_CLERK_URL: server.base,
    PROGRAM_CLERK_KEY: 'test-key',
    CLAUDE_CODE_SESSION_ID: SESSION,
    XDG_CACHE_HOME: join(dir, 'cache')
  };
  const lines = [];
  const wrap = (argv, extra = {}) =>
    run(argv, {
      env: {...env, ...extra},
      cwd: top,
      out: line => lines.push(line),
      now: () => NOW,
      versionsOf: noVersions
    });
  const done = async () => {
    await server.close();
    removeAll(dir);
  };
  return {dir, top, env, file, server, wrap, lines, done};
};

const ok = {status: 200, body: {}};

test('the file: a title, a summary, and the body after the rule; a part missing is refused', t => {
  t.deepEqual(logOf('title: T\r\nsummary: S\r\n---\r\nB\r\n'), {
    title: 'T',
    summary: 'S',
    body: 'B\n'
  });
  t.throws(() => logOf('title: T\nsummary: S\nB\n'), /--- line/);
  t.throws(() => logOf('title: T\n---\nB\n'), /no summary/);
  t.throws(() => logOf('title: T\nsummary: S\n---\n\n'), /no body/);
});

test('a wrap writes the body, then its line, then the baseline, the line built here', async t => {
  const day = DAY;
  const bodyPath = `projects/proj/data/sessions/logs/${day}-0123abcd-the-slug.markdown`;
  const month = `projects/proj/data/sessions/${NOW.toISOString().slice(0, 7)}.jsonl`;
  const {file, server, wrap, lines, done} = await setUp({
    [`PUT /data/${bodyPath}`]: ok,
    [`POST /data/${month}`]: ok,
    'PUT /vault/projects/proj/state.md': ok
  });
  try {
    await wrap([file, '--slug', 'the slug']);
    t.deepEqual(
      server.requests.map(r => `${r.method} ${r.path}`),
      [`PUT /data/${bodyPath}`, `POST /data/${month}`, 'PUT /vault/projects/proj/state.md']
    );
    t.equal(server.requests[0].body, 'Did it.\n\n## Open\n\n- Is it right?\n');
    t.equal(server.requests[0].auth, 'Bearer test-key');
    const line = JSON.parse(server.requests[1].body);
    t.deepEqual(Object.keys(line), ['kind', 'at', 'holder', 'title', 'summary', 'body']);
    t.match(line, {
      kind: 'log',
      holder: `${host}/0123abcd`,
      title: `proj: Built the thing (${day})`,
      summary: 'The thing is built. One question is open.',
      body: bodyPath
    });
    t.equal(line.at, NOW.toISOString().slice(0, 19) + 'Z', 'the time in UTC');
    t.ok(server.requests[1].body.endsWith('}\n'), 'one line, ending in a newline');
    t.equal(server.requests[2].json.frontmatter.type, 'state');
    t.deepEqual(lines, [`log: ${bodyPath}`, `line: ${month}`, 'baseline: projects/proj/state.md']);
  } finally {
    await done();
  }
});

test('a failed step stops the next; another project gets the log and no baseline', async t => {
  const {file, server, wrap, lines, done} = await setUp({
    'POST /data/projects/proj/data/sessions/logs': ok
  });
  try {
    await t.rejects(wrap([file]), /the log's body: 404/);
    t.equal(server.requests.length, 1, 'no line after a body that did not land');
    t.deepEqual(lines, []);

    server.routes[`PUT ${server.requests[0].path}`] = ok;
    await t.rejects(wrap([file]), /the log's line: 404/);
    t.equal(server.requests.length, 3, 'no baseline after a line that did not land');

    const other = server.requests[0].path.replace('/proj/', '/other/');
    server.routes[`PUT ${other}`] = ok;
    const month = server.requests[2].path.replace('/proj/', '/other/');
    server.routes[`POST ${month}`] = ok;
    lines.length = 0;
    await wrap([file, '--project', 'other']);
    t.deepEqual(lines.at(-1), 'baseline: not written, since no checkout of other is here');
    t.notOk(server.requests.some(r => r.path.endsWith('/state.md')));
  } finally {
    await done();
  }
});

test('no key, no session id, or no project: refused before any call', async t => {
  const {file, server, wrap, done} = await setUp();
  try {
    await t.rejects(wrap([file], {PROGRAM_CLERK_KEY: ''}), /no key/);
    await t.rejects(wrap([file], {CLAUDE_CODE_SESSION_ID: ''}), /no session id/);
    await t.rejects(wrap([file, '--project', 'Bad Name']), /no project/);
    t.equal(server.requests.length, 0);
  } finally {
    await done();
  }
});

const SCRIPTS = new URL('../plugins/program-clerk/scripts/', import.meta.url);

/** Starts a script as the agent's shell does, in `cwd` with `env`. */
const runScript = (name, args, {cwd, env}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(name, SCRIPTS)), ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });

test('the scripts run as processes: their output, and exit 1 with the reason on a failure', async t => {
  const {top, env, file, server, done} = await setUp({'PUT /vault/projects/proj/state.md': ok});
  const all = {...process.env, ...env};
  for (const name of Object.keys(all)) if (/^CLAUDE_PLUGIN_OPTION_/.test(name)) delete all[name];
  try {
    let r = await runScript('wrap.mjs', ['baseline'], {cwd: top, env: all});
    t.deepEqual([r.code, r.stdout, r.stderr], [0, 'baseline: projects/proj/state.md\n', '']);
    r = await runScript('wrap.mjs', [file], {cwd: top, env: all});
    t.equal(r.code, 1);
    t.matchString(r.stderr, /^the log's body: 404/);
    server.routes['POST /notes/query'] = {body: {items: []}};
    r = await runScript('queue.mjs', ['list', 'proj'], {cwd: top, env: all});
    t.deepEqual([r.code, r.stdout], [0, '0 items\n']);
    r = await runScript('queue.mjs', ['list'], {cwd: top, env: all});
    t.equal(r.code, 1);
    t.matchString(r.stderr, /^usage: /);
  } finally {
    await done();
  }
});
