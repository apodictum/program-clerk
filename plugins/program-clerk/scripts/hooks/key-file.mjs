// The shell commands the agent runs never see the plugin's key option, so the plugin's scripts
// (the queue, the wrap) would have no key. SessionStart: with the option set and PROGRAM_CLERK_KEY
// unset, keep the key in a file only the person can read, named by the session, where a script finds
// it by CLAUDE_CODE_SESSION_ID; the agent's environment carries neither the key nor a path. Files a
// crashed session left are cleared after 30 days. SessionEnd: remove the session's file. Silent,
// and fails open like every hook.

import {mkdirSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {SESSION_ID, keyFileOf, readPayload} from '../lib/common.mjs';

const KEY = /^[A-Za-z0-9_-]+$/;
// Claude Code clears its own per-session files after about as long.
const STALE_MS = 30 * 864e5;

const sweep = (dir, now) => {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > STALE_MS) rmSync(file, {force: true});
    } catch {
      // gone already
    }
  }
};

const start = (session, env) => {
  const key = env.CLAUDE_PLUGIN_OPTION_KEY ?? '';
  if (!key || !KEY.test(key) || env.PROGRAM_CLERK_KEY) return;
  const file = keyFileOf(session, env);
  mkdirSync(dirname(file), {recursive: true, mode: 0o700});
  sweep(dirname(file), Date.now());
  writeFileSync(file, `${key}\n`, {mode: 0o600});
};

const main = () => {
  const payload = readPayload();
  if (payload.agent_id) return;
  const session = payload.session_id;
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return;
  if (payload.hook_event_name === 'SessionStart') start(session, process.env);
  else if (payload.hook_event_name === 'SessionEnd') {
    rmSync(keyFileOf(session, process.env), {force: true});
  }
};

try {
  main();
} catch {
  // fails open
}
