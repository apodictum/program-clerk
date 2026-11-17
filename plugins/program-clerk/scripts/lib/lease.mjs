import {mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {cacheDir, fileSafe, hashOf, readText, stateDir} from './common.mjs';
import {call, jsonOf} from './http.mjs';

export const MODES = ['checkout', 'repository'];
export const SETTINGS_FOLDER = 'program-clerk';
export const SETTINGS_PATH = 'program-clerk/settings.md';

// A lookup is trusted this long, so a burst of edits costs one request.
export const LOOKUP_TTL = 10;
export const RENEW_EVERY = 900;

const writeSafely = (file, text) => {
  try {
    mkdirSync(dirname(file), {recursive: true, mode: 0o700});
    writeFileSync(file, text, {mode: 0o600});
    return true;
  } catch {
    return false;
  }
};

export const leaseCache = (env = process.env) => join(cacheDir(env), 'lease');

// ── the mode, read once a session ───────────────────────────────────────

const sessionFile = (sessionId, env) => join(cacheDir(env), 'sessions', `${sessionId}.json`);

export const readSession = (sessionId, env = process.env) =>
  jsonOf(readText(sessionFile(sessionId, env)));

export const saveSession = (sessionId, state, env = process.env) =>
  writeSafely(sessionFile(sessionId, env), JSON.stringify(state));

export const dropSession = (sessionId, env = process.env) =>
  rmSync(sessionFile(sessionId, env), {force: true});

const lastModeFile = (conn, env) =>
  join(stateDir(env), `mode-${hashOf(`${conn.base}\t${conn.key}`).slice(0, 16)}`);

/** The account's lease mode: {mode, source, invalid?}. */
export const readMode = async (conn, deadline, env = process.env) => {
  const answer = await call(conn, '/notes/query', {
    method: 'POST',
    read: true,
    body: {folder: SETTINGS_FOLDER, limit: 100},
    deadline,
    env
  });
  const items = answer?.status === 200 ? jsonOf(answer.text)?.items : undefined;
  let invalid;
  if (Array.isArray(items)) {
    const value = items.find(item => item?.path === SETTINGS_PATH)?.frontmatter?.leases;
    if (value === undefined) {
      writeSafely(lastModeFile(conn, env), 'checkout');
      return {mode: 'checkout', source: 'default'};
    }
    if (MODES.includes(value)) {
      writeSafely(lastModeFile(conn, env), value);
      return {mode: value, source: 'account'};
    }
    invalid = String(value);
  }
  const last = readText(lastModeFile(conn, env)).trim();
  if (MODES.includes(last)) return {mode: last, source: 'last read', invalid};
  return {mode: 'checkout', source: 'fallback', invalid};
};

// A session keeps the mode it read at its start; one whose start did not run takes the machine's last.
export const sessionMode = (session, conn, env = process.env) => {
  if (MODES.includes(session?.mode)) return session.mode;
  const last = readText(lastModeFile(conn, env)).trim();
  return MODES.includes(last) ? last : 'checkout';
};

export const modeClause = ({mode, source, invalid}, resource) => {
  const keyed =
    mode === 'repository'
      ? 'Leases are keyed by repository'
      : `Leases are keyed by checkout (repo:<remote>@<host>:<path>, this one ${resource})`;
  const bad =
    invalid === undefined
      ? ''
      : `leases: "${invalid}" in ${SETTINGS_PATH} is neither checkout nor repository; `;
  const why = {
    account: `the account's setting in ${SETTINGS_PATH}`,
    default: `the default, with no setting in ${SETTINGS_PATH}`,
    'last read': 'the last value read on this machine, since the setting could not be read now',
    fallback: 'the default, since the setting could not be read'
  }[source];
  return `${keyed}: ${bad}${why}.`;
};

// ── claim tokens: renew and release present the claim's token ───────────

const tokenFile = (holder, resource, env) =>
  join(stateDir(env), 'tokens', fileSafe(holder), hashOf(resource));

export const tokenOf = (holder, resource, env = process.env) =>
  readText(tokenFile(holder, resource, env)).trim();

export const saveToken = (holder, resource, token, env = process.env) =>
  token && writeSafely(tokenFile(holder, resource, env), token);

export const dropToken = (holder, resource, env = process.env) =>
  rmSync(tokenFile(holder, resource, env), {force: true});

// rank 10 takes a side lease at once; another session takes this one only after an hour unrenewed.
export const claimBody = (resource, holder, token) => ({
  resource,
  holder,
  kind: 'agent',
  rank: 10,
  takeover_after: 3600,
  ...(token ? {claim_token: token} : {})
});

export const tokenBody = (resource, holder, token) => ({
  resource,
  holder,
  ...(token ? {claim_token: token} : {})
});

// ── what the last lookup saw, and when this session last renewed ─────────

const holderFile = (resource, env) => join(leaseCache(env), hashOf(resource));
export const stampFile = (resource, env = process.env) => `${holderFile(resource, env)}.renew`;

export const readHolder = (resource, env = process.env) =>
  jsonOf(readText(holderFile(resource, env)));

export const saveHolder = (resource, state, env = process.env) =>
  writeSafely(holderFile(resource, env), JSON.stringify(state));

export const readStamp = (resource, env = process.env) => {
  const value = Number(readText(stampFile(resource, env)).trim());
  return Number.isFinite(value) ? value : 0;
};

export const saveStamp = (resource, seconds, env = process.env) =>
  writeSafely(stampFile(resource, env), String(seconds));

export const forgetLease = (resource, env = process.env) => {
  rmSync(holderFile(resource, env), {force: true});
  rmSync(stampFile(resource, env), {force: true});
};

// ── notes for the next PostToolUse of this session or sub-agent ──────────

export const notesFile = (sessionId, agentId, env = process.env) =>
  join(leaseCache(env), `pending-${hashOf(`${sessionId}\t${agentId ?? ''}`)}`);

export const addNote = (sessionId, agentId, text, env = process.env) => {
  const file = notesFile(sessionId, agentId, env);
  return writeSafely(file, readText(file) + text + '\n');
};

export const refusedStamp = (holder, resource, env = process.env) =>
  join(leaseCache(env), `${hashOf(`${holder}\t${resource}`)}.refused`);

// ── releases a session could not finish ─────────────────────────────────

const pendingDir = env => join(stateDir(env), 'pending-release');

export const markPending = (holder, env = process.env) =>
  writeSafely(join(pendingDir(env), fileSafe(holder)), holder);

export const clearPending = (holder, env = process.env) =>
  rmSync(join(pendingDir(env), fileSafe(holder)), {force: true});

export const pendingHolders = (env = process.env) => {
  try {
    return readdirSync(pendingDir(env)).map(name => ({
      name,
      holder: readText(join(pendingDir(env), name)).trim()
    }));
  } catch {
    return [];
  }
};

export const dropPendingFile = (name, env = process.env) =>
  rmSync(join(pendingDir(env), name), {force: true});

export const listLeases = async (conn, deadline, env = process.env) => {
  const answer = await call(conn, '/leases?prefix=repo%3A', {deadline, env});
  const items = answer?.status === 200 ? jsonOf(answer.text)?.items : undefined;
  return Array.isArray(items) ? items : null;
};

/**
 * Releases what `holder` holds, at most `max` calls. Resolves to {posts, done}: done when nothing it
 * held is left, released, gone (404), or not its to release (409: a lease claimed through MCP, whose
 * token the hooks never saw, lapses at its TTL).
 */
export const releaseHeld = async (conn, holder, leases, max, deadline, env = process.env) => {
  let posts = 0;
  let done = true;
  for (const lease of leases) {
    if (lease?.holder !== holder || typeof lease.resource !== 'string') continue;
    if (posts >= max) {
      done = false;
      continue;
    }
    ++posts;
    const answer = await call(conn, '/leases/release', {
      method: 'POST',
      body: tokenBody(lease.resource, holder, tokenOf(holder, lease.resource, env)),
      deadline,
      env
    });
    if (answer && [200, 404, 409].includes(answer.status)) {
      forgetLease(lease.resource, env);
      dropToken(holder, lease.resource, env);
    } else {
      done = false;
    }
  }
  return {posts, done};
};

// ── one checkout's lease, as an edit or a tool call meets it ──────────

export const lookup = async (conn, resource, now, deadline) => {
  const cached = readHolder(resource);
  if (cached && now - cached.at < LOOKUP_TTL) return {holder: cached.holder, kind: cached.kind};
  const answer = await call(conn, `/leases?resource=${encodeURIComponent(resource)}`, {deadline});
  if (!answer) return null;
  if (answer.status !== 200) return answer.status === 429 ? {refused: answer} : null;
  const items = jsonOf(answer.text)?.items;
  if (!Array.isArray(items)) return null;
  const lease = items[0] ?? {};
  const seen = {holder: lease.holder ?? '', kind: lease.holder_kind ?? ''};
  saveHolder(resource, {at: now, ...seen});
  return seen;
};

export const claimOwn = async (conn, resource, me, now, deadline) => {
  const answer = await call(conn, '/leases/claim', {
    method: 'POST',
    body: claimBody(resource, me, tokenOf(me, resource)),
    deadline
  });
  if (!answer) return null;
  if (answer.status === 200) {
    saveToken(me, resource, jsonOf(answer.text)?.claim_token);
    saveHolder(resource, {at: now, holder: me, kind: 'agent'});
    saveStamp(resource, now);
    return {holder: me, kind: 'agent'};
  }
  if (answer.status === 409) {
    const current = jsonOf(answer.text)?.details?.current ?? {};
    if (!current.holder) return null;
    const seen = {holder: current.holder, kind: current.holder_kind ?? ''};
    saveHolder(resource, {at: now, ...seen});
    return seen;
  }
  return {refusedLine: refusedLine(resource, answer.status, answer.text)};
};

export const renewIfDue = async (conn, resource, me, now, deadline) => {
  if (now - readStamp(resource) < RENEW_EVERY) return;
  await call(conn, '/leases/renew', {
    method: 'POST',
    body: tokenBody(resource, me, tokenOf(me, resource)),
    deadline
  });
  saveStamp(resource, now);
};

// ── the lines a session reads ──────────────────────────────────────────

const errorCodeOf = text => {
  const body = jsonOf(text);
  return body && typeof body === 'object' && typeof body.code === 'string' ? body.code : '';
};

export const refusedLine = (resource, status, text) => {
  const code = errorCodeOf(text);
  return `[pc] lease: ${resource} — not claimed: the server answered HTTP ${status}${code ? ` (${code})` : ''}, so this session holds no lease. Behave as holding it, as when Program Clerk is unreachable; a 401 means the key is expired or recalled.`;
};

const hoursLeft = (expiresAt, now) => {
  const at = Date.parse(expiresAt ?? '');
  return Number.isFinite(at) ? ` (TTL ${Math.floor((at - now) / 3600000)}h)` : '';
};

/** The line a session-start claim's answer earns, or '' for none. */
export const claimLine = ({status, text}, {resource, role, me, base, now = Date.now()}) => {
  const body = jsonOf(text) ?? {};
  if (status === 200) {
    const ttl = hoursLeft(body.lease?.expires_at, now);
    const prior = body.prior ?? {};
    const after = 'Renews on activity; released at session end.';
    if (body.status === 'preempted' && prior.takeover_after != null)
      return `[pc] lease: ${resource} — claimed (cwd) as ${me}${ttl}, taking over from ${prior.holder}, unrenewed since ${prior.renewed_at} (a cwd lease yields after an hour without renewal). ${after}`;
    if (body.status === 'preempted')
      return `[pc] lease: ${resource} — claimed (cwd) as ${me}${ttl}, preempting a side holder, which learns at its next edit. ${after}`;
    const verb = body.status === 'renewed' ? 'renewed' : 'claimed';
    return `[pc] lease: ${resource} — ${verb} (cwd) as ${me}${ttl}. Yours; renews on activity; released at session end.`;
  }
  if (status === 409) {
    if (body.code === 'claim_token_mismatch')
      return `[pc] lease: ${resource} is held under this session's holder id ${me} by a claim whose token this machine no longer has, so it cannot be renewed or released from here; it lapses at its TTL. Treat the checkout as held by you meanwhile.`;
    const current = body.details?.current ?? {};
    if (!current.holder) return '';
    if (current.holder_kind === 'human')
      return `[pc] lease: ${resource} is held by ${current.holder} (a person). Ask before editing this working tree; work goes in a worktree and a handoff to "${role}".`;
    const how = current.takeover_after != null ? 'cwd' : 'side';
    return `[pc] lease: ${resource} is held by ${current.holder} (${how}, since ${current.claimed_at ?? '?'}, renewed ${current.renewed_at ?? '?'}): you are SUBORDINATE as ${me}. Read freely; every edit goes in a worktree and a handoff to "${role}" (SendMessage the holder if ListAgents shows it). Taking the lease is a person's act, on the account's Agents page (${base}/ui/agents). A cwd lease left unrenewed for an hour passes to the next session that starts here.`;
  }
  return refusedLine(resource, status, text);
};
