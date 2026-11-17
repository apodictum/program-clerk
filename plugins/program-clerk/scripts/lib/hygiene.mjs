// The hygiene lint, which `scripts/lint.mjs` runs: every note through `/sections`, checked for its
// frontmatter, an empty or collapsed body, broken links, density, currency, duplicates, and the
// queue's shape. It reports and never fixes.

import {NO_KEY, connectionOf} from './common.mjs';
import {request} from './http.mjs';
import {SECTIONS} from './queue.mjs';

export const CATEGORIES = [
  'frontmatter',
  'body',
  'wikilinks',
  'density',
  'currency',
  'duplicates',
  'queue'
];

export const USAGE = `usage: lint.mjs [--quiet] [--category=a,b] [--max=N] [--no-fetch]
categories: ${CATEGORIES.join(', ')}`;

export const RETENTION_DAYS = {log: 90, query: 90, fleeting: 30, project: 180, permanent: 365};
export const TOPIC_MIN_LINKS = 2;
export const FETCH_CAP = 300;
export const COLLAPSE_MIN_LINE = 400;
export const COLLAPSE_MIN_MARKS = 2;
export const FOLDER_MAX_DISTANCE = 1;
export const TITLE_MAX_DISTANCE = 2;
export const DEFAULT_MAX = 40;

const REQUIRED_FM = ['title', 'type', 'status', 'created', 'updated'];
const TYPE_EXEMPT = new Set(['_index.md', '_about.md']);
// A project's running files stay empty until there is something to record, so an empty one is no
// stub.
const RUNNING_FILES = new Set([
  'decisions.md',
  'learnings.md',
  'stack.md',
  'queue.md',
  'queue-archive.md',
  'feedback.md'
]);
const DENSITY_SKIP_STATUS = new Set(['archived', 'archive', 'done']);
const TITLE_DUP_SKIP = new Set(['log', 'state', 'queue-item', 'index', 'meta']);
const ARCHIVE_RE = /(^|\/)archive\//;
const ACTIONS = {
  log: 'removed by /sweep (expire-logs)',
  query: 'archive (0 inbound)',
  fleeting: 'ingest or retire',
  project: 'verify still current',
  permanent: 'verify still current'
};
const PAGE = 100;
const QUERY_PAGE = 500;
const DAY_MS = 86_400_000;

const LABELS = {
  frontmatter: ['FRONTMATTER', 'fm'],
  body: ['BODY', 'body'],
  wikilinks: ['WIKILINKS', 'links'],
  density: ['DENSITY', 'density'],
  currency: ['CURRENCY', 'currency'],
  duplicates: ['DUPLICATES', 'dups'],
  queue: ['QUEUE', 'queue']
};

/** The options; a TypeError names what is wrong with them. */
export const optionsOf = argv => {
  const opts = {quiet: false, noFetch: false, max: DEFAULT_MAX, categories: CATEGORIES};
  for (const arg of argv) {
    const at = arg.indexOf('=');
    const [flag, value] = at < 0 ? [arg, null] : [arg.slice(0, at), arg.slice(at + 1)];
    if (flag === '--quiet' && value === null) opts.quiet = true;
    else if (flag === '--no-fetch' && value === null) opts.noFetch = true;
    else if (flag === '--max' && /^\d+$/.test(value ?? '')) opts.max = Number(value);
    else if (flag === '--category' && value !== null) {
      const names = value
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);
      for (const name of names) {
        if (!CATEGORIES.includes(name)) {
          throw new TypeError(`unknown --category '${name}' (known: ${CATEGORIES.join(', ')})`);
        }
      }
      opts.categories = names.length ? names : CATEGORIES;
    } else throw new TypeError(`unknown option: ${arg}\n${USAGE}`);
  }
  return opts;
};

// --- the queue's completion markers

