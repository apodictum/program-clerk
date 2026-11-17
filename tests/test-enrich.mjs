// The enrichment pass's paperwork: the calls, lease claims, and worksheet of `prepare` in each mode,
// `show`'s pages, `apply`'s writes, and `release`, against a server that keeps batch claims.

import {spawn} from 'node:child_process';
import {readFileSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'tape-six';
import {ApiError, USAGE, run} from '../plugins/program-clerk/scripts/lib/enrich.mjs';
import {sweepDir} from '../plugins/program-clerk/scripts/lib/sweep-files.mjs';
import {renderItem} from '../plugins/program-clerk/scripts/lib/worksheet-view.mjs';
import {fakeServer, removeAll, scratch} from './helpers.mjs';

const SESSION = '0123abcd-4567-89ef-0123-456789abcdef';

const note = (id, path, body, extra = {}) => ({
  record_id: id,
  file_path: path,
  type: 'note',
  title: id.toUpperCase(),
  body_hash: `hash-${id}`,
  body,
  ...extra
});

const ONE_BODY = '# One\n\n## Part\n\n### Deep\n\nSee [[projects/a/two]] and `[[not/a/link]]`.\n';
const NOTES = [
  note('r1', 'projects/a/one.md', ONE_BODY),
  note('r2', 'projects/a/two.md', 'Two, with [[projects/a/one|one]].\n', {type: 'plan'}),
  note('r3', 'projects/b/held.md', 'Held elsewhere.\n'),
  note('r4', 'projects/b/empty.md', ' \n'),
  note('r5', 'projects/c/view.md', 'A view.\n'),
  note('ra', 'projects/p/log/_about.md', 'About the log.\n', {type: 'meta'})
];

// The lint lists r1 at the path it had before a move.
const UNENRICHED = [
  {record_id: 'r1', file_path: 'projects/a/old-one.md', type: 'note'},
  {record_id: 'r2', file_path: 'projects/a/two.md', type: 'plan'},
  {record_id: 'r3', file_path: 'projects/b/held.md', type: 'note'},
  {record_id: 'r4', file_path: 'projects/b/empty.md', type: 'note'}
];

const FOLDER = {
  record_id: 'ra',
  file_path: 'projects/p/log/_about.md',
  folder: 'projects/p/log.md',
  hash: 'folder-hash',
  pieces: 2,
  summary: false,
  stale: false
};

const LOG_BODY = '# Log\n\n' + 'Entry one, at some length.\n'.repeat(4);

// _about.md and a nested piece are not the folder's own entries.
const PIECES = [
  {file_path: 'projects/p/log/_about.md', title: 'About', updated: '2026-11-02', body: 'About.'},
  {file_path: 'projects/p/log/b.md', title: 'B', updated: '2026-11-02', body: 'Entry b.'},
  {file_path: 'projects/p/log/old/c.md', title: 'C', updated: '2026-11-03', body: 'Nested.'}
];

const routesOf = w => {
  const routes = {
    'GET /system/lint': () => ({
      body: {
        coverage: {
          enrichment: {
            total: 10,
            enriched: 4,
            unenriched: 6,
            unenriched_records: w.unenriched,
            folders: [w.folder]
          }
        }
      }
    }),
    'GET /tags': ({url}) => ({
      body: {items: url.searchParams.get('offset') === '0' ? [{tag: 'alpha'}, {tag: 'beta'}] : []}
    }),
    'GET /suggestions': ({url}) => {
      const offset = Number(url.searchParams.get('offset'));
      return {body: {items: w.stale.slice(offset, offset + 100), total: w.stale.length}};
    },
    // Two rows a page, so a folder's pieces take more than one.
    'GET /sections': ({url}) => {
      const p = url.searchParams;
      if (p.has('file_path')) {
        const found = [...w.notes.values()].filter(n => n.file_path === p.get('file_path'));
        const items = found.map(({record_id, file_path}) => ({record_id, file_path}));
        return {body: {items, total: items.length}};
      }
      const all = PIECES.filter(
        x => x.file_path.startsWith(p.get('file_prefix')) && x.updated >= p.get('updated_since')
      );
      const offset = Number(p.get('offset'));
      return {body: {items: all.slice(offset, offset + 2), total: all.length}};
    },
    'GET /vault/projects/p/log.md': {
      body: '---\ntype: log\n---\n' + LOG_BODY,
      headers: {'x-program-clerk-composed': 'true', etag: 'W/"log"'}
    },
    // A batch claim takes every note no other lease covers, under one token.
    'POST /leases/claim': ({json}) => {
      w.claims.push(json);
      const claimed = json.resources.filter(r => !w.held.has(r));
      const held = json.resources
        .filter(r => w.held.has(r))
        .map(resource => ({resource, holder: 'someone-else'}));
      return {
        body: {
          claim_token: claimed.length ? 'token-1' : null,
          expires_at: '2026-11-17T12:30:00.000Z',
          claimed,
          held
        }
      };
    },
    'POST /leases/release': ({json}) => {
      w.releases.push(json);
      if (json.claim_token === 'token-x') {
        return {status: 409, body: {code: 'not_holder', error: 'held by another'}};
      }
      if (json.claim_token !== 'token-1' || w.released) {
        return {status: 404, body: {code: 'lease_not_found', error: 'no such claim'}};
      }
      w.released = true;
      return {body: {released: 1}};
    }
  };
  for (const id of w.notes.keys()) {
    routes[`GET /sections/${id}`] = () => ({body: w.notes.get(id)});
    routes[`GET /sections/${id}/fm`] = () => ({body: {frontmatter: w.fm.get(id) ?? {}}});
    routes[`GET /sections/${id}/similar`] = () => ({body: {items: w.similar.get(id) ?? []}});
    routes[`GET /sections/${id}/enrichment-delta`] = () =>
      w.deltas.has(id) ? {body: w.deltas.get(id)} : {status: 404, body: {code: 'no_baseline'}};
  }
  return routes;
};

/** A world of NOTES, with `more` notes listed as unenriched after the lint's own four. */
const setUp = async (more = []) => {
  const dir = scratch();
  const w = {
    notes: new Map([...NOTES, ...more].map(n => [n.record_id, n])),
    unenriched: [
      ...UNENRICHED,
      ...more.map(({record_id, file_path, type}) => ({record_id, file_path, type}))
    ],
    fm: new Map(),
    similar: new Map(),
    deltas: new Map(),
    stale: [],
    folder: {...FOLDER},
    held: new Set(['note:projects/b/held.md']),
    claims: [],
    releases: [],
    released: false
  };
  const server = await fakeServer(routesOf(w));
  const env = {
    PROGRAM_CLERK_URL: server.base,
    PROGRAM_CLERK_KEY: 'test-key',
    CLAUDE_CODE_SESSION_ID: SESSION,
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_STATE_HOME: join(dir, 'state')
  };
  const lines = [];
  const enrich = (argv, extra = {}) =>
    run(argv, {env: {...env, ...extra}, out: line => lines.push(line)});
  // The pool sends calls in no fixed order, so they compare sorted.
  const calls = (from = 0) =>
    server.requests
      .slice(from)
      .map(r => `${r.method} ${r.url}`)
      .sort();
  const file = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };
  const done = async () => {
    await server.close();
    removeAll(dir);
  };
  return {dir, w, env, server, enrich, lines, calls, file, done};
};

