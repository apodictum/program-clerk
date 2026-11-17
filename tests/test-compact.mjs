// A folder's compaction: the selection `plan` makes, the links it reads, the batch it leases; the
// note, the moves, and the release `execute` makes; and `release`, against a store that keeps a
// batch's leases by the server's rules.

import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'tape-six';
import {
  USAGE,
  escapeRegExp,
  namesPiece,
  planPathFor,
  run,
  summaryPathFor
} from '../plugins/program-clerk/scripts/lib/compact.mjs';
import {fakeServer, removeAll, scratch} from './helpers.mjs';

const SESSION = '0123abcd-4567-89ef-0123-456789abcdef';
const FOLDER = 'projects/p/logs';
const EXPIRES = '2099-01-01T00:00:00.000Z';
const SUMMARY = `## 2026-Q1\n\n${'The first quarter: what was built, decided, and left open. '.repeat(3)}\n`;

const piece = (id, name, created, extra = {}) => ({
  record_id: id,
  file_path: `${FOLDER}/${name}.md`,
  title: name,
  type: 'log',
  status: 'active',
  created,
  ...extra
});

// Out of order, so the sort shows; the last five are never candidates.
const RECORDS = [
  piece('r4', 'd', '2026-07-01'),
  piece('r1', 'a', '2026-01-05'),
  piece('r2', 'b', '2026-02-10'),
  piece('r3', 'c', '2026-03-15'),
  piece('r5', 'e', '2026-08-01'),
  piece('r6', 'f', '2026-09-01'),
  piece('x1', 'archive/2025/old', '2025-01-01'),
  piece('x2', '_summary-2025-01-01-to-2025-02-01', '2025-03-01', {type: 'meta'}),
  piece('x3', 'gone', '2025-12-01', {status: 'archived'}),
  piece('x4', 'replaced', '2025-12-02', {status: 'superseded'}),
  piece('x5', 'state', '2025-12-03', {type: 'state'})
];

const TEXTS = {
  [`${FOLDER}/a.md`]: '---\ntitle: a\n---\nBody of a.\n',
  [`${FOLDER}/b.md`]: 'Body of b.\n',
  [`${FOLDER}/c.md`]: '---\ntitle: c\n---\nBody of c.\n',
  [`${FOLDER}/d.md`]: 'Body of d.\n',
  'topics/t1.md': 'See [[a]] for where it started.\n',
  'topics/t2.md': 'Names nothing.\n'
};

const linker = (id, path, title, type) => ({
  from_record: {record_id: id, file_path: path, title},
  edge: {type}
});

// a: one link from a piece compacted with it, one that names it, one the server mirrors; b's route
// fails; c's linker can't be read.
const BACKLINKS = {
  r1: [
    linker('r2', `${FOLDER}/b.md`, 'b', 'cites'),
    linker('n1', 'topics/t1.md', 'T1', 'cites'),
    linker('n2', 'topics/t2.md', 'T2', 'related-to')
  ],
  r3: [linker('n3', 'topics/t3.md', 'T3', 'cites')]
};

// One token over every resource the batch gets; a resource another lease has is held, never taken.
const batchLeaseRoutes = leases => ({
  'POST /leases/claim': ({json}) => {
    const claimed = [];
    const held = [];
    for (const resource of json.resources) {
      const current = leases.get(resource);
      if (current) held.push({resource, holder: current.holder, expires_at: current.expires_at});
      else claimed.push(resource);
    }
    const token = claimed.length ? randomUUID() : null;
    for (const resource of claimed) {
      leases.set(resource, {holder: json.holder, token, expires_at: EXPIRES});
    }
    return {
      body: {claim_token: token, claimed, held, expires_at: token ? EXPIRES : null}
    };
  },
  'POST /leases/release': ({json}) => {
    const mine = [...leases].filter(([, lease]) => lease.token === json.claim_token);
    if (!mine.length) {
      return {
        status: 404,
        body: {code: 'lease_not_found', error: 'no live lease holds that token'}
      };
    }
    if (mine.some(([, lease]) => lease.holder !== json.holder)) {
      return {status: 409, body: {code: 'claim_token_mismatch', error: 'another holder'}};
    }
    for (const [resource] of mine) leases.delete(resource);
    return {body: {status: 'released', released: mine.length}};
  }
});