// Shouted anywhere in a title; plain only beside a date, so "fixed the flaky test" stays open. A
// plain marker before the word it modifies is an adjective ("a closed enum", "a fixed −5", "a fixed
// 30-second cap"), while a connector may follow one ("published to npm" and a date). Bodies narrate
// partial progress, so titles alone are read.
const SHOUTED_RE = /\b(?:SHIPPED|DONE|COMPLETED?|CLOSED|FIXED|PUBLISHED)\b/;
const PLAIN =
  '\\b(?:shipped|done|completed|fixed|closed|published)\\b(?![\\s-]+(?:(?!(?:on|in|to)\\b)[a-z]|[−+]\\d|\\d+-[a-z]))';
const DATE = '\\d{4}-\\d{2}-\\d{2}';
const DATED_RE = new RegExp(`${PLAIN}[^\\n]{0,24}?${DATE}|${DATE}[^\\n]{0,24}?${PLAIN}`, 'i');

const withoutCode = text => text.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));

/** The words in a title that say its work is finished, or null. */
export const completionMarker = title => {
  const text = withoutCode(title);
  const m = SHOUTED_RE.exec(text) ?? DATED_RE.exec(text);
  return m ? m[0] : null;
};

const short = text => (text.length > 72 ? `${text.slice(0, 69)}…` : text);

/** One finding for each open item's title that says its work is finished. */
export const markerFindings = titles =>
  titles.flatMap(title => {
    const marker = completionMarker(title);
    return marker === null
      ? []
      : [`"${short(title)}": completion marker '${marker}' on an open item; archive it`];
  });

// --- links

const WIKILINK_RE = /\[\[([^\]]+?)\]\]/g;
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|pdf|mp4|mov|webm|ico|zip)$/i;
const norm = path => path.replace(/\.md$/i, '');
const baseOf = path => path.slice(path.lastIndexOf('/') + 1);

// Notes about code quote `[[x]]` as examples, and one stray `[[` would stretch a match to the next
// `]]`.
export const stripCode = text => text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

/** The notes a text links to, without `.md`, a heading, an alias, or an asset. */
export const linkTargets = text => {
  if (!text) return [];
  const out = [];
  for (const m of stripCode(text).matchAll(WIKILINK_RE)) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (!target || target.length > 200 || target.includes('\n') || ASSET_EXT.test(target)) continue;
    out.push(norm(target.replace(/^\/+/, '')));
  }
  return out;
};

/**
 * How a link resolves, by path when it has a folder and by base name otherwise, over every note,
 * the archived among them, and every data file; and how many notes link to a note.
 */
export const linkIndex = (all, dataPaths = []) => {
  const paths = new Set();
  const byBase = new Map();
  for (const r of all) {
    const path = norm(r.file_path);
    paths.add(path);
    const base = baseOf(path);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(path);
  }
  // A data file, and each folder above it up to the project's `data`, opens as a page.
  const data = new Set();
  for (const path of dataPaths) {
    data.add(path);
    const parts = path.split('/');
    for (let i = 3, n = parts.length; i < n; ++i) data.add(parts.slice(0, i).join('/'));
  }
  const inbound = new Map();
  for (const r of all) {
    const from = norm(r.file_path);
    for (const target of new Set(linkTargets(r.body))) {
      const found = target.includes('/')
        ? paths.has(target)
          ? [target]
          : []
        : (byBase.get(target) ?? []);
      for (const to of found) if (to !== from) inbound.set(to, (inbound.get(to) ?? 0) + 1);
    }
  }
  return {
    resolves: target =>
      target.includes('/')
        ? paths.has(target) || data.has(target.replace(/\/+$/, ''))
        : byBase.has(target),
    inboundOf: r => inbound.get(norm(r.file_path)) ?? 0
  };
};

// --- bodies

