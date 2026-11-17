// A triage pass's paperwork: the worksheet `prepare` writes, the calls `resolve` makes from the
// decisions and the report it leaves for the sweep, and `release`, against a store that keeps
// claims by the server's rules.

import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'tape-six';
import {ApiError, USAGE, run} from '../plugins/program-clerk/scripts/lib/triage.mjs';
import {
  reportPathFor,
  worksheetPathFor
} from '../plugins/program-clerk/scripts/lib/sweep-files.mjs';
import {fakeServer, removeAll, scratch} from './helpers.mjs';

const SESSION = '0123abcd-4567-89ef-0123-456789abcdef';

// A live claim yields only to its token; a lapsed one reads as pending, so a resolve takes it and a
// release answers already_pending.
const suggestionRoutes = rows => {
  const shown = ({token, context, ...row}) => row;
  const withContext = row => ({...shown(row), context: row.context});
  const routes = {
    'GET /suggestions': ({url}) => {
      const p = url.searchParams;
      const all = [...rows.values()].filter(
        r => r.kind === p.get('kind') && r.status === p.get('status')
      );
      const offset = Number(p.get('offset') ?? 0);
      const page = all.slice(offset, offset + Number(p.get('limit') ?? 100));
      const expand = p.get('expand') === 'context';
      return {body: {items: page.map(expand ? withContext : shown), total: all.length}};
    },
    'POST /suggestions/claim': ({json}) => {
      const pending = [...rows.values()].filter(
        r => r.kind === json.kind && r.status === 'pending'
      );
      const taken = pending.slice(0, json.limit);
      const token = taken.length ? randomUUID() : null;
      for (const r of taken) Object.assign(r, {status: 'claimed', claimed_by: json.holder, token});
      return {
        body: {
          claimed: taken.length,
          claim_token: token,
          remaining_pending: pending.length - taken.length,
          items: taken.map(withContext)
        }
      };
    },
    'POST /suggestions/resolve-batch': ({json}) => {
      let accepted = 0,
        rejected = 0,
        failed = 0;
      const results = [];
      for (const {id, decision} of json.items) {
        const r = rows.get(id);
        const refusal = !r
          ? 'suggestion_not_found'
          : r.status === 'claimed'
            ? r.token === json.claim_token
              ? null
              : 'claimed_by_other'
            : r.status === 'pending'
              ? null
              : 'already_resolved';
        if (refusal) {
          ++failed;
          results.push({id, error: {code: refusal, message: `refused: ${refusal}`}});
          continue;
        }
        const status = decision === 'accept' ? 'accepted' : 'rejected';
        Object.assign(r, {status, claimed_by: null, token: null, resolved_by: json.resolved_by});
        if (status === 'accepted') ++accepted;
        else ++rejected;
        results.push({id, status});
      }
      return {body: {accepted, rejected, failed, results}};
    }
  };
  for (const id of rows.keys()) {
    routes[`POST /suggestions/${id}/reopen`] = ({json}) => {
      const r = rows.get(id);
      const refusal =
        r.status === 'claimed'
          ? json?.claim_token === r.token
            ? null
            : 'claimed_by_other'
          : r.status === 'pending'
            ? 'already_pending'
            : null;
      if (refusal) return {status: 409, body: {code: refusal, error: `refused: ${refusal}`}};
      Object.assign(r, {status: 'pending', claimed_by: null, token: null});
      return {body: shown(r)};
    };
  }
  return routes;
};