const json = path => JSON.parse(readFileSync(path, 'utf8'));

test('prepare backfill: the lint worklist, leased as one batch, in the session folder', async t => {
  const {w, env, enrich, lines, calls, file, done} = await setUp();
  w.fm.set('r1', {tags: ['alpha'], related: ['[[projects/c/known]]']});
  w.similar.set('r1', [
    {file_path: 'projects/c/known.md', title: 'Known', distance: 0.1},
    {file_path: 'projects/a/two.md', title: 'Two', distance: 0.1},
    {file_path: 'projects/c/near.md', title: 'Near', distance: 0.2},
    {file_path: 'projects/c/far.md', title: 'Far', distance: 0.5}
  ]);
  try {
    t.equal(await enrich(['prepare', '--holder=h1']), 0);
    const path = join(sweepDir(env), 'enrich-h1.json');
    t.deepEqual(lines, [
      `worksheet: ${path} — 3 item(s) (missing), 6 unenriched total, 1 need a body, 1 not claimed; claimed as h1`
    ]);
    if (process.platform !== 'win32') {
      t.equal(statSync(sweepDir(env)).mode & 0o777, 0o700, 'only its owner reads the folder');
    }
    t.deepEqual(
      calls(),
      [
        'GET /system/lint',
        'GET /sections/r1',
        'GET /sections/r2',
        'GET /sections/r3',
        'GET /sections/r4',
        'GET /sections/ra',
        'POST /leases/claim',
        'GET /tags?limit=100&offset=0',
        'GET /tags?limit=100&offset=2',
        'GET /sections/r1/fm?exclude=body',
        'GET /sections/r2/fm?exclude=body',
        'GET /sections/r4/fm?exclude=body',
        'GET /sections/ra/fm?exclude=body',
        'GET /sections/r1/similar?k=15',
        'GET /sections/r2/similar?k=15',
        'GET /vault/projects/p/log.md'
      ].sort(),
      'no context for the held note, no similar notes for the empty one or the folder'
    );
    t.equal(w.claims.length, 1);
    t.equal(w.claims[0].holder, 'h1');
    t.equal(w.claims[0].ttl_seconds, 1800);
    t.deepEqual(
      [...w.claims[0].resources].sort(),
      [
        'note:projects/a/one.md',
        'note:projects/a/two.md',
        'note:projects/b/empty.md',
        'note:projects/b/held.md',
        'note:projects/p/log/_about.md'
      ],
      'each note at its current path'
    );

    const ws = json(path);
    t.match(ws, {
      mode: 'missing',
      coverage: {total: 10, enriched: 4, unenriched: 6, worklist_truncated: true},
      claim: {holder: 'h1', claim_token: 'token-1', expires_at: '2026-11-17T12:30:00.000Z'},
      held: [{resource: 'projects/b/held.md', holder: 'someone-else'}],
      unclaimed: ['projects/b/held.md'],
      taxonomy: ['alpha', 'beta'],
      needs_a_body: ['projects/b/empty.md']
    });
    t.notOk('reads' in ws);
    t.deepEqual(Object.keys(ws.enrichments_template), [
      'projects/a/one.md',
      'projects/a/two.md',
      'projects/p/log/_about.md'
    ]);
    t.deepEqual(ws.items[0], {
      record_id: 'r1',
      file_path: 'projects/a/one.md',
      path_moved: {from: 'projects/a/old-one.md', to: 'projects/a/one.md'},
      type: 'note',
      title: 'R1',
      body_hash: 'hash-r1',
      existing_tags: ['alpha'],
      existing_related: ['[[projects/c/known]]'],
      body_wikilinks: ['[[projects/a/two]]'],
      related_candidates: [{file_path: 'projects/c/near.md', title: 'Near', distance: 0.2}],
      read: 'full',
      body: ONE_BODY
    });
    t.deepEqual(ws.items[1].body_wikilinks, ['[[projects/a/one]]'], 'an alias is dropped');
    t.deepEqual(ws.items[2], {
      record_id: 'ra',
      file_path: 'projects/p/log/_about.md',
      folder: 'projects/p/log.md',
      folder_hash: 'folder-hash',
      pieces: 2,
      type: 'meta',
      title: 'RA',
      body_hash: 'hash-ra',
      existing_tags: [],
      existing_related: [],
      body_wikilinks: [],
      related_candidates: [],
      read: 'full',
      body: LOG_BODY
    });

    const limited = file('limited.json', '');
    lines.length = 0;
    t.equal(await enrich(['prepare', '--limit=2', '--holder=h2', `--out=${limited}`]), 0);
    t.deepEqual(lines, [
      `worksheet: ${limited} — 2 item(s) (missing), 6 unenriched total; claimed as h2`
    ]);
    t.deepEqual(
      json(limited).items.map(item => item.file_path),
      ['projects/a/one.md', 'projects/a/two.md']
    );

    lines.length = 0;
    t.equal(await enrich(['prepare', '--type=meta', '--holder=h3', `--out=${limited}`]), 0);
    t.deepEqual(
      json(limited).items.map(item => item.file_path),
      ['projects/p/log/_about.md'],
      'a folder is a meta note'
    );
  } finally {
    await done();
  }
});

