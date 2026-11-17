// The `queue` skill's commands, which `scripts/queue.mjs` runs.

import {readFileSync} from 'node:fs';
import {NO_KEY, connectionOf} from './common.mjs';
import {request} from './http.mjs';
import {
  archiveItem,
  fileItem,
  listAll,
  listItems,
  moveItem,
  queueOf,
  trackerLine
} from './queue.mjs';

const parseArgs = argv => {
  const opts = {_: []};
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else opts._.push(a);
  }
  return opts;
};

const numberOf = (value, name) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new TypeError(`--${name} takes a whole number, got: ${value}`);
  return n;
};

export const run = async (argv, {env = process.env, out = line => console.log(line)} = {}) => {
  const opts = parseArgs(argv);
  const [command, project, ref] = opts._;
  if (!command || (!project && command !== 'all')) {
    throw new TypeError('usage: queue.mjs list|file|move|archive|trackers <project> …, or all');
  }
  const conn = connectionOf(env);
  if (conn === null) throw new Error(NO_KEY);
  const api = (path, o = {}) => request(conn, path, {...o, env});
  const priority = numberOf(opts.priority, 'priority');
  const show = value => out(JSON.stringify(value, null, 2));
  switch (command) {
    case 'all': {
      const items = await listAll(api, {
        section: opts.section,
        priority,
        limit: numberOf(opts.limit, 'limit')
      });
      if (opts.json) return show(items);
      for (const i of items) {
        out(`${i.project}\t${i.section ?? '(no section)'}\t${i.priority}\t${i.title}`);
      }
      return out(`${items.length} items`);
    }
    case 'list': {
      const items = await listItems(api, project, {section: opts.section});
      if (opts.json) return show(items);
      for (const i of items) out(`${i.section ?? '(no section)'}\t${i.priority}\t${i.title}`);
      return out(`${items.length} items`);
    }
    case 'file':
      return show(
        await fileItem(api, project, {
          title: opts.title,
          section: opts.section,
          priority,
          source: opts.source ?? null,
          blockedBy: opts['blocked-by'] ? [opts['blocked-by']] : [],
          body: opts['body-file'] ? readFileSync(opts['body-file'], 'utf8') : opts.body
        })
      );
    case 'move':
      return show(await moveItem(api, project, ref, {section: opts.section, priority}));
    case 'archive':
      return show(await archiveItem(api, project, ref, {reason: opts.reason, trail: opts.trail}));
    case 'trackers': {
      const {trackers} = await queueOf(api, project);
      if (opts.json) return show(trackers);
      out(trackerLine(trackers));
      for (const problem of trackers.problems) out(`problem: ${problem}`);
      return undefined;
    }
    default:
      throw new TypeError(`unknown command: ${command}`);
  }
};