const setUp = async (rows = [], routes = {}) => {
  const dir = scratch();
  const store = new Map(rows.map(r => [r.id, {claimed_by: null, token: null, ...r}]));
  const server = await fakeServer({...suggestionRoutes(store), ...routes});
  const env = {
    PROGRAM_CLERK_URL: server.base,
    PROGRAM_CLERK_KEY: 'test-key',
    CLAUDE_CODE_SESSION_ID: SESSION,
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_STATE_HOME: join(dir, 'state')
  };
  const lines = [];
  const warnings = [];
  const triage = (argv, extra = {}) =>
    run(argv, {
      env: {...env, ...extra},
      out: line => lines.push(line),
      warn: line => warnings.push(line)
    });
  // A claim that lapsed, and one taken by another claim, possibly under the same holder name.
  const lapse = id =>
    Object.assign(store.get(id), {status: 'pending', claimed_by: null, token: null});
  const take = (id, holder) =>
    Object.assign(store.get(id), {status: 'claimed', claimed_by: holder, token: randomUUID()});
  const calls = (from = 0) => server.requests.slice(from).map(r => `${r.method} ${r.url}`);
  const done = async () => {
    await server.close();
    removeAll(dir);
  };
  return {dir, env, store, server, triage, lines, warnings, lapse, take, calls, done};
};

const record = (path, title) => ({file_path: path, title, type: 'note', status: 'active'});

const TAG_ROWS = [
  {
    id: 's1',
    kind: 'tag_suggestion',
    status: 'pending',
    payload: {tag: 'testing', record_id: 'r1', file_path: 'projects/a/old.md'},
    context: {
      records: {r1: record('projects/a/new.md', 'A')},
      tag: {in_taxonomy: true, canonical: 'testing', description: 'Tests.'}
    }
  },
  {
    id: 's2',
    kind: 'tag_suggestion',
    status: 'pending',
    payload: {tag: 'testing', record_id: 'r2', file_path: 'projects/b/b.md'},
    context: {records: {r2: record('projects/b/b.md', 'B')}, tag: {in_taxonomy: true}}
  },
  {
    id: 's3',
    kind: 'tag_suggestion',
    status: 'pending',
    payload: {tag: 'other', record_id: 'r3', file_path: 'projects/c/c.md'},
    context: {records: {r3: record('projects/c/c.md', 'C')}, tag: {in_taxonomy: true}}
  },
  {id: 'n1', kind: 'new_tag', status: 'rejected', payload: {tag: 'testing', record_id: 'r9'}},
  {id: 'n2', kind: 'new_tag', status: 'pending', payload: {tag: 'other', record_id: 'r8'}}
];

const EDGE_ROWS = [
  {
    id: 'e1',
    kind: 'edge_type',
    status: 'pending',
    payload: {
      from_record: 'r1',
      to_record: 'r2',
      from_path: 'projects/a/x.md',
      to_path: 'projects/b/decisions.md',
      context: 'as [[projects/b/decisions]] says'
    },
    context: {
      records: {r1: record('projects/a/x.md', 'X'), r2: record('projects/b/decisions.md', 'D')}
    }
  },
  {
    id: 'e2',
    kind: 'edge_type',
    status: 'pending',
    payload: {
      from_record: 'r1',
      to_record: 'r3',
      from_path: 'projects/a/x.md',
      to_path: 'projects/c/queue.md',
      context: 'see [[projects/c/queue]]'
    },
    context: {records: {r1: record('projects/a/x.md', 'X')}}
  }
];

// An earlier entry with the target's basename must not shadow the exact one after it.
const EDGE_FM = {
  'GET /sections/r1/fm': {
    body: {
      frontmatter: {
        agent: {
          edge_classifications: {
            '[[projects/z/decisions]]': 'cites',
            '[[projects/b/decisions]]': 'derived-from',
            '[[projects/y/queue]]': 'revises'
          }
        }
      }
    }
  }
};