test('prepare backfill with --records: only the paths, ids, and folders listed', async t => {
  const {w, enrich, lines, calls, file, done} = await setUp();
  const records = file(
    'records.txt',
    'projects/a/two.md\r\nr4\r\n\r\nprojects/p/log.md\r\nprojects/z/unlisted.md'
  );
  const out = file('ws.json', '');
  try {
    t.equal(await enrich(['prepare', `--records=${records}`, '--holder=h1', `--out=${out}`]), 0);
    t.deepEqual(lines, [
      `worksheet: ${out} — 2 item(s) (missing), 6 unenriched total, 1 need a body; claimed as h1`
    ]);
    t.deepEqual(
      calls().filter(c => /^GET \/sections\/\w+$/.test(c)),
      ['GET /sections/r2', 'GET /sections/r4', 'GET /sections/ra']
    );
    t.deepEqual([...w.claims[0].resources].sort(), [
      'note:projects/a/two.md',
      'note:projects/b/empty.md',
      'note:projects/p/log/_about.md'
    ]);
    const ws = json(out);
    t.deepEqual(
      ws.items.map(item => item.file_path),
      ['projects/a/two.md', 'projects/p/log/_about.md']
    );
    t.deepEqual(ws.needs_a_body, ['projects/b/empty.md']);
  } finally {
    await done();
  }
});

