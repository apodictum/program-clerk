// PostToolUse on every tool: keep the session's own lease alive, say once what changed about it, and
// pass on the service's notices. Never blocks. The common call costs a few file reads: the renewal
// is due once in 15 minutes, the notices once a minute.

import {rmSync} from 'node:fs';
import {
  HOOK_BUDGET_MS,
  SESSION_ID,
  connectionOf,
  contextFor,
  holderOf,
  readPayload,
  readText,
  secondsNow
} from '../lib/common.mjs';
import {keysOf, topOf} from '../lib/checkout.mjs';
import {
  RENEW_EVERY,
  claimOwn,
  lookup,
  notesFile,
  readHolder,
  readSession,
  readStamp,
  renewIfDue,
  saveSession,
  saveStamp,
  sessionMode
} from '../lib/lease.mjs';
import {newNotices} from '../lib/notices.mjs';

const deadline = Date.now() + HOOK_BUDGET_MS;

const leaseNews = async (conn, payload, sessionId) => {
  const notes = notesFile(sessionId, payload.agent_id);
  const waiting = readText(notes).trim();
  if (waiting) {
    rmSync(notes, {force: true});
    return waiting;
  }
  // A sub-agent shares its parent's holder and never claims under a prefix of its own.
  if (payload.agent_id) return '';
  let session = readSession(sessionId);
  if (!session?.resource) {
    const top = topOf(typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : '.');
    if (!top) return '';
    const mode = sessionMode(session, conn);
    session = {mode, source: 'last read', top, ...keysOf(top, mode)};
    saveSession(sessionId, session);
  }
  const {resource, role} = session;
  const now = secondsNow();
  if (now - readStamp(resource) < RENEW_EVERY) return '';
  const me = holderOf(sessionId);
  const before = readHolder(resource)?.holder;
  let seen = await lookup(conn, resource, now, deadline);
  if (!seen || seen.refused) return '';
  if (!seen.holder) {
    seen = await claimOwn(conn, resource, me, now, deadline);
    if (seen?.refusedLine) {
      saveStamp(resource, now);
      return seen.refusedLine;
    }
    if (!seen?.holder) return '';
  }
  if (seen.holder === me) {
    await renewIfDue(conn, resource, me, now, deadline);
    return '';
  }
  saveStamp(resource, now);
  if (before !== me) return '';
  return seen.kind === 'human'
    ? `[pc] lease: ${resource} is now held by ${seen.holder} (a person); this session (${me}) no longer holds it. Ask before editing this working tree; work goes in a worktree and a handoff to "${role}".`
    : `[pc] lease: ${resource} is now held by ${seen.holder}; this session (${me}) no longer holds it (a cwd lease left unrenewed for an hour passes to the next session that starts in the checkout). You are SUBORDINATE now: read freely; every edit goes in a worktree and a handoff to "${role}" (SendMessage the holder if ListAgents shows it). Taking it back is a person's act, on the account's Agents page (${conn.base}/ui/agents).`;
};

const main = async () => {
  const conn = connectionOf();
  if (!conn) return;
  const payload = readPayload();
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return;
  const [lease, notices] = await Promise.all([
    leaseNews(conn, payload, sessionId).catch(() => ''),
    payload.agent_id ? '' : newNotices(conn, sessionId, {atStart: false, deadline}).catch(() => '')
  ]);
  const text = [lease, notices].filter(Boolean).join('\n');
  if (text) process.stdout.write(contextFor('PostToolUse', text));
};

await main().catch(() => {});
