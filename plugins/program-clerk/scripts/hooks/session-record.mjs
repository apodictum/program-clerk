// SessionEnd: append one JSON line about this session's end to the project's month file, so a
// session that ends without a wrap leaves what it did where the next brief finds it. The line's
// fields are the server's contract for projects/<name>/data/sessions/<YYYY-MM>.jsonl.

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  HOOK_BUDGET_MS,
  SESSION_ID,
  connectionOf,
  holderOf,
  readPayload,
  transcriptsDirOf
} from '../lib/common.mjs';
import {call} from '../lib/http.mjs';
import {PROJECT, changedSinceMark, projectOf, topOf} from '../lib/checkout.mjs';
import {readTranscript} from '../lib/transcript.mjs';

const deadline = Date.now() + HOOK_BUDGET_MS;

const commitsSince = (top, since) => {
  try {
    return execFileSync('git', ['-C', top, 'log', `--since=${since}`, '--format=%h'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    return [];
  }
};

const main = async () => {
  const payload = readPayload();
  if (payload.agent_id) return;
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return;
  const conn = connectionOf();
  if (!conn) return;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  if (!cwd || !existsSync(cwd)) return;
  const top = topOf(cwd);
  if (!top) return;
  const project = projectOf(top);
  if (!PROJECT.test(project)) return;
  const reason = /^[a-z_-]+$/.test(payload.reason ?? '') ? payload.reason : 'other';
  const ended = new Date().toISOString().slice(0, 19) + 'Z';
  let transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (!transcript || !existsSync(transcript))
    transcript = join(transcriptsDirOf(cwd), `${sessionId}.jsonl`);
  let {started, wrote} = {started: '', wrote: []};
  try {
    ({started, wrote} = readTranscript(readFileSync(transcript, 'utf8')));
  } catch {
    // no transcript: the session's end alone
  }
  started ||= ended;
  // at most a second, so the commits' read and the append keep their share of the budget
  const changed = changedSinceMark(sessionId, top, Math.min(1000, deadline - Date.now() - 3000));
  const line = {
    kind: 'end',
    ended,
    holder: holderOf(sessionId),
    started,
    reason,
    commits: commitsSince(top, started),
    wrote,
    ...(changed === undefined ? {} : {changed})
  };
  await call(conn, `/data/projects/${project}/data/sessions/${ended.slice(0, 7)}.jsonl`, {
    method: 'POST',
    body: JSON.stringify(line) + '\n',
    deadline
  });
};

await main().catch(() => {});