test('prepare --records with no --limit takes the whole list, at most 200', async t => {
  const many = Array.from({length: 50}, (_, i) =>
    note(`m${i}`, `projects/m/n${String(i).padStart(2, '0')}.md`, `Note ${i}.\n`)
  );
  const {w, server, enrich, file, done} = await setUp(many);
  const records = file('chunk.txt', many.map(n => n.file_path).join('\n') + '\n');
  const out = file('ws.json', '');
  try {
    t.equal(await enrich(['prepare', `--records=${records}`, '--holder=h1', `--out=${out}`]), 0);
    t.equal(json(out).items.length, 50, 'a shard of 50 is not cut to the default 30');
    t.equal(w.claims[0].resources.length, 50);

    t.equal(
      await enrich([
        'prepare',
        `--records=${records}`,
        '--limit=20',
        '--holder=h2',
        `--out=${out}`
      ]),
      0
    );
    t.equal(json(out).items.length, 20, 'an explicit --limit still narrows it');

    const from = server.requests.length;
    const big = file('big.txt', Array.from({length: 201}, (_, i) => `id${i}`).join('\n'));
    const e = await t.rejects(enrich(['prepare', `--records=${big}`]), TypeError);
    t.equal(e.message, '--limit must be 1..200');
    t.equal(server.requests.length, from, 'refused before any call');
    t.equal(
      await enrich(['prepare', `--records=${big}`, '--limit=5', '--holder=h3', `--out=${out}`]),
      0,
      'a long list under an explicit --limit is fine'
    );
  } finally {
    await done();
  }
});

test('prepare --stale: deltas within the threshold, the rest whole, a folder by its pieces', async t => {
  const {w, enrich, lines, calls, file, done} = await setUp();
  w.stale = [
    {
      id: 's1',
      payload: {record_id: 'r1', file_path: 'projects/a/one.md', reason: 'possibly_stale'}
    },
    {id: 's2', payload: {record_id: 'r2', file_path: 'projects/a/two.md'}}
  ];
  Object.assign(w.folder, {summary: true, stale: true});
  const oneAgent = {summary: 'One, summarized.', related_proposed: ['[[projects/c/near]]']};
  w.fm.set('r1', {agent: oneAgent});
  w.fm.set('r2', {agent: {summary: 'Two, summarized.'}});
  w.fm.set('ra', {agent: {summary: 'The log.', derived_at: '2026-11-01T10:00:00Z'}});
  const delta = {
    body_bytes: 900,
    chunks: {total: 5, added: 1, removed: 0},
    added_bytes: 180,
    removed_bytes: 0,
    changed_fraction: 0.2,
    added_chunks: [{index: 4, text: 'The newest entry.'}]
  };
  w.deltas.set('r1', {baseline: 'b1', ...delta});
  w.deltas.set('r2', {baseline: 'b2', ...delta, changed_fraction: 0.6});
  const out = file('ws.json', '');
  try {
    t.equal(await enrich(['prepare', '--stale', '--holder=h1', `--out=${out}`]), 0);
    t.deepEqual(lines, [
      `worksheet: ${out} — 3 item(s) (stale, 2 read as a delta), 6 unenriched total; claimed as h1`
    ]);
    const seen = calls();
    for (const call of [
      'GET /suggestions?kind=agent_enrichment_stale&status=pending&limit=100&offset=0',
      'GET /suggestions?kind=agent_enrichment_stale&status=pending&limit=100&offset=2',
      'GET /sections/r1/enrichment-delta',
      'GET /sections/r2/enrichment-delta',
      'GET /sections/r2/similar?k=15',
      'GET /sections?file_prefix=projects%2Fp%2Flog%2F&updated_since=2026-11-01&sort=file_path_asc&limit=100&offset=0',
      'GET /sections?file_prefix=projects%2Fp%2Flog%2F&updated_since=2026-11-01&sort=file_path_asc&limit=100&offset=2'
    ]) {
      t.ok(seen.includes(call), call);
    }
    t.notOk(seen.includes('GET /sections/r1/similar?k=15'), 'a delta needs no similar notes');

    const ws = json(out);
    t.equal(ws.mode, 'stale');
    t.deepEqual(ws.reads, {delta: 2, full: 1, full_threshold: 0.4});
    t.deepEqual(
      w.claims.map(c => [c.holder, [...c.resources].sort(), c.ttl_seconds]),
      [
        [
          'h1',
          ['note:projects/a/one.md', 'note:projects/a/two.md', 'note:projects/p/log/_about.md'],
          1800
        ]
      ]
    );
    t.equal(ws.claim.claim_token, 'token-1');
    const [one, two, log] = ws.items;
    t.match(one, {
      file_path: 'projects/a/one.md',
      current_agent: oneAgent,
      suggestion_id: 's1',
      reason: 'possibly_stale',
      read: 'delta',
      delta
    });
    t.notOk('body' in one);
    t.match(two, {suggestion_id: 's2', read: 'full', body: NOTES[1].body});
    t.notOk('reason' in two);
    t.match(log, {
      file_path: 'projects/p/log/_about.md',
      current_agent: {summary: 'The log.'},
      read: 'folder-delta',
      changed_pieces: [
        {file_path: 'projects/p/log/b.md', title: 'B', updated: '2026-11-02', body: 'Entry b.'}
      ]
    });
    t.equal(log.changed_pieces.length, 1, 'neither _about.md nor a nested piece');
  } finally {
    await done();
  }
});

