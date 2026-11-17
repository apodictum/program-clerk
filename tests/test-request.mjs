// The call a script makes: an outage waited out to a deadline every process shares, a 429 waited
// out for its Retry-After, and what a resend could apply twice never sent again.

import {mkdirSync, writeFileSync, existsSync} from 'node:fs';
import http from 'node:http';
import {join} from 'node:path';
import test from 'tape-six';
import {outageMarker, request} from '../plugins/program-clerk/scripts/lib/http.mjs';
import {removeAll, scratch} from './helpers.mjs';

/** A server answering each request with the next of `answers`, the last one repeated. */
const serve = async answers => {
  let count = 0;
  const server = http.createServer((_, res) => {
    const [status, body = {}, headers = {}] = answers[Math.min(count++, answers.length - 1)];
    res.writeHead(status, {'content-type': 'application/json', ...headers});
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    conn: {base: `http://127.0.0.1:${server.address().port}`, key: 'k'},
    count: () => count,
    close: () => new Promise(resolve => server.close(resolve))
  };
};

const clock = (start = Date.parse('2026-11-17T00:00:00Z')) => {
  const c = {
    at: start,
    waits: [],
    now: () => c.at,
    wait: async ms => {
      c.waits.push(ms);
      c.at += ms;
    }
  };
  return c;
};

const withHome = async fn => {
  const home = scratch();
  try {
    await fn({XDG_CACHE_HOME: home});
  } finally {
    removeAll(home);
  }
};

test('an answer that applied nothing is sent again, and the first answer clears the mark', async t => {
  const s = await serve([
    [503, {code: 'tenant_unavailable'}],
    [200, {ok: true}]
  ]);
  await withHome(async env => {
    const c = clock();
    const answer = await request(s.conn, '/x', {method: 'POST', body: {}, env, ...c});
    t.equal(answer.status, 200);
    t.deepEqual(c.waits, [250]);
    t.equal(existsSync(outageMarker(env)), false, 'no mark is left');
  });
  await s.close();
});

test("an outage's deadline is shared: a call meeting another's mark waits only what is left", async t => {
  const s = await serve([[502]]);
  await withHome(async env => {
    const c = clock();
    mkdirSync(join(env.XDG_CACHE_HOME, 'program-clerk'), {recursive: true});
    writeFileSync(outageMarker(env), `${new Date(c.at - 80_000).toISOString()}\n`);
    const answer = await request(s.conn, '/x', {env, ...c});
    t.equal(answer.status, 502, 'past the deadline, the last answer');
    t.equal(
      c.waits.reduce((a, b) => a + b, 0),
      10_000,
      'ninety seconds from the first failure, not from this call'
    );
    t.equal(existsSync(outageMarker(env)), true, 'the mark stands until an answer clears it');
  });
  await s.close();
});

test('a write is not sent again after an answer that may have applied it', async t => {
  const s = await serve([[502]]);
  await withHome(async env => {
    const c = clock();
    const answer = await request(s.conn, '/x', {method: 'PUT', body: 'text', env, ...c});
    t.equal(answer.status, 502);
    t.equal(s.count(), 1);
    t.deepEqual(c.waits, []);
  });
  await s.close();
});

test('a 429 waits for its Retry-After', async t => {
  const s = await serve([[429, {}, {'retry-after': '2'}], [200]]);
  await withHome(async env => {
    const c = clock();
    t.equal((await request(s.conn, '/x', {env, ...c})).status, 200);
    t.deepEqual(c.waits, [2000]);
  });
  await s.close();
});

test('no server: a read waits out its window, then answers null', async t => {
  const s = await serve([[200]]);
  await s.close();
  await withHome(async env => {
    const c = clock();
    t.equal(await request(s.conn, '/x', {env, outageMs: 3_000, ...c}), null);
    t.equal(
      c.waits.reduce((a, b) => a + b, 0),
      3_000
    );
  });
});