const setUp = async ({records = RECORDS, texts = TEXTS, routes = {}} = {}) => {
  const dir = scratch();
  const leases = new Map();
  const moved = [];
  const all = {
    ...batchLeaseRoutes(leases),
    // A page holds at most two, as a server may cap a page under the limit asked.
    'GET /sections': ({url}) => {
      const p = url.searchParams;
      const offset = Number(p.get('offset'));
      const items = records
        .filter(r => r.file_path.startsWith(p.get('file_prefix')))
        .slice(offset, offset + Math.min(Number(p.get('limit')), 2));
      return {body: {items}};
    },
    [`POST /vault/move`]: ({json}) => {
      const lease = leases.get(`note:${json.from}`);
      if (lease && lease.token !== json.claim_token) {
        return {status: 409, body: {code: 'lease_held', error: `${json.from} is leased`}};
      }
      moved.push(json);
      return {body: {from: json.from, to: json.to}};
    },
    [`PUT /vault/${FOLDER}/_summary-2026-01-05-to-2026-03-15.md`]: {body: {}},
    'POST /maintenance/find-compaction-candidates': {body: {qualifying: 0, autoResolved: 1}}
  };
  for (const [path, text] of Object.entries(texts)) all[`GET /vault/${path}`] = {body: text};
  for (const [id, rows] of Object.entries(BACKLINKS)) {
    all[`GET /sections/${id}/backlinks`] = ({url}) => {
      const offset = Number(url.searchParams.get('offset'));
      return {body: {items: rows.slice(offset, offset + 2), total: rows.length}};
    };
  }
  const server = await fakeServer({...all, ...routes});
  const env = {
    PROGRAM_CLERK_URL: server.base,
    PROGRAM_CLERK_KEY: 'test-key',
    CLAUDE_CODE_SESSION_ID: SESSION,
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_STATE_HOME: join(dir, 'state')
  };
  const lines = [];
  const compact = (argv, extra = {}) =>
    run(argv, {env: {...env, ...extra}, out: line => lines.push(line)});
  const calls = (from = 0) => server.requests.slice(from).map(r => `${r.method} ${r.path}`);
  const done = async () => {
    await server.close();
    removeAll(dir);
  };
  return {dir, env, server, leases, moved, compact, lines, calls, done};
};

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const byArchived = (x, y) => x.archived.localeCompare(y.archived);

test('the escape: every character of a stem with . ( and [ matches only itself', t => {
  const stem = '2026.01 (x) [y]';
  t.equal(escapeRegExp(stem), '2026\\.01 \\(x\\) \\[y\\]');
  t.equal(escapeRegExp('a*b+c?d^e$f{g}h|i\\j'), 'a\\*b\\+c\\?d\\^e\\$f\\{g\\}h\\|i\\\\j');
  t.ok(new RegExp(`^${escapeRegExp(stem)}$`).test(stem));
  t.notOk(new RegExp(escapeRegExp(stem)).test('2026x01 (x) [y]'), 'the dot is a dot');
  t.notOk(new RegExp(escapeRegExp(stem)).test('2026.01 x y'), 'the brackets are brackets');

  const path = `${FOLDER}/${stem}.md`;
  t.ok(namesPiece(`See ${FOLDER}/${stem} here.`, path), 'by its path');
  t.ok(namesPiece(`See [[${stem}]].`, path), 'as a wikilink');
  t.ok(namesPiece(`See [[${stem}|it]] and [[${stem}#part]].`, path), 'with an alias or a part');
  t.notOk(namesPiece(`See ${FOLDER}/2026x01 (x) [y] here.`, path), 'another name');
  t.notOk(namesPiece(`See ${FOLDER}/${stem}-2 and [[${stem}-2]].`, path), 'a longer name');
  t.ok(namesPiece(null, path), 'a text not read counts');
});