test('prepare --refresh --outline: the listed notes as given, each by its headings', async t => {
  const {w, server, enrich, lines, calls, file, done} = await setUp();
  w.fm.set('r1', {agent: {summary: 'One, summarized at length.'}});
  const out = file('ws.json', '');
  try {
    const records = file('list.txt', 'projects/a/one.md\nr2\nprojects/p/log.md\n');
    t.equal(
      await enrich([
        'prepare',
        '--refresh',
        '--outline',
        `--records=${records}`,
        '--holder=h1',
        `--out=${out}`
      ]),
      0
    );
    t.deepEqual(lines, [
      `worksheet: ${out} — 3 item(s) (refresh), 6 unenriched total; claimed as h1`
    ]);
    t.ok(
      calls().includes('GET /sections?file_path=projects%2Fa%2Fone.md&fields=record_id,file_path'),
      'a path is looked up; an id and a folder are not'
    );
    t.equal(calls().filter(c => c.startsWith('GET /sections?')).length, 1);
    const ws = json(out);
    t.equal(ws.mode, 'refresh');
    t.deepEqual(
      w.claims.map(c => [c.holder, [...c.resources].sort()]),
      [
        [
          'h1',
          ['note:projects/a/one.md', 'note:projects/a/two.md', 'note:projects/p/log/_about.md']
        ]
      ]
    );
    t.deepEqual(
      ws.items.map(item => [item.file_path, item.read, item.outline]),
      [
        [
          'projects/a/one.md',
          'outline',
          {body_bytes: Buffer.byteLength(ONE_BODY), headings: ['# One', '## Part']}
        ],
        [
          'projects/a/two.md',
          'outline',
          {body_bytes: Buffer.byteLength(NOTES[1].body), headings: []}
        ],
        ['projects/p/log/_about.md', 'outline', {body_bytes: LOG_BODY.length, headings: ['# Log']}]
      ]
    );
    t.deepEqual(ws.items[0].current_agent, {summary: 'One, summarized at length.'});
    t.equal(ws.items[1].current_agent, null);

    const from = server.requests.length;
    const gone = file('gone.txt', 'projects/z/gone.md\n');
    const e = await t.rejects(enrich(['prepare', '--refresh', `--records=${gone}`]));
    t.equal(e.message, 'no note at: projects/z/gone.md');
    t.notOk(e instanceof TypeError);
    t.notOk(calls(from).includes('POST /leases/claim'), 'nothing claimed');
  } finally {
    await done();
  }
});

test('show: an index, then an item a page at a time, with no key and no call', async t => {
  const {server, enrich, lines, file, done} = await setUp();
  const long = {file_path: 'a.md', read: 'full', body: 'line of text\n'.repeat(2500)};
  const ws = file('ws.json', {items: [long, {file_path: 'b.md', read: 'full', body: 'short'}]});
  const noKey = {PROGRAM_CLERK_KEY: '', PROGRAM_CLERK_URL: ''};
  try {
    t.equal(await enrich(['show', `--worksheet=${ws}`], noKey), 0);
    t.deepEqual(lines, [
      '1. a.md · read: full · 32500 characters of body\n2. b.md · read: full · 5 characters of body',
      `--- 2 items; read each with show --worksheet=${ws} --item=N ---`
    ]);

    lines.length = 0;
    t.equal(await enrich(['show', `--worksheet=${ws}`, '--item=1'], noKey), 0);
    t.equal(lines.length, 2);
    const whole = renderItem(long, 1, 2);
    const next = whole.lastIndexOf('\n', 24000 - 1) + 1;
    t.equal(lines[0], whole.slice(0, next));
    t.equal(
      lines[1],
      `--- continued: show --worksheet=${ws} --item=1 --from=${next} (${next} of ${whole.length} characters shown) ---`
    );

    lines.length = 0;
    t.equal(await enrich(['show', `--worksheet=${ws}`, '--item=1', `--from=${next}`], noKey), 0);
    t.deepEqual(lines, [whole.slice(next)], 'the last page names no next');

    await t.rejects(enrich(['show', `--worksheet=${ws}`, '--item=3']), TypeError);
    await t.rejects(enrich(['show', `--worksheet=${ws}`, '--item=1', '--from=-1']), TypeError);
    t.equal(server.requests.length, 0);
  } finally {
    await done();
  }
});

