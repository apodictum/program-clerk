// The key option reaches hooks alone: the session-start hook keeps it in a file of the session's,
// where a script the agent runs finds it by the session id, and the session-end hook removes it.

import {existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'tape-six';
import {connectionOf, keyFileOf} from '../plugins/program-clerk/scripts/lib/common.mjs';
import {hookEnv, removeAll, runHook, scratch} from './helpers.mjs';

const SESSION = 'feed1234-0000-4000-8000-000000000001';

test('the session start keeps the option in a file only the person reads; the end removes it', async t => {
  const home = scratch();
  try {
    const env = hookEnv(home, null, {CLAUDE_PLUGIN_OPTION_KEY: 'vsk_ABC-def_123'});
    const file = keyFileOf(SESSION, env);
    let r = await runHook(
      'key-file.mjs',
      {hook_event_name: 'SessionStart', session_id: SESSION},
      env
    );
    t.deepEqual([r.code, r.stdout], [0, ''], 'silent');
    t.equal(readFileSync(file, 'utf8'), 'vsk_ABC-def_123\n');
    if (process.platform !== 'win32') t.equal(statSync(file).mode & 0o777, 0o600);

    const shell = {XDG_STATE_HOME: env.XDG_STATE_HOME, CLAUDE_CODE_SESSION_ID: SESSION};
    t.equal(connectionOf(shell)?.key, 'vsk_ABC-def_123', "a script finds it by the session's id");
    t.equal(connectionOf({...shell, CLAUDE_CODE_SESSION_ID: 'other'}), null);
    t.equal(connectionOf({...shell, PROGRAM_CLERK_KEY: 'mine'}).key, 'mine', 'the variable first');

    r = await runHook('key-file.mjs', {hook_event_name: 'SessionEnd', session_id: SESSION}, env);
    t.equal(r.code, 0);
    t.notOk(existsSync(file));
    t.equal(connectionOf(shell), null);
  } finally {
    removeAll(home);
  }
});

test('no file with the variable set, with no option, or with a key of other characters', async t => {
  const home = scratch();
  try {
    const start = {hook_event_name: 'SessionStart', session_id: SESSION};
    for (const extra of [
      {CLAUDE_PLUGIN_OPTION_KEY: 'vsk_a', PROGRAM_CLERK_KEY: 'mine'},
      {},
      {CLAUDE_PLUGIN_OPTION_KEY: 'vsk_a\nexport X=1'}
    ]) {
      const env = hookEnv(home, null, extra);
      t.equal((await runHook('key-file.mjs', start, env)).code, 0);
      t.notOk(existsSync(keyFileOf(SESSION, env)), JSON.stringify(Object.keys(extra)));
    }
    const env = hookEnv(home, null, {CLAUDE_PLUGIN_OPTION_KEY: 'vsk_a'});
    await runHook('key-file.mjs', {...start, agent_id: 'sub'}, env);
    t.notOk(existsSync(keyFileOf(SESSION, env)), "a subagent's start writes none");
  } finally {
    removeAll(home);
  }
});

test("a session start clears what a crashed session left a month ago, and nobody's newer file", async t => {
  const home = scratch();
  try {
    const env = hookEnv(home, null, {CLAUDE_PLUGIN_OPTION_KEY: 'vsk_a'});
    const old = keyFileOf('old-session', env);
    const recent = keyFileOf('recent-session', env);
    mkdirSync(join(old, '..'), {recursive: true});
    writeFileSync(old, 'vsk_old\n');
    writeFileSync(recent, 'vsk_recent\n');
    const monthAgo = new Date(Date.now() - 31 * 864e5);
    utimesSync(old, monthAgo, monthAgo);
    await runHook('key-file.mjs', {hook_event_name: 'SessionStart', session_id: SESSION}, env);
    t.notOk(existsSync(old));
    t.ok(existsSync(recent));
    t.ok(existsSync(keyFileOf(SESSION, env)));
  } finally {
    removeAll(home);
  }
});
