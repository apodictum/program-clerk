// `/sweep`'s driver: options, the one-shots, the stages in order, floors, and the done report.

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'tape-six';
import {optionsOf, run} from '../plugins/program-clerk/scripts/lib/sweep.mjs';
import {reportPathFor, sweepDir} from '../plugins/program-clerk/scripts/lib/sweep-files.mjs';
import {fakeServer, removeAll, scratch} from './helpers.mjs';

const SESSION = '5eed5eed-0000-4000-8000-000000000001';

/**
 * A server whose counts the test sets: `by` the suggestion kinds, `unenriched` and `folders` the
 * lint's.
 */
const setUp = async () => {
  const dir = scratch();
  const world = {
    by: {},
    unenriched: 0,
    backfill: [],
    oversized: 0,
    oversizedIds: [],
    folders: [],
    pending: {},
    failing: false
  };
  const server = await fakeServer({
    'GET /system/lint': () => ({
      body: {
        ok: !world.failing,
        total_issues: world.failing ? 1 : 0,
        coverage: {
          enrichment: {
            unenriched: world.unenriched,
            unenriched_records: world.backfill,
            folders: world.folders
          }
        },
        checks: {
          oversized_summaries: {
            count: world.oversized,
            samples: world.oversizedIds.map(id => ({id}))
          },
          broken_links: {count: world.failing ? 1 : 0, samples: world.failing ? ['a.md'] : []},
          size_bound: {
            count: 1,
            advisory: true,
            samples: [{file_path: 'big.md', role: 'x', bytes: 9, bound: 1, remedy: 'split'}]
          }
        }
      }
    }),
    'GET /suggestions/summary': () => ({body: {by_kind: world.by}}),
    'POST /maintenance/cleanup-lint': {body: {removed: 0}},
    'POST /maintenance/embed-pending': {body: {embedded: 0}},
    'POST /maintenance/gc-tags': {body: {tags: []}},
    'POST /maintenance/check-edges': {body: {repaired: false}},
    'GET /suggestions': ({url}) => {
      const items = world.pending[url.searchParams.get('kind')] ?? [];
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return {body: {items: items.slice(offset), total: items.length}};
    }
  });
  const env = {
    PROGRAM_CLERK_URL: server.base,
    PROGRAM_CLERK_KEY: 'test-key',
    CLAUDE_CODE_SESSION_ID: SESSION,
    XDG_CACHE_HOME: join(dir, 'cache')
  };
  const sweep = async argv => {
    const lines = [];
    await run(argv, {env, out: text => lines.push(text)});
    return JSON.parse(lines.join('\n'));
  };
  const done = async () => {
    await server.close();
    removeAll(dir);
  };
  return {dir, env, server, world, sweep, done};
};

test('options: kinds by name or alias, and a TypeError for anything else', t => {
  t.deepEqual(optionsOf(['begin', '--include=new_tag,inefficiency_detected']).opts.include, [
    'new_tag',
    'report'
  ]);
  t.deepEqual(optionsOf(['next', '--state=s.json']).opts.state, 's.json');
  t.equal(optionsOf(['begin', '--max-rounds=2']).opts.maxRounds, 2);
  t.throws(() => optionsOf(['start']), TypeError);
  t.throws(() => optionsOf(['begin', '--include=tags']), /unknown kind: tags/);
  t.throws(() => optionsOf(['begin', '--max-passes=0']), TypeError);
  t.throws(() => optionsOf(['begin', '--include-destructive']), /unknown option/);
});

test('a dry run measures and writes nothing', async t => {
  const {env, server, world, sweep, done} = await setUp();
  try {
    world.by = {new_tag: 3, compaction_candidate: 2};
    world.unenriched = 5;
    const plan = await sweep(['begin', '--dry-run', '--exclude=duplicate']);
    t.deepEqual(plan.would_run, ['enrich_backfill', 'new_tag', 'compaction_candidate']);
    t.notOk(plan.action_set.includes('duplicate'));
    t.notOk(
      server.requests.some(r => r.method === 'POST'),
      'no one-shot on a dry run'
    );
    t.notOk(existsSync(sweepDir(env)), 'no state');
  } finally {
    await done();
  }
});

