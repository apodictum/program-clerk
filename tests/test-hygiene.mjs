// The hygiene lint: each category on a note that trips it and one that does not, the reports, the
// paging, the refusals, and the script as a process; and the queue's completion-marker rule.

import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'tape-six';
import {
  USAGE,
  completionMarker,
  markerFindings,
  run
} from '../plugins/program-clerk/scripts/lib/hygiene.mjs';
import {fakeServer, removeAll, scratch} from './helpers.mjs';

const SESSION = '0123abcd-4567-89ef-0123-456789abcdef';
const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-17T12:00:00Z');
const daysAgo = days => new Date(NOW.getTime() - days * DAY_MS).toISOString().slice(0, 10);

const note = (path, fields = {}) => ({
  record_id: `r-${path}`,
  file_path: path,
  title: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
  type: 'permanent',
  status: 'active',
  created: daysAgo(20),
  updated: daysAgo(10),
  body: 'Text.',
  ...fields
});

// Pages of at most `pageMax` notes, whatever the limit asked, with the total the server sends.
const sectionsRoute =
  (notes, pageMax = Infinity) =>
  ({url}) => {
    const offset = Number(url.searchParams.get('offset'));
    const limit = Math.min(Number(url.searchParams.get('limit')), pageMax);
    return {body: {items: notes.slice(offset, offset + limit), offset, limit, total: notes.length}};
  };

const setUp = async (notes, routes = {}, pageMax = Infinity) => {
  const dir = scratch();
  const server = await fakeServer({'GET /sections': sectionsRoute(notes, pageMax), ...routes});
  const env = {
    PROGRAM_CLERK_URL: server.base,
    PROGRAM_CLERK_KEY: 'test-key',
    CLAUDE_CODE_SESSION_ID: SESSION,
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_STATE_HOME: join(dir, 'state')
  };
  const lines = [];
  const lint = (argv, extra = {}) =>
    run(argv, {env: {...env, ...extra}, out: line => lines.push(line), now: () => NOW});
  const done = async () => {
    await server.close();
    removeAll(dir);
  };
  return {dir, env, server, lint, lines, done};
};

/** One category's quiet lines and the exit code. */
const quiet = async (notes, category, {routes = {}, args = []} = {}) => {
  const {server, lint, lines, done} = await setUp(notes, routes);
  try {
    const code = await lint(['--quiet', `--category=${category}`, ...args]);
    return {code, lines, requests: server.requests};
  } finally {
    await done();
  }
};

test('frontmatter: the five keys, dates that parse, created before updated', async t => {
  const {code, lines} = await quiet(
    [
      note('topics/good.md'),
      note('topics/bad.md', {status: null, created: daysAgo(1), updated: daysAgo(5)}),
      note('topics/odd.md', {created: 'someday'}),
      note('projects/p/queue/_about.md', {type: null}),
      note('projects/p/state.md', {type: 'state', title: null}),
      note('topics/archive/old.md', {title: null})
    ],
    'frontmatter'
  );
  t.equal(code, 1);
  t.deepEqual(lines, [
    `frontmatter\ttopics/bad.md\tmissing status; created > updated (${daysAgo(1)} > ${daysAgo(5)})`,
    "frontmatter\ttopics/odd.md\tunparseable created 'someday'"
  ]);
});

test('body: an empty or `null` body, and a long line with glued block boundaries', async t => {
  const collapsed = 'word '.repeat(80) + 'end.The next part## Heading here';
  const {code, lines} = await quiet(
    [
      note('topics/empty.md', {body: '  \n '}),
      note('topics/null.md', {body: 'null'}),
      note('topics/collapsed.md', {body: `Intro.\n${collapsed}`}),
      note('topics/long.md', {body: 'word '.repeat(100).trim()}),
      note('topics/code.md', {body: 'word '.repeat(80) + '`a.Bc d## e` and `f.Gh`'}),
      note('topics/fine.md'),
      note('projects/p/decisions.md', {type: 'project', body: ''}),
      note('projects/p/state.md', {type: 'state', body: ''}),
      note('projects/p/notes.md', {type: 'project', body: null})
    ],
    'body'
  );
  t.equal(code, 1);
  t.deepEqual(lines, [
    'body\ttopics/empty.md\tempty body (no content written)',
    'body\ttopics/null.md\tempty body (no content written)',
    `body\ttopics/collapsed.md\tcollapsed line: ${collapsed.length} chars, 2 glued block boundaries (newlines lost on save)`,
    'body\tprojects/p/notes.md\tempty body (no content written)'
  ]);
});

