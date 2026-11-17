// `/pc check`: the report against the stored baseline, `--update`, and the script as a process.

import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'tape-six';
import {run} from '../plugins/program-clerk/scripts/lib/check.mjs';
import {baselineNote, currentOf} from '../plugins/program-clerk/scripts/lib/drift.mjs';
import {fakeServer, git, makeRepo, removeAll, scratch} from './helpers.mjs';

const noVersions = async () => [];

const setUp = async (routes = {}) => {
  const dir = scratch();
  const top = makeRepo(join(dir, 'proj'));
  const server = await fakeServer(routes);
  const env = {
    PROGRAM_CLERK_URL: server.base,
    PROGRAM_CLERK_KEY: 'test-key',
    XDG_CACHE_HOME: join(dir, 'cache')
  };
  const lines = [];
  const check = (argv, extra = {}) =>
    run(argv, {
      env: {...env, ...extra},
      cwd: top,
      out: text => lines.push(text),
      versionsOf: noVersions
    });
  const done = async () => {
    await server.close();
    removeAll(dir);
  };
  return {dir, top, env, server, lines, check, done};
};

const noteText = note => `---\ntitle: ${note.frontmatter.title}\ntype: state\n---\n${note.body}`;

test('a checkout that matches its baseline exits 0; one that moved exits 1 and says how', async t => {
  const {top, server, lines, check, done} = await setUp();
  try {
    const {snapshot} = await currentOf({top, project: 'proj', versionsOf: noVersions});
    server.routes['GET /vault/projects/proj/state.md'] = {
      body: noteText(baselineNote('proj', snapshot))
    };
    t.equal(await check([]), 0);
    t.matchString(lines.at(-1), /^project "proj": matches its baseline/);
    git(top, 'commit', '--allow-empty', '-q', '-m', 'Moved on.');
    lines.length = 0;
    t.equal(await check([]), 1);
    t.matchString(lines.join('\n'), /DRIFT since last baseline/);
    t.notOk(
      server.requests.some(r => r.method === 'PUT'),
      'a report writes nothing'
    );
  } finally {
    await done();
  }
});

test('--update writes the checkout as the new baseline after the report; no baseline reads as drift', async t => {
  const {server, lines, check, done} = await setUp({
    'PUT /vault/projects/proj/state.md': {body: {}}
  });
  try {
    t.equal(await check(['--update']), 1, 'no baseline yet');
    t.matchString(lines[0], /no baseline recorded yet/);
    t.equal(lines.at(-1), 'baseline: projects/proj/state.md');
    const put = server.requests.find(r => r.method === 'PUT');
    t.equal(put.json.frontmatter.type, 'state');
  } finally {
    await done();
  }
});

test('refusals: an unknown option, no key, a baseline that cannot be read, no checkout', async t => {
  const {dir, env, server, check, done} = await setUp();
  try {
    await t.rejects(check(['--updat']), TypeError);
    await t.rejects(check([], {PROGRAM_CLERK_KEY: ''}), /no key/);
    server.routes['GET /vault/projects/proj/state.md'] = {status: 403, body: {}};
    await t.rejects(check([]), /the baseline could not be read: 403/);
    await t.rejects(
      run([], {env, cwd: dir, out: () => {}, versionsOf: noVersions}),
      /no checkout here/
    );
  } finally {
    await done();
  }
});

test('the script runs as a process: exit 2 on a usage error', async t => {
  const {top, env, done} = await setUp();
  const script = fileURLToPath(
    new URL('../plugins/program-clerk/scripts/check.mjs', import.meta.url)
  );
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--nope'], {
        cwd: top,
        env: {...process.env, ...env},
        stdio: 'ignore',
        windowsHide: true
      });
      child.on('error', reject);
      child.on('close', resolve);
    });
    t.equal(code, 2);
  } finally {
    await done();
  }
});