test('plan selects the oldest half, leases it as one batch, and keeps the links that break', async t => {
  const {dir, env, server, leases, compact, lines, done} = await setUp();
  try {
    t.equal(await compact(['plan', `${FOLDER}/`, '--holder=H']), 0);
    const file = planPathFor(FOLDER, env);
    t.equal(dirname(file), join(dir, 'cache', 'program-clerk', 'sweep', SESSION));
    if (process.platform !== 'win32') t.equal(statSync(dirname(file)).mode & 0o777, 0o700);
    t.deepEqual(lines, [
      `plan: ${file} — archive 3 of 6 pieces (2026-01-05-to-2026-03-15), 2 external inbound link(s); claimed as H`,
      `summary file: ${summaryPathFor(FOLDER, env)}`
    ]);

    const sheet = readJson(file);
    t.match(sheet, {
      folder: FOLDER,
      mode: 'oldest half',
      total_pieces: 6,
      selected_count: 3,
      remaining_after: 3,
      truncated_to_cap: false,
      summary_path: `${FOLDER}/_summary-2026-01-05-to-2026-03-15.md`,
      suggested_groups: {'2026-Q1': [`${FOLDER}/a.md`, `${FOLDER}/b.md`, `${FOLDER}/c.md`]},
      claim: {holder: 'H', expires_at: EXPIRES}
    });
    t.deepEqual(
      sheet.selected.map(p => [p.record_id, p.created, p.body]),
      [
        ['r1', '2026-01-05', 'Body of a.\n'],
        ['r2', '2026-02-10', 'Body of b.\n'],
        ['r3', '2026-03-15', 'Body of c.\n']
      ],
      'oldest first, each body without its frontmatter'
    );
    t.deepEqual(
      sheet.inbound_backlinks.sort(byArchived),
      [
        {archived: `${FOLDER}/a.md`, from: 'topics/t1.md', title: 'T1', edge_type: 'cites'},
        {archived: `${FOLDER}/c.md`, from: 'topics/t3.md', title: 'T3', edge_type: 'cites'}
      ],
      'neither a piece compacted with it, nor a link whose text does not name it'
    );

    const claims = server.requests.filter(r => r.path === '/leases/claim');
    t.deepEqual(
      claims.map(r => r.json),
      [
        {
          holder: 'H',
          resources: ['a', 'b', 'c'].map(n => `note:${FOLDER}/${n}.md`),
          ttl_seconds: 3600
        }
      ]
    );
    t.equal(sheet.claim.claim_token, leases.get(`note:${FOLDER}/a.md`).token);
    t.equal(leases.size, 3);

    const sections = server.requests.filter(r => r.path === '/sections');
    t.equal(sections.length, 7, 'eleven records two a page, then the empty page');
    t.matchString(sections[0].url, /file_prefix=projects%2Fp%2Flogs%2F&limit=100&offset=0/);
    t.matchString(sections[0].url, /&exclude=body&sort=created$/);
    t.deepEqual(
      server.requests
        .filter(r => r.path.endsWith('/backlinks'))
        .map(r => r.url)
        .sort(),
      [
        '/sections/r1/backlinks?limit=100&offset=0',
        '/sections/r1/backlinks?limit=100&offset=2',
        '/sections/r2/backlinks?limit=100&offset=0',
        '/sections/r3/backlinks?limit=100&offset=0'
      ]
    );
    t.deepEqual(
      server.requests
        .filter(r => r.path.startsWith('/vault/topics/'))
        .map(r => r.path)
        .sort(),
      ['/vault/topics/t1.md', '/vault/topics/t2.md', '/vault/topics/t3.md'],
      'each outside linker read once'
    );
  } finally {
    await done();
  }
});

