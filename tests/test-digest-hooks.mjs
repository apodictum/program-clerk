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

const withRepo = async (fn, routes = {}) => {
  const home = scratch();
  const server = await fakeServer({
    'POST /system/resume-project': {body: STATE},
    'POST /notes/query': {body: {items: []}},
    ...routes
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

test('/pickup lists a version marked wrong in a draw, and says nothing of a server without draws', async t => {
  const draws = {
    draws: [
      {
        id: 'd1',
        drawnAt: '2026-11-22T23:00:00Z',
        drawnBy: 'Dana',
        versions: [
          {
            versionId: 7,
            recordId: 'r7',
            path: 'topics/seven.md',
            at: '2026-11-21T10:00:00Z',
            keyName: 'desk agent',
            verdict: 'wrong',
            note: 'The date is off.',
            decidedAt: '2026-11-22T23:05:00Z',
            decidedBy: 'Dana',
            fixedAt: null,
            fixedBy: null
          }
        ]
      }
    ]
  };
  const payload = repo => ({prompt: '/pickup', session_id: 's1', cwd: repo});
  await withRepo(
    async ({home, server, repo}) => {
      const r = await runHook('digest.mjs', payload(repo), hookEnv(home, server.base));
      const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      t.ok(
        context.includes(
          '- Marked wrong in a draw: topics/seven.md, written 2026-11-21 by desk agent, marked 2026-11-22 by Dana: The date is off.'
        )
      );
      t.ok(
        server.requests.some(req => req.url === '/draws?limit=100'),
        'the newest draws read'
      );
    },
    {'GET /draws': {body: draws}}
  );
  for (const [status, routes] of [
    [404, {}],
    [501, {'GET /draws': {status: 501, body: {code: 'not_supported'}}}]
  ]) {
    await withRepo(async ({home, server, repo}) => {
      const r = await runHook('digest.mjs', payload(repo), hookEnv(home, server.base));
      const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      t.notOk(context.includes('Marked wrong'), `a ${status}: no line`);
      t.notOk(context.includes('The draws could not be read'), 'and no problem');
    }, routes);
  }
  await withRepo(
    async ({home, server, repo}) => {
      const r = await runHook('digest.mjs', payload(repo), hookEnv(home, server.base));
      const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      t.ok(context.includes('The draws could not be read: the draws: 500'), 'a 500 is a problem');
    },
    {'GET /draws': {status: 500, body: {code: 'broken'}}}
  );
});

test("/pickup ends with the account's deletion an admin asked for, and says nothing of it when none waits (apodictum-web D98)", async t => {
  const deletion =
    'An admin asked to delete this account: it is deleted at 2026-12-27 14:00 UTC and is read-only until then. An admin can stop the deletion at https://accounts.apodictum.com/';
  const payload = repo => ({prompt: '/pickup', session_id: 's1', cwd: repo});
  await withRepo(
    async ({home, server, repo}) => {
      const r = await runHook('digest.mjs', payload(repo), hookEnv(home, server.base));
      const out = JSON.parse(r.stdout);
      t.matchString(
        out.systemMessage,
        new RegExp(
          `This account is to be deleted\\S*\\n${deletion.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`
        ),
        'the last section, on the screen'
      );
      const context = out.hookSpecificOutput.additionalContext;
      t.ok(
        context.includes(`## This account is to be deleted\n${deletion}\n</pc-digest-`),
        'and last in the context'
      );
      t.notOk(context.includes('An upgrade'), "the operator's notices stay the session hooks'");
    },
    {
      'GET /system/notices': {
        body: {
          notices: [
            {id: 'deletion-2026-12-27T14:00:00.000Z', text: deletion, minutes: null},
            {id: 'op', text: 'An upgrade', starts_at: '2026-12-01T10:00:00Z', minutes: 30}
          ]
        }
      }
    }
  );
  for (const [label, routes] of [
    ['none waits', {'GET /system/notices': {body: {notices: []}}}],
    ['a server with no notices', {}]
  ]) {
    await withRepo(async ({home, server, repo}) => {
      const r = await runHook('digest.mjs', payload(repo), hookEnv(home, server.base));
      const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      t.notOk(context.includes('to be deleted'), `${label}: no section`);
      t.notOk(context.includes('The notices could not be read'), `${label}: and no problem`);
    }, routes);
  }
});
