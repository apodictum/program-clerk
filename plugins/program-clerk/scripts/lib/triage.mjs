// The triage passes' paperwork, which `scripts/sweep/triage.mjs` runs: list or claim, gather each
// item's context, guard against moved paths, assemble the batch, resolve, and report. The agent
// writes only the judgment, a decisions map over the worksheet this prints.

import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {STATUS_CODES} from 'node:http';
import {dirname} from 'node:path';
import {NO_KEY, connectionOf} from './common.mjs';
import {jsonOf, request} from './http.mjs';
import {reportPathFor, worksheetPathFor} from './sweep-files.mjs';
import {NEIGHBOR_KEEP, NEIGHBOR_WINDOW, nearestTags, neighborPrefixes} from './tag-distance.mjs';

export const KINDS = ['new_tag', 'tag_suggestion', 'edge_type', 'duplicate'];
const EDGE_TYPES = [
  'supersedes',
  'revises',
  'derived-from',
  // an alias the server stores as derived-from with the edge flipped
  'basis-for',
  'applies-to',
  'contradicts',
  'related-to'
];

export const USAGE = `usage:
  triage.mjs prepare <kind> [--limit=N] [--claim] [--holder=H] [--ttl=S] [--scan[=DIST]] [--out=FILE]
  triage.mjs resolve <kind> --worksheet=FILE --decisions=FILE [--label=L] [--dry-run]
  triage.mjs release <kind> --holder=H | --worksheet=FILE
kinds: ${KINDS.join(' | ')}`;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// Exit 3: refused before the first write, so the queue is as it was.
const refused = message => Object.assign(new Error(message), {exitCode: 3});

/** The command, the kind, and the options; a TypeError names what is wrong with them. */
export const optionsOf = argv => {
  const [command, kind, ...rest] = argv;
  if (!['prepare', 'resolve', 'release'].includes(command)) {
    throw new TypeError(command ? `unknown command: ${command}\n${USAGE}` : USAGE);
  }
  if (!KINDS.includes(kind)) {
    throw new TypeError(`kind must be one of ${KINDS.join(', ')}\n${USAGE}`);
  }
  const opts = {
    limit: 25,
    claim: false,
    holder: null,
    ttl: null,
    scan: null,
    out: null,
    worksheet: null,
    decisions: null,
    label: null,
    dryRun: false
  };
  for (const arg of rest) {
    const at = arg.indexOf('=');
    const [flag, value] = at < 0 ? [arg, null] : [arg.slice(0, at), arg.slice(at + 1)];
    if (flag === '--limit') opts.limit = +value;
    else if (flag === '--claim') opts.claim = true;
    else if (flag === '--holder') opts.holder = value;
    else if (flag === '--ttl') opts.ttl = +value;
    else if (flag === '--scan') opts.scan = value ? +value : 0.1;
    else if (flag === '--out') opts.out = value;
    else if (flag === '--worksheet') opts.worksheet = value;
    else if (flag === '--decisions') opts.decisions = value;
    else if (flag === '--label') opts.label = value;
    else if (flag === '--dry-run') opts.dryRun = true;
    else throw new TypeError(`unknown option: ${arg}\n${USAGE}`);
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 100) {
    throw new TypeError('--limit must be 1..100');
  }
  return {command, kind, opts};
};

const pool = async (jobs, width = 6) => {
  const results = new Array(jobs.length);
  let next = 0;
  const work = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({length: Math.min(width, jobs.length)}, work));
  return results;
};

const brief = (context, id) => {
  const record = context?.records?.[id];
  if (!record) return {record_id: id, record_missing: true};
  return {
    record_id: id,
    file_path: record.file_path,
    title: record.title,
    type: record.type,
    status: record.status,
    updated: record.updated,
    summary: record.summary
  };
};

// A payload's path is the one at filing time; a write to it after a move would bring the old note
// back, so every write takes the current path.
const moved = (payloadPath, briefRecord) =>
  briefRecord.file_path && payloadPath !== briefRecord.file_path
    ? {from: payloadPath, to: briefRecord.file_path}
    : undefined;

const stripWikilink = s => s.replace(/^\[\[/, '').replace(/\]\]$/, '');
const pathKey = p => p.replace(/\.md$/, '');