test('plan by --keep, by --before, to --out, and capped at 20 a pass', async t => {
  const many = Array.from({length: 22}, (_, i) =>
    piece(
      `m${i}`,
      `m${String(i).padStart(2, '0')}`,
      `2025-${String((i % 12) + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`
    )
  );
  const {dir, env, leases, compact, lines, done} = await setUp();
  try {
    t.equal(await compact(['plan', FOLDER, '--keep=4', '--holder=K']), 0);
    const kept = readJson(planPathFor(FOLDER, env));
    t.deepEqual(
      [kept.mode, kept.selected.map(p => p.title), kept.suggested_groups],
      ['keep 4', ['a', 'b'], {'2026-Q1': [`${FOLDER}/a.md`, `${FOLDER}/b.md`]}]
    );
    leases.clear();

    const out = join(dir, 'elsewhere', 'plan.json');
    t.equal(await compact(['plan', FOLDER, '--before=2026-02-01', `--out=${out}`]), 0);
    const before = readJson(out);
    t.deepEqual(
      [before.mode, before.selected.map(p => p.title), before.remaining_after],
      ['before 2026-02-01', ['a'], 5]
    );
    t.matchString(before.claim.holder, /^compact-.+-[0-9a-f]{6}$/, 'a generated holder');
    t.matchString(lines.at(-2), new RegExp(`^plan: ${escapeRegExp(out)} — archive 1 of 6 `));
  } finally {
    await done();
  }

  const capped = await setUp({
    records: many,
    texts: Object.fromEntries(many.map(p => [p.file_path, 'A piece.\n']))
  });
  try {
    t.equal(await capped.compact(['plan', FOLDER, '--keep=0']), 0);
    const sheet = readJson(planPathFor(FOLDER, capped.env));
    t.deepEqual([sheet.selected_count, sheet.truncated_to_cap], [20, true]);
    t.equal(capped.leases.size, 20);
    t.matchString(
      capped.lines[0],
      /archive 20 of 22 pieces .* \[capped at 20 — re-run after this pass\], 0 external/
    );
    t.deepEqual(
      Object.keys(sheet.suggested_groups),
      ['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4'],
      'twelve months widen to quarters'
    );
  } finally {
    await capped.done();
  }
});

test('plan refused: a piece another holder has, or an empty selection; nothing kept', async t => {
  const {env, server, leases, compact, lines, done} = await setUp();
  try {
    leases.set(`note:${FOLDER}/b.md`, {holder: 'other', token: 'T', expires_at: EXPIRES});
    const e = await t.rejects(compact(['plan', FOLDER, '--holder=H']));
    t.equal(e.exitCode, 3);
    t.equal(
      e.message,
      `another pass holds 1 selected piece(s) — nothing claimed:\n  ${FOLDER}/b.md (other, until ${EXPIRES})`
    );
    t.deepEqual([...leases.keys()], [`note:${FOLDER}/b.md`], 'the part it got, given back');
    t.ok(server.requests.some(r => r.path === '/leases/release' && r.json.holder === 'H'));
    t.notOk(
      server.requests.some(r => r.path.startsWith('/vault/')),
      'no body read'
    );
    t.notOk(existsSync(planPathFor(FOLDER, env)), 'no plan written');

    const empty = await t.rejects(compact(['plan', FOLDER, '--before=2020-01-01']));
    t.equal(empty.exitCode, 3);
    t.equal(empty.message, `nothing to archive in ${FOLDER} (6 pieces, selection empty)`);
    t.deepEqual(lines, []);
  } finally {
    await done();
  }
});

test('plan that fails after its claim gives the batch back', async t => {
  const texts = {...TEXTS};
  delete texts[`${FOLDER}/a.md`];
  const {env, leases, compact, done} = await setUp({texts});
  try {
    const e = await t.rejects(compact(['plan', FOLDER, '--keep=5', '--holder=H']));
    t.matchString(e.message, /^404 route_not_found — 404 Not Found on GET \/vault\/projects/);
    t.equal(e.exitCode, undefined);
    t.equal(leases.size, 0, 'no lease left to lapse');
    t.notOk(existsSync(planPathFor(FOLDER, env)));
  } finally {
    await done();
  }
});

const planned = async (setup, argv = []) => {
  const code = await setup.compact(['plan', FOLDER, '--holder=H', ...argv]);
  if (code !== 0) throw new Error(`plan exited ${code}`);
  const file = planPathFor(FOLDER, setup.env);
  writeFileSync(summaryPathFor(FOLDER, setup.env), SUMMARY);
  setup.lines.length = 0;
  return {file, sheet: readJson(file), from: setup.server.requests.length};
};

