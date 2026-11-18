import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {cacheDir} from './common.mjs';

// Codes of a 503 that applied nothing, so even a write is safe to send again.
const APPLIED_NOTHING = new Set([
  'tenant_unavailable',
  'verification_unavailable',
  'writes_paused',
  'data_busy'
]);

const delaysOf = (env = process.env) => {
  const text = env.PROGRAM_CLERK_RETRY_DELAYS;
  if (!text) return [1000, 2000];
  return text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
};

const versionOf = () => {
  try {
    const manifest = new URL('../../.claude-plugin/plugin.json', import.meta.url);
    return JSON.parse(readFileSync(manifest, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
};

// The server's usage record counts calls by this, so a retired form waits for old plugins to stop.
export const USER_AGENT = `program-clerk-plugin/${versionOf()}`;

export const outageMarker = (env = process.env) => join(cacheDir(env), 'outage');

export const jsonOf = text => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const codeOf = text => {
  const body = jsonOf(text);
  return body && typeof body === 'object' ? body.code : undefined;
};

const failureOf = error => {
  const code = error?.cause?.code;
  if (code === 'ECONNREFUSED') return 'refused';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  return 'dropped';
};

/**
 * One call to the API, sent again while the server is between answers: a connection never made, or
 * a 503 whose code applied nothing, whatever the method; a read also after a 502, 503, or 504, a
 * timeout, or a dropped connection. After the last delay the outage is remembered, and while it is,
 * a call tries once, until any answer ends it. Resolves to {status, text}, or null with no answer.
 */
export const call = async (
  conn,
  path,
  {method = 'GET', body, read, deadline, timeout = 2000, env = process.env} = {}
) => {
  const isRead = read ?? (method === 'GET' || method === 'HEAD');
  const headers = {authorization: `Bearer ${conn.key}`, 'user-agent': USER_AGENT};
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    headers['content-type'] =
      typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
  }
  const marker = outageMarker(env);
  const delays = delaysOf(env);
  const end = deadline ?? Date.now() + timeout * 3;
  for (let i = 0; ; ++i) {
    const left = end - Date.now();
    if (left <= 0) return null;
    let answer = null;
    let failure = '';
    try {
      const response = await fetch(conn.base + path, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(Math.min(timeout, left))
      });
      answer = {status: response.status, text: await response.text()};
    } catch (error) {
      failure = failureOf(error);
    }
    const status = answer?.status ?? 0;
    const repeat =
      failure === 'refused' ||
      (status === 503 && APPLIED_NOTHING.has(codeOf(answer.text))) ||
      (isRead && (failure !== '' || status === 502 || status === 503 || status === 504));
    if (!repeat) {
      if (answer) rmSync(marker, {force: true});
      return answer;
    }
    const delay = delays[i];
    if (delay === undefined) {
      outageStart(marker, Date.now());
      return answer;
    }
    if (existsSync(marker) || Date.now() + delay >= end) return answer;
    await sleep(delay);
  }
};

const RATE_WAIT_MS = 5 * 60_000;
export const OUTAGE_WAIT_MS = 90_000;
const STEPS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000];
// No connection was made, so the request was never sent.
const NOT_SENT = new Set([
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'EAI_AGAIN'
]);

/** The outage's first failure: the time the mark holds, or `at`, marked now when none stands. */
const outageStart = (marker, at) => {
  try {
    mkdirSync(dirname(marker), {recursive: true});
    writeFileSync(marker, `${new Date(at).toISOString()}\n`, {flag: 'wx'});
    return at;
  } catch {
    // one stands already, or none can be written
  }
  try {
    const since = Date.parse(readFileSync(marker, 'utf8').trim());
    return Number.isNaN(since) ? at : since;
  } catch {
    return at;
  }
};

const repeatable = (answer, failure, isRead) => {
  if (failure !== null) {
    const code = failure?.cause?.code ?? failure?.code;
    if (code === 'ENOTFOUND') return false;
    return NOT_SENT.has(code) || isRead;
  }
  if (answer.status === 502 || answer.status === 504) return isRead;
  if (answer.status !== 503) return false;
  const code = codeOf(answer.text);
  return code === undefined || APPLIED_NOTHING.has(code) || isRead;
};

/**
 * One call for a script a person waits on, not a hook. A 429 naming its Retry-After is sent again
 * after it, for five minutes in all. An outage (what `call` sends again) is waited out until its
 * first failure, which the mark holds for every process, plus `outageMs`, so calls that meet one
 * restart all recover. Resolves to {status, text, headers}, or null with no answer.
 */
export const request = async (
  conn,
  path,
  {
    method = 'GET',
    body,
    contentType,
    headers: extra = {},
    outageMs = OUTAGE_WAIT_MS,
    timeout = 30_000,
    env = process.env,
    wait = sleep,
    now = Date.now
  } = {}
) => {
  const isRead = method === 'GET' || method === 'HEAD';
  const headers = {...extra, authorization: `Bearer ${conn.key}`, 'user-agent': USER_AGENT};
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    headers['content-type'] =
      contentType ?? (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json');
  }
  const marker = outageMarker(env);
  let rateWaited = 0;
  let deadline = null;
  for (let step = 0; ;) {
    let answer = null;
    let failure = null;
    let after = 0;
    try {
      const response = await fetch(conn.base + path, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeout)
      });
      answer = {status: response.status, text: await response.text(), headers: response.headers};
      after = Number(response.headers.get('retry-after')) * 1000 || 0;
    } catch (error) {
      failure = error;
    }
    if (answer?.status === 429 && after > 0 && rateWaited < RATE_WAIT_MS) {
      const ms = Math.min(after, RATE_WAIT_MS - rateWaited);
      await wait(ms);
      rateWaited += ms;
      continue;
    }
    if (!repeatable(answer, failure, isRead)) {
      if (answer) rmSync(marker, {force: true});
      return answer;
    }
    deadline ??= outageStart(marker, now()) + outageMs;
    const left = deadline - now();
    if (left <= 0) return answer;
    await wait(Math.min(Math.max(STEPS_MS[Math.min(step, STEPS_MS.length - 1)], after), left));
    ++step;
  }
};