test('wikilinks: by path or base name, to archived notes and data files; code is no link', async t => {
  const notes = [
    note('topics/a.md', {
      body: 'See [[b]], [[topics/c]], [[old]], [[b#Part|alias]], [[pic.png]], `[[nope]]`,\n```\n[[none]]\n```\nand [[projects/p/data/logs]], [[projects/p/data/logs/one.json]].'
    }),
    note('topics/b.md', {body: 'See [[missing]], [[topics/nope]], and [[missing]] again.'}),
    note('topics/c.md'),
    note('topics/archive/old.md', {body: '[[gone]]'})
  ];
  const data = {body: {count: 1, items: [{path: 'projects/p/data/logs/one.json'}]}};
  const {code, lines} = await quiet(notes, 'wikilinks', {routes: {'GET /data': data}});
  t.equal(code, 1);
  t.deepEqual(lines, ['wikilinks\ttopics/b.md\t[[missing]], [[topics/nope]]']);

  const without = await quiet(notes, 'wikilinks');
  t.deepEqual(
    without.lines,
    [
      'wikilinks\ttopics/a.md\t[[projects/p/data/logs]], [[projects/p/data/logs/one.json]]',
      'wikilinks\ttopics/b.md\t[[missing]], [[topics/nope]]'
    ],
    'no data list: no link resolves to a data file'
  );
});

test('density: a topic needs two links, `related:` counted from its text; a project note one link', async t => {
  const notes = [
    note('topics/rich.md', {body: '[[a]] and [[b]]'}),
    note('topics/related.md', {body: 'See [[a]].'}),
    note('topics/thin.md', {body: 'Alone.'}),
    note('topics/done.md', {status: 'done', body: 'Done.'}),
    note('projects/p/alone.md', {type: 'project'}),
    note('projects/p/hub.md', {type: 'project', body: 'See [[linked]].'}),
    note('projects/p/linked.md', {type: 'project'})
  ];
  const routes = {
    'GET /vault/topics/related.md': {body: '---\nrelated:\n  - "[[b]]"\n---\nSee [[a]].\n'},
    'GET /vault/topics/thin.md': {body: '---\ntitle: Thin\n---\nAlone.\n'}
  };
  const fetched = await quiet(notes, 'density', {routes});
  t.equal(fetched.code, 1);
  t.deepEqual(fetched.lines, [
    'density\ttopics/thin.md\ttopic: 0 outbound wikilinks (< 2)',
    'density\tprojects/p/alone.md\tproject: isolated (0 outbound, 0 inbound)'
  ]);
  t.deepEqual(
    fetched.requests.filter(r => r.path.startsWith('/vault/')).map(r => r.path),
    ['/vault/topics/related.md', '/vault/topics/thin.md', '/vault/projects/p/alone.md'],
    'a sparse note alone is read whole'
  );

  const bodies = await quiet(notes, 'density', {routes, args: ['--no-fetch']});
  t.deepEqual(bodies.lines, [
    'density\ttopics/related.md\ttopic: 1 outbound wikilink (< 2)',
    'density\ttopics/thin.md\ttopic: 0 outbound wikilinks (< 2)',
    'density\tprojects/p/alone.md\tproject: isolated (0 outbound, 0 inbound)'
  ]);
  t.notOk(bodies.requests.some(r => r.path.startsWith('/vault/')));
});

