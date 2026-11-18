// The enrichment pass's paperwork, which `scripts/sweep/enrich.mjs` runs. The worklist is the
// server's own, never derived here, so the pass and the lint count the same notes. The agent writes
// only the enrichment content; `apply` checks all of it before the first write.

import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {STATUS_CODES} from 'node:http';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {NO_KEY, connectionOf, fileSafe} from './common.mjs';
import {jsonOf, request} from './http.mjs';
import {sweepDir} from './sweep-files.mjs';
import {pageOf, renderIndex, renderItem} from './worksheet-view.mjs';

const COMMANDS = ['prepare', 'apply', 'release', 'show'];
const COMPLEXITY = ['prose', 'code-heavy', 'tabular', 'mixed', 'hub', 'log-entry'];
const EDGE_TYPES = [
  'cites',
  'supersedes',
  'revises',
  'derived-from',
  // an alias the server stores as derived-from with the edge flipped
  'basis-for',
  'applies-to',
  'contradicts',
  'related-to'
];

export const USAGE = `Usage:
  enrich.mjs prepare [--limit=N] [--stale | --refresh [--outline]] [--full-threshold=F] [--type=T] [--records=FILE] [--holder=H] [--out=FILE]
  enrich.mjs apply --worksheet=FILE --enrichments=FILE [--dry-run]
  enrich.mjs release --worksheet=FILE
  enrich.mjs show --worksheet=FILE [--item=N [--from=C]]`;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// Exit 3: refused before the first write, so every note is as it was.
const refused = message => Object.assign(new Error(message), {exitCode: 3});

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const LIMIT_RANGE = `--limit must be 1..${MAX_LIMIT}`;

const listOf = file =>
  new Set(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
  );

