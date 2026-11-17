// A folder's compaction, which `scripts/sweep/compact.mjs` runs: select the oldest pieces, lease them
// as one batch, gather their bodies and the links that will break, then write the summary note, move
// each piece into the folder's archive, and give the batch back. The agent writes only the summary.

import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {STATUS_CODES} from 'node:http';
import {hostname} from 'node:os';
import {dirname, join} from 'node:path';
import {NO_KEY, connectionOf, fileSafe} from './common.mjs';
import {jsonOf, request} from './http.mjs';
import {sweepDir} from './sweep-files.mjs';

// Repeated passes read better than one summary of everything.
const PASS_CAP = 20;
const CLAIM_TTL_S = 3600;
const NOTE = 'note:';

export const USAGE = `usage:
  compact.mjs plan <folder> [--keep=N | --before=YYYY-MM-DD] [--holder=H] [--out=FILE]
  compact.mjs execute (<folder> | --plan=FILE) [--summary=FILE] [--related=[[a]],[[b]]] [--dry-run]
  compact.mjs release (<folder> | --plan=FILE)`;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// Exit 3: refused before the first write.
const refused = message => Object.assign(new Error(message), {exitCode: 3});

export const planPathFor = (folder, env = process.env) =>
  join(sweepDir(env), `compact-${fileSafe(folder)}.json`);

export const summaryPathFor = (folder, env = process.env) =>
  join(sweepDir(env), `compact-${fileSafe(folder)}.summary.md`);

const VALUED = new Set([
  '--keep',
  '--before',
  '--holder',
  '--out',
  '--plan',
  '--summary',
  '--related'
]);

/** The command and the options; a TypeError names what is wrong with them. */
const optionsOf = argv => {
  const [command, ...rest] = argv;
  if (!['plan', 'execute', 'release'].includes(command)) {
    throw new TypeError(command ? `unknown command: ${command}\n${USAGE}` : USAGE);
  }
  const opts = {
    folder: null,
    keep: null,
    before: null,
    holder: null,
    out: null,
    plan: null,
    summary: null,
    related: [],
    dryRun: false
  };
  for (const arg of rest) {
    const at = arg.indexOf('=');
    const [flag, value] = at < 0 ? [arg, null] : [arg.slice(0, at), arg.slice(at + 1)];
    if (VALUED.has(flag) && !value) throw new TypeError(`${flag} needs a value\n${USAGE}`);
    if (flag === '--keep') {
      opts.keep = Number(value);
      if (!Number.isInteger(opts.keep) || opts.keep < 0) {
        throw new TypeError('--keep must be a whole number, 0 or more');
      }
    } else if (flag === '--before') opts.before = value;
    else if (flag === '--holder') opts.holder = value;
    else if (flag === '--out') opts.out = value;
    else if (flag === '--plan') opts.plan = value;
    else if (flag === '--summary') opts.summary = value;
    else if (flag === '--related') {
      opts.related = value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    } else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag.startsWith('--')) throw new TypeError(`unknown option: ${arg}\n${USAGE}`);
    else if (opts.folder !== null) throw new TypeError(`unexpected argument: ${arg}\n${USAGE}`);
    else opts.folder = arg.replace(/\/+$/, '');
  }
  if (opts.keep !== null && opts.before !== null) {
    throw new TypeError('--keep and --before are mutually exclusive');
  }
  if (command === 'plan' && !opts.folder) throw new TypeError(`plan needs a folder\n${USAGE}`);
  if (command !== 'plan' && !opts.folder && !opts.plan) {
    throw new TypeError(`${command} needs a folder or --plan\n${USAGE}`);
  }
  return {command, opts};
};

export const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a linker's text names the piece by its path or as a wikilink to its name. A related-to or
 * contradicts row can be the server's mirror of the piece's own link, which moves with the record,
 * so only a note whose text names the piece breaks; a text that could not be read counts.
 */
export const namesPiece = (text, path) => {
  if (text === null) return true;
  const stem = path.replace(/\.md$/, '');
  const base = escapeRegExp(stem.split('/').pop());
  return new RegExp(`${escapeRegExp(stem)}(?![\\w-])|\\[\\[${base}(?:\\]\\]|[|#])`).test(text);
};

const selectionOf = (pieces, opts) => {
  const chosen =
    opts.before !== null
      ? pieces.filter(p => String(p.created) < opts.before)
      : opts.keep !== null
        ? pieces.slice(0, Math.max(0, pieces.length - opts.keep))
        : pieces.slice(0, Math.floor(pieces.length / 2));
  return {selected: chosen.slice(0, PASS_CAP), truncated: chosen.length > PASS_CAP};
};