test('prepare without a claim prints the worksheet, each prior read from the source note', async t => {
  const {server, triage, lines, calls, done} = await setUp(EDGE_ROWS, EDGE_FM);
  try {
    t.equal(await triage(['prepare', 'edge_type', '--limit=2']), 0);
    t.deepEqual(calls(), [
      'GET /suggestions?kind=edge_type&status=pending&limit=2&expand=context',
      'GET /sections/r1/fm?exclude=body'
    ]);
    t.equal(server.requests[0].auth, 'Bearer test-key');
    t.matchString(server.requests[0].agent, /^program-clerk-plugin\//);
    t.equal(lines.length, 1);
    const worksheet = JSON.parse(lines[0]);
    t.match(worksheet, {
      kind: 'edge_type',
      claimed: false,
      holder: null,
      claim_token: null,
      total_pending: 2
    });
    t.deepEqual(worksheet.decisions_template, {e1: null, e2: null});
    const [e1, e2] = worksheet.items;
    t.equal(e1.prior, 'derived-from', 'the exact path wins over an earlier basename');
    t.equal(e2.prior, 'revises', 'a basename one entry has stands in');
    t.equal(e1.snippet, 'as [[projects/b/decisions]] says');
    t.notOk('path_moved' in e1.from, 'a path that did not move leaves no mark');
    t.match(e2.to, {record_id: 'r3', record_missing: true});
  } finally {
    await done();
  }
});

test('prepare with a claim writes the worksheet to the holder file, with companions', async t => {
  const {env, store, triage, lines, calls, server, done} = await setUp(TAG_ROWS);
  try {
    t.equal(
      await triage([
        'prepare',
        'tag_suggestion',
        '--claim',
        '--holder=h1',
        '--ttl=600',
        '--limit=5'
      ]),
      0
    );
    t.deepEqual(calls(), [
      'POST /suggestions/claim?expand=context',
      'GET /suggestions?kind=new_tag&status=rejected&limit=100&offset=0',
      'GET /suggestions?kind=new_tag&status=pending&limit=100&offset=0'
    ]);
    t.deepEqual(server.requests[0].json, {
      kind: 'tag_suggestion',
      holder: 'h1',
      limit: 5,
      ttl_seconds: 600
    });
    const file = worksheetPathFor('h1', env);
    t.deepEqual(lines, [`worksheet: ${file} — 3 item(s), 3 pending total, claimed by h1`]);
    if (process.platform !== 'win32') t.equal(statSync(dirname(file)).mode & 0o777, 0o700);
    const worksheet = JSON.parse(readFileSync(file, 'utf8'));
    t.match(worksheet, {
      kind: 'tag_suggestion',
      claimed: true,
      holder: 'h1',
      claim_token: store.get('s1').token,
      total_pending: 3
    });
    t.deepEqual(worksheet.decisions_template, {s1: null, s2: null, s3: null});
    const [s1, , s3] = worksheet.items;
    t.match(s1, {
      tag: 'testing',
      in_taxonomy: true,
      canonical: 'testing',
      tag_description: 'Tests.',
      companion_verdict: 'rejected',
      record: {path_moved: {from: 'projects/a/old.md', to: 'projects/a/new.md'}}
    });
    t.deepEqual(
      s1.companion_new_tags.map(c => [c.status, c.suggestion_id]),
      [['rejected', 'n1']]
    );
    t.equal(s3.companion_verdict, 'pending');
  } finally {
    await done();
  }
});

test('prepare new_tag: the server lookup ranks neighbours; without it, prefix windows', async t => {
  const NEW_TAG = [
    {
      id: 't1',
      kind: 'new_tag',
      status: 'pending',
      payload: {tag: 'contract', record_id: 'r1', file_path: 'a.md'},
      context: {records: {r1: record('a.md', 'A')}, tag: null}
    }
  ];
  const TAGS = [
    {tag: 'context', record_count: 60},
    {tag: 'contracts', record_count: 2}
  ];
  const {server, triage, lines, calls, done} = await setUp(NEW_TAG, {
    'GET /tags': ({url}) => {
      const prefix = url.searchParams.get('prefix');
      const items = TAGS.filter(x => x.tag.startsWith(prefix));
      return {body: {items, total: items.length}};
    }
  });
  try {
    await triage(['prepare', 'new_tag']);
    t.deepEqual(calls(1), ['POST /tags/nearest', 'GET /tags?prefix=con&limit=100']);
    let [group] = JSON.parse(lines[0]).items;
    t.match(group, {tag: 'contract', count: 1, neighbor_windows: [{prefix: 'con', total: 2}]});
    t.equal(group.neighbors[0].tag, 'contracts');
    t.equal(group.records[0].suggestion_id, 't1');

    server.routes['POST /tags/nearest'] = {
      body: {queries: [{exact: null, items: [...TAGS].reverse()}]}
    };
    const from = server.requests.length;
    await triage(['prepare', 'new_tag']);
    t.deepEqual(calls(from + 1), ['POST /tags/nearest']);
    t.deepEqual(server.requests[from + 1].json, {tags: ['contract'], k: 10});
    [group] = JSON.parse(lines[1]).items;
    t.deepEqual(group.neighbor_source, {route: '/tags/nearest', k: 10});
    t.deepEqual(
      group.neighbors.map(n => n.tag),
      ['contracts', 'context'],
      "the server's order"
    );
  } finally {
    await done();
  }
});

test("prepare duplicate with --scan: the scan line on stderr, each note's head", async t => {
  const DUP = [
    {
      id: 'd1',
      kind: 'duplicate',
      status: 'pending',
      payload: {a_record: 'r1', b_record: 'r2', a_path: 'a.md', b_path: 'b.md', distance: 0.05},
      context: {records: {r1: record('a.md', 'A'), r2: record('b2.md', 'B')}}
    }
  ];
  const {triage, lines, warnings, calls, done} = await setUp(DUP, {
    'POST /maintenance/find-duplicates': {body: {filed: 1}},
    'GET /vault/a.md': {body: '---\ntitle: A\n---\nBody of A.\r\nSecond line.\n'}
  });
  try {
    await triage(['prepare', 'duplicate', '--scan=0.2']);
    t.equal(calls()[0], 'POST /maintenance/find-duplicates?max_distance=0.2');
    t.deepEqual(warnings, ['scan: {"filed":1}']);
    const [item] = JSON.parse(lines[0]).items;
    t.equal(item.a.body_head, 'Body of A.\nSecond line.\n');
    t.deepEqual(item.b.path_moved, {from: 'b.md', to: 'b2.md'});
    t.matchString(item.b.body_head, /^<unreadable: 404 /);
  } finally {
    await done();
  }
});

const decide = (dir, decisions) => {
  const file = join(dir, 'decisions.json');
  writeFileSync(file, JSON.stringify({decisions}));
  return file;
};

const claimed = async (setup, holder = 'h1') => {
  await setup.triage(['prepare', 'tag_suggestion', '--claim', `--holder=${holder}`]);
  return worksheetPathFor(holder, setup.env);
};

test('resolve sends the batch with the claim token, reopens the skips, and writes the report', async t => {
  const setup = await setUp(TAG_ROWS);
  const {dir, env, store, server, triage, lines, calls, done} = setup;
  try {
    const worksheet = await claimed(setup);
    const token = store.get('s1').token;
    const decisions = decide(dir, {s1: 'accept', s2: 'reject', s3: 'defer'});
    const from = server.requests.length;
    const started = new Date().toISOString();
    t.equal(
      await triage([
        'resolve',
        'tag_suggestion',
        `--worksheet=${worksheet}`,
        `--decisions=${decisions}`
      ]),
      0
    );
    t.deepEqual(calls(from), ['POST /suggestions/resolve-batch', 'POST /suggestions/s3/reopen']);
    t.deepEqual(server.requests[from].json, {
      resolved_by: 'h1',
      claim_token: token,
      items: [
        {id: 's1', decision: 'accept'},
        {id: 's2', decision: 'reject'}
      ]
    });
    t.deepEqual(server.requests[from + 1].json, {claim_token: token});
    t.deepEqual(
      ['s1', 's2', 's3'].map(id => store.get(id).status),
      ['accepted', 'rejected', 'pending']
    );
    const report = JSON.parse(lines.at(-1));
    t.match(report, {
      kind: 'tag_suggestion',
      resolved_by: 'h1',
      accepted: 1,
      rejected: 1,
      skipped: 1,
      reopened: ['s3'],
      failures: [],
      report_file: reportPathFor('h1', env)
    });
    t.ok(report.resolved_at >= started, 'resolved_at is this run');
    t.deepEqual(JSON.parse(readFileSync(reportPathFor('h1', env), 'utf8')), report);
  } finally {
    await done();
  }
});

test('a claim that lapsed before resolve: the batch lands, and a skip reads as released', async t => {
  const setup = await setUp(TAG_ROWS);
  const {dir, triage, lines, lapse, store, done} = setup;
  try {
    const worksheet = await claimed(setup);
    for (const id of ['s1', 's2', 's3']) lapse(id);
    const decisions = decide(dir, {s1: 'accept', s2: 'reject', s3: null});
    t.equal(
      await triage([
        'resolve',
        'tag_suggestion',
        `--worksheet=${worksheet}`,
        `--decisions=${decisions}`
      ]),
      0
    );
    const report = JSON.parse(lines.at(-1));
    t.match(report, {accepted: 1, rejected: 1, reopened: ['s3'], failures: []});
    t.equal(store.get('s3').status, 'pending');
  } finally {
    await done();
  }
});

test('a claim taken before resolve: its items fail, the report is still written, exit 1', async t => {
  const setup = await setUp(TAG_ROWS);
  const {dir, env, triage, lines, take, store, done} = setup;
  try {
    const worksheet = await claimed(setup);
    take('s1', 'other');
    take('s3', 'h1');
    const decisions = decide(dir, {s1: 'accept', s2: 'reject', s3: 'skip'});
    t.equal(
      await triage([
        'resolve',
        'tag_suggestion',
        `--worksheet=${worksheet}`,
        `--decisions=${decisions}`
      ]),
      1
    );
    const report = JSON.parse(lines.at(-1));
    t.match(report, {accepted: 0, rejected: 1, skipped: 1, reopened: []});
    t.deepEqual(
      report.failures.map(f => [f.where, f.status, f.code]),
      [
        ['resolve:s1', 200, 'claimed_by_other'],
        ['reopen:s3', 409, 'claimed_by_other']
      ]
    );
    t.deepEqual(
      ['s1', 's3'].map(id => [store.get(id).status, store.get(id).claimed_by]),
      [
        ['claimed', 'other'],
        ['claimed', 'h1']
      ],
      "the other claims' items are untouched"
    );
    t.deepEqual(JSON.parse(readFileSync(reportPathFor('h1', env), 'utf8')), report);
  } finally {
    await done();
  }
});

const NEW_TAG_ROWS = [
  ['t1', 'contract', 'r1', 'a.md'],
  ['t2', 'contract', 'r2', 'b.md'],
  ['t3', 'fresh', 'r3', 'c.md'],
  ['t4', 'dup', 'r4', 'd.md'],
  ['t5', 'junk', 'r5', 'e.md'],
  ['t6', 'later', 'r6', 'f.md']
].map(([id, tag, recordId, path]) => ({
  id,
  kind: 'new_tag',
  status: 'pending',
  payload: {tag, record_id: recordId, file_path: path},
  context: {records: {[recordId]: record(path, id)}, tag: null}
}));

test('resolve new_tag: a tag the taxonomy has already is accepted in the batch', async t => {
  const conflict = {status: 409, body: {code: 'conflict', error: 'already in the taxonomy'}};
  const setup = await setUp(NEW_TAG_ROWS, {
    'POST /tags/nearest': {body: {queries: [{exact: null, items: []}]}},
    'POST /tags/taxonomy': ({json}) =>
      json.tag === 'contract' ? conflict : {body: {linked: 1, accepted: 1}},
    'POST /tags/aliases': conflict,
    'PATCH /tags/taxonomy/duplicates': {body: {}},
    'DELETE /sections/r5/tags/junk': {body: {tags: ['kept']}}
  });
  const {dir, env, store, server, triage, lines, calls, done} = setup;
  try {
    await triage(['prepare', 'new_tag', '--claim', '--holder=h2']);
    const worksheet = worksheetPathFor('h2', env);
    const token = store.get('t1').token;
    const decisions = decide(dir, {
      contract: {action: 'taxonomy'},
      fresh: {action: 'taxonomy', description: 'New.'},
      dup: {action: 'alias', canonical: 'duplicates', description: 'Broader.'},
      junk: {action: 'reject'},
      later: null
    });
    const from = server.requests.length;
    t.equal(
      await triage(['resolve', 'new_tag', `--worksheet=${worksheet}`, `--decisions=${decisions}`]),
      0
    );
    t.deepEqual(calls(from), [
      'POST /tags/taxonomy',
      'POST /tags/taxonomy',
      'POST /tags/aliases',
      'PATCH /tags/taxonomy/duplicates',
      'DELETE /sections/r5/tags/junk',
      'POST /suggestions/resolve-batch',
      'POST /suggestions/t6/reopen'
    ]);
    const sent = server.requests.slice(from).map(r => r.json);
    t.deepEqual(sent.slice(0, 4), [
      {tag: 'contract'},
      {tag: 'fresh', description: 'New.'},
      {alias: 'dup', canonical: 'duplicates'},
      {description: 'Broader.'}
    ]);
    t.deepEqual(
      sent[5],
      {
        resolved_by: 'h2',
        claim_token: token,
        items: [
          {id: 't1', decision: 'accept'},
          {id: 't2', decision: 'accept'},
          {id: 't4', decision: 'accept'},
          {id: 't5', decision: 'reject'}
        ]
      },
      "conflict on the add or the alias accepts the tag's items; the add that landed accepted its own"
    );
    t.deepEqual(sent[6], {claim_token: token});
    const report = JSON.parse(lines.at(-1));
    t.deepEqual(
      [report.accepted, report.rejected, report.skipped, report.reopened, report.failures],
      [4, 1, 1, ['t6'], []]
    );
    t.deepEqual(report.taxonomy_added, [{tag: 'fresh', linked: 1, auto_accepted: 1}]);
    t.deepEqual(report.aliased, []);
    t.deepEqual(report.descriptions_updated, [{tag: 'duplicates', description: 'Broader.'}]);
    t.deepEqual(report.tags_stripped, [{tag: 'junk', record: 'e.md', remaining: ['kept']}]);
    t.deepEqual(
      ['t1', 't2', 't4', 't5', 't6'].map(id => store.get(id).status),
      ['accepted', 'accepted', 'accepted', 'rejected', 'pending']
    );
  } finally {
    await done();
  }
});

const pair = (id, [aId, aPath], [bId, bPath], bMissing = false) => ({
  id,
  kind: 'duplicate',
  status: 'pending',
  payload: {a_record: aId, b_record: bId, a_path: aPath, b_path: bPath, distance: 0.04},
  context: {
    records: {[aId]: record(aPath, aId), ...(bMissing ? {} : {[bId]: record(bPath, bId)})}
  }
});

const DUP_ROWS = [
  pair('d1', ['r1', 'n/1.md'], ['r2', 'n/2.md']),
  pair('d2', ['rA', 'n/a.md'], ['rB', 'n/b.md']),
  pair('d3', ['r3', 'n/3.md'], ['r4', 'n/4.md']),
  pair('d4', ['r5', 'n/5.md'], ['r6', 'n/6.md']),
  pair('d5', ['r7', 'n/7.md'], ['r8', 'n/8.md']),
  pair('d6', ['r9', 'n/9.md'], ['r0', 'n/0.md'], true)
];

test('resolve duplicate: related links both notes, a merge candidate is released', async t => {
  const setup = await setUp(DUP_ROWS, {
    'PATCH /sections/rA/fm': {body: {}},
    'PATCH /sections/rB/fm': {body: {}}
  });
  const {dir, env, store, server, triage, lines, calls, done} = setup;
  try {
    await triage(['prepare', 'duplicate', '--claim', '--holder=h3']);
    const worksheet = worksheetPathFor('h3', env);
    const resolve = decisions =>
      triage([
        'resolve',
        'duplicate',
        `--worksheet=${worksheet}`,
        `--decisions=${decide(dir, decisions)}`
      ]);
    const from = server.requests.length;
    const e = await t.rejects(resolve({d6: 'related'}));
    t.equal(e.exitCode, 3);
    t.matchString(e.message, /related decision for d6: a record no longer exists/);
    t.equal(server.requests.length, from, 'nothing sent');

    t.equal(
      await resolve({
        d1: 'reject',
        d2: 'related',
        d3: 'merge-candidate',
        d4: {action: 'contradiction', note: 'They disagree.'},
        d5: 'related'
      }),
      1
    );
    t.deepEqual(calls(from), [
      'PATCH /sections/rA/fm',
      'PATCH /sections/rB/fm',
      'PATCH /sections/r7/fm',
      'PATCH /sections/r8/fm',
      'POST /suggestions/resolve-batch',
      'POST /suggestions/d3/reopen',
      'POST /suggestions/d6/reopen',
      'POST /suggestions/d5/reopen'
    ]);
    t.deepEqual(server.requests[from].json, {
      ops: [{op: 'add', path: '/related', value: '[[n/b]]'}]
    });
    t.deepEqual(server.requests[from + 1].json, {
      ops: [{op: 'add', path: '/related', value: '[[n/a]]'}]
    });
    t.deepEqual(
      server.requests[from + 4].json.items,
      [
        {id: 'd1', decision: 'reject'},
        {id: 'd2', decision: 'accept'},
        {id: 'd4', decision: 'reject'}
      ],
      'd5, whose link failed, is left out of the batch'
    );
    const report = JSON.parse(lines.at(-1));
    t.deepEqual(
      [report.accepted, report.rejected, report.skipped, report.reopened],
      [1, 2, 2, ['d3', 'd6', 'd5']],
      'd5, both of whose links failed, is skipped once and released'
    );
    t.deepEqual(
      report.failures.map(f => [f.where, f.status, f.code]),
      [
        ['related:d5', 404, 'route_not_found'],
        ['related:d5', 404, 'route_not_found']
      ]
    );
    t.deepEqual(report.merge_candidates, [{id: 'd3', a: 'n/3.md', b: 'n/4.md', distance: 0.04}]);
    t.deepEqual(report.contradictions, [
      {id: 'd4', a: 'n/5.md', b: 'n/6.md', note: 'They disagree.'}
    ]);
    t.deepEqual(report.related_added, [{a: 'n/a.md', b: 'n/b.md'}], 'no pair whose link failed');
    t.deepEqual(
      ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map(id => store.get(id).status),
      ['rejected', 'accepted', 'pending', 'rejected', 'pending', 'pending']
    );
  } finally {
    await done();
  }
});

test('decisions refused before any write: exit 3, nothing sent', async t => {
  const setup = await setUp([...TAG_ROWS, ...EDGE_ROWS], EDGE_FM);
  const {dir, server, triage, done} = setup;
  try {
    const worksheet = await claimed(setup);
    const from = server.requests.length;
    const resolve = (kind, decisions, file = worksheet) =>
      triage(['resolve', kind, `--worksheet=${file}`, `--decisions=${decide(dir, decisions)}`]);
    let e = await t.rejects(resolve('tag_suggestion', {s1: 'accept', zz: 'reject'}));
    t.equal(e.exitCode, 3);
    t.matchString(e.message, /not in the worksheet: zz$/);
    e = await t.rejects(resolve('tag_suggestion', {s1: 'maybe'}));
    t.equal(e.exitCode, 3);
    e = await t.rejects(resolve('edge_type', {s1: 'accept'}));
    t.matchString(e.message, /worksheet is for kind tag_suggestion, not edge_type/);

    const out = join(dir, 'edges.json');
    await triage(['prepare', 'edge_type', `--out=${out}`]);
    e = await t.rejects(resolve('edge_type', {e1: 'cousin-of'}, out));
    t.matchString(e.message, /unknown edge decision "cousin-of"/);
    t.notOk(
      server.requests.slice(from).some(r => r.method !== 'GET'),
      'no write reached the server'
    );
  } finally {
    await done();
  }
});

test("release reopens what the worksheet's token still holds", async t => {
  const setup = await setUp(TAG_ROWS);
  const {store, server, triage, lines, lapse, take, calls, done} = setup;
  try {
    await claimed(setup);
    lapse('s2');
    take('s2', 'h1');
    take('s3', 'other');
    const from = server.requests.length;
    t.equal(await triage(['release', 'tag_suggestion', '--holder=h1']), 0);
    t.deepEqual(calls(from), [
      'GET /suggestions?kind=tag_suggestion&status=claimed&limit=100',
      'POST /suggestions/s1/reopen',
      'POST /suggestions/s2/reopen'
    ]);
    t.deepEqual(lines.at(-1), 'released 1 of 2 claimed by h1');
    t.deepEqual(
      ['s1', 's2', 's3'].map(id => store.get(id).status),
      ['pending', 'claimed', 'claimed']
    );
    await t.rejects(triage(['release', 'tag_suggestion']), TypeError);
    const e = await t.rejects(triage(['release', 'tag_suggestion', '--holder=nobody']), TypeError);
    t.matchString(e.message, /^release: no readable worksheet at /);
  } finally {
    await done();
  }
});

test('usage errors are TypeErrors, sent before any call; no key is refused too', async t => {
  const {server, triage, lines, done} = await setUp();
  try {
    for (const argv of [
      [],
      ['triage', 'new_tag'],
      ['prepare', 'bogus'],
      ['prepare', 'new_tag', '--limit=0'],
      ['prepare', 'new_tag', '--limit=101'],
      ['prepare', 'new_tag', '--nope'],
      ['prepare', 'new_tag', '--scan'],
      ['resolve', 'new_tag', '--worksheet=w.json']
    ]) {
      await t.rejects(triage(argv), TypeError, argv.join(' ') || '(nothing)');
    }
    const e = await t.rejects(triage(['prepare', 'new_tag'], {PROGRAM_CLERK_KEY: ''}));
    t.notOk(e instanceof TypeError);
    t.matchString(e.message, /^no key/);
    t.equal(server.requests.length, 0);
    t.equal(await triage(['--help']), 0);
    t.deepEqual(lines, [USAGE]);
  } finally {
    await done();
  }
});

test('a failed call names its status and code; the ApiError rides on cause', async t => {
  const {triage, done} = await setUp([], {
    'POST /suggestions/claim': {status: 409, body: {code: 'busy', error: 'come back later'}}
  });
  try {
    const e = await t.rejects(triage(['prepare', 'new_tag', '--claim']));
    t.equal(e.message, '409 busy — come back later');
    t.ok(e.cause instanceof ApiError);
    t.deepEqual([e.cause.status, e.cause.code], [409, 'busy']);
  } finally {
    await done();
  }
});

const ENTRY = fileURLToPath(
  new URL('../plugins/program-clerk/scripts/sweep/triage.mjs', import.meta.url)
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
  const setup = await setUp([...TAG_ROWS, ...EDGE_ROWS], EDGE_FM);
  const {dir, env, take, done} = setup;
  const all = {...process.env, ...env};
  for (const name of Object.keys(all)) if (/^CLAUDE_PLUGIN_OPTION_/.test(name)) delete all[name];
  try {
    let r = await runEntry(['prepare', 'edge_type'], all);
    t.deepEqual([r.code, r.stderr], [0, '']);
    t.equal(JSON.parse(r.stdout).items.length, 2);

    r = await runEntry(['prepare', 'nope'], all);
    t.equal(r.code, 2);
    t.matchString(r.stderr, /^kind must be one of /);

    const worksheet = await claimed(setup);
    r = await runEntry(
      [
        'resolve',
        'tag_suggestion',
        `--worksheet=${worksheet}`,
        `--decisions=${decide(dir, {zz: 'accept'})}`
      ],
      all
    );
    t.deepEqual([r.code, r.stdout], [3, '']);
    t.matchString(r.stderr, /not in the worksheet: zz/);

    take('s2', 'other');
    r = await runEntry(
      [
        'resolve',
        'tag_suggestion',
        `--worksheet=${worksheet}`,
        `--decisions=${decide(dir, {s1: 'accept', s2: 'accept', s3: 'accept'})}`
      ],
      all
    );
    t.equal(r.code, 1);
    t.match(JSON.parse(r.stdout), {accepted: 2, failures: [{where: 'resolve:s2'}]});
  } finally {
    await done();
  }
});
