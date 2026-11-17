// `/wrap`'s writes, each only after the one before it landed: the session's log, its line in the
// project's month file of sessions, and the checkout's drift baseline. The line's `at` and
// `holder` come from this machine's clock and the session's id, since the server pairs a log with
// its session's end by them.

import {readFileSync} from 'node:fs';
import {PROJECT, projectOf, topOf} from './checkout.mjs';
import {NO_KEY, SESSION_ID, connectionOf, holderOf} from './common.mjs';
import {refreshBaseline} from './drift.mjs';
import {request} from './http.mjs';
import {slugOf} from './queue.mjs';

/** The file the agent writes, as {title, summary, body}; throws on a part missing. */
export const logOf = text => {
  const lines = text.split(/\r?\n/);
  const rule = lines.indexOf('---');
  if (rule < 0) throw new SyntaxError('the file needs a --- line between its header and the body');
  const field = name => {
    const prefix = `${name}:`;
    const line = lines.slice(0, rule).find(l => l.startsWith(prefix));
    return line === undefined ? '' : line.slice(prefix.length).trim();
  };
  const log = {
    title: field('title'),
    summary: field('summary'),
    body: lines
      .slice(rule + 1)
      .join('\n')
      .trim()
  };
  for (const [name, value] of Object.entries(log)) {
    if (!value) throw new SyntaxError(`the file has no ${name}`);
  }
  return {...log, body: `${log.body}\n`};
};

const parseArgs = argv => {
  const opts = {_: []};
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i];
    if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else opts._.push(a);
  }
  return opts;
};

const landed = (answer, what) => {
  if (answer === null) throw new Error(`${what}: no answer`);
  if (answer.status >= 300)
    throw new Error(`${what}: ${answer.status} ${answer.text.slice(0, 300)}`);
};

// The person's day names the log, as the logs written by hand do; `at` and the month stay in UTC,
// as the session's end line has them.
const localDay = date =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0'))
    .join('-');

export const run = async (
  argv,
  {
    env = process.env,
    cwd = process.cwd(),
    out = line => console.log(line),
    now = () => new Date(),
    versionsOf
  } = {}
) => {
  const opts = parseArgs(argv);
  const [file] = opts._;
  if (!file)
    throw new TypeError('usage: wrap.mjs <file> [--slug S] [--project P], or wrap.mjs baseline');
  const conn = connectionOf(env);
  if (conn === null) throw new Error(NO_KEY);
  const api = (path, o = {}) => request(conn, path, {...o, env});
  if (file === 'baseline') {
    const top = topOf(cwd);
    if (!top) throw new Error('no checkout here: run this in the project checkout');
    const project = projectOf(top);
    landed(await refreshBaseline({api, top, project, versionsOf}), 'the baseline');
    out(`baseline: projects/${project}/state.md`);
    return;
  }
  const session = env.CLAUDE_CODE_SESSION_ID ?? '';
  if (!SESSION_ID.test(session)) {
    throw new Error('no session id: run this from a Claude Code session (CLAUDE_CODE_SESSION_ID)');
  }
  const top = topOf(cwd);
  const own = top ? projectOf(top) : null;
  const project = opts.project ?? own;
  if (!project || !PROJECT.test(project)) {
    throw new Error('no project: run this in the project checkout, or name it with --project');
  }
  const {title, summary, body} = logOf(readFileSync(file, 'utf8'));
  const date = now();
  const at = date.toISOString().slice(0, 19) + 'Z';
  const day = localDay(date);
  const sessions = `projects/${project}/data/sessions`;
  const bodyPath = `${sessions}/logs/${day}-${session.slice(0, 8)}-${slugOf(opts.slug ?? title)}.markdown`;
  landed(await api(`/data/${bodyPath}`, {method: 'PUT', body}), "the log's body");
  out(`log: ${bodyPath}`);
  const line = {
    kind: 'log',
    at,
    holder: holderOf(session),
    title: `${project}: ${title} (${day})`,
    summary,
    body: bodyPath
  };
  const month = `${sessions}/${at.slice(0, 7)}.jsonl`;
  landed(
    await api(`/data/${month}`, {method: 'POST', body: JSON.stringify(line) + '\n'}),
    "the log's line"
  );
  out(`line: ${month}`);
  if (own !== project) {
    out(`baseline: not written, since no checkout of ${project} is here`);
    return;
  }
  landed(await refreshBaseline({api, top, project, versionsOf}), 'the baseline');
  out(`baseline: projects/${project}/state.md`);
};