// An exact path wins over a basename hit, wherever it sits; a basename stands in only when a
// single entry has it, since names like decisions and queue repeat in every project folder.
const priorOf = (classifications, toPath) => {
  const want = pathKey(toPath);
  const basenameHits = [];
  for (const [key, type] of Object.entries(classifications)) {
    const got = pathKey(stripWikilink(key));
    if (got === want) return type;
    if (got.split('/').pop() === want.split('/').pop()) basenameHits.push(type);
  }
  return basenameHits.length === 1 ? basenameHits[0] : undefined;
};

// A tag_suggestion's companion is the new_tag row for the same tag, whose status the pass's rule
// keys on. An accepted one is in the taxonomy, which `in_taxonomy` shows already; the list route
// has no tag filter, so the join is here.
const COMPANION_STATUSES = ['rejected', 'pending'];
const COMPANION_PAGE_CAP = 40;

const isSkip = decision =>
  decision === null || decision === undefined || decision === 'skip' || decision === 'defer';

const writeJson = (path, value) => {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
};

const today = () => new Date().toISOString().slice(0, 10);

/** Runs one command; resolves to the exit code, 1 when a resolve recorded failures. */
export const run = async (
  argv,
  {env = process.env, out = text => console.log(text), warn = text => console.error(text)} = {}
) => {
  if (argv[0] === '--help' || argv[0] === '-h') {
    out(USAGE);
    return 0;
  }
  const {command, kind, opts} = optionsOf(argv);
  const conn = connectionOf(env);
  if (conn === null) throw new Error(NO_KEY);

  const api = async (method, path, body) => {
    const answer = await request(conn, path, {method, body, env});
    if (answer === null) throw new Error(`no answer on ${method} ${path}`);
    const json = jsonOf(answer.text);
    if (answer.status < 200 || answer.status > 299) {
      throw new ApiError(
        answer.status,
        json?.code ?? 'http_error',
        json?.error ?? `${answer.status} ${STATUS_CODES[answer.status] ?? ''} on ${method} ${path}`
      );
    }
    return json ?? answer.text;
  };

  const bodyHead = async path => {
    try {
      const text = await api('GET', `/vault/${path}`);
      const start =
        typeof text === 'string' && text.startsWith('---\n') ? text.indexOf('\n---\n', 4) + 5 : 0;
      const head = String(text).slice(start).trimStart();
      const lines = head.split(/\r?\n/).slice(0, 30).join('\n');
      return lines.length > 1500 ? lines.slice(0, 1500) + '…' : lines;
    } catch (error) {
      return `<unreadable: ${error.message}>`;
    }
  };

  const companionNewTags = async wanted => {
    const want = new Set(wanted),
      rows = new Map();
    let truncated = false;
    if (!want.size) return {rows, truncated};
    for (const status of COMPANION_STATUSES) {
      let offset = 0;
      for (let page = 0; ; ++page) {
        if (page >= COMPANION_PAGE_CAP) {
          truncated = true;
          break;
        }
        const response = await api(
          'GET',
          `/suggestions?kind=new_tag&status=${status}&limit=100&offset=${offset}`
        );
        const batch = response.items ?? [];
        if (!batch.length) break;
        for (const row of batch) {
          const tag = row.payload?.tag;
          if (!want.has(tag)) continue;
          if (!rows.has(tag)) rows.set(tag, []);
          rows.get(tag).push({
            status: row.status,
            suggestion_id: row.id,
            record_id: row.payload?.record_id ?? null,
            file_path: row.payload?.file_path ?? null,
            resolved_by: row.resolved_by ?? null,
            resolved_at: row.resolved_at ?? null
          });
        }
        // by what came back, never the limit asked: the server caps a page
        offset += batch.length;
        if (offset >= (response.total ?? offset)) break;
      }
    }
    return {rows, truncated};
  };

  const prepare = async () => {
    if (opts.scan !== null) {
      if (kind !== 'duplicate') throw new TypeError('--scan only applies to duplicate');
      const scan = await api('POST', `/maintenance/find-duplicates?max_distance=${opts.scan}`);
      warn(`scan: ${JSON.stringify(scan)}`);
    }

    let items,
      holder = null,
      claimed = false,
      claimToken = null,
      totalPending;
    if (opts.claim) {
      holder = opts.holder ?? `triage-${kind}-${today()}-${Math.random().toString(36).slice(2, 7)}`;
      const response = await api('POST', '/suggestions/claim?expand=context', {
        kind,
        holder,
        limit: opts.limit,
        ...(opts.ttl ? {ttl_seconds: opts.ttl} : {})
      });
      items = response.items;
      claimed = response.claimed > 0;
      claimToken = response.claim_token ?? null;
      totalPending = response.remaining_pending + response.claimed;
    } else {
      const response = await api(
        'GET',
        `/suggestions?kind=${kind}&status=pending&limit=${opts.limit}&expand=context`
      );
      items = response.items;
      totalPending = response.total;
    }

    // Concurrent sub-agents share one session folder, so a claimed pass's default file is named by
    // its holder, which is unique to the agent.
    if (opts.claim && !opts.out && holder) opts.out = worksheetPathFor(holder, env);

    const worksheet = {
      kind,
      generated_at: new Date().toISOString(),
      claimed,
      holder: claimed ? holder : null,
      claim_token: claimed ? claimToken : null,
      total_pending: totalPending,
      items: [],
      decisions_template: {}
    };

    if (kind === 'new_tag') {
      const groups = new Map();
      for (const item of items) {
        const tag = item.payload.tag;
        if (!groups.has(tag)) {
          groups.set(tag, {tag, taxonomy: item.context?.tag ?? null, records: []});
        }
        const record = brief(item.context, item.payload.record_id);
        groups.get(tag).records.push({
          suggestion_id: item.id,
          ...record,
          ...(record.file_path ? {path_moved: moved(item.payload.file_path, record)} : {})
        });
      }
      const prefixNeighbors = async group => {
        const found = new Map();
        const windows = [];
        const fetchWindow = async prefix => {
          const query = `/tags?prefix=${encodeURIComponent(prefix)}&limit=${NEIGHBOR_WINDOW}`;
          const response = await api('GET', query);
          for (const entry of response.items) found.set(entry.tag, entry);
          windows.push({prefix, total: response.total, fetched: response.items.length});
          return response.total > response.items.length;
        };
        let truncated = false;
        for (const prefix of neighborPrefixes(group.tag)) {
          if (await fetchWindow(prefix)) truncated = true;
        }
        // A truncated window drops by usage, so the full candidate brings its closest family back.
        if (truncated) await fetchWindow(group.tag);
        group.neighbors = nearestTags(group.tag, [...found.values()]);
        group.neighbor_windows = windows;
      };
      // The server's lookup scores the candidate against every tag's name and description, with
      // exact, alias, and word matches merged in; a server without the route gets prefix windows.
      const lookupNeighbors = async group => {
        let answer;
        try {
          answer = await api('POST', '/tags/nearest', {tags: [group.tag], k: NEIGHBOR_KEEP});
        } catch (error) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
            return false;
          }
          throw error;
        }
        const [query] = answer.queries;
        const rank = new Map(query.items.map((item, i) => [item.tag, i]));
        group.neighbors = nearestTags(group.tag, query.items).sort(
          (x, y) => rank.get(x.tag) - rank.get(y.tag)
        );
        group.exact = query.exact;
        group.neighbor_source = {route: '/tags/nearest', k: NEIGHBOR_KEEP};
        return true;
      };
      await pool(
        [...groups.values()].map(group => async () => {
          if (!(await lookupNeighbors(group))) await prefixNeighbors(group);
          group.count = group.records.length;
        })
      );
      worksheet.items = [...groups.values()];
      for (const group of worksheet.items) worksheet.decisions_template[group.tag] = null;
    } else if (kind === 'tag_suggestion') {
      worksheet.items = items.map(item => {
        const record = brief(item.context, item.payload.record_id);
        return {
          id: item.id,
          tag: item.payload.tag,
          in_taxonomy: item.context?.tag?.in_taxonomy ?? null,
          canonical: item.context?.tag?.canonical,
          tag_description: item.context?.tag?.description,
          record: {
            ...record,
            ...(record.file_path ? {path_moved: moved(item.payload.file_path, record)} : {})
          }
        };
      });
      const {rows: companions, truncated} = await companionNewTags(
        worksheet.items.map(item => item.tag)
      );
      for (const item of worksheet.items) {
        const found = companions.get(item.tag) ?? [];
        item.companion_new_tags = found;
        // rejected outranks pending: it is the status the pass's rule acts on
        item.companion_verdict = found.some(row => row.status === 'rejected')
          ? 'rejected'
          : found.some(row => row.status === 'pending')
            ? 'pending'
            : null;
      }
      if (truncated) worksheet.companion_scan_truncated = true;
      for (const item of worksheet.items) worksheet.decisions_template[item.id] = null;
    } else if (kind === 'edge_type') {
      worksheet.items = items.map(item => {
        const from = brief(item.context, item.payload.from_record);
        const to = brief(item.context, item.payload.to_record);
        return {
          id: item.id,
          snippet: item.payload.context,
          from: {
            ...from,
            ...(from.file_path ? {path_moved: moved(item.payload.from_path, from)} : {})
          },
          to: {...to, ...(to.file_path ? {path_moved: moved(item.payload.to_path, to)} : {})},
          to_path: item.payload.to_path
        };
      });
      // The source note's own `agent.edge_classifications` is the strongest prior a pass has.
      const sources = [
        ...new Set(worksheet.items.filter(i => !i.from.record_missing).map(i => i.from.record_id))
      ];
      const fmMaps = new Map();
      await pool(
        sources.map(id => async () => {
          try {
            const response = await api('GET', `/sections/${id}/fm?exclude=body`);
            fmMaps.set(id, response.frontmatter?.agent?.edge_classifications ?? {});
          } catch {
            fmMaps.set(id, {});
          }
        })
      );
      for (const item of worksheet.items) {
        const prior = priorOf(fmMaps.get(item.from.record_id) ?? {}, item.to_path);
        if (prior !== undefined) item.prior = prior;
        worksheet.decisions_template[item.id] = null;
      }
    } else {
      worksheet.items = await pool(
        items.map(item => async () => {
          const a = brief(item.context, item.payload.a_record);
          const b = brief(item.context, item.payload.b_record);
          return {
            id: item.id,
            distance: item.payload.distance,
            a: {
              ...a,
              ...(a.file_path
                ? {
                    path_moved: moved(item.payload.a_path, a),
                    body_head: await bodyHead(a.file_path)
                  }
                : {})
            },
            b: {
              ...b,
              ...(b.file_path
                ? {
                    path_moved: moved(item.payload.b_path, b),
                    body_head: await bodyHead(b.file_path)
                  }
                : {})
            }
          };
        })
      );
      for (const item of worksheet.items) worksheet.decisions_template[item.id] = null;
    }

    if (opts.out) {
      writeJson(opts.out, worksheet);
      out(
        `worksheet: ${opts.out} — ${worksheet.items.length} item(s), ${totalPending} pending total${claimed ? `, claimed by ${holder}` : ''}`
      );
    } else out(JSON.stringify(worksheet, null, 2));
    return 0;
  };

  const readDecisions = () => {
    const raw = JSON.parse(readFileSync(opts.decisions, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) && raw.decisions
      ? raw.decisions
      : raw;
  };

  const resolve = async () => {
    if (!opts.worksheet || !opts.decisions) {
      throw new TypeError('resolve needs --worksheet and --decisions');
    }
    const worksheet = JSON.parse(readFileSync(opts.worksheet, 'utf8'));
    if (worksheet.kind !== kind)
      throw refused(`worksheet is for kind ${worksheet.kind}, not ${kind}`);
    const decisions = readDecisions();
    const label = worksheet.holder ?? opts.label ?? `triage-${today()}`;

    const keys =
      kind === 'new_tag'
        ? new Map(worksheet.items.map(item => [item.tag, item]))
        : new Map(worksheet.items.map(item => [item.id, item]));
    const unknown = Object.keys(decisions).filter(key => !keys.has(key));
    if (unknown.length) {
      throw refused(`decisions reference keys not in the worksheet: ${unknown.join(', ')}`);
    }

    // Everything is checked before the first write: a refused decisions file leaves the queue as
    // it was.
    const plan = {
      batch: [],
      reopen: [],
      tagOps: [],
      fmPatches: [],
      report: {
        kind,
        resolved_by: label,
        accepted: 0,
        rejected: 0,
        skipped: 0,
        reopened: [],
        failures: [],
        taxonomy_added: [],
        aliased: [],
        descriptions_updated: [],
        tags_stripped: [],
        related_added: [],
        merge_candidates: [],
        contradictions: []
      }
    };
    const relatedOf = new Map();

    const skipItem = item => {
      ++plan.report.skipped;
      if (worksheet.claimed) {
        plan.reopen.push(
          ...(kind === 'new_tag' ? item.records.map(r => r.suggestion_id) : [item.id])
        );
      }
    };

    if (kind === 'new_tag') {
      for (const [tag, item] of keys) {
        const decision = decisions[tag];
        if (isSkip(decision)) {
          skipItem(item);
          continue;
        }
        const action = decision.action;
        if (action === 'taxonomy') {
          plan.tagOps.push({kind: 'taxonomy', tag, description: decision.description, item});
        } else if (action === 'alias') {
          if (!decision.canonical) throw refused(`alias decision for "${tag}" needs a canonical`);
          plan.tagOps.push({
            kind: 'alias',
            tag,
            canonical: decision.canonical,
            description: decision.description,
            item
          });
        } else if (action === 'reject') plan.tagOps.push({kind: 'reject', tag, item});
        else throw refused(`unknown action "${action}" for tag "${tag}"`);
      }
    } else if (kind === 'tag_suggestion') {
      const blocked = [];
      for (const [id, item] of keys) {
        const decision = decisions[id];
        if (isSkip(decision)) {
          skipItem(item);
          continue;
        }
        if (decision === 'accept') {
          if (item.in_taxonomy === false && !item.canonical) blocked.push(`${id} (${item.tag})`);
          plan.batch.push({id, decision: 'accept'});
        } else if (decision === 'reject') plan.batch.push({id, decision: 'reject'});
        else throw refused(`unknown decision "${decision}" for ${id}`);
      }
      if (blocked.length) {
        throw refused(
          `accepting tags not in the taxonomy — add via the new_tag flow first, or defer:\n  ${blocked.join('\n  ')}`
        );
      }
    } else if (kind === 'edge_type') {
      for (const [id, item] of keys) {
        const decision = decisions[id];
        if (isSkip(decision)) {
          skipItem(item);
          continue;
        }
        if (decision === 'reject' || decision === 'cites') {
          plan.batch.push({id, decision: 'reject'});
        } else if (EDGE_TYPES.includes(decision)) {
          plan.batch.push({id, decision: 'accept', edge_type: decision});
        } else {
          throw refused(
            `unknown edge decision "${decision}" for ${id} (valid: ${EDGE_TYPES.join(', ')}, reject, cites, skip)`
          );
        }
      }
    } else {
      for (const [id, item] of keys) {
        const decision = decisions[id];
        if (isSkip(decision)) {
          skipItem(item);
          continue;
        }
        if (decision === 'merge-candidate') {
          plan.report.merge_candidates.push({
            id,
            a: item.a.file_path,
            b: item.b.file_path,
            distance: item.distance
          });
          skipItem(item);
          --plan.report.skipped;
        } else if (decision === 'reject') plan.batch.push({id, decision: 'reject'});
        else if (decision === 'related') {
          if (item.a.record_missing || item.b.record_missing) {
            throw refused(`related decision for ${id}: a record no longer exists`);
          }
          plan.fmPatches.push({
            record: item.a.record_id,
            value: `[[${pathKey(item.b.file_path)}]]`,
            id
          });
          plan.fmPatches.push({
            record: item.b.record_id,
            value: `[[${pathKey(item.a.file_path)}]]`,
            id
          });
          plan.batch.push({id, decision: 'accept'});
          const pair = {a: item.a.file_path, b: item.b.file_path};
          relatedOf.set(id, pair);
          plan.report.related_added.push(pair);
        } else if (decision?.action === 'contradiction') {
          plan.batch.push({id, decision: 'reject'});
          plan.report.contradictions.push({
            id,
            a: item.a.file_path,
            b: item.b.file_path,
            note: decision.note ?? ''
          });
        } else throw refused(`unknown decision ${JSON.stringify(decision)} for ${id}`);
      }
    }

    if (opts.dryRun) {
      out(JSON.stringify({dry_run: true, ...plan, report: undefined}, null, 2));
      return 0;
    }

    const failure = (where, error) =>
      plan.report.failures.push({
        where,
        status: error.status,
        code: error.code,
        message: error.message
      });

    for (const op of plan.tagOps) {
      const ids = op.item.records.map(r => r.suggestion_id);
      try {
        if (op.kind === 'taxonomy' || op.kind === 'alias') {
          try {
            const response =
              op.kind === 'taxonomy'
                ? await api('POST', '/tags/taxonomy', {
                    tag: op.tag,
                    ...(op.description ? {description: op.description} : {})
                  })
                : await api('POST', '/tags/aliases', {alias: op.tag, canonical: op.canonical});
            (op.kind === 'taxonomy' ? plan.report.taxonomy_added : plan.report.aliased).push({
              tag: op.tag,
              ...(op.canonical ? {canonical: op.canonical} : {}),
              linked: response.linked,
              auto_accepted: response.accepted
            });
            plan.report.accepted += response.accepted;
          } catch (error) {
            if (error.code !== 'conflict') throw error;
            // already in the taxonomy, so the add's own accept never fired
            plan.batch.push(...ids.map(id => ({id, decision: 'accept'})));
          }
          if (op.kind === 'alias' && op.description) {
            await api('PATCH', `/tags/taxonomy/${encodeURIComponent(op.canonical)}`, {
              description: op.description
            });
            plan.report.descriptions_updated.push({tag: op.canonical, description: op.description});
          }
        } else {
          for (const record of op.item.records) {
            if (record.record_missing) continue;
            const response = await api(
              'DELETE',
              `/sections/${record.record_id}/tags/${encodeURIComponent(op.tag)}`
            );
            plan.report.tags_stripped.push({
              tag: op.tag,
              record: record.file_path,
              remaining: response.tags
            });
          }
          plan.batch.push(...ids.map(id => ({id, decision: 'reject'})));
        }
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        failure(`${op.kind}:${op.tag}`, error);
      }
    }

    const unlinked = new Set();
    for (const patch of plan.fmPatches) {
      try {
        await api('PATCH', `/sections/${patch.record}/fm`, {
          ops: [{op: 'add', path: '/related', value: patch.value}]
        });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        failure(`related:${patch.id}`, error);
        unlinked.add(patch.id);
      }
    }
    // An item whose link failed on either note is skipped once and released for a later pass,
    // never left claimed until its claim lapses.
    for (const id of unlinked) {
      plan.batch = plan.batch.filter(entry => entry.id !== id);
      plan.report.related_added = plan.report.related_added.filter(p => p !== relatedOf.get(id));
      ++plan.report.skipped;
      if (worksheet.claimed) plan.reopen.push(id);
    }

    for (let i = 0; i < plan.batch.length; i += 100) {
      const items = plan.batch.slice(i, i + 100);
      try {
        const response = await api('POST', '/suggestions/resolve-batch', {
          resolved_by: label,
          ...(worksheet.claim_token ? {claim_token: worksheet.claim_token} : {}),
          items
        });
        plan.report.accepted += response.accepted;
        plan.report.rejected += response.rejected;
        for (const result of response.results) {
          if (result.error) failure(`resolve:${result.id}`, {status: 200, ...result.error});
        }
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        failure('resolve-batch', error);
      }
    }

    // A lapsed claim reads as pending, so its release answers already_pending: released all the same.
    for (const id of plan.reopen) {
      try {
        await api(
          'POST',
          `/suggestions/${id}/reopen`,
          worksheet.claim_token ? {claim_token: worksheet.claim_token} : undefined
        );
      } catch (error) {
        if (!(error instanceof ApiError)) continue;
        if (error.code !== 'already_pending') {
          failure(`reopen:${id}`, error);
          continue;
        }
      }
      plan.report.reopened.push(id);
    }

    plan.report.resolved_at = new Date().toISOString();
    if (worksheet.holder) {
      plan.report.report_file = reportPathFor(worksheet.holder, env);
      writeJson(plan.report.report_file, plan.report);
    }
    out(JSON.stringify(plan.report, null, 2));
    return plan.report.failures.length ? 1 : 0;
  };

  // A holder name can be reused, so the worksheet's token decides what is ours: an item claimed
  // again under the same name answers 409.
  const release = async () => {
    const path = opts.worksheet ?? (opts.holder ? worksheetPathFor(opts.holder, env) : null);
    if (!path) throw new TypeError('release needs --holder or --worksheet');
    let worksheet;
    try {
      worksheet = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new TypeError(`release: no readable worksheet at ${path}`);
    }
    if (!worksheet.claim_token) throw new TypeError(`release: ${path} records no claim token`);
    const response = await api('GET', `/suggestions?kind=${kind}&status=claimed&limit=100`);
    const mine = response.items.filter(item => item.claimed_by === worksheet.holder);
    let released = 0;
    for (const item of mine) {
      try {
        await api('POST', `/suggestions/${item.id}/reopen`, {claim_token: worksheet.claim_token});
        ++released;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
      }
    }
    out(`released ${released} of ${mine.length} claimed by ${worksheet.holder}`);
    return 0;
  };

  try {
    if (command === 'prepare') return await prepare();
    if (command === 'resolve') return await resolve();
    return await release();
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Error(`${error.status} ${error.code} — ${error.message}`, {cause: error});
    }
    throw error;
  }
};