/** The command and its options; a TypeError names what is wrong with them, before any call. */
const optionsOf = argv => {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new TypeError(USAGE);
  const opts = {
    limit: null,
    stale: false,
    refresh: false,
    outline: false,
    fullThreshold: 0.4,
    type: null,
    records: null,
    holder: null,
    out: null,
    worksheet: null,
    enrichments: null,
    dryRun: false,
    item: null,
    from: 0
  };
  for (const arg of rest) {
    const at = arg.indexOf('=');
    const [flag, value] = at < 0 ? [arg, null] : [arg.slice(0, at), arg.slice(at + 1)];
    if (flag === '--limit') opts.limit = +value;
    else if (flag === '--stale') opts.stale = true;
    else if (flag === '--refresh') opts.refresh = true;
    else if (flag === '--outline') opts.outline = true;
    else if (flag === '--full-threshold') opts.fullThreshold = +value;
    else if (flag === '--type') opts.type = value;
    else if (flag === '--records') opts.records = value;
    else if (flag === '--holder') opts.holder = value;
    else if (flag === '--out') opts.out = value;
    else if (flag === '--worksheet') opts.worksheet = value;
    else if (flag === '--enrichments') opts.enrichments = value;
    else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--item') opts.item = +value;
    else if (flag === '--from') opts.from = +value;
    else throw new TypeError(`unknown option: ${arg}\n${USAGE}`);
  }
  if (
    opts.limit !== null &&
    (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_LIMIT)
  ) {
    throw new TypeError(LIMIT_RANGE);
  }
  if (!(opts.fullThreshold >= 0 && opts.fullThreshold <= 1)) {
    throw new TypeError('--full-threshold must be 0..1');
  }
  if (command === 'prepare' && opts.refresh && (!opts.records || opts.stale)) {
    throw new TypeError('--refresh takes its notes from --records, and not with --stale');
  }
  if (command === 'prepare' && opts.outline && !opts.refresh) {
    throw new TypeError('--outline goes with --refresh');
  }
  if (command === 'apply' && (!opts.worksheet || !opts.enrichments)) {
    throw new TypeError('apply needs --worksheet and --enrichments');
  }
  if (command !== 'prepare' && command !== 'apply' && !opts.worksheet) {
    throw new TypeError(`${command} needs --worksheet`);
  }
  return {command, opts};
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

const splitDoc = text => {
  if (typeof text !== 'string' || !text.startsWith('---\n')) return {body: String(text)};
  const end = text.indexOf('\n---\n', 4);
  return end < 0 ? {body: text} : {body: text.slice(end + 5)};
};

const emptyBody = body => {
  const stripped = body.replace(/\s/g, '').toLowerCase();
  return stripped.length === 0 || stripped === 'null';
};

// Code is masked first, as the server's link parser does: a stray `[[` in inline code would
// swallow the text up to the next real link.
const maskCode = text =>
  text
    .replace(/(^|\n)([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?\n\2\3[ \t]*(?=\n|$)/g, s =>
      s.replace(/[^\n]/g, ' ')
    )
    .replace(/`+[^`\n]+?`+/g, s => s.replace(/[^\n]/g, ' '));

const WIKILINK_RE = /\[\[([^\]\n|[]+?)(?:\|[^\]]*)?\]\]/g;

const wikilinks = body => [
  ...new Set([...maskCode(body).matchAll(WIKILINK_RE)].map(m => `[[${m[1].trim()}]]`))
];

// A note's shape without its text, for restating a summary it has outgrown: the notes whose
// summaries pass the lint's bound are the long rolling notes, megabytes of body.
const outlineOf = body => ({
  body_bytes: Buffer.byteLength(body, 'utf8'),
  headings: body
    .split(/\r?\n/)
    .filter(line => /^#{1,2} /.test(line))
    .map(line => line.slice(0, 160))
});

const CLAIM_TTL = {base: 600, perItem: 120, min: 1800, max: 14400};
const NOTE = 'note:';

/** The writes and confirmations an enrichments map asks for; the first fault refuses them all. */
const jobsOf = (worksheet, enrichments) => {
  const byPath = new Map(worksheet.items.map(item => [item.file_path, item]));
  const unknown = Object.keys(enrichments).filter(key => !byPath.has(key));
  if (unknown.length) {
    throw refused(`enrichments reference paths not in the worksheet: ${unknown.join(', ')}`);
  }
  const jobs = [];
  for (const [path, enrichment] of Object.entries(enrichments)) {
    if (enrichment === null) continue;
    const item = byPath.get(path);
    const err = message => {
      throw refused(`${path}: ${message} — nothing written`);
    };
    if (typeof enrichment !== 'object') err('enrichment must be an object or null');
    if (enrichment.summary_holds === true) {
      if (!item.current_agent) {
        err('summary_holds needs an item with current_agent (--stale, --refresh)');
      }
      jobs.push({item, confirm: true});
      continue;
    }
    if (typeof enrichment.summary !== 'string' || enrichment.summary.trim().length < 10) {
      err('summary must be a string (≥ 10 chars)');
    }
    if (
      !Array.isArray(enrichment.key_concepts) ||
      !enrichment.key_concepts.length ||
      enrichment.key_concepts.some(c => typeof c !== 'string')
    ) {
      err('key_concepts must be a non-empty string array');
    }
    if (!COMPLEXITY.includes(enrichment.complexity)) {
      err(`complexity must be one of ${COMPLEXITY.join(', ')}`);
    }
    // `null` on the three optional keys is absent, as the write reads it: an agent writing JSON
    // puts null on a field it has nothing for.
    for (const field of ['tags_suggested', 'related_proposed']) {
      if (
        enrichment[field] != null &&
        (!Array.isArray(enrichment[field]) || enrichment[field].some(v => typeof v !== 'string'))
      ) {
        err(`${field} must be a string array`);
      }
    }
    if (enrichment.edge_classifications != null) {
      if (
        typeof enrichment.edge_classifications !== 'object' ||
        Array.isArray(enrichment.edge_classifications)
      ) {
        err('edge_classifications must be an object of wikilink → edge type');
      }
      const links = new Set(item.body_wikilinks);
      for (const [key, type] of Object.entries(enrichment.edge_classifications)) {
        if (!links.has(key)) {
          err(`edge_classifications key ${key} is not a body wikilink of this note`);
        }
        if (!EDGE_TYPES.includes(type)) {
          err(`edge type "${type}" invalid (valid: ${EDGE_TYPES.join(', ')})`);
        }
      }
    }
    jobs.push({item, enrichment});
  }
  return jobs;
};

const show = (opts, out) => {
  const worksheet = JSON.parse(readFileSync(opts.worksheet, 'utf8'));
  const items = worksheet.items ?? [];
  if (opts.item === null) {
    out(renderIndex(worksheet));
    out(
      `--- ${items.length} items; read each with show --worksheet=${opts.worksheet} --item=N ---`
    );
    return 0;
  }
  if (!Number.isInteger(opts.item) || opts.item < 1 || opts.item > items.length) {
    throw new TypeError(`--item must be 1..${items.length}`);
  }
  if (!Number.isInteger(opts.from) || opts.from < 0) {
    throw new TypeError('--from must be a whole number');
  }
  const text = renderItem(items[opts.item - 1], opts.item, items.length);
  const {page, next, total} = pageOf(text, opts.from);
  out(page);
  if (next !== null) {
    out(
      `--- continued: show --worksheet=${opts.worksheet} --item=${opts.item} --from=${next} (${next} of ${total} characters shown) ---`
    );
  }
  return 0;
};

/** Runs one command; resolves to the exit code, 1 when an apply recorded failures. */
export const run = async (argv, {env = process.env, out = text => console.log(text)} = {}) => {
  if (argv[0] === '--help' || argv[0] === '-h') {
    out(USAGE);
    return 0;
  }
  const {command, opts} = optionsOf(argv);
  if (command === 'show') return show(opts, out);
  // A records list is its own limit unless --limit says fewer: a sweep's shard is prepared whole.
  const wanted = command === 'prepare' && opts.records ? listOf(opts.records) : null;
  const limit = opts.limit ?? wanted?.size ?? DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) throw new TypeError(LIMIT_RANGE);
  const conn = connectionOf(env);
  if (conn === null) throw new Error(NO_KEY);

  const api = async (method, path, body, headers) => {
    const answer = await request(conn, path, {method, body, headers, env});
    if (answer === null) throw new Error(`no answer on ${method} ${path}`);
    const json = jsonOf(answer.text);
    if (answer.status < 200 || answer.status > 299) {
      throw new ApiError(
        answer.status,
        json?.code ?? 'http_error',
        json?.error ?? `${answer.status} ${STATUS_CODES[answer.status] ?? ''} on ${method} ${path}`
      );
    }
    return {
      data: json ?? answer.text,
      etag: answer.headers.get('etag'),
      composed: answer.headers.get('x-program-clerk-composed') === 'true'
    };
  };

  // Partial by design: a note another lease covers comes back `held` and is left out.
  const claimWork = async (holder, paths) => {
    if (!paths.length) return {claim: null, claimed: new Set(), held: []};
    const ttl = Math.min(
      CLAIM_TTL.max,
      Math.max(CLAIM_TTL.min, CLAIM_TTL.base + paths.length * CLAIM_TTL.perItem)
    );
    const {data} = await api('POST', '/leases/claim', {
      holder,
      resources: paths.map(path => NOTE + path),
      ttl_seconds: ttl
    });
    return {
      claim: data.claim_token
        ? {holder, claim_token: data.claim_token, expires_at: data.expires_at}
        : null,
      claimed: new Set(data.claimed.map(resource => resource.slice(NOTE.length))),
      held: data.held.map(h => ({...h, resource: h.resource.slice(NOTE.length)}))
    };
  };

  // A lapsed batch (404) is already free; anything else is reported, never thrown.
  const releaseWork = async claim => {
    try {
      await api('POST', '/leases/release', {holder: claim.holder, claim_token: claim.claim_token});
      return 'released';
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return error.status === 404
        ? 'lapsed'
        : {status: error.status, code: error.code, message: error.message};
    }
  };

  /** The pieces directly in a folder written on or after `since` (a date): its new entries. */
  const changedPieces = async (folder, since) => {
    const dir = folder.folder.slice(0, -'.md'.length) + '/';
    const pieces = [];
    for (let offset = 0; ;) {
      const {data: page} = await api(
        'GET',
        `/sections?file_prefix=${encodeURIComponent(dir)}&updated_since=${since}&sort=file_path_asc&limit=100&offset=${offset}`
      );
      for (const row of page.items) {
        const name = row.file_path.slice(dir.length);
        if (name.includes('/') || name === '_about.md') continue;
        pieces.push({
          file_path: row.file_path,
          title: row.title,
          updated: row.updated,
          body: row.body
        });
      }
      offset += page.items.length;
      if (!page.items.length || offset >= page.total) return pieces;
    }
  };

  /**
   * A folder's item: its `_about.md` record with the composed note's body, or, for a stale summary,
   * the pieces written since it when they are at most the threshold of the note.
   */
  const folderItem = async (folder, record, frontmatter, candidate) => {
    const {body} = splitDoc((await api('GET', `/vault/${folder.folder}`)).data);
    const agent = frontmatter.agent ?? null;
    let pieces = null;
    if (opts.stale && agent?.summary && typeof agent.derived_at === 'string') {
      pieces = await changedPieces(folder, agent.derived_at.slice(0, 10));
      const bytes = pieces.reduce(
        (sum, piece) => sum + Buffer.byteLength(piece.body ?? '', 'utf8'),
        0
      );
      if (bytes > opts.fullThreshold * Buffer.byteLength(body, 'utf8')) pieces = null;
    }
    return {
      record_id: candidate.record_id,
      file_path: record.file_path,
      folder: folder.folder,
      folder_hash: folder.hash,
      pieces: folder.pieces,
      type: record.type,
      title: record.title,
      body_hash: record.body_hash,
      existing_tags: frontmatter.tags ?? [],
      existing_related: frontmatter.related ?? [],
      ...(opts.stale || opts.refresh ? {current_agent: agent} : {}),
      body_wikilinks: wikilinks(record.body ?? ''),
      related_candidates: [],
      ...(pieces
        ? {read: 'folder-delta', changed_pieces: pieces}
        : opts.outline
          ? {read: 'outline', outline: outlineOf(body)}
          : {read: 'full', body})
    };
  };

  const prepare = async () => {
    const {data: lint} = await api('GET', '/system/lint');
    const coverage = lint.coverage?.enrichment;
    if (!coverage) throw new Error('the server reports no coverage.enrichment, so no worklist');

    const listed = r =>
      wanted.has(r.file_path) || wanted.has(r.record_id) || (r.folder && wanted.has(r.folder));
    const folders = new Map((coverage.folders ?? []).map(f => [f.record_id, f]));
    const folderCandidates = keep =>
      [...folders.values()]
        .filter(f => keep(f) && (!wanted || listed(f)))
        .map(f => ({record_id: f.record_id, file_path: f.file_path}));

    let candidates;
    if (opts.refresh) {
      candidates = [];
      const missing = [];
      for (const entry of wanted) {
        if (!entry.endsWith('.md')) {
          candidates.push({record_id: entry});
          continue;
        }
        const folder = [...folders.values()].find(f => f.folder === entry);
        if (folder) {
          candidates.push({record_id: folder.record_id, file_path: folder.file_path});
          continue;
        }
        const {data} = await api(
          'GET',
          `/sections?file_path=${encodeURIComponent(entry)}&fields=record_id,file_path`
        );
        const row = data.items?.[0];
        if (row) candidates.push({record_id: row.record_id, file_path: row.file_path});
        else missing.push(entry);
      }
      if (missing.length) throw new Error(`no note at: ${missing.join(', ')}`);
    } else if (opts.stale) {
      candidates = [];
      let offset = 0;
      while (candidates.length < limit) {
        const {data: page} = await api(
          'GET',
          `/suggestions?kind=agent_enrichment_stale&status=pending&limit=100&offset=${offset}`
        );
        if (!page.items.length) break;
        for (const item of page.items) {
          const candidate = {
            record_id: item.payload.record_id,
            file_path: item.payload.file_path,
            suggestion_id: item.id,
            ...(item.payload.reason ? {reason: item.payload.reason} : {})
          };
          if (!wanted || listed(candidate)) candidates.push(candidate);
        }
        offset += page.items.length;
      }
      const taken = new Set(candidates.map(candidate => candidate.record_id));
      candidates.push(...folderCandidates(f => f.stale && !taken.has(f.record_id)));
    } else if (wanted) {
      candidates = (coverage.unenriched_records ?? []).filter(listed);
      candidates.push(...folderCandidates(f => !f.summary));
    } else {
      candidates = coverage.unenriched_records ?? [];
      if (opts.type) candidates = candidates.filter(r => r.type === opts.type);
      if (!opts.type || opts.type === 'meta') candidates.push(...folderCandidates(f => !f.summary));
    }
    candidates = candidates.slice(0, limit);

    // Each note is claimed at its current path: a payload's path predates a rename.
    const records = new Map();
    await pool(
      candidates.map(candidate => async () => {
        const {data} = await api('GET', `/sections/${candidate.record_id}`);
        records.set(candidate.record_id, data);
      })
    );
    const holder = opts.holder ?? `enrich-${hostname()}-${randomBytes(3).toString('hex')}`;
    const work = await claimWork(holder, [...new Set([...records.values()].map(r => r.file_path))]);
    const unclaimed = [];

    const taxonomy = [];
    for (let offset = 0; ;) {
      const {data: page} = await api('GET', `/tags?limit=100&offset=${offset}`);
      if (!page.items.length) break;
      taxonomy.push(...page.items.map(t => t.tag));
      offset += page.items.length;
    }

    const needsBody = [];
    const items = [];
    await pool(
      candidates.map(candidate => async () => {
        const record = records.get(candidate.record_id);
        if (!work.claimed.has(record.file_path)) {
          unclaimed.push(record.file_path);
          return;
        }
        const {data: fm} = await api('GET', `/sections/${candidate.record_id}/fm?exclude=body`);
        const folder = folders.get(candidate.record_id);
        if (folder) {
          items.push(await folderItem(folder, record, fm.frontmatter, candidate));
          return;
        }
        if (emptyBody(record.body ?? '')) {
          needsBody.push(record.file_path);
          return;
        }
        const links = wikilinks(record.body);
        let delta = null;
        if (opts.stale && fm.frontmatter.agent?.summary) {
          try {
            const {data} = await api('GET', `/sections/${candidate.record_id}/enrichment-delta`);
            if (data.baseline && data.changed_fraction <= opts.fullThreshold) delta = data;
          } catch {
            // no delta: the whole body is read
          }
        }
        // A delta keeps current_agent.related_proposed, which saves the similar-notes call.
        let similar = [];
        if (!delta) {
          try {
            const {data} = await api('GET', `/sections/${candidate.record_id}/similar?k=15`);
            const rows = Array.isArray(data) ? data : (data.items ?? []);
            const known = new Set([
              ...(fm.frontmatter.related ?? []).map(r => r.replace(/^\[\[|\]\]$/g, '')),
              ...links.map(l => l.replace(/^\[\[|\]\]$/g, ''))
            ]);
            similar = rows
              .filter(row => (row.distance ?? 1) <= 0.3)
              .filter(row => !known.has((row.file_path ?? '').replace(/\.md$/, '')))
              .map(row => ({file_path: row.file_path, title: row.title, distance: row.distance}));
          } catch {
            // no candidates: the item goes without them
          }
        }
        items.push({
          record_id: candidate.record_id,
          file_path: record.file_path,
          ...(candidate.file_path && candidate.file_path !== record.file_path
            ? {path_moved: {from: candidate.file_path, to: record.file_path}}
            : {}),
          type: record.type,
          title: record.title,
          body_hash: record.body_hash,
          existing_tags: fm.frontmatter.tags ?? [],
          existing_related: fm.frontmatter.related ?? [],
          ...(opts.stale || opts.refresh
            ? {
                current_agent: fm.frontmatter.agent ?? null,
                suggestion_id: candidate.suggestion_id,
                ...(candidate.reason ? {reason: candidate.reason} : {})
              }
            : {}),
          body_wikilinks: links,
          related_candidates: similar,
          ...(delta
            ? {
                read: 'delta',
                delta: {
                  body_bytes: delta.body_bytes,
                  chunks: delta.chunks,
                  added_bytes: delta.added_bytes,
                  removed_bytes: delta.removed_bytes,
                  changed_fraction: delta.changed_fraction,
                  added_chunks: delta.added_chunks
                }
              }
            : opts.outline
              ? {read: 'outline', outline: outlineOf(record.body)}
              : {read: 'full', body: record.body})
        });
      })
    );
    items.sort((a, b) => a.file_path.localeCompare(b.file_path));
    const deltas = items.filter(item => item.read !== 'full').length;

    const worksheet = {
      mode: opts.refresh ? 'refresh' : opts.stale ? 'stale' : 'missing',
      generated_at: new Date().toISOString(),
      coverage: {
        total: coverage.total,
        enriched: coverage.enriched,
        unenriched: coverage.unenriched,
        worklist_truncated: (coverage.unenriched_records?.length ?? 0) < coverage.unenriched
      },
      ...(opts.stale
        ? {reads: {delta: deltas, full: items.length - deltas, full_threshold: opts.fullThreshold}}
        : {}),
      claim: work.claim,
      held: work.held,
      unclaimed: unclaimed.sort(),
      taxonomy,
      needs_a_body: needsBody,
      items,
      enrichments_template: Object.fromEntries(items.map(item => [item.file_path, null]))
    };
    // Sub-agents share the session's folder, so the default file is named by the holder.
    let file = opts.out;
    if (!file) {
      const dir = sweepDir(env);
      mkdirSync(dir, {recursive: true, mode: 0o700});
      file = join(dir, `enrich-${fileSafe(holder)}.json`);
    }
    writeFileSync(file, JSON.stringify(worksheet, null, 2) + '\n');
    out(
      `worksheet: ${file} — ${items.length} item(s) (${worksheet.mode}${opts.stale ? `, ${deltas} read as a delta` : ''}), ${coverage.unenriched} unenriched total${needsBody.length ? `, ${needsBody.length} need a body` : ''}${unclaimed.length ? `, ${unclaimed.length} not claimed` : ''}${worksheet.claim ? `; claimed as ${holder}` : ''}`
    );
    return 0;
  };

  const apply = async () => {
    const worksheet = JSON.parse(readFileSync(opts.worksheet, 'utf8'));
    const raw = JSON.parse(readFileSync(opts.enrichments, 'utf8'));
    const enrichments = raw && typeof raw === 'object' && raw.enrichments ? raw.enrichments : raw;
    const jobs = jobsOf(worksheet, enrichments);
    const report = {
      mode: worksheet.mode,
      written: [],
      confirmed: [],
      skipped: Object.values(enrichments).filter(e => e === null).length,
      needs_a_body: [],
      failures: []
    };

    if (opts.dryRun) {
      out(
        JSON.stringify(
          {
            dry_run: true,
            would_write: jobs.filter(j => !j.confirm).map(j => j.item.file_path),
            would_confirm: jobs.filter(j => j.confirm).map(j => j.item.file_path),
            skipped: report.skipped
          },
          null,
          2
        )
      );
      return 0;
    }

    const failure = (path, error) =>
      report.failures.push({
        file_path: path,
        status: error.status,
        code: error.code,
        message: error.message
      });

    const confirmOne = async item => {
      try {
        await api('POST', `/sections/${item.record_id}/summary-checked`, {
          body_hash: item.body_hash
        });
        report.confirmed.push(item.file_path);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        failure(item.file_path, error);
      }
    };

    const writeOne = async ({item, enrichment, confirmed = false}) => {
      // The current path, never the worksheet's: a write to a path the note left brings it back.
      // A note gone since `prepare` is one failure, never the end of the run.
      let record;
      try {
        ({data: record} = await api('GET', `/sections/${item.record_id}`));
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        failure(item.file_path, error);
        return;
      }
      const put = async () => {
        const doc = await api('GET', `/vault/${record.file_path}`);
        if (doc.composed || doc.etag?.startsWith('W/')) {
          throw new ApiError(409, 'composed_view', `${record.file_path} is a composed folder view`);
        }
        const {body} = splitDoc(doc.data);
        if (emptyBody(body)) {
          report.needs_a_body.push(record.file_path);
          return false;
        }
        const agent = {
          derived_from_hash: item.folder_hash ?? 'auto',
          // Stamped by the writer; a folder's next stale read takes the pieces written since.
          derived_at: 'auto',
          summary: enrichment.summary.trim(),
          key_concepts: enrichment.key_concepts,
          tags_suggested: enrichment.tags_suggested ?? [],
          related_proposed: enrichment.related_proposed ?? [],
          edge_classifications: enrichment.edge_classifications ?? {},
          complexity: enrichment.complexity
        };
        await api(
          'PUT',
          `/vault/${record.file_path}`,
          {frontmatter: {agent}, body},
          {'If-Match': doc.etag}
        );
        return true;
      };
      const done = report[confirmed ? 'confirmed' : 'written'];
      try {
        if (await put()) done.push(record.file_path);
      } catch (error) {
        let last = error;
        // Another write landed between the read and the write: read again, write once more.
        if (error instanceof ApiError && error.status === 412) {
          try {
            if (await put()) done.push(record.file_path);
            return;
          } catch (retryError) {
            last = retryError;
          }
        }
        if (!(last instanceof ApiError)) throw last;
        failure(item.file_path, last);
      }
    };

    await pool(
      jobs.map(job => () => {
        if (!job.confirm) return writeOne(job);
        // A folder's summary holds for the composed note it was read from, whose hash
        // summary-checked never sees.
        if (job.item.folder) {
          return writeOne({item: job.item, enrichment: job.item.current_agent, confirmed: true});
        }
        return confirmOne(job.item);
      }),
      4
    );

    report.written.sort();
    report.confirmed.sort();
    if (worksheet.claim) report.claim = await releaseWork(worksheet.claim);
    out(JSON.stringify(report, null, 2));
    return report.failures.length ? 1 : 0;
  };

  const release = async () => {
    const {claim} = JSON.parse(readFileSync(opts.worksheet, 'utf8'));
    out(JSON.stringify({claim: claim ? await releaseWork(claim) : 'none'}, null, 2));
    return 0;
  };

  try {
    if (command === 'prepare') return await prepare();
    if (command === 'apply') return await apply();
    return await release();
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Error(`${error.status} ${error.code} — ${error.message}`, {cause: error});
    }
    // Every usage error is thrown before this point, so a TypeError here is a defect's: exit 1.
    if (error instanceof TypeError) throw new Error(error.message, {cause: error});
    throw error;
  }
};
