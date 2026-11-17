// SessionEnd: release every lease this session's holder holds. A marker naming the holder is written
// first and removed only when nothing is left, so a release cut short by a slow server or the hook's
// timeout is finished by the next session start on this machine. Silent: no one reads SessionEnd's
// output. Never forces: a lease another holder has is not this session's to drop.

import {HOOK_BUDGET_MS, SESSION_ID, connectionOf, holderOf, readPayload} from '../lib/common.mjs';
import {clearPending, dropSession, listLeases, markPending, releaseHeld} from '../lib/lease.mjs';

const deadline = Date.now() + HOOK_BUDGET_MS;

const main = async () => {
  const payload = readPayload();
  if (payload.agent_id) return;
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return;
  const conn = connectionOf();
  if (!conn) return;
  dropSession(sessionId);
  const me = holderOf(sessionId);
  markPending(me);
  const leases = await listLeases(conn, deadline);
  if (!leases) return;
  const {done} = await releaseHeld(conn, me, leases, 100, deadline);
  if (done) clearPending(me);
};

await main().catch(() => {});
