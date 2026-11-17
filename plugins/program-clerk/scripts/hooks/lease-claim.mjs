// SessionStart: claim the session's checkout for its life, and say where the session stands. Fails
// open: a session never waits on Program Clerk, and only a line it prints tells it its standing.

import {HOOK_BUDGET_MS, SESSION_ID, connectionOf, holderOf, readPayload} from '../lib/common.mjs';
import {call, jsonOf} from '../lib/http.mjs';
import {keysOf, topOf} from '../lib/checkout.mjs';
import {
  claimBody,
  claimLine,
  dropPendingFile,
  listLeases,
  modeClause,
  pendingHolders,
  readMode,
  readSession,
  releaseHeld,
  saveHolder,
  saveSession,
  saveStamp,
  saveToken,
  tokenOf
} from '../lib/lease.mjs';

const deadline = Date.now() + HOOK_BUDGET_MS;

const main = async () => {
  const conn = connectionOf();
  if (!conn) return;
  const payload = readPayload();
  if (payload.agent_id) return;
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return;
  const top = topOf(typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd());
  if (!top) return;
  const me = holderOf(sessionId);

  // A session that ended here without finishing its release; two releases at most.
  const pending = pendingHolders();
  if (pending.length) {
    const leases = await listLeases(conn, deadline);
    if (leases) {
      let budget = 2;
      for (const {name, holder} of pending) {
        if (!holder) {
          dropPendingFile(name);
          continue;
        }
        const {posts, done} = await releaseHeld(conn, holder, leases, budget, deadline);
        if (done) dropPendingFile(name);
        budget -= posts;
        if (budget <= 0) break;
      }
    }
  }

  // A compacted or resumed session keeps the mode it started with.
  const known = readSession(sessionId);
  const mode = known?.mode ? known : await readMode(conn, deadline);
  const {resource, role} = keysOf(top, mode.mode);
  saveSession(sessionId, {mode: mode.mode, source: mode.source, top, resource, role});

  const answer = await call(conn, '/leases/claim', {
    method: 'POST',
    body: claimBody(resource, me, tokenOf(me, resource)),
    deadline
  });
  if (!answer) return;
  if (answer.status === 200) {
    saveToken(me, resource, jsonOf(answer.text)?.claim_token);
    const now = Math.floor(Date.now() / 1000);
    saveHolder(resource, {at: now, holder: me, kind: 'agent'});
    saveStamp(resource, now);
  }
  const line = claimLine(answer, {resource, role, me, base: conn.base});
  if (line) process.stdout.write(`${line} ${modeClause(mode, resource)}\n`);
};

await main().catch(() => {});