test('currency: each type past its retention, a query kept while a note links to it', async t => {
  const {code, lines} = await quiet(
    [
      note('logs/old.md', {type: 'log', updated: daysAgo(100)}),
      note('logs/new.md', {type: 'log', updated: daysAgo(90)}),
      note('queries/cited.md', {type: 'query', updated: daysAgo(200)}),
      note('queries/lone.md', {type: 'query', updated: daysAgo(200)}),
      note('inbox/idea.md', {type: 'fleeting', updated: daysAgo(31)}),
      note('projects/p/plan.md', {type: 'project', updated: daysAgo(181)}),
      note('topics/stale.md', {updated: daysAgo(366)}),
      note('topics/t.md', {body: 'See [[cited]].'}),
      note('projects/p/design/x.md', {type: 'design', updated: daysAgo(1000)}),
      note('topics/archive/ancient.md', {type: 'log', updated: daysAgo(999)})
    ],
    'currency'
  );
  t.equal(code, 1);
  t.deepEqual(lines, [
    `currency\tlogs/old.md\tlog: updated ${daysAgo(100)} (100d > 90d) — removed by /sweep (expire-logs)`,
    `currency\tqueries/lone.md\tquery: updated ${daysAgo(200)} (200d > 90d) — archive (0 inbound)`,
    `currency\tinbox/idea.md\tfleeting: updated ${daysAgo(31)} (31d > 30d) — ingest or retire`,
    `currency\tprojects/p/plan.md\tproject: updated ${daysAgo(181)} (181d > 180d) — verify still current`,
    `currency\ttopics/stale.md\tpermanent: updated ${daysAgo(366)} (366d > 365d) — verify still current`
  ]);
});

test('duplicates: project folders named alike, and titles alike in one folder', async t => {
  const {code, lines} = await quiet(
    [
      note('projects/demo-app/a.md', {type: 'project'}),
      note('projects/demoapp/b.md', {type: 'project'}),
      note('projects/alpha-one/c.md', {type: 'project'}),
      note('projects/alpha-two/d.md', {type: 'project'}),
      note('topics/r1.md', {title: 'Retry budgets'}),
      note('topics/r2.md', {title: 'Retry budget'}),
      note('topics/k.md', {title: 'Cache keys'}),
      note('topics/d1.md', {title: 'Report 2026-11-01'}),
      note('topics/d2.md', {title: 'Report 2026-11-02'}),
      note('topics/l1.md', {type: 'log', title: 'Session'}),
      note('topics/l2.md', {type: 'log', title: 'Session'})
    ],
    'duplicates'
  );
  t.equal(code, 1);
  t.deepEqual(lines, [
    'duplicates\tprojects/{demo-app,demoapp}\tnear-identical folder names (lev 0 ignoring case/separators)',
    'duplicates\ttopics\tnear-duplicate titles: "Retry budgets" ~ "Retry budget"'
  ]);
});

test('queue: an unknown section or type, a finished title, and a real queue.md', async t => {
  const items = [
    {path: 'projects/p/queue/_about.md', frontmatter: {type: 'meta'}},
    {
      path: 'projects/p/queue/good.md',
      frontmatter: {title: 'Add retries', section: 'backlog', type: 'queue-item'}
    },
    {
      path: 'projects/p/queue/lost.md',
      frontmatter: {title: 'Lost', section: 'later', type: 'queue-item'}
    },
    {
      path: 'projects/p/queue/odd.md',
      frontmatter: {title: 'Odd', section: 'inbox', type: 'project'}
    },
    {
      path: 'projects/p/queue/done.md',
      frontmatter: {title: 'Release SHIPPED.', section: 'active', type: 'queue-item'}
    },
    {path: 'projects/p/queue/bare.md', frontmatter: {}}
  ];
  // Two items a page, so the paging moves by what came.
  const query = ({json}) => ({
    body: {
      folder: json.folder,
      items: items.slice(json.offset, json.offset + 2),
      total: items.length,
      offset: json.offset,
      limit: json.limit
    }
  });
  const {code, lines, requests} = await quiet(
    [
      note('projects/p/queue/_about.md', {type: 'meta'}),
      note('projects/q/queue.md', {type: 'project'}),
      note('projects/r/notes.md', {type: 'project'})
    ],
    'queue',
    {routes: {'POST /notes/query': query}}
  );
  t.equal(code, 1);
  t.deepEqual(lines, [
    'queue\tprojects/p/queue/lost.md\tsection "later" is none of inbox, active, backlog, watching',
    'queue\tprojects/p/queue/odd.md\ttype "project" is not queue-item',
    'queue\tprojects/p/queue/done.md\t"Release SHIPPED.": completion marker \'SHIPPED\' on an open item; archive it',
    'queue\tprojects/p/queue/bare.md\tsection "" is none of inbox, active, backlog, watching',
    'queue\tprojects/p/queue/bare.md\ttype "" is not queue-item',
    'queue\tprojects/q/queue.md\ta real queue.md: the queue commands and the session brief do not read it'
  ]);
  t.deepEqual(
    requests.filter(r => r.path === '/notes/query').map(r => r.json),
    [0, 2, 4].map(offset => ({folder: 'projects/p/queue', limit: 500, offset}))
  );
});

