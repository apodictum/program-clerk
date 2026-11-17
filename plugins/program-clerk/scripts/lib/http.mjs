import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {cacheDir} from './common.mjs';

// Codes of a 503 that applied nothing, so even a write is safe to send again.
const APPLIED_NOTHING = new Set([
  'tenant_unavailable',
  'verification_unavailable',
  'writes_paused'
]);

const delaysOf = (env = process.env) => {
  const text = env.PROGRAM_CLERK_RETRY_DELAYS;
  if (!text) return [1000, 2000];
  return text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
};

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
  const headers = {authorization: `Bearer ${conn.key}`};
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
      try {
        mkdirSync(dirname(marker), {recursive: true});
        writeFileSync(marker, '');
      } catch {
        // an unwritable cache only costs the next call its waits
      }
      return answer;
    }
    if (existsSync(marker) || Date.now() + delay >= end) return answer;
    await sleep(delay);
  }
};