test('begin runs the one-shots, then plans the first stage with work; next moves on and floors', async t => {
  const {env, server, world, sweep, done} = await setUp();
  try {
    world.by = {new_tag: 150, edge_type: 2, report: 0};
    let plan = await sweep(['begin']);
    const posts = server.requests.filter(r => r.method === 'POST').map(r => r.path);
    t.deepEqual(posts.slice(-1), ['/maintenance/check-edges'], 'check-edges after the others');
    t.equal(posts.length, 5);
    t.equal(plan.state, join(sweepDir(env), 'state.json'));
    t.deepEqual(JSON.parse(readFileSync(plan.state, 'utf8')).one_shots.expire_logs, {
      skipped: 'route_absent',
      route: '/maintenance/expire-logs'
    });
    t.match(plan, {status: 'dispatch', round: 1, stage: 2});
    t.equal(plan.dispatch.length, 1);
    t.match(plan.dispatch[0], {kind: 'new_tag', pass: 'tags', count: 150});
    t.equal(plan.dispatch[0].agents.length, 2, 'one agent a hundred items');
    t.matchString(
      plan.dispatch[0].agents[0].holder,
      /^sweep-\d{4}-\d\d-\d\d-[0-9a-f]{6}-new_tag-r1p1$/
    );
    t.equal(plan.estimate_s, 45 + 100 * 5);

    world.by = {new_tag: 0, edge_type: 2};
    plan = await sweep(['next']);
    t.match(plan, {status: 'dispatch', stage: 3});
    t.deepEqual(
      plan.dispatch.map(e => e.kind),
      ['edge_type']
    );

    plan = await sweep(['next']);
    t.equal(plan.status, 'done', 'a count that did not drop is floored, and nothing is left');
    t.deepEqual(plan.floors, {edge_type: 2});
    t.equal(plan.reason, 'converged');
    t.deepEqual(plan.residue, {edge_type: 2});
    t.match(plan.lint, {ok: true, failing: {}});
    t.deepEqual(plan.size_bound, [
      {file_path: 'big.md', role: 'x', bytes: 9, bound: 1, remedy: 'split'}
    ]);
  } finally {
    await done();
  }
});

test('enrichment comes first: backfill chunked, stale frozen at begin and sharded, oversized one an agent', async t => {
  const {world, sweep, done} = await setUp();
  try {
    world.unenriched = 120;
    world.backfill = Array.from({length: 120}, (_, i) => ({file_path: `n/${i}.md`}));
    world.by = {agent_enrichment_stale: 5, new_tag: 1};
    world.pending = {
      agent_enrichment_stale: [
        ...Array.from({length: 5}, (_, i) => ({
          id: `s${i}`,
          payload: {file_path: `s/${i}.md`},
          created: '2000-01-01T00:00:00Z'
        })),
        {id: 'late', payload: {file_path: 's/late.md'}, created: '2999-01-01T00:00:00Z'}
      ]
    };
    world.oversized = 2;
    world.oversizedIds = ['r1', 'r2'];
    const plan = await sweep(['begin']);
    t.match(plan, {status: 'dispatch', stage: 1});
    const byKind = Object.fromEntries(plan.dispatch.map(e => [e.kind, e]));
    t.deepEqual(Object.keys(byKind), ['enrich_backfill', 'enrich_stale', 'enrich_oversized']);
    t.equal(byKind.enrich_backfill.pass, 'enrich');
    t.deepEqual(
      byKind.enrich_backfill.agents.map(a => a.records),
      [50, 50, 20],
      'a backfill past a hundred notes goes out in chunks of fifty'
    );
    t.equal(
      readFileSync(byKind.enrich_backfill.agents[2].records_file, 'utf8').split(/\r?\n/)[0],
      'n/100.md'
    );
    t.deepEqual(
      byKind.enrich_stale.agents.map(a => a.records),
      [4, 1],
      'four stale notes an agent, the one filed after begin left out'
    );
    t.match(byKind.enrich_oversized.agents, [
      {mode: 'refresh', outline: true, records: 1},
      {mode: 'refresh', outline: true, records: 1}
    ]);
    t.equal(readFileSync(byKind.enrich_oversized.agents[1].records_file, 'utf8'), 'r2\n');
    t.equal(plan.estimate_s, null, 'a backfill has no measured rate, so the plan has no estimate');
  } finally {
    await done();
  }
});

