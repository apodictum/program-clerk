// `/pickup`'s prompt hook as Claude Code runs it: silent on every other prompt, and on `/pickup` the
// digest shown to the person and put in the context behind a tag no quoted text can close.

import {join} from 'node:path';
import test from 'tape-six';
import {fakeServer, hookEnv, makeRepo, removeAll, runHook, scratch} from './helpers.mjs';

const STATE = {
  project: {
    found: true,
    name: 'p',
    logs: [{title: 'p: the last session', summary: 'Built a thing.', at: '2026-11-16T00:00:00Z'}],
    sessions: {unlogged: []},
    notices: [],
    changes: null,
    handoffs: {open: [], returned: []}
  },
  stalls: null
};

const withRepo = async fn => {
  const home = scratch();
  const server = await fakeServer({
    'POST /system/resume-project': {body: STATE},
    'POST /notes/query': {body: {items: []}}
  });
  try {
    await fn({home, server, repo: makeRepo(join(home, 'p'), null)});
  } finally {
    await server.close();
    removeAll(home);
  }
};

test('another prompt leaves the hook at its first test, with no call', async t => {
  await withRepo(async ({home, server, repo}) => {
    for (const prompt of ['hello', '/pickup me', 'run /pickup', '/pickuply']) {
      const r = await runHook(
        'digest.mjs',
        {prompt, session_id: 's1', cwd: repo},
        hookEnv(home, server.base)
      );
      t.equal(r.code, 0);
      t.equal(r.stdout, '', `${prompt}: no output`);
    }
    t.equal(server.requests.length, 0);
  });
});

test('/pickup shows the digest and puts it in the context behind a random tag', async t => {
  await withRepo(async ({home, server, repo}) => {
    const env = hookEnv(home, server.base, {CLAUDE_CODE_ENTRYPOINT: 'cli'});
    for (const prompt of ['/pickup', '  /program-clerk:pickup  ']) {
      const r = await runHook('digest.mjs', {prompt, session_id: 's1', cwd: repo}, env);
      t.equal(r.code, 0);
      const out = JSON.parse(r.stdout);
      t.ok(out.systemMessage.includes('\x1b['), 'styled for a terminal');
      const context = out.hookSpecificOutput.additionalContext;
      const tag = /^\[pc\] The \/pickup digest, between <(pc-digest-[0-9a-f]{12})> tags\./.exec(
        context
      )?.[1];
      t.ok(tag, `${prompt}: tagged`);
      t.ok(context.endsWith(`</${tag}>`));
      t.ok(context.includes('# p\n\n## How we finished\np: the last session\nBuilt a thing.'));
      t.ok(context.includes('Drift:\nDRIFT since last baseline:\n  (no baseline recorded yet)'));
    }
  });
});

test('/pickup with no key or no server says nothing, so the skill runs the script', async t => {
  await withRepo(async ({home, repo}) => {
    const payload = {prompt: '/pickup', session_id: 's1', cwd: repo};
    t.equal((await runHook('digest.mjs', payload, hookEnv(home, null))).stdout, '');
    const dead = hookEnv(home, 'http://127.0.0.1:9');
    t.equal((await runHook('digest.mjs', payload, dead)).stdout, '');
  });
});
