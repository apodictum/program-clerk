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

/** A server whose counts the test sets: `by` the suggestion kinds, `unenriched` the lint's. */
const setUp = async () => {
  const dir = scratch();
  const world = {by: {}, unenriched: 0, oversized: 0, pending: {}, failing: false};
  const server = await fakeServer({
    'GET /system/lint': () => ({
      body: {
        ok: !world.failing,
        total_issues: world.failing ? 1 : 0,
        coverage: {enrichment: {unenriched: world.unenriched, unenriched_records: []}},
        checks: {
          oversized_summaries: {count: world.oversized, samples: []},
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

test('a dry run measures and writes nothing; enrichment and compaction are never dispatched', async t => {
  const {env, server, world, sweep, done} = await setUp();
  try {
    world.by = {new_tag: 3, compaction_candidate: 2};
    world.unenriched = 5;
    const plan = await sweep(['begin', '--dry-run']);
    t.deepEqual(plan.would_run, ['new_tag']);
    t.notOk(plan.action_set.includes('enrich_backfill'));
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
    world.unenriched = 4;
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
    t.deepEqual(plan.not_dispatched, ['enrich_backfill']);
    t.deepEqual(plan.residue, {enrich_backfill: 4, edge_type: 2});
    t.match(plan.lint, {ok: true, failing: {}});
    t.deepEqual(plan.size_bound, [
      {file_path: 'big.md', role: 'x', bytes: 9, bound: 1, remedy: 'split'}
    ]);
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
