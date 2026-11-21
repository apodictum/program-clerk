// SessionStart: keep a mark of the checkout as the session found it, so the session's record can
// say whether the session changed it. A compaction or a resume keeps the first mark. Silent.

import {existsSync} from 'node:fs';
import {SESSION_ID, connectionOf, readPayload} from '../lib/common.mjs';
import {keepMark, topOf} from '../lib/checkout.mjs';

const main = () => {
  const payload = readPayload();
  if (payload.agent_id) return;
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return;
  if (!connectionOf()) return;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  if (!cwd || !existsSync(cwd)) return;
  const top = topOf(cwd);
  if (top) keepMark(sessionId, top);
};

try {
  main();
} catch {
  // fails open
}