test('the full report: a header, each category capped by --max, the tally; clean says so', async t => {
  const notes = [
    note('topics/a.md', {status: null}),
    note('topics/b.md', {title: ''}),
    note('topics/c.md', {body: '[[nowhere]]'}),
    note('topics/archive/d.md', {status: null})
  ];
  const {lint, lines, done} = await setUp(notes);
  try {
    t.equal(await lint(['--category=frontmatter,wikilinks,body', '--max=1']), 1);
    t.deepEqual(lines, [
      'lint — 3 active notes (4 total, 1 archived/skipped)',
      '\nFRONTMATTER (2)',
      '  topics/a.md: missing status',
      '  (+1 more — --quiet for the full list)',
      '\nWIKILINKS (1)',
      '  topics/c.md: [[nowhere]]',
      '\n3 findings — fm:2 body:0 links:1'
    ]);

    lines.length = 0;
    t.equal(await lint(['--category=body']), 0);
    t.deepEqual(lines, [
      'lint — 3 active notes (4 total, 1 archived/skipped)',
      'clean — no findings.'
    ]);

    lines.length = 0;
    t.equal(await lint(['--category=density', '--no-fetch']), 1);
    t.deepEqual(lines.slice(-2), [
      '\n3 findings — density:3',
      'note: density raw-fetch hit the 0 cap; some density flags are body-link-only (may over-flag related:-heavy notes).'
    ]);
  } finally {
    await done();
  }
});

test('every page of /sections is read, the offset moving by the notes that came', async t => {
  const notes = Array.from({length: 250}, (_, i) => note(`topics/n${i}.md`));
  notes[0].body = 'See [[n249]].';
  const {server, lint, lines, done} = await setUp(notes, {}, 60);
  try {
    t.equal(await lint(['--quiet', '--category=wikilinks']), 0);
    t.deepEqual(lines, []);
    const pages = server.requests.filter(r => r.path === '/sections');
    t.deepEqual(
      pages.map(r => r.url),
      [0, 60, 120, 180, 240].map(offset => `/sections?limit=100&offset=${offset}`)
    );
    t.ok(pages.every(r => r.auth === 'Bearer test-key'));
  } finally {
    await done();
  }
});

test('usage errors are TypeErrors, sent before any call; no key and a failed call refuse', async t => {
  const {server, lint, lines, done} = await setUp([note('topics/a.md')]);
  try {
    for (const argv of [
      ['--bogus'],
      ['--category=nope'],
      ['--category=body,nope'],
      ['--category'],
      ['--max=x'],
      ['--max'],
      ['--quiet=1'],
      ['list']
    ]) {
      await t.rejects(lint(argv), TypeError, argv.join(' '));
    }
    const e = await t.rejects(lint([], {PROGRAM_CLERK_KEY: ''}));
    t.notOk(e instanceof TypeError);
    t.matchString(e.message, /^no key/);
    t.equal(server.requests.length, 0);
    t.equal(await lint(['--help']), 0);
    t.deepEqual(lines, [USAGE]);

    server.routes['GET /sections'] = {status: 500, body: {code: 'boom', error: 'it broke'}};
    const failed = await t.rejects(lint(['--quiet']));
    t.matchString(failed.message, /^failed to load \/sections\?limit=100&offset=0: 500 /);
  } finally {
    await done();
  }
});

const ENTRY = fileURLToPath(new URL('../plugins/program-clerk/scripts/lint.mjs', import.meta.url));

const runEntry = (args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });

