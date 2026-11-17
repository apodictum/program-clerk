import test from 'tape-six';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DEAD, fakeServer, removeAll, scratch} from './helpers.mjs';
import {call, outageMarker} from '../plugins/program-clerk/scripts/lib/http.mjs';

// Each path answers its script in turn, the last answer repeated: '503:tenant_unavailable' is a 503
// whose body names that code, '503' one with no code, as a balancer's.
const scripted = scripts => {
  const seen = {};
  const routes = {};
  for (const [key, script] of Object.entries(scripts)) {
    routes[key] = () => {
      const n = (seen[key] = (seen[key] ?? 0) + 1);
      const [status, code] = script[Math.min(n, script.length) - 1].split(':');
      return {
        status: Number(status),
        body: code ? {code} : status === '200' ? {ok: true} : 'Service Unavailable'
      };
    };
  }
  return routes;
};

test('which answers a call sends again, how often, and the remembered outage', async t => {
  const home = scratch();
  const env = {XDG_CACHE_HOME: join(home, 'cache'), PROGRAM_CLERK_RETRY_DELAYS: '50 50'};
  const marker = outageMarker(env);
  const server = await fakeServer(
    scripted({
      'POST /w-unreached': ['503:tenant_unavailable', '200'],
      'POST /w-maybe': ['503:database_unavailable', '200'],
      'POST /w-gateway': ['502', '200'],
      'GET /r-maybe': ['503:database_unavailable', '200'],
      'GET /r-gateway': ['502'],
      'GET /r-again': ['502', '200'],
      'POST /r-query': ['503', '200']
    })
  );
  const conn = {base: server.base, key: 'k'};
  const sent = path => server.requests.filter(q => q.path === path).length;
  const deadline = () => Date.now() + 4000;

  let answer = await call(conn, '/w-unreached', {
    method: 'POST',
    body: {},
    deadline: deadline(),
    env
  });
  t.deepEqual(
    [answer?.status, sent('/w-unreached')],
    [200, 2],
    'a write refused with a code that applied nothing goes again'
  );
  answer = await call(conn, '/w-maybe', {method: 'POST', body: {}, deadline: deadline(), env});
  t.deepEqual(
    [answer?.status, sent('/w-maybe')],
    [503, 1],
    'a write that may have applied is answered at once'
  );
  answer = await call(conn, '/w-gateway', {method: 'POST', body: {}, deadline: deadline(), env});
  t.deepEqual([answer?.status, sent('/w-gateway')], [502, 1], "a write's 502 is answered at once");
  answer = await call(conn, '/r-query', {
    method: 'POST',
    read: true,
    body: {},
    deadline: deadline(),
    env
  });
  t.deepEqual([answer?.status, sent('/r-query')], [200, 2], 'a query sent as a POST is a read');

  answer = await call(conn, '/r-maybe', {deadline: deadline(), env});
  t.deepEqual([answer?.status, sent('/r-maybe')], [200, 2], 'a read goes again after any 503');
  t.notOk(existsSync(marker), 'no outage remembered after an answer');
  answer = await call(conn, '/r-gateway', {deadline: deadline(), env});
  t.deepEqual(
    [answer?.status, sent('/r-gateway')],
    [502, 3],
    'a read is tried three times in all, then the caller gets the last answer'
  );
  t.ok(existsSync(marker), 'the outage is remembered once waited out');

  await call(conn, '/r-gateway', {deadline: deadline(), env});
  t.equal(sent('/r-gateway'), 4, 'while remembered, a call tries once');
  answer = await call(conn, '/r-again', {deadline: deadline(), env});
  t.deepEqual([answer?.status, sent('/r-again')], [502, 1], 'still once on the next path');
  answer = await call(conn, '/r-again', {deadline: deadline(), env});
  t.equal(answer?.status, 200);
  t.notOk(existsSync(marker), 'an answer ends the outage');
  await server.close();

  // Windows takes about 2 s to refuse a connection to a closed local port.
  const began = Date.now();
  answer = await call({base: DEAD, key: 'k'}, '/x', {
    method: 'POST',
    body: {},
    deadline: Date.now() + 30000,
    timeout: 10000,
    env
  });
  t.equal(answer, null, 'a refused connection has no answer');
  t.ok(Date.now() - began >= 100, 'a refused write waits both delays');
  t.ok(existsSync(marker), 'and is remembered');
  removeAll(home);
});

test('a call stops at its deadline', async t => {
  const home = scratch();
  const env = {XDG_CACHE_HOME: join(home, 'cache'), PROGRAM_CLERK_RETRY_DELAYS: '5000'};
  const server = await fakeServer({'GET /slow': {status: 502, body: {}}});
  const began = Date.now();
  const answer = await call({base: server.base, key: 'k'}, '/slow', {
    deadline: Date.now() + 300,
    env
  });
  t.equal(answer?.status, 502, 'the answer it had');
  t.ok(Date.now() - began < 1000, 'without a wait past the deadline');
  await server.close();
  removeAll(home);
});