test('execute writes the note, moves each piece with the token, releases, and scans', async t => {
  const setup = await setUp();
  const {server, leases, compact, lines, calls, done} = setup;
  try {
    const {sheet, from} = await planned(setup);
    t.equal(await compact(['execute', FOLDER, '--related=[[topics/x]], [[topics/y]]']), 0);
    const day = new Date().toISOString().slice(0, 10);
    const archived = n => `${FOLDER}/archive/2026/${n}.md`;
    t.deepEqual(calls(from), [
      `PUT /vault/${FOLDER}/_summary-2026-01-05-to-2026-03-15.md`,
      'POST /vault/move',
      'POST /vault/move',
      'POST /vault/move',
      'POST /leases/release',
      'POST /maintenance/find-compaction-candidates'
    ]);
    const [put, ...rest] = server.requests.slice(from);
    t.deepEqual(put.json, {
      frontmatter: {
        title: 'logs — summary 2026-01-05 to 2026-03-15',
        tags: ['summary', 'logs', 'archived-history'],
        created: day,
        updated: day,
        status: 'active',
        type: 'meta',
        related: ['[[topics/x]]', '[[topics/y]]']
      },
      body: SUMMARY
    });
    t.deepEqual(
      rest.slice(0, 3).map(r => r.json),
      ['a', 'b', 'c'].map(n => ({
        from: `${FOLDER}/${n}.md`,
        to: archived(n),
        claim_token: sheet.claim.claim_token
      }))
    );
    t.deepEqual(rest[3].json, {holder: 'H', claim_token: sheet.claim.claim_token});
    t.equal(leases.size, 0);
    t.deepEqual(JSON.parse(lines.join('\n')), {
      summary_written: `${FOLDER}/_summary-2026-01-05-to-2026-03-15.md`,
      archived: ['a', 'b', 'c'].map(n => `${FOLDER}/${n}.md → ${archived(n)}`),
      failures: [],
      remaining_in_folder: 3,
      inbound_links_now_broken: sheet.inbound_backlinks,
      claim: 'released',
      rescan: {qualifying: 0, auto_resolved: 1}
    });
  } finally {
    await done();
  }
});

test('execute with a move that fails midway: the rest move, the batch is released, exit 1', async t => {
  const setup = await setUp({
    routes: {
      [`POST /vault/move`]: ({json}) =>
        json.from.endsWith('/b.md')
          ? {status: 409, body: {code: 'target_exists', error: `${json.to} exists`}}
          : {body: json}
    }
  });
  const {leases, compact, lines, calls, done} = setup;
  try {
    const {from} = await planned(setup);
    t.equal(await compact(['execute', FOLDER]), 1);
    t.equal(calls(from).filter(c => c === 'POST /vault/move').length, 3);
    const report = JSON.parse(lines.join('\n'));
    t.deepEqual(report.archived, [
      `${FOLDER}/a.md → ${FOLDER}/archive/2026/a.md`,
      `${FOLDER}/c.md → ${FOLDER}/archive/2026/c.md`
    ]);
    t.deepEqual(report.failures, [
      {
        from: `${FOLDER}/b.md`,
        to: `${FOLDER}/archive/2026/b.md`,
        status: 409,
        code: 'target_exists',
        message: `${FOLDER}/archive/2026/b.md exists`
      }
    ]);
    t.equal(report.claim, 'released');
    t.deepEqual(report.rescan, {qualifying: 0, auto_resolved: 1});
    t.equal(leases.size, 0);
  } finally {
    await done();
  }
});

test('execute refused for a short summary; --dry-run sends nothing; explicit files work', async t => {
  const setup = await setUp();
  const {dir, env, compact, lines, calls, done} = setup;
  try {
    const {file, from} = await planned(setup);
    writeFileSync(summaryPathFor(FOLDER, env), 'Too short.\n');
    const e = await t.rejects(compact(['execute', FOLDER]));
    t.deepEqual(
      [e.exitCode, e.message],
      [3, 'summary body is suspiciously short (< 100 chars) — nothing written']
    );

    const summary = join(dir, 'summary.md');
    writeFileSync(summary, SUMMARY);
    t.equal(await compact(['execute', `--plan=${file}`, `--summary=${summary}`, '--dry-run']), 0);
    t.deepEqual(JSON.parse(lines.join('\n')), {
      dry_run: true,
      would_write: `${FOLDER}/_summary-2026-01-05-to-2026-03-15.md`,
      would_move: ['a', 'b', 'c'].map(n => ({
        from: `${FOLDER}/${n}.md`,
        to: `${FOLDER}/archive/2026/${n}.md`
      }))
    });
    t.deepEqual(calls(from), []);
  } finally {
    await done();
  }
});

