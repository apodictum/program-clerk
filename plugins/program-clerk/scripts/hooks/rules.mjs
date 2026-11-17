// SessionStart: the project's feedback rules, each a heading and its first paragraph, so every
// session starts with them. A hook of its own: Claude Code caps each hook's output at 10,000
// characters, and the server fits the rules under that.

import {HOOK_BUDGET_MS, connectionOf, readPayload} from '../lib/common.mjs';
import {call, jsonOf} from '../lib/http.mjs';
import {PROJECT, projectOf, topOf} from '../lib/checkout.mjs';

const deadline = Date.now() + HOOK_BUDGET_MS;

const main = async () => {
  const conn = connectionOf();
  if (!conn) return;
  const payload = readPayload();
  const top = topOf(typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd());
  if (!top) return;
  const project = projectOf(top);
  if (!PROJECT.test(project)) return;
  const answer = await call(conn, `/projects/${project}/rules`, {deadline});
  const text = answer?.status === 200 ? jsonOf(answer.text)?.text : undefined;
  if (typeof text === 'string' && text)
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
};

await main().catch(() => {});
