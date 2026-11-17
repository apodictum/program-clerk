// SessionStart: a few lines on the account and the project, and the service's notices. Fails open:
// no key, an unreachable server, or an answer it cannot read prints nothing, except a refused key,
// the one failure a session must hear of, since every hook goes quiet with it.

import {HOOK_BUDGET_MS, SESSION_ID, connectionOf, readPayload} from '../lib/common.mjs';
import {call, jsonOf} from '../lib/http.mjs';
import {PROJECT, projectOf, topOf} from '../lib/checkout.mjs';
import {
  TRAILER,
  briefLines,
  githubLine,
  needsQueue,
  refusedKeyLine,
  withQueue
} from '../lib/brief.mjs';
import {newNotices} from '../lib/notices.mjs';

const deadline = Date.now() + HOOK_BUDGET_MS;

const main = async () => {
  const conn = connectionOf();
  if (!conn) return;
  const payload = readPayload();
  const top = topOf(typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd());
  const name = top ? projectOf(top) : '';
  const project = PROJECT.test(name) ? name : '';
  const sessionId =
    typeof payload.session_id === 'string' && SESSION_ID.test(payload.session_id)
      ? payload.session_id
      : '';

  // The first semantic search would otherwise wait for the model to load.
  const warm = call(conn, '/maintenance/warm-embedder', {method: 'POST', deadline, timeout: 1000});
  const notices =
    sessionId && !payload.agent_id
      ? newNotices(conn, sessionId, {atStart: true, deadline}).catch(() => '')
      : Promise.resolve('');
  const github = project
    ? call(conn, `/data/projects/${project}/data/github.json`, {deadline})
    : Promise.resolve(null);

  const answer = await call(
    conn,
    `/system/resume-brief${project ? `?project=${encodeURIComponent(project)}` : ''}`,
    {deadline}
  );
  const lines = [];
  if (answer?.status === 401) {
    lines.push(refusedKeyLine(conn.base));
  } else if (answer?.status === 200) {
    let brief = jsonOf(answer.text);
    if (brief && typeof brief === 'object') {
      if (needsQueue(brief)) {
        const items = await call(conn, '/notes/query', {
          method: 'POST',
          read: true,
          body: {folder: `projects/${project}/queue`, sort: 'sequence_key', limit: 500},
          deadline
        });
        if (items?.status === 200) brief = withQueue(brief, jsonOf(items.text)?.items);
      }
      lines.push(...briefLines(brief, {base: conn.base}));
      const stored = await github;
      try {
        const line = stored?.status === 200 ? githubLine(jsonOf(stored.text)) : null;
        if (line) lines.push(line);
      } catch {
        // a baseline this reader cannot read costs its own line, never the brief
      }
    }
  }
  const said = await notices;
  if (said) lines.push(said);
  await warm;
  if (!lines.length) return;
  // A title can quote a stranger, and hook output reads as the user's words.
  if (answer?.status !== 401) lines.push(TRAILER);
  process.stdout.write(lines.join('\n') + '\n');
};

await main().catch(() => {});