test("release gives the plan's batch back; again, it has lapsed; a plan without one has none", async t => {
  const setup = await setUp();
  const {dir, leases, compact, lines, done} = setup;
  try {
    await planned(setup);
    t.equal(leases.size, 3);
    t.equal(await compact(['release', FOLDER]), 0);
    t.equal(leases.size, 0);
    t.equal(await compact(['release', FOLDER]), 0);
    const plan = join(dir, 'unclaimed.json');
    writeFileSync(plan, JSON.stringify({folder: FOLDER, claim: null}));
    t.equal(await compact(['release', `--plan=${plan}`]), 0);
    t.deepEqual(
      lines.map(line => JSON.parse(line)),
      [{claim: 'released'}, {claim: 'lapsed'}, {claim: 'none'}]
    );
  } finally {
    await done();
  }
});

test('usage errors are TypeErrors, sent before any call; no key is refused too', async t => {
  const {server, compact, lines, done} = await setUp();
  try {
    for (const argv of [
      [],
      ['nope'],
      ['plan'],
      ['plan', FOLDER, 'more'],
      ['plan', FOLDER, '--nope'],
      ['plan', FOLDER, '--keep'],
      ['plan', FOLDER, '--keep=x'],
      ['plan', FOLDER, '--keep=-1'],
      ['plan', FOLDER, '--keep=2', '--before=2026-01-01'],
      ['execute', '--summary=s.md'],
      ['execute', FOLDER, '--related'],
      ['release']
    ]) {
      await t.rejects(compact(argv), TypeError, argv.join(' ') || '(nothing)');
    }
    const e = await t.rejects(compact(['plan', FOLDER], {PROGRAM_CLERK_KEY: ''}));
    t.notOk(e instanceof TypeError);
    t.matchString(e.message, /^no key/);
    t.equal(server.requests.length, 0);
    t.equal(await compact(['--help']), 0);
    t.deepEqual(lines, [USAGE]);
  } finally {
    await done();
  }
});

const ENTRY = fileURLToPath(
  new URL('../plugins/program-clerk/scripts/sweep/compact.mjs', import.meta.url)
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
  const {env, server, done} = await setUp();
  const all = {...process.env, ...env};
  for (const name of Object.keys(all)) if (/^CLAUDE_PLUGIN_OPTION_/.test(name)) delete all[name];
  try {
    let r = await runEntry(['plan', FOLDER, '--holder=P1'], all);
    t.deepEqual([r.code, r.stderr], [0, '']);
    t.equal(r.stdout.split(/\r?\n/).length, 3, 'two lines');
    t.matchString(r.stdout, /archive 3 of 6 pieces .*; claimed as P1\r?\nsummary file: /);

    r = await runEntry(['plan', FOLDER, '--holder=P2'], all);
    t.deepEqual([r.code, r.stdout], [3, '']);
    t.matchString(r.stderr, /^another pass holds 3 selected piece\(s\) — nothing claimed:/);

    r = await runEntry(['plan'], all);
    t.equal(r.code, 2);
    t.matchString(r.stderr, /^plan needs a folder\r?\nusage:/);

    r = await runEntry(['release', FOLDER], all);
    t.deepEqual([r.code, JSON.parse(r.stdout)], [0, {claim: 'released'}]);

    server.routes['GET /sections'] = {status: 500, body: {code: 'boom', error: 'it broke'}};
    r = await runEntry(['plan', FOLDER], all);
    t.deepEqual([r.code, r.stderr], [1, '500 boom — it broke\n']);
  } finally {
    await done();
  }
});