const WORKSHEET = {
  mode: 'stale',
  claim: {holder: 'h1', claim_token: 'token-1', expires_at: '2026-11-17T12:30:00.000Z'},
  items: [
    // The worksheet still has r1 at the path it left.
    {
      record_id: 'r1',
      file_path: 'projects/a/old-one.md',
      body_hash: 'hash-r1',
      body_wikilinks: ['[[projects/a/two]]']
    },
    {
      record_id: 'r2',
      file_path: 'projects/a/two.md',
      body_hash: 'hash-r2',
      body_wikilinks: [],
      current_agent: {summary: 'Two, still.'}
    },
    {record_id: 'r5', file_path: 'projects/c/view.md', body_hash: 'hash-r5', body_wikilinks: []},
    {
      record_id: 'ra',
      file_path: 'projects/p/log/_about.md',
      folder: 'projects/p/log.md',
      folder_hash: 'folder-hash',
      body_hash: 'hash-ra',
      body_wikilinks: [],
      current_agent: {
        summary: 'The log, as it was.',
        key_concepts: ['log'],
        complexity: 'log-entry'
      }
    },
    {record_id: 'r4', file_path: 'projects/b/empty.md', body_hash: 'hash-r4', body_wikilinks: []}
  ]
};

const ENRICHMENTS = {
  'projects/a/old-one.md': {
    summary: '  One, enriched at length.  ',
    key_concepts: ['one'],
    tags_suggested: null,
    edge_classifications: {'[[projects/a/two]]': 'derived-from'},
    complexity: 'prose'
  },
  'projects/a/two.md': {summary_holds: true},
  'projects/c/view.md': {summary: 'A view, enriched.', key_concepts: ['view'], complexity: 'hub'},
  'projects/p/log/_about.md': {summary_holds: true},
  'projects/b/empty.md': null
};

test('apply: If-Match at the current path, a 412 read again, a composed view refused', async t => {
  const {w, server, enrich, lines, calls, file, done} = await setUp();
  let etag = 1;
  const ifMatch = [];
  const puts = new Map();
  const put =
    path =>
    ({req, json: body}) => {
      ifMatch.push([path, req.headers['if-match']]);
      puts.set(path, body);
      if (path === 'one' && etag === 1) {
        etag = 2;
        return {status: 412, body: {code: 'precondition_failed', error: 'the note changed'}};
      }
      return {body: {ok: true}};
    };
  server.routes['GET /vault/projects/a/one.md'] = () => ({
    body: '---\ntitle: One\n---\nOne body.\n',
    headers: {etag: `"e${etag}"`}
  });
  server.routes['PUT /vault/projects/a/one.md'] = put('one');
  server.routes['GET /vault/projects/c/view.md'] = {
    body: 'A view.\n',
    headers: {'x-program-clerk-composed': 'true', etag: '"v1"'}
  };
  server.routes['GET /vault/projects/p/log/_about.md'] = {
    body: '---\ntype: meta\n---\nAbout the log.\n',
    headers: {etag: '"a1"'}
  };
  server.routes['PUT /vault/projects/p/log/_about.md'] = put('about');
  server.routes['POST /sections/r2/summary-checked'] = {body: {ok: true}};
  const ws = file('ws.json', WORKSHEET);
  const enrichments = file('enr.json', {enrichments: ENRICHMENTS});
  try {
    t.equal(await enrich(['apply', `--worksheet=${ws}`, `--enrichments=${enrichments}`]), 1);
    t.deepEqual(JSON.parse(lines.at(-1)), {
      mode: 'stale',
      written: ['projects/a/one.md'],
      confirmed: ['projects/a/two.md', 'projects/p/log/_about.md'],
      skipped: 1,
      needs_a_body: [],
      failures: [
        {
          file_path: 'projects/c/view.md',
          status: 409,
          code: 'composed_view',
          message: 'projects/c/view.md is a composed folder view'
        }
      ],
      claim: 'released'
    });
    t.deepEqual(
      ifMatch.filter(([path]) => path === 'one').map(([, tag]) => tag),
      ['"e1"', '"e2"'],
      'the second write carries the tag read again'
    );
    t.deepEqual(puts.get('one'), {
      frontmatter: {
        agent: {
          derived_from_hash: 'auto',
          derived_at: 'auto',
          summary: 'One, enriched at length.',
          key_concepts: ['one'],
          tags_suggested: [],
          related_proposed: [],
          edge_classifications: {'[[projects/a/two]]': 'derived-from'},
          complexity: 'prose'
        }
      },
      body: 'One body.\n'
    });
    t.match(puts.get('about'), {
      frontmatter: {agent: {derived_from_hash: 'folder-hash', summary: 'The log, as it was.'}},
      body: 'About the log.\n'
    });
    const seen = calls();
    t.notOk(
      seen.some(c => c.includes('old-one')),
      'nothing at the path the note left'
    );
    t.notOk(seen.includes('PUT /vault/projects/c/view.md'));
    t.deepEqual(
      server.requests.filter(r => r.path.endsWith('/summary-checked')).map(r => r.json),
      [{body_hash: 'hash-r2'}]
    );
    t.deepEqual(w.releases, [{holder: 'h1', claim_token: 'token-1'}]);

    const from = server.requests.length;
    lines.length = 0;
    t.equal(
      await enrich(['apply', `--worksheet=${ws}`, `--enrichments=${enrichments}`, '--dry-run']),
      0
    );
    t.deepEqual(JSON.parse(lines[0]), {
      dry_run: true,
      would_write: ['projects/a/old-one.md', 'projects/c/view.md'],
      would_confirm: ['projects/a/two.md', 'projects/p/log/_about.md'],
      skipped: 1
    });
    t.equal(server.requests.length, from, 'a dry run sends nothing');
  } finally {
    await done();
  }
});