// A save that lost newlines leaves each block boundary as a missing space. A long line proves
// nothing alone, since a one-paragraph note is one line, so a line counts only with marks.
const GLUE_RES = [
  // An opener before the run is a quoted section reference: prose.
  /[\w.!?,;)]#{1,6} +\S/g, // a heading: `project## README`
  /[^\s`]```/g, // a fence: `an example:```js`
  // A real word or a one-letter one, or `unicode-X.X.X` and `Node.JS` would count.
  /[.!?][")'\]]?(?:[A-Z][a-z]|[IA] )/g, // a paragraph: `true.I cannot`
  /[.!?:)"']- +\S/g // a list item: `people. And:- Some`; `*` would meet `*emphasis*`
];

/** The block boundaries a line carries glued, its code set aside. */
export const glueMarks = line => {
  const text = stripCode(line);
  return GLUE_RES.reduce((n, re) => n + (text.match(re) ?? []).length, 0);
};

// --- dates and distances

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const parseDate = text => {
  if (typeof text !== 'string' || !text) return null;
  const date = new Date(DATE_RE.test(text) ? `${text}T00:00:00Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** The Levenshtein distance. */
export const lev = (a, b) => {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({length: n + 1}, (_, i) => i);
  for (let i = 1; i <= m; ++i) {
    const cur = [i];
    for (let j = 1; j <= n; ++j)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
};

// --- the checks; each takes the active notes, the archived set aside

export const frontmatterFindings = active => {
  const found = [];
  for (const r of active) {
    // The baseline, kept by its own command.
    if (r.type === 'state') continue;
    const base = baseOf(r.file_path);
    const missing = REQUIRED_FM.filter(
      key => !(key === 'type' && TYPE_EXEMPT.has(base)) && (r[key] ?? '') === ''
    );
    const problems = [];
    if (missing.length) problems.push(`missing ${missing.join(',')}`);
    const created = parseDate(r.created);
    const updated = parseDate(r.updated);
    if (r.created && !created) problems.push(`unparseable created '${r.created}'`);
    if (r.updated && !updated) problems.push(`unparseable updated '${r.updated}'`);
    if (created && updated && created.getTime() > updated.getTime())
      problems.push(`created > updated (${r.created} > ${r.updated})`);
    if (problems.length) found.push({path: r.file_path, detail: problems.join('; ')});
  }
  return found;
};

export const bodyFindings = active => {
  const found = [];
  for (const r of active) {
    if (r.type === 'state') continue;
    if (r.type === 'project' && RUNNING_FILES.has(baseOf(r.file_path))) continue;
    // A body never written reads back as the text `null`.
    const body = String(r.body ?? '').trim();
    if (body === '' || body === 'null') {
      found.push({path: r.file_path, detail: 'empty body (no content written)'});
      continue;
    }
    for (const line of body.split(/\r?\n/)) {
      if (line.length < COLLAPSE_MIN_LINE) continue;
      const marks = glueMarks(line);
      if (marks < COLLAPSE_MIN_MARKS) continue;
      found.push({
        path: r.file_path,
        detail: `collapsed line: ${line.length} chars, ${marks} glued block boundaries (newlines lost on save)`
      });
      break;
    }
  }
  return found;
};

export const wikilinkFindings = (active, {resolves}) =>
  active.flatMap(r => {
    const broken = [...new Set(linkTargets(r.body))].filter(target => !resolves(target));
    return broken.length
      ? [{path: r.file_path, detail: broken.map(target => `[[${target}]]`).join(', ')}]
      : [];
  });

/** `linkCountOf(path)` counts a note's links in its whole text, `related:` included, or is null. */
export const densityFindings = async (active, {inboundOf}, linkCountOf = async () => null) => {
  const found = [];
  for (const r of active) {
    if (DENSITY_SKIP_STATUS.has(r.status)) continue;
    const bodyOut = new Set(linkTargets(r.body)).size;
    if (r.type === 'permanent') {
      if (bodyOut >= TOPIC_MIN_LINKS) continue;
      const total = (await linkCountOf(r.file_path)) ?? bodyOut;
      if (total < TOPIC_MIN_LINKS)
        found.push({
          path: r.file_path,
          detail: `topic: ${total} outbound wikilink${total === 1 ? '' : 's'} (< ${TOPIC_MIN_LINKS})`
        });
    } else if (r.type === 'project') {
      if (bodyOut > 0 || inboundOf(r) > 0) continue;
      if (((await linkCountOf(r.file_path)) ?? 0) === 0)
        found.push({path: r.file_path, detail: 'project: isolated (0 outbound, 0 inbound)'});
    }
  }
  return found;
};

export const currencyFindings = (active, {inboundOf}, now = new Date()) => {
  const found = [];
  for (const r of active) {
    const limit = RETENTION_DAYS[r.type];
    if (!limit) continue;
    const updated = parseDate(r.updated);
    if (!updated) continue;
    const age = Math.floor((now.getTime() - updated.getTime()) / DAY_MS);
    if (age <= limit) continue;
    // A query stays while a note links to it.
    if (r.type === 'query' && inboundOf(r) > 0) continue;
    found.push({
      path: r.file_path,
      detail: `${r.type}: updated ${r.updated} (${age}d > ${limit}d) — ${ACTIONS[r.type]}`
    });
  }
  return found;
};

/** Project folders named alike across `all`, and titles alike within one folder. */
export const duplicateFindings = (all, active) => {
  const found = [];
  const folders = new Set();
  for (const r of all) {
    const parts = r.file_path.split('/');
    if (parts[0] === 'projects' && parts.length > 2) folders.add(parts[1]);
  }
  // Case and separators set aside, so two spellings of one name meet while siblings sharing a
  // prefix stay apart.
  const squeezed = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = [...folders].sort();
  for (let i = 0, n = names.length; i < n; ++i)
    for (let j = i + 1; j < n; ++j) {
      const distance = lev(squeezed(names[i]), squeezed(names[j]));
      if (distance <= FOLDER_MAX_DISTANCE)
        found.push({
          path: `projects/{${names[i]},${names[j]}}`,
          detail: `near-identical folder names (lev ${distance} ignoring case/separators)`
        });
    }

  const byDir = new Map();
  for (const r of active) {
    // A dated title is a series in time, never a pair to merge.
    if (!r.title || TITLE_DUP_SKIP.has(r.type) || /\d{4}-\d{2}-\d{2}/.test(r.title)) continue;
    const dir = r.file_path.split('/').slice(0, -1).join('/') || '.';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(r);
  }
  for (const [dir, notes] of byDir)
    for (let i = 0, n = notes.length; i < n; ++i)
      for (let j = i + 1; j < n; ++j) {
        const a = notes[i].title.toLowerCase().trim();
        const b = notes[j].title.toLowerCase().trim();
        if (a === b || lev(a, b) <= TITLE_MAX_DISTANCE)
          found.push({
            path: dir,
            detail: `near-duplicate titles: "${notes[i].title}" ~ "${notes[j].title}"`
          });
      }
  return found;
};

const QUEUE_NOTE_RE = /^projects\/[^/]+\/queue\.md$/;
const ABOUT_RE = /^(projects\/[^/]+\/queue)\/_about\.md$/;
const SPECIAL_RE = /\/_(?:about|lead)\.md$/;

/**
 * What the queue's readers skip, and what a list cannot tell: an item with no known section or of
 * another type, a real queue.md where the folder's view belongs, and an open item whose title says
 * it is finished. `notesOf(folder)` resolves to the folder's notes with their frontmatter.
 */
export const queueFindings = async (active, notesOf) => {
  const found = [];
  for (const r of active) {
    if (QUEUE_NOTE_RE.test(r.file_path)) {
      found.push({
        path: r.file_path,
        detail: 'a real queue.md: the queue commands and the session brief do not read it'
      });
      continue;
    }
    const folder = ABOUT_RE.exec(r.file_path)?.[1];
    if (!folder) continue;
    for (const n of await notesOf(folder)) {
      if (SPECIAL_RE.test(n.path)) continue;
      const fm = n.frontmatter ?? {};
      if (!SECTIONS.includes(fm.section))
        found.push({
          path: n.path,
          detail: `section "${fm.section ?? ''}" is none of ${SECTIONS.join(', ')}`
        });
      if (fm.type !== 'queue-item')
        found.push({path: n.path, detail: `type "${fm.type ?? ''}" is not queue-item`});
      for (const detail of markerFindings([String(fm.title ?? '')]))
        found.push({path: n.path, detail});
    }
  }
  return found;
};

// --- the run

const pathOf = path => path.split('/').map(encodeURIComponent).join('/');

/** Lints the account's notes; resolves to 1 with findings, 0 without. */
export const run = async (
  argv,
  {env = process.env, out = text => console.log(text), now = () => new Date()} = {}
) => {
  if (argv[0] === '--help' || argv[0] === '-h') {
    out(USAGE);
    return 0;
  }
  const opts = optionsOf(argv);
  const conn = connectionOf(env);
  if (conn === null) throw new Error(NO_KEY);

  const api = async (path, init = {}) => {
    const answer = await request(conn, path, {...init, env});
    if (answer === null) throw new Error(`failed to load ${path}: no answer`);
    if (answer.status < 200 || answer.status > 299)
      throw new Error(`failed to load ${path}: ${answer.status} ${answer.text.slice(0, 200)}`);
    return answer.text;
  };
  // A page may hold fewer items than asked for, so the offset moves by what came.
  const everything = async pageAt => {
    const items = [];
    for (;;) {
      const page = await pageAt(items.length);
      items.push(...page.items);
      if (!page.items.length || items.length >= (page.total ?? items.length)) return items;
    }
  };

  const all = await everything(async offset =>
    JSON.parse(await api(`/sections?limit=${PAGE}&offset=${offset}`))
  );
  // An archived note links on as history, so it resolves, and has no findings of its own.
  const active = all.filter(r => !ARCHIVE_RE.test(r.file_path));
  const want = name => opts.categories.includes(name);

  let dataPaths = [];
  if (want('wikilinks')) {
    try {
      const list = JSON.parse(await api('/data?prefix=projects/'));
      dataPaths = (list.items ?? []).map(item => item.path);
    } catch {
      // an account without data files answers no list, and no link resolves to one
    }
  }
  const index = linkIndex(all, dataPaths);

  const cap = opts.noFetch ? 0 : FETCH_CAP;
  let fetches = 0;
  let capped = false;
  const linkCountOf = async path => {
    if (fetches >= cap) {
      capped = true;
      return null;
    }
    ++fetches;
    try {
      return new Set(linkTargets(await api(`/vault/${pathOf(path)}`))).size;
    } catch {
      return null;
    }
  };
  const notesOf = folder =>
    everything(async offset =>
      JSON.parse(
        await api('/notes/query', {method: 'POST', body: {folder, limit: QUERY_PAGE, offset}})
      )
    );

  const lists = {};
  if (want('frontmatter')) lists.frontmatter = frontmatterFindings(active);
  if (want('body')) lists.body = bodyFindings(active);
  if (want('wikilinks')) lists.wikilinks = wikilinkFindings(active, index);
  if (want('density')) lists.density = await densityFindings(active, index, linkCountOf);
  if (want('currency')) lists.currency = currencyFindings(active, index, now());
  if (want('duplicates')) lists.duplicates = duplicateFindings(all, active);
  if (want('queue')) lists.queue = await queueFindings(active, notesOf);

  const selected = CATEGORIES.filter(want);
  const total = selected.reduce((sum, name) => sum + lists[name].length, 0);

  if (opts.quiet) {
    for (const name of selected)
      for (const f of lists[name]) out(`${name}\t${f.path}\t${f.detail}`);
    return total > 0 ? 1 : 0;
  }
  out(
    `lint — ${active.length} active notes (${all.length} total, ${all.length - active.length} archived/skipped)`
  );
  if (total === 0) out('clean — no findings.');
  else {
    for (const name of selected) {
      const list = lists[name];
      if (!list.length) continue;
      out(`\n${LABELS[name][0]} (${list.length})`);
      for (const f of list.slice(0, opts.max)) out(`  ${f.path}: ${f.detail}`);
      if (list.length > opts.max)
        out(`  (+${list.length - opts.max} more — --quiet for the full list)`);
    }
    const tally = selected.map(name => `${LABELS[name][1]}:${lists[name].length}`).join(' ');
    out(`\n${total} findings — ${tally}`);
  }
  if (capped)
    out(
      `note: density raw-fetch hit the ${cap} cap; some density flags are body-link-only (may over-flag related:-heavy notes).`
    );
  return total > 0 ? 1 : 0;
};
