// The sweep's control: every count, stage, pass, floor, and round, kept in a state file, so the
// agent's loop is `begin`, the sub-agents the plan names, `next`, until the plan says done. The
// judgment lives in the sub-agents; every count here is a fresh read, never a remembered one.
//
// Stages, in data-flow order, since an earlier one fills a later one's queue:
//   0 one-shots: cleanup-lint ∥ embed-pending ∥ expire-logs ∥ gc-tags, then check-edges
//   1 enrich_backfill ∥ enrich_stale ∥ enrich_oversized
//   2 new_tag, alone, since it mints the tags the next stage judges against
//   3 tag_suggestion ∥ edge_type
//   4 duplicate
//   5 compaction_candidate
//   6 report, last, so a backlog report is judged against the queue the sweep left
//
// Stale enrichment is frozen at `begin` and sharded, a few notes an agent; a note that goes stale
// mid-sweep waits for the next sweep. A kind whose whole pending set is what the last pass released
// back (the triage harness's report names them) is floored at once, its items listed as skipped.

import {randomBytes} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {NO_KEY, connectionOf} from './common.mjs';
import {request} from './http.mjs';
import {readySweepDir, reportPathFor, sweepDir} from './sweep-files.mjs';

export const STAGES = [
  ['enrich_backfill', 'enrich_stale', 'enrich_oversized'],
  ['new_tag'],
  ['tag_suggestion', 'edge_type'],
  ['duplicate'],
  ['compaction_candidate'],
  ['report']
];
export const ALL_KINDS = STAGES.flat();
const ALIASES = {
  coverage: 'enrich_backfill',
  enrichment: 'enrich_backfill',
  agent_enrichment_stale: 'enrich_stale',
  oversized_summaries: 'enrich_oversized',
  inefficiency_detected: 'report',
  infrastructure_upgrade: 'report'
};
// The reference file under the skill each kind's agents follow.
export const PASS_FOR = {
  enrich_backfill: 'enrich',
  enrich_stale: 'enrich',
  enrich_oversized: 'enrich',
  new_tag: 'tags',
  tag_suggestion: 'tags',
  edge_type: 'edges',
  duplicate: 'duplicates',
  compaction_candidate: 'compact',
  report: 'reports'
};

const PER_AGENT = {enrich_stale: 4, enrich_oversized: 1};
const MAX_STALE_AGENTS = 6;
// Seconds, measured on sweep agents: to an agent's first action, a stale note, a triage item.
const AGENT_START_S = 45;
const PER_ITEM_S = {enrich_stale: 52, enrich_oversized: 52, triage: 5};

export const USAGE = `usage:
  sweep.mjs begin [--state=FILE] [--include=k,k] [--exclude=k,k] [--max-passes=N] [--max-rounds=N] [--dry-run]
  sweep.mjs next [--state=FILE]
kinds: ${ALL_KINDS.join(' | ')}`;

/** The command and its options; a TypeError names what is wrong with them. */
export const optionsOf = argv => {
  const [command, ...rest] = argv;
  if (!['begin', 'next'].includes(command)) throw new TypeError(USAGE);
  const opts = {state: null, include: null, exclude: [], maxPasses: 5, maxRounds: 5, dryRun: false};
  for (const arg of rest) {
    const at = arg.indexOf('=');
    const [flag, value] = at < 0 ? [arg, null] : [arg.slice(0, at), arg.slice(at + 1)];
    const kinds = () => (value ?? '').split(',').map(k => ALIASES[k.trim()] ?? k.trim());
    const count = () => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new TypeError(`${flag} takes a whole number`);
      return n;
    };
    if (flag === '--state') opts.state = value;
    else if (flag === '--include') opts.include = kinds();
    else if (flag === '--exclude') opts.exclude = kinds();
    else if (flag === '--max-passes') opts.maxPasses = count();
    else if (flag === '--max-rounds') opts.maxRounds = count();
    else if (flag === '--dry-run') opts.dryRun = true;
    else throw new TypeError(`unknown option: ${arg}\n${USAGE}`);
  }
  for (const k of [...(opts.include ?? []), ...opts.exclude]) {
    if (!ALL_KINDS.includes(k)) throw new TypeError(`unknown kind: ${k}\n${USAGE}`);
  }
  return {command, opts};
};