test('the script runs as a process: exit 0, 1, and 2', async t => {
  const {env, server, done} = await setUp([
    note('topics/a.md', {body: '[[b]]'}),
    note('topics/b.md', {body: '[[c]]'})
  ]);
  const all = {...process.env, ...env};
  for (const name of Object.keys(all)) if (/^CLAUDE_PLUGIN_OPTION_/.test(name)) delete all[name];
  try {
    let r = await runEntry(['--quiet', '--category=wikilinks'], all);
    t.deepEqual(
      [r.code, r.stdout.split(/\r?\n/), r.stderr],
      [1, ['wikilinks\ttopics/b.md\t[[c]]', ''], '']
    );

    r = await runEntry(['--quiet', '--category=body'], all);
    t.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);

    r = await runEntry(['--nope'], all);
    t.equal(r.code, 2);
    t.matchString(r.stderr, /^unknown option: --nope\r?\nusage:/);

    r = await runEntry([], {...all, PROGRAM_CLERK_KEY: ''});
    t.equal(r.code, 2);
    t.matchString(r.stderr, /^no key/);

    server.routes['GET /sections'] = {status: 500, body: {code: 'boom'}};
    r = await runEntry([], all);
    t.deepEqual([r.code, r.stdout], [2, '']);
    t.matchString(r.stderr, /^failed to load \/sections/);
  } finally {
    await done();
  }
});

// The queue's completion-marker rule, on the titles it was calibrated on.

test('completion markers: shouted or dated in the title', t => {
  t.equal(completionMarker('Phase 8 — MERGE SHIPPED 2026-07-29: all executed.'), 'SHIPPED');
  t.equal(completionMarker('Goedecke read — filed and closed 2026-08-16.'), 'closed 2026-08-16');
  t.equal(completionMarker('Fix the flaky test.'), null);
  t.equal(completionMarker('Fixed the flaky test, again.'), null, 'a plain one needs a date');
  t.equal(completionMarker('Emit `DONE` events.'), null, 'code spans are stripped');
});

test('a plain marker before the word it modifies is an adjective, not a marker', t => {
  t.equal(
    completionMarker('Report stored frontmatter values outside a closed enum (2026-09-29).'),
    null
  );
  t.equal(completionMarker('Unlinked mentions of published posts — ruled 2026-09-15.'), null);
  t.equal(completionMarker('A fixed-width column for the pager (2026-09-27).'), null);
  t.equal(completionMarker('Filed 2026-09-29: closed enums go unreported.'), null);
  t.equal(completionMarker('Staging trees ingested — fixed on 2026-07-28.'), 'fixed on 2026-07-28');
  t.equal(completionMarker('v0.1.0 published to npm 2026-04-20.'), 'published to npm 2026-04-20');
  t.equal(completionMarker('1.2.2 release shipped (2026-05-07).'), 'shipped (2026-05-07');
  t.equal(completionMarker('Audit follow-ups (2026-08-10) — shipped'), '2026-08-10) — shipped');
  t.equal(completionMarker('Both 2026-06-20 gaps shipped.'), '2026-06-20 gaps shipped');
  t.equal(completionMarker('Staging fixed 2026-07-29.'), 'fixed 2026-07-29');
});

test('a plain marker before a signed or counted modifier is an adjective too', t => {
  t.equal(completionMarker('Local days: `tz_offset_hours` is a fixed −5 (filed 2026-10-31)'), null);
  t.equal(completionMarker('A fixed 30-second cap (filed 2026-10-31)'), null);
  t.equal(completionMarker('Release shipped 1.2.0 (2026-05-07).'), 'shipped 1.2.0 (2026-05-07');
});

test('markerFindings says which title, and says nothing of a clean one', t => {
  t.deepEqual(markerFindings(['Fix the flaky test.', 'Release SHIPPED.']), [
    '"Release SHIPPED.": completion marker \'SHIPPED\' on an open item; archive it'
  ]);
  t.deepEqual(markerFindings([]), []);
  t.deepEqual(markerFindings(['x'.repeat(80) + ' DONE']), [
    `"${'x'.repeat(69)}…": completion marker 'DONE' on an open item; archive it`
  ]);
});
