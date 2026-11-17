import test from 'tape-six';
import {join} from 'node:path';
import {DEAD, fakeServer, git, hookEnv, makeRepo, removeAll, runHook, scratch} from './helpers.mjs';
import {
  TRAILER,
  briefLines,
  githubLine,
  needsQueue,
  renewalOf,
  withQueue
} from '../plugins/program-clerk/scripts/lib/brief.mjs';

const BASE = 'https://pc.example';
const NOW = Date.parse('2026-11-16T12:00:00Z');
const hoursAgo = h => new Date(NOW - h * 3600000).toISOString();
const ahead = h => new Date(NOW + h * 3600000).toISOString();
const plain = extra => ({
  lint: {ok: true, total_issues: 0},
  suggestions_pending: 0,
  latest_log: null,
  project: null,
  ...extra
});
const lines = brief => briefLines(brief, {base: BASE, now: NOW});

test('the project line: active items, their tickets, and the queue counts', t => {
  let out = lines(
    plain({
      project: {
        name: 'p',
        queue: {
          active: ['A.', 'B.'],
          in_flight: [
            {title: 'A.', source: null},
            {title: 'B.', source: 'github example/p#15'}
          ],
          inbox: 2,
          backlog: 0,
          ready: 0,
          blocked: 0
        }
      }
    })
  );
  t.equal(
    out[1],
    '[pc] p: ACTIVE: A. | B. (github example/p#15); 2 in the inbox to triage; 0/0 backlog ready'
  );

  out = lines(
    plain({
      project: {
        name: 'p',
        queue: {
          active: ['A.', 'B.', 'C.'],
          in_flight: [
            {title: 'A.', source: 'github example/p#1', upstream: 'merged'},
            {title: 'B.', source: 'github example/p#2', upstream: 'open'},
            {title: 'C.', source: 'github example/p#3', upstream: null}
          ],
          backlog: 0,
          ready: 0,
          blocked: 0
        }
      }
    })
  );
  t.matchString(
    out[1],
    /ACTIVE: A\. \(github example\/p#1, merged upstream\) \| B\. \(github example\/p#2\) \| C\. \(github example\/p#3\);/,
    'only a closed or merged ticket is marked'
  );

  out = lines(
    plain({project: {name: 'p', queue: {active: ['A.'], backlog: 0, ready: 0, blocked: 0}}})
  );
  t.matchString(out[1], /ACTIVE: A\.;/, 'titles alone from a server without in_flight');
  t.doesNotMatchString(out.join('\n'), /inbox|loop stall/, 'no clause for a field not sent');

  out = lines(plain({project: {name: 'p'}}));
  t.equal(out[1], '[pc] p: ', 'no queue block, no queue clause');
  t.doesNotMatchString(out[1], /null/);

  out = lines(
    plain({
      project: {
        name: 'p',
        queue: {active: [], backlog: 0, ready: 0, blocked: 0},
        handoffs_returned: 2,
        sessions_unlogged: 1,
        feedback: {updated: '2026-11-16'}
      }
    })
  );
  t.equal(
    out[1],
    '[pc] p: 0/0 backlog ready; feedback.md updated 2026-11-16; 1 session(s) ended without a log; 2 of its handoffs returned for rework'
  );
});

test('the first line: lint, suggestions, stalls, the store, the disk', t => {
  t.deepEqual(lines(plain({stalls: null})), ['[pc] lint ok'], 'nothing more by default');
  t.equal(
    lines(
      plain({
        stalls: {count: 2, latestAt: '2026-10-09T02:25:41.431Z', latestMs: 659, worstMs: 11353}
      })
    )[0],
    '[pc] lint ok; loop stalls this week: 2, latest 659 ms at 2026-10-09 02:25Z, worst 11353 ms (/system/events?log=stalls)'
  );
  t.matchString(
    lines(
      plain({
        stalls: {
          count: 1,
          latestAt: '2026-10-09T02:25:41Z',
          latestMs: 1,
          worstMs: 2,
          filedBy: 'server'
        }
      })
    )[0],
    /worst 2 ms, filed by the server \(/
  );
  t.equal(
    lines(plain({lint: {ok: false, total_issues: 3}, suggestions_pending: 21}))[0],
    '[pc] lint: 3 issues; 21 pending suggestions'
  );
  const store = s => lines(plain({store: s}))[0];
  t.equal(
    store({remote: 'origin/main', ahead: 2, behind: 1, diverged: true, lastError: null}),
    '[pc] lint ok; store: origin/main has 1 commit(s) the account lacks, pushing stopped (2 waiting)'
  );
  t.equal(
    store({
      remote: 'origin/main',
      ahead: 1,
      behind: 0,
      diverged: false,
      lastError: 'git fetch failed'
    }),
    '[pc] lint ok; store: git fetch failed'
  );
  t.equal(
    store({remote: 'origin/main', ahead: 0, behind: 0, diverged: false, lastError: null}),
    '[pc] lint ok'
  );
  const disk = d => lines(plain({disk: d}))[0];
  t.equal(
    disk({
      path: '/data',
      free_bytes: 483183820,
      total_bytes: 21474836480,
      low: true,
      build_room_bytes: 6442450944
    }),
    '[pc] lint ok; disk: 0.4 GB free of 20 GB under /data, low; a deploy needs 6 GB (/system/status)'
  );
  t.equal(
    disk({path: '/data', free_bytes: 483183820, total_bytes: 21474836480, low: true}),
    '[pc] lint ok; disk: 0.4 GB free of 20 GB under /data, low (/system/status)'
  );
  t.equal(disk({path: '/data', free_bytes: 1, total_bytes: 2, low: false}), '[pc] lint ok');
});

test("the caller's key, named within a week of its expiry", t => {
  const key = h => lines(plain({key: {name: 'laptop', expiresAt: ahead(h)}}));
  const expected = (when, at) =>
    `[pc] key laptop expires ${when} (${at.slice(0, 10)}); ${renewalOf(BASE)}`;
  t.deepEqual(key(73), ['[pc] lint ok', expected('in 3 days', ahead(73))]);
  t.equal(key(25)[1], expected('in 1 day', ahead(25)), 'one day, singular');
  t.equal(key(2)[1], expected('within a day', ahead(2)));
  t.deepEqual(key(240), ['[pc] lint ok'], 'ten days out: nothing yet');
  t.deepEqual(lines(plain({key: null})), ['[pc] lint ok'], 'a key that never expires');
  t.matchString(
    renewalOf(BASE),
    /https:\/\/pc\.example\/ui\/keys/,
    'the Keys page on the account in use'
  );
});

test('handoffs waiting in other projects, and returned to their filer', t => {
  t.equal(
    lines(
      plain({
        handoffs_waiting: [
          {project: 'web', open: 1, oldest: hoursAgo(121)},
          {project: 'tool', open: 2, oldest: hoursAgo(26.1)}
        ]
      })
    )[1],
    '[pc] handoffs waiting over a day in other projects: web 1 (oldest 5 days), tool 2 (oldest 26 h); a session there picks them up'
  );
  t.deepEqual(lines(plain({handoffs_waiting: []})), ['[pc] lint ok']);
  t.equal(
    lines(
      plain({
        handoffs_returned: [{filer: 'github.com/example/x', returned: 1, oldest: hoursAgo(121)}]
      })
    )[1],
    '[pc] handoffs returned for rework over a day ago: github.com/example/x 1 (oldest 5 days); their filer resubmits them'
  );
  t.equal(
    lines(
      plain({latest_log: {updated: '2026-11-16T23:33:18Z', title: 'A log', scope: 'fleet'}})
    )[1],
    '[pc] last log 2026-11-16T23:33:18Z (all projects): A log'
  );
});

test('a queue kept one item to a note: the counts come from the items', t => {
  const brief = plain({project: {name: 'p', queue: {active: [], backlog: 0}}});
  t.ok(needsQueue(brief));
  const merged = withQueue(brief, [
    {frontmatter: {title: 'About.'}},
    {frontmatter: {title: 'A.', section: 'active', source: 'github example/p#1'}},
    {frontmatter: {title: 'B.', section: 'backlog'}},
    {frontmatter: {title: 'C.', section: 'backlog', blocked_by: ['A.']}},
    {frontmatter: {title: 'D.', section: 'inbox'}},
    {frontmatter: {title: 'E.', section: 'watching'}}
  ]);
  t.equal(
    lines(merged)[1],
    '[pc] p: ACTIVE: A. (github example/p#1); 1 in the inbox to triage; 1/2 backlog ready; 1 blocked'
  );
  t.notOk(needsQueue(plain({project: {name: 'p', queue: {active: ['X.'], backlog: 0}}})));
});

test('the GitHub line from the stored baseline', t => {
  const block = {
    repo: 'example/p',
    collected_at: hoursAgo(3),
    items: {
      1: {state: 'open', is_pr: false},
      2: {state: 'open', is_pr: true},
      3: {state: 'closed', is_pr: false}
    },
    advisories: {
      'GHSA-1': {state: 'published', cve_id: null},
      'GHSA-2': {state: 'published', cve_id: 'CVE-1'}
    },
    alerts: {code_scanning: {open: 2}, dependabot: {open: 0}},
    ci: {conclusion: 'success'}
  };
  t.equal(
    githubLine(block, NOW),
    `[pc] github example/p: 2 open (1 issues, 1 PRs); 1 advisories without CVE; alerts code scanning 2; CI success; collected ${hoursAgo(3).slice(0, 16).replace('T', ' ')} (3h ago)`
  );
  t.matchString(githubLine({...block, collected_at: hoursAgo(50)}, NOW), /\(2d ago\)$/);
  t.equal(githubLine(null, NOW), null);
});

test('the hook: silent on failure, a refused key said, the trailer last', async t => {
  const home = scratch();
  const repo = makeRepo(join(home, 'main-name'));
  const linked = join(home, 'other-name');
  git(repo, 'worktree', 'add', '-q', '--detach', linked);

  let r = await runHook('brief.mjs', {cwd: repo}, hookEnv(home, null));
  t.deepEqual([r.code, r.stdout], [0, ''], 'no key is silent');
  r = await runHook('brief.mjs', {cwd: repo}, hookEnv(home, DEAD));
  t.deepEqual([r.code, r.stdout], [0, ''], 'an unreachable server is silent');

  let server = await fakeServer({'GET /system/resume-brief': {status: 401, body: {}}});
  r = await runHook('brief.mjs', {cwd: repo}, hookEnv(home, server.base));
  t.equal(
    r.stdout,
    `[pc] Program Clerk refused the key (401): expired or recalled; ${renewalOf(server.base)}\n`,
    'a refused key is one line'
  );
  await server.close();

  server = await fakeServer({
    'GET /system/resume-brief': ({url}) => ({
      body: plain({
        project: {name: url.searchParams.get('project'), queue: {active: [], backlog: 0}}
      })
    }),
    'POST /notes/query': {body: {items: [{frontmatter: {title: 'B.', section: 'backlog'}}]}},
    'GET /data/projects/main-name/data/github.json': {
      body: {
        repo: 'example/p',
        collected_at: new Date().toISOString(),
        items: {1: {state: 'closed', is_pr: true}},
        advisories: {},
        alerts: {dependabot: {unavailable: 'disabled', status: 403}},
        ci: null
      }
    },
    'GET /system/notices': {
      body: {notices: [{id: 'n1', text: 'Maintenance tonight.', minutes: null}]}
    },
    'POST /maintenance/warm-embedder': {body: {}}
  });
  r = await runHook('brief.mjs', {cwd: linked, session_id: 'abc123'}, hookEnv(home, server.base));
  const out = r.stdout.trimEnd().split(/\r?\n/);
  t.ok(
    server.requests.some(q => q.url === '/system/resume-brief?project=main-name'),
    "a linked worktree asks for its main checkout's project"
  );
  t.equal(out[1], '[pc] main-name: 1/1 backlog ready', 'the queue counted from its items');
  t.matchString(out[2], /^\[pc\] github example\/p: 0 open/);
  t.equal(out[3], '[pc] notice: Maintenance tonight.', 'the notices before the trailer');
  t.equal(out.at(-1), TRAILER, 'the trailer last');
  t.ok(
    server.requests.some(q => q.path === '/maintenance/warm-embedder'),
    'the model is warmed'
  );

  r = await runHook('brief.mjs', {cwd: home, session_id: 'abc123'}, hookEnv(home, server.base));
  t.ok(
    server.requests.some(q => q.url === '/system/resume-brief'),
    'outside a checkout: the account alone'
  );
  t.doesNotMatchString(r.stdout, /github|notice:/, 'no GitHub line, and a notice said once');
  t.equal(r.stdout.trimEnd().split(/\r?\n/).at(-1), TRAILER);
  await server.close();
  removeAll(home);
});
