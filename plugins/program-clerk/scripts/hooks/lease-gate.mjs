// PreToolUse on the edit tools: block an edit into a checkout another holder leases, and point at the
// worktree and handoff instead. Fails open: no key, an unreachable server, or a path outside a
// checkout allows the edit, so a block always means a real, current, someone else's lease.

import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {
  HOOK_BUDGET_MS,
  SESSION_ID,
  connectionOf,
  holderOf,
  readPayload,
  readText,
  secondsNow
} from '../lib/common.mjs';
import {jsonOf} from '../lib/http.mjs';
import {isLinkedWorktree, keysOf, topOf, topOfPath} from '../lib/checkout.mjs';
import {
  RENEW_EVERY,
  addNote,
  claimOwn,
  lookup,
  readSession,
  refusedStamp,
  renewIfDue,
  sessionMode
} from '../lib/lease.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const deadline = Date.now() + HOOK_BUDGET_MS;

const noteRefused = (payload, me, resource, refused, now) => {
  const stamp = refusedStamp(me, resource);
  const last = Number(readText(stamp).trim()) || 0;
  if (now - last < RENEW_EVERY) return;
  try {
    mkdirSync(dirname(stamp), {recursive: true});
    writeFileSync(stamp, String(now));
  } catch {
    return;
  }
  const code = jsonOf(refused.text)?.code;
  addNote(
    payload.session_id,
    payload.agent_id,
    `[pc] lease: the check of ${resource} was refused (HTTP ${refused.status}${code ? `, ${code}` : ''}), so this edit went through unchecked, as when Program Clerk is unreachable. If another session holds ${resource}, move the change to a worktree and a handoff addressed to it. Said once per ${RENEW_EVERY / 60} minutes a checkout.`
  );
};

const blockMessage = ({resource, role, top, holder, kind, me}) =>
  kind === 'human'
    ? `Edit blocked: ${resource} is held by ${holder} (a person).

A person's lease is never preempted and never expires, so taking work from it is ask-first.

Ask before touching this working tree. If you have work for it, put it in a disposable worktree and
file a handoff addressed to the repository:

  handoff_create({idempotency_key, project, to: "${role}", kind, ref, from, body})
`
    : `Edit blocked: ${resource} is held by ${holder}.

This session is ${me}, so that lease is not yours: editing the working tree directly would mix your
changes into whatever that agent has in flight.

Do this instead:
  1. git -C "${top}" worktree add <scratch> -b <topic>
  2. work there, and run the repository's checks there
  3. git format-patch --base=$(git merge-base main HEAD) main..HEAD --stdout
  4. handoff_create({... to: "${role}" ...}), then handoff_put_artifact

If this checkout is your session's working directory, a session claim preempts an agent's side
lease, so try

  lease_claim({resource: "${resource}", holder: "${me}", rank: 10, takeover_after: 3600})

If that answers 409, the holder is another session working here and you are subordinate: read
freely, send edits through the worktree and handoff above, and SendMessage the holder if ListAgents
shows it. Taking the lease is a person's act.
`;

const main = async () => {
  const conn = connectionOf();
  if (!conn) return;
  const payload = readPayload();
  if (!EDIT_TOOLS.has(payload.tool_name)) return;
  const target = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  if (typeof target !== 'string' || !target) return;
  const top = topOfPath(target);
  if (!top) return;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const session = SESSION_ID.test(sessionId) ? readSession(sessionId) : null;
  const mode = sessionMode(session, conn);
  // The protocol sends a non-holder to a worktree of the leased repository, which shares its key.
  if (mode === 'repository' && isLinkedWorktree(top)) return;
  const {resource, role} = keysOf(top, mode);
  const me = holderOf(sessionId);
  const now = secondsNow();
  let seen = await lookup(conn, resource, now, deadline);
  if (!seen) return;
  if (seen.refused) {
    noteRefused(payload, me, resource, seen.refused, now);
    return;
  }
  if (!seen.holder) {
    const cwdTop =
      session?.top ?? topOf(typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : '.');
    if (top !== cwdTop) return;
    seen = await claimOwn(conn, resource, me, now, deadline);
    if (!seen?.holder) return;
  }
  if (seen.holder === me) {
    await renewIfDue(conn, resource, me, now, deadline);
    return;
  }
  process.stderr.write(
    blockMessage({resource, role, top, holder: seen.holder, kind: seen.kind, me})
  );
  process.exitCode = 2;
};

await main().catch(() => {});