const jsonOf = text => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const run = async (
  argv,
  {env = process.env, out = text => console.log(text), now = () => new Date()} = {}
) => {
  const {command, opts} = optionsOf(argv);
  const conn = connectionOf(env);
  if (conn === null) throw new Error(NO_KEY);

  // A route the server may predate answers 404, which skips that one-shot instead of the sweep.
  const api = async (method, path, {optional = false} = {}) => {
    const answer = await request(conn, path, {method, env});
    if (answer === null) throw new Error(`no answer on ${method} ${path}`);
    if (optional && answer.status === 404) return {skipped: 'route_absent', route: path};
    if (answer.status >= 300) {
      throw new Error(`${answer.status} on ${method} ${path}: ${answer.text.slice(0, 300)}`);
    }
    return jsonOf(answer.text);
  };

  const measure = async () => {
    const [lint, summary] = await Promise.all([
      api('GET', '/system/lint'),
      api('GET', '/suggestions/summary')
    ]);
    const by = summary.by_kind ?? {};
    return {
      counts: {
        enrich_backfill: lint.coverage?.enrichment?.unenriched ?? 0,
        enrich_stale: by.agent_enrichment_stale ?? 0,
        new_tag: by.new_tag ?? 0,
        tag_suggestion: by.tag_suggestion ?? 0,
        edge_type: by.edge_type ?? 0,
        duplicate: by.duplicate ?? 0,
        compaction_candidate: by.compaction_candidate ?? 0,
        report: (by.inefficiency_detected ?? 0) + (by.infrastructure_upgrade ?? 0),
        enrich_oversized: lint.checks?.oversized_summaries?.count ?? 0
      },
      lists: {
        backfill: lint.coverage?.enrichment?.unenriched_records ?? [],
        // by record id, which the enrichment reads as the folder a `_about.md` composes
        oversized: (lint.checks?.oversized_summaries?.samples ?? []).map(item => item.id)
      }
    };
  };

  // The lint read fresh at the end, so a sweep never reads done over a failing check; an advisory
  // check counts toward neither, and its lists say what splitting before `begin` left.
  const closingLint = async () => {
    const lint = await api('GET', '/system/lint');
    const failing = Object.fromEntries(
      Object.entries(lint.checks ?? {})
        .filter(([, check]) => check?.count > 0 && !check.advisory)
        .map(([name, {count, samples}]) => [name, {count, samples}])
    );
    return {
      lint: {ok: lint.ok, total_issues: lint.total_issues, failing},
      size_bound: (lint.checks?.size_bound?.samples ?? []).map(
        ({file_path, role, bytes, bound, remedy}) => ({file_path, role, bytes, bound, remedy})
      ),
      ungrouped_pieces: (lint.checks?.ungrouped_pieces?.samples ?? []).map(
        ({file_path, role, ungrouped}) => ({file_path, role, ungrouped})
      ),
      small_splits: (lint.checks?.small_splits?.samples ?? []).map(
        ({file_path, role, bytes, bound}) => ({file_path, role, bytes, bound})
      )
    };
  };

  // Ids the last pass released back, from each holder's report; a report older than the sweep
  // is another sweep's, and an empty set leaves the floor to the counts.
  const reopenedBy = (state, kind) => {
    const ids = new Set();
    for (const holder of state.holders?.[kind] ?? []) {
      let report;
      try {
        report = JSON.parse(readFileSync(reportPathFor(holder, env), 'utf8'));
      } catch {
        continue;
      }
      if (!(report.resolved_at >= state.started)) continue;
      for (const id of report.reopened ?? []) ids.add(id);
    }
    return ids;
  };

  // Paged by the items a page holds, never by the limit asked: the server caps a page.
  const pendingItems = async kind => {
    const items = [];
    for (let offset = 0; ;) {
      const page = await api(
        'GET',
        `/suggestions?kind=${kind}&status=pending&limit=100&offset=${offset}`
      );
      if (!page.items.length) break;
      for (const {id, payload, created} of page.items) items.push({id, payload, created});
      offset += page.items.length;
      if (offset >= page.total) break;
    }
    return items;
  };

  const actionSet = () => (opts.include ?? ALL_KINDS).filter(k => !opts.exclude.includes(k));

  // The nonce keeps two sweeps of one day apart: their holders name worksheet and report files.
  const holderFor = (state, kind, i) =>
    `sweep-${state.started.slice(0, 10)}-${state.nonce}${kind}-r${state.round}p${state.passes[kind]}${i > 0 ? `-${i}` : ''}`;

  const shard = (state, entry, spec, records) => {
    const {kind} = entry;
    const label = kind.replace('enrich_', '');
    const per = PER_AGENT[kind];
    const dir = dirname(state.file);
    for (let i = 0; i < records.length && entry.agents.length < MAX_STALE_AGENTS; i += per) {
      const part = records.slice(i, i + per);
      const file = join(
        dir,
        `sweep-${label}-r${state.round}p${state.passes[kind]}-${entry.agents.length}.txt`
      );
      writeFileSync(file, part.join('\n') + '\n');
      entry.agents.push({
        ...spec,
        records_file: file,
        records: part.length,
        holder: holderFor(state, kind, entry.agents.length)
      });
    }
  };

  const buildDispatch = async (state, kind, count, lists) => {
    state.passes[kind] = (state.passes[kind] ?? 0) + 1;
    const entry = {kind, count, pass: PASS_FOR[kind], agents: []};
    if (kind === 'enrich_backfill') {
      const worklist = lists.backfill;
      if (count > 100 && worklist.length) {
        const chunkSize = 50;
        const maxAgents = 4;
        const dir = dirname(state.file);
        for (let i = 0; i < worklist.length && entry.agents.length < maxAgents; i += chunkSize) {
          const chunk = worklist.slice(i, i + chunkSize);
          const n = entry.agents.length;
          const file = join(dir, `sweep-chunk-r${state.round}p${state.passes[kind]}-${n}.txt`);
          writeFileSync(file, chunk.map(r => r.file_path).join('\n') + '\n');
          entry.agents.push({
            mode: 'backfill',
            records_file: file,
            records: chunk.length,
            holder: holderFor(state, kind, n)
          });
        }
      } else entry.agents.push({mode: 'backfill', limit: 100, holder: holderFor(state, kind, 0)});
    } else if (kind === 'enrich_stale') {
      const frozen = (await pendingItems('agent_enrichment_stale'))
        .filter(item => item.created <= state.started)
        .map(item => item.payload.file_path);
      shard(state, entry, {mode: 'stale'}, frozen);
    } else if (kind === 'enrich_oversized') {
      shard(state, entry, {mode: 'refresh', outline: true}, lists.oversized);
    } else if (kind === 'compaction_candidate') {
      const pending = await api(
        'GET',
        '/suggestions?kind=compaction_candidate&status=pending&limit=100'
      );
      entry.candidates = pending.items.map(item => item.payload);
    } else {
      const shards = Math.min(4, Math.ceil(count / 100));
      for (let i = 0; i < shards; ++i) {
        entry.agents.push({triage_kind: kind, holder: holderFor(state, kind, i), limit: 100});
      }
    }
    return entry;
  };

  const agentSeconds = (kind, agent, count) => {
    if (kind in PER_ITEM_S) return AGENT_START_S + agent.records * PER_ITEM_S[kind];
    if (agent.triage_kind) return AGENT_START_S + Math.min(count, agent.limit) * PER_ITEM_S.triage;
    return null;
  };

  const estimateSeconds = dispatch => {
    const seconds = dispatch.flatMap(entry =>
      entry.agents.map(agent => agentSeconds(entry.kind, agent, entry.count))
    );
    return seconds.length > 0 && seconds.every(s => s !== null) ? Math.max(...seconds) : null;
  };

  const drainable = (state, counts) =>
    actionSet().filter(
      kind => counts[kind] > 0 && (!(kind in state.floors) || counts[kind] > state.floors[kind])
    );

  // Advances through the stages; a plan, or null when the round is complete.
  const plan = async (state, counts, lists) => {
    while (state.stage < STAGES.length) {
      const active = STAGES[state.stage].filter(
        kind =>
          actionSet().includes(kind) &&
          counts[kind] > 0 &&
          !(kind in state.floors && counts[kind] <= state.floors[kind]) &&
          (state.passes[kind] ?? 0) < state.maxPasses
      );
      if (active.length > 0) {
        const dispatch = [];
        state.holders = {};
        for (const kind of active) {
          const entry = await buildDispatch(state, kind, counts[kind], lists);
          if (entry.agents.length === 0 && !entry.candidates) {
            state.floors[kind] = counts[kind];
            continue;
          }
          dispatch.push(entry);
          state.holders[kind] = entry.agents.map(agent => agent.holder).filter(Boolean);
        }
        if (dispatch.length > 0) {
          state.pending = dispatch.map(entry => entry.kind);
          return {
            status: 'dispatch',
            round: state.round,
            stage: state.stage + 1,
            estimate_s: estimateSeconds(dispatch),
            dispatch
          };
        }
      }
      ++state.stage;
    }
    return null;
  };

  const endOfRound = (state, counts) => {
    const round = state.trail.at(-1);
    round.after = {...counts};
    const noChange = ALL_KINDS.every(k => round.before[k] === round.after[k]);
    const residue = drainable(state, counts);
    if (residue.length === 0 || state.round >= state.maxRounds || noChange) {
      return {
        status: 'done',
        reason: residue.length === 0 ? 'converged' : noChange ? 'no_change_round' : 'max_rounds',
        rounds: state.trail,
        floors: state.floors,
        skipped: state.skipped ?? {},
        residue: Object.fromEntries(ALL_KINDS.filter(k => counts[k] > 0).map(k => [k, counts[k]])),
        one_shots: state.one_shots
      };
    }
    ++state.round;
    state.stage = 0;
    state.passes = {};
    state.trail.push({round: state.round, before: {...counts}});
    return null;
  };

  const elapsed = state => Math.round((now().getTime() - Date.parse(state.started)) / 1000);
  const emit = value => out(JSON.stringify(value, null, 2));
  const save = state => writeFileSync(state.file, JSON.stringify(state, null, 2) + '\n');

  if (command === 'begin') {
    const {counts, lists} = await measure();
    if (opts.dryRun) {
      emit({
        dry_run: true,
        action_set: actionSet(),
        counts,
        would_run: actionSet().filter(k => counts[k] > 0),
        ...(await closingLint())
      });
      return;
    }
    const file = resolve(opts.state ?? join(readySweepDir(env), 'state.json'));
    const oneShots = {};
    // expire-logs is a one-shot, not a kind to triage: a log's expiry is settled policy, with
    // nothing to judge, and nothing else drains it.
    [oneShots.cleanup_lint, oneShots.embed_pending, oneShots.expire_logs, oneShots.gc_tags] =
      await Promise.all([
        api('POST', '/maintenance/cleanup-lint'),
        api('POST', '/maintenance/embed-pending'),
        api('POST', '/maintenance/expire-logs', {optional: true}),
        api('POST', '/maintenance/gc-tags', {optional: true})
      ]);
    // After the others, since expiring logs moves paths the stored links point at.
    oneShots.check_edges = await api('POST', '/maintenance/check-edges', {optional: true});
    const state = {
      file,
      started: now().toISOString(),
      nonce: `${randomBytes(3).toString('hex')}-`,
      include: opts.include,
      exclude: opts.exclude,
      maxPasses: opts.maxPasses,
      maxRounds: opts.maxRounds,
      round: 1,
      stage: 0,
      passes: {},
      floors: {},
      holders: {},
      skipped: {},
      pending: [],
      one_shots: oneShots,
      trail: [{round: 1, before: {...counts}}]
    };
    let result = (await plan(state, counts, lists)) ?? endOfRound(state, counts);
    if (!result) {
      const fresh = await measure();
      result = (await plan(state, fresh.counts, fresh.lists)) ?? endOfRound(state, fresh.counts);
    }
    if (result.status === 'done') Object.assign(result, await closingLint());
    save(state);
    emit({state: file, elapsed_s: elapsed(state), ...result});
    return;
  }

  const file = resolve(opts.state ?? join(sweepDir(env), 'state.json'));
  const state = JSON.parse(readFileSync(file, 'utf8'));
  opts.include = state.include;
  opts.exclude = state.exclude;
  const {counts, lists} = await measure();
  // For each kind the last plan dispatched: a pending set the pass released back whole is a floor
  // now, its items named; a count that stopped dropping is a stuck floor; a count above one reopens.
  state.skipped ??= {};
  const floored = {};
  for (const kind of state.pending ?? []) {
    const before = state.trail.at(-1).before[kind];
    const last = state.lastCounts?.[kind] ?? before;
    if (counts[kind] > 0) {
      const reopened = reopenedBy(state, kind);
      if (reopened.size > 0) {
        const pending = await pendingItems(kind);
        if (pending.length > 0 && pending.every(item => reopened.has(item.id))) {
          state.floors[kind] = counts[kind];
          state.skipped[kind] = pending;
          floored[kind] = pending;
          continue;
        }
      }
    }
    if (counts[kind] > 0 && counts[kind] >= last) state.floors[kind] = counts[kind];
    else if (kind in state.floors && counts[kind] > state.floors[kind]) delete state.floors[kind];
  }
  state.lastCounts = {...counts};
  state.pending = [];
  let result = await plan(state, counts, lists);
  if (!result) {
    result = endOfRound(state, counts);
    if (!result) result = await plan(state, counts, lists);
    // the next round had nothing to dispatch
    if (!result) result = endOfRound(state, counts);
  }
  if (result.status === 'dispatch' && Object.keys(floored).length > 0) result.skipped = floored;
  if (result.status === 'done') Object.assign(result, await closingLint());
  save(state);
  emit({state: file, elapsed_s: elapsed(state), ...result});
};