test('a stale folder summary is stale enrichment: counted, sharded by the note it composes, once', async t => {
  const {world, sweep, done} = await setUp();
  const folder = (id, stale) => ({
    record_id: id,
    file_path: `p/${id}/_about.md`,
    folder: `p/${id}.md`,
    stale
  });
  try {
    world.folders = [folder('fa', true), folder('fb', false), folder('fc', true)];
    // An oversized summary on a folder's _about.md is a stale suggestion for the same note.
    world.by = {agent_enrichment_stale: 1};
    world.pending = {
      agent_enrichment_stale: [
        {
          id: 's0',
          payload: {record_id: 'fc', file_path: 'p/fc/_about.md'},
          created: '2000-01-01T00:00:00Z'
        }
      ]
    };
    let plan = await sweep(['begin']);
    t.match(plan, {status: 'dispatch', stage: 1});
    const [stale] = plan.dispatch;
    t.match(
      stale,
      {kind: 'enrich_stale', pass: 'enrich', count: 3},
      'counted by source: the suggestion and the two stale folders'
    );
    t.deepEqual(
      stale.agents.map(a => a.records),
      [2],
      'each note once'
    );
    t.equal(readFileSync(stale.agents[0].records_file, 'utf8'), 'p/fc/_about.md\np/fa.md\n');

    world.folders = [folder('fa', false), folder('fb', false), folder('fc', false)];
    world.by = {};
    world.pending = {};
    plan = await sweep(['next']);
    t.match(plan, {status: 'done', reason: 'converged', residue: {}});
  } finally {
    await done();
  }
});

test('compaction lists its candidate folders for the main session, with no agents', async t => {
  const {world, sweep, done} = await setUp();
  try {
    world.by = {compaction_candidate: 1};
    world.pending = {
      compaction_candidate: [{id: 'c1', payload: {folder: 'projects/p/logs'}, created: 'x'}]
    };
    const plan = await sweep(['begin']);
    t.match(plan.dispatch, [{kind: 'compaction_candidate', pass: 'compact', agents: []}]);
    t.deepEqual(plan.dispatch[0].candidates, [{folder: 'projects/p/logs'}]);
    t.equal(plan.estimate_s, null);
  } finally {
    await done();
  }
});

test('a pending set the last pass released back whole is floored at once, its items skipped', async t => {
  const {env, world, sweep, done} = await setUp();
  try {
    world.by = {duplicate: 2};
    let plan = await sweep(['begin']);
    const holder = plan.dispatch[0].agents[0].holder;
    const report = reportPathFor(holder, env);
    mkdirSync(dirname(report), {recursive: true});
    writeFileSync(
      report,
      JSON.stringify({resolved_at: new Date().toISOString(), reopened: ['d1', 'd2']})
    );
    world.by = {duplicate: 1};
    world.pending = {duplicate: [{id: 'd1', payload: {a: 1}, created: 'x'}]};
    world.failing = true;
    plan = await sweep(['next']);
    t.equal(plan.status, 'done');
    t.deepEqual(plan.skipped, {duplicate: [{id: 'd1', payload: {a: 1}, created: 'x'}]});
    t.deepEqual(plan.floors, {duplicate: 1});
    t.match(plan.lint, {ok: false, failing: {broken_links: {count: 1}}});
    const state = JSON.parse(readFileSync(join(sweepDir(env), 'state.json'), 'utf8'));
    t.deepEqual(
      state.skipped.duplicate.map(i => i.id),
      ['d1']
    );
  } finally {
    await done();
  }
});

test('the script runs as a process: a usage error exits 2, no key exits 1', async t => {
  const {env, done} = await setUp();
  const script = fileURLToPath(
    new URL('../plugins/program-clerk/scripts/sweep/sweep.mjs', import.meta.url)
  );
  const runScript = (args, extra) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: {...process.env, ...env, ...extra},
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stderr = '';
      child.stderr.on('data', chunk => (stderr += chunk));
      child.on('error', reject);
      child.on('close', code => resolve({code, stderr}));
    });
  try {
    let r = await runScript(['start'], {});
    t.equal(r.code, 2);
    t.matchString(r.stderr, /^usage:/);
    r = await runScript(['begin', '--dry-run'], {
      PROGRAM_CLERK_KEY: '',
      CLAUDE_PLUGIN_OPTION_KEY: ''
    });
    t.equal(r.code, 1);
    t.matchString(r.stderr, /^no key/);
  } finally {
    await done();
  }
});