test('apply: a note gone since prepare is one failure, and the batch is still released', async t => {
  const {w, server, enrich, lines, file, done} = await setUp();
  server.routes['GET /sections/r5'] = {
    status: 404,
    body: {code: 'not_found', error: 'no such note'}
  };
  const ws = file('ws.json', WORKSHEET);
  const only = Object.fromEntries(
    Object.keys(ENRICHMENTS).map(path => [
      path,
      path === 'projects/c/view.md' ? ENRICHMENTS[path] : null
    ])
  );
  const enrichments = file('enr.json', {enrichments: only});
  try {
    t.equal(await enrich(['apply', `--worksheet=${ws}`, `--enrichments=${enrichments}`]), 1);
    t.match(JSON.parse(lines.at(-1)), {
      written: [],
      failures: [{file_path: 'projects/c/view.md', status: 404, code: 'not_found'}],
      claim: 'released'
    });
    t.deepEqual(w.releases, [{holder: 'h1', claim_token: 'token-1'}]);
  } finally {
    await done();
  }
});

test('apply refuses a faulty enrichments file before any write: exit 3', async t => {
  const {server, enrich, file, done} = await setUp();
  const ws = file('ws.json', WORKSHEET);
  const valid = ENRICHMENTS['projects/a/old-one.md'];
  const cases = [
    [{'projects/z/nope.md': null}, /^enrichments reference paths not in the worksheet: projects/],
    [{'projects/a/old-one.md': {...valid, summary: 'short'}}, /summary must be a string/],
    [{'projects/a/old-one.md': {...valid, key_concepts: []}}, /key_concepts must be/],
    [{'projects/a/old-one.md': {...valid, complexity: 'dense'}}, /complexity must be one of/],
    [{'projects/a/old-one.md': {...valid, related_proposed: [1]}}, /related_proposed must be/],
    [
      {'projects/a/old-one.md': {...valid, edge_classifications: {'[[elsewhere]]': 'cites'}}},
      /\[\[elsewhere\]\] is not a body wikilink of this note — nothing written$/
    ],
    [
      {'projects/a/old-one.md': {...valid, edge_classifications: {'[[projects/a/two]]': 'kin'}}},
      /edge type "kin" invalid/
    ],
    [{'projects/a/old-one.md': {summary_holds: true}}, /summary_holds needs an item/]
  ];
  try {
    for (const [enrichments, message] of cases) {
      const e = await t.rejects(
        enrich(['apply', `--worksheet=${ws}`, `--enrichments=${file('enr.json', enrichments)}`])
      );
      t.equal(e.exitCode, 3);
      t.matchString(e.message, message);
    }
    t.equal(server.requests.length, 0);
  } finally {
    await done();
  }
});