// By month, widened to quarter, then year, until a section holds about five pieces or more.
const groupsOf = selected => {
  const monthOf = p => String(p.created).slice(0, 7);
  const quarterOf = p =>
    `${String(p.created).slice(0, 4)}-Q${Math.ceil(+String(p.created).slice(5, 7) / 3)}`;
  const yearOf = p => String(p.created).slice(0, 4);
  const most = Math.ceil(selected.length / 5);
  let keyOf = monthOf;
  if (new Set(selected.map(monthOf)).size > most) keyOf = quarterOf;
  if (new Set(selected.map(keyOf)).size > most) keyOf = yearOf;
  const groups = {};
  for (const piece of selected) (groups[keyOf(piece)] ??= []).push(piece.file_path);
  return groups;
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

const writeJson = (path, value) => {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
};

const today = () => new Date().toISOString().slice(0, 10);

/** Runs one command; resolves to the exit code, 1 when a move failed. */
export const run = async (argv, {env = process.env, out = text => console.log(text)} = {}) => {
  if (argv[0] === '--help' || argv[0] === '-h') {
    out(USAGE);
    return 0;
  }
  const {command, opts} = optionsOf(argv);
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

  // The whole selection or nothing, so the summary's range has no hole.
  const claimSelection = async paths => {
    const holder = opts.holder ?? `compact-${hostname()}-${randomBytes(3).toString('hex')}`;
    const answer = await api('POST', '/leases/claim', {
      holder,
      resources: paths.map(path => NOTE + path),
      ttl_seconds: CLAIM_TTL_S
    });
    const claim = answer.claim_token
      ? {holder, claim_token: answer.claim_token, expires_at: answer.expires_at}
      : null;
    if (answer.held.length) {
      if (claim) await releaseWork(claim);
      const held = answer.held.map(
        h => `${h.resource.slice(NOTE.length)} (${h.holder}, until ${h.expires_at ?? 'released'})`
      );
      throw refused(
        `another pass holds ${answer.held.length} selected piece(s) — nothing claimed:\n  ${held.join('\n  ')}`
      );
    }
    return claim;
  };

  /** Fills each piece's body; resolves to the links from outside the selection that will break. */
  const gather = async selected => {
    const selectedIds = new Set(selected.map(p => p.record_id));
    const candidates = [];
    await pool(
      selected.map(piece => async () => {
        const doc = await api('GET', `/vault/${piece.file_path}`);
        const start =
          typeof doc === 'string' && doc.startsWith('---\n') ? doc.indexOf('\n---\n', 4) + 5 : 0;
        piece.body = String(doc).slice(start);
        try {
          for (let offset = 0; ;) {
            const back = await api(
              'GET',
              `/sections/${piece.record_id}/backlinks?limit=100&offset=${offset}`
            );
            const items = back.items ?? [];
            for (const row of items)
              if (row.from_record && !selectedIds.has(row.from_record.record_id))
                candidates.push({
                  archived: piece.file_path,
                  from: row.from_record.file_path,
                  title: row.from_record.title,
                  edge_type: row.edge?.type
                });
            offset += items.length;
            if (items.length === 0 || offset >= (back.total ?? offset)) break;
          }
        } catch {
          // the links are advice for the summary, so a piece whose links can't be read lists none
        }
      })
    );
    const linkerText = new Map();
    await pool(
      [...new Set(candidates.map(b => b.from))].map(from => async () => {
        try {
          linkerText.set(from, String(await api('GET', `/vault/${from}`)));
        } catch {
          linkerText.set(from, null);
        }
      })
    );
    return candidates.filter(b => namesPiece(linkerText.get(b.from), b.archived));
  };

  const plan = async () => {
    const prefix = `${opts.folder}/`;
    const pieces = [];
    for (let offset = 0; ;) {
      const page = await api(
        'GET',
        `/sections?file_prefix=${encodeURIComponent(prefix)}&limit=100&offset=${offset}&exclude=body&sort=created`
      );
      if (!page.items.length) break;
      for (const record of page.items) {
        // A subfolder's piece, the archive's among them, and an earlier summary are compacted
        // already; a state note is the project's baseline, kept current by its own command.
        const relative = record.file_path.slice(prefix.length);
        if (relative.includes('/') || relative.startsWith('_summary-')) continue;
        if (record.status === 'archived' || record.status === 'superseded') continue;
        if (record.type === 'state') continue;
        pieces.push({
          record_id: record.record_id,
          file_path: record.file_path,
          title: record.title,
          type: record.type,
          created: record.created
        });
      }
      offset += page.items.length;
    }
    pieces.sort((a, b) => String(a.created).localeCompare(String(b.created)));

    const {selected, truncated} = selectionOf(pieces, opts);
    if (!selected.length) {
      throw refused(
        `nothing to archive in ${opts.folder} (${pieces.length} pieces, selection empty)`
      );
    }
    const range = `${String(selected[0].created).slice(0, 10)}-to-${String(selected.at(-1).created).slice(0, 10)}`;
    const outPath = opts.out ?? planPathFor(opts.folder, env);
    const summaryPath = summaryPathFor(opts.folder, env);
    mkdirSync(dirname(summaryPath), {recursive: true, mode: 0o700});

    const claim = await claimSelection(selected.map(p => p.file_path));
    let backlinks;
    try {
      backlinks = await gather(selected);
      writeJson(outPath, {
        folder: opts.folder,
        mode:
          opts.before !== null
            ? `before ${opts.before}`
            : opts.keep !== null
              ? `keep ${opts.keep}`
              : 'oldest half',
        generated_at: new Date().toISOString(),
        total_pieces: pieces.length,
        selected_count: selected.length,
        remaining_after: pieces.length - selected.length,
        truncated_to_cap: truncated,
        summary_path: `${opts.folder}/_summary-${range}.md`,
        suggested_groups: groupsOf(selected),
        inbound_backlinks: backlinks,
        claim,
        selected
      });
    } catch (error) {
      // No file holds the batch's token yet, so it would stay held until it lapses.
      if (claim) await releaseWork(claim).catch(() => null);
      throw error;
    }
    out(
      `plan: ${outPath} — archive ${selected.length} of ${pieces.length} pieces (${range})${truncated ? ` [capped at ${PASS_CAP} — re-run after this pass]` : ''}, ${backlinks.length} external inbound link(s)${claim ? `; claimed as ${claim.holder}` : ''}`
    );
    out(`summary file: ${summaryPath}`);
    return 0;
  };

  const execute = async () => {
    const sheet = JSON.parse(readFileSync(opts.plan ?? planPathFor(opts.folder, env), 'utf8'));
    const body = readFileSync(opts.summary ?? summaryPathFor(sheet.folder, env), 'utf8');
    if (body.trim().length < 100) {
      throw refused('summary body is suspiciously short (< 100 chars) — nothing written');
    }
    const folderTag = sheet.folder.split('/').pop();
    const range = sheet.summary_path.match(/_summary-(.+)\.md$/)[1].replace('-to-', ' to ');

    const moves = sheet.selected.map(piece => ({
      from: piece.file_path,
      to: `${sheet.folder}/archive/${String(piece.created).slice(0, 4)}/${piece.file_path.split('/').pop()}`
    }));
    if (opts.dryRun) {
      out(
        JSON.stringify({dry_run: true, would_write: sheet.summary_path, would_move: moves}, null, 2)
      );
      return 0;
    }

    await api('PUT', `/vault/${sheet.summary_path}`, {
      frontmatter: {
        title: `${folderTag} — summary ${range}`,
        tags: ['summary', folderTag, 'archived-history'],
        created: today(),
        updated: today(),
        status: 'active',
        type: 'meta',
        ...(opts.related.length ? {related: opts.related} : {})
      },
      body
    });

    const report = {
      summary_written: sheet.summary_path,
      archived: [],
      failures: [],
      remaining_in_folder: sheet.remaining_after,
      inbound_links_now_broken: sheet.inbound_backlinks
    };
    for (const move of moves) {
      try {
        await api('POST', `/vault/move`, {
          ...move,
          ...(sheet.claim && {claim_token: sheet.claim.claim_token})
        });
        report.archived.push(`${move.from} → ${move.to}`);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        report.failures.push({
          ...move,
          status: error.status,
          code: error.code,
          message: error.message
        });
      }
    }
    if (sheet.claim) report.claim = await releaseWork(sheet.claim);
    // Nothing else runs the scan again, so the folder's compaction_candidate would stay pending.
    try {
      const {qualifying, autoResolved} = await api(
        'POST',
        '/maintenance/find-compaction-candidates'
      );
      report.rescan = {qualifying, auto_resolved: autoResolved};
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      report.rescan = {status: error.status, code: error.code, message: error.message};
    }
    out(JSON.stringify(report, null, 2));
    return report.failures.length ? 1 : 0;
  };

  const release = async () => {
    const {claim} = JSON.parse(readFileSync(opts.plan ?? planPathFor(opts.folder, env), 'utf8'));
    out(JSON.stringify({claim: claim ? await releaseWork(claim) : 'none'}, null, 2));
    return 0;
  };

  try {
    if (command === 'plan') return await plan();
    if (command === 'execute') return await execute();
    return await release();
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Error(`${error.status} ${error.code} — ${error.message}`, {cause: error});
    }
    throw error;
  }
};