test('release gives the batch back: released, lapsed, reported, or none', async t => {
  const {w, server, enrich, lines, file, done} = await setUp();
  const ws = file('ws.json', {claim: {holder: 'h1', claim_token: 'token-1'}, items: []});
  try {
    t.equal(await enrich(['release', `--worksheet=${ws}`]), 0);
    t.deepEqual(JSON.parse(lines.at(-1)), {claim: 'released'});
    t.deepEqual(w.releases, [{holder: 'h1', claim_token: 'token-1'}]);
    t.equal(await enrich(['release', `--worksheet=${ws}`]), 0);
    t.deepEqual(JSON.parse(lines.at(-1)), {claim: 'lapsed'});

    const other = file('other.json', {claim: {holder: 'h1', claim_token: 'token-x'}, items: []});
    t.equal(await enrich(['release', `--worksheet=${other}`]), 0);
    t.deepEqual(JSON.parse(lines.at(-1)), {
      claim: {status: 409, code: 'not_holder', message: 'held by another'}
    });

    const from = server.requests.length;
    const none = file('none.json', {claim: null, items: []});
    t.equal(await enrich(['release', `--worksheet=${none}`]), 0);
    t.deepEqual(JSON.parse(lines.at(-1)), {claim: 'none'});
    t.equal(server.requests.length, from);
  } finally {
    await done();
  }
});

test('usage errors are TypeErrors before any call; no key and failed calls are not', async t => {
  const {server, enrich, lines, done} = await setUp();
  try {
    for (const argv of [
      [],
      ['nope'],
      ['prepare', '--limit=0'],
      ['prepare', '--limit=201'],
      ['prepare', '--bogus'],
      ['prepare', '--full-threshold=2'],
      ['prepare', '--refresh'],
      ['prepare', '--refresh', '--records=x.txt', '--stale'],
      ['prepare', '--outline'],
      ['apply', '--worksheet=w.json'],
      ['release'],
      ['show']
    ]) {
      await t.rejects(enrich(argv), TypeError, argv.join(' ') || '(nothing)');
    }
    const e = await t.rejects(enrich(['prepare'], {PROGRAM_CLERK_KEY: ''}));
    t.notOk(e instanceof TypeError);
    t.matchString(e.message, /^no key/);
    t.equal(server.requests.length, 0);
    t.equal(await enrich(['--help']), 0);
    t.deepEqual(lines, [USAGE]);

    server.routes['GET /system/lint'] = {
      status: 403,
      body: {code: 'forbidden', error: 'no access'}
    };
    const failed = await t.rejects(enrich(['prepare']));
    t.equal(failed.message, '403 forbidden — no access');
    t.ok(failed.cause instanceof ApiError);

    server.routes['GET /system/lint'] = {body: {coverage: {}}};
    const old = await t.rejects(enrich(['prepare']));
    t.matchString(old.message, /no coverage\.enrichment/);
    t.notOk(old instanceof TypeError);
  } finally {
    await done();
  }
});

const ENTRY = fileURLToPath(
  new URL('../plugins/program-clerk/scripts/sweep/enrich.mjs', import.meta.url)
);

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

test('the script runs as a process: exit 0, 1, 2, and 3', async t => {
  const {env, file, done} = await setUp();
  const all = {...process.env, ...env};
  for (const name of Object.keys(all)) if (/^CLAUDE_PLUGIN_OPTION_/.test(name)) delete all[name];
  try {
    let r = await runEntry(['prepare', '--holder=h1'], all);
    const path = join(sweepDir(env), 'enrich-h1.json');
    t.deepEqual(
      [r.code, r.stderr, r.stdout],
      [
        0,
        '',
        `worksheet: ${path} — 3 item(s) (missing), 6 unenriched total, 1 need a body, 1 not claimed; claimed as h1\n`
      ]
    );

    r = await runEntry(['show', `--worksheet=${path}`], {...all, PROGRAM_CLERK_KEY: ''});
    t.equal(r.code, 0);
    t.matchString(r.stdout, /^1\. projects\/a\/one\.md · read: full · /);

    r = await runEntry(['prepare', '--outline'], all);
    t.equal(r.code, 2);
    t.matchString(r.stderr, /^--outline goes with --refresh/);

    const enrichments = file('enr.json', {'projects/z/nope.md': null});
    r = await runEntry(['apply', `--worksheet=${path}`, `--enrichments=${enrichments}`], all);
    t.deepEqual([r.code, r.stdout], [3, '']);
    t.matchString(r.stderr, /not in the worksheet: projects\/z\/nope\.md/);

    r = await runEntry(['prepare'], {...all, PROGRAM_CLERK_KEY: ''});
    t.equal(r.code, 1);
    t.matchString(r.stderr, /^no key/);
  } finally {
    await done();
  }
});
