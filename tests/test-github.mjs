import test from 'tape-six';
import {
  appendRuns,
  collectRepo,
  commitBaseline,
  diff,
  digestOf,
  eventLine,
  ghLogin,
  readBaseline,
  renderBrief,
  repoOfRemote,
  runGh,
  runRecord
} from '../plugins/program-clerk/scripts/lib/github.mjs';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const BASE_TIME = '2026-11-10T00:00:00.000Z';
const R = 'repos/example/demo';
const WEB = 'https://github.com/example/demo';

// The query parameters a read adds as it pages or windows; a stub route is the rest.
const PARAMS = /[?&](?:per_page|page|since|after)=[^&]*/g;

const ok = data => ({code: 0, out: JSON.stringify(data), err: ''});
const httpError = (status, message) => ({
  code: 1,
  out: JSON.stringify({message, status: String(status)}),
  err: `gh: ${message} (HTTP ${status})`
});
const withHead = (data, next) => ({
  code: 0,
  out: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n${next ? `Link: <https://api.github.com/${next}>; rel="next"\r\n` : ''}\r\n${JSON.stringify(data)}`,
  err: ''
});

/** A stand-in for gh: each route answers its data (or a function of the route), 404 elsewhere. */
const ghStub = (routes, {auth = ok('')} = {}) => {
  const calls = [];
  const gh = async args => {
    calls.push(args);
    if (args[0] === 'auth') return auth;
    const route = args[1] === 'graphql' ? 'graphql' : args.at(-1);
    const answer = routes[route.replace(PARAMS, '')];
    if (answer === undefined) return httpError(404, 'Not Found');
    if (typeof answer === 'function') return answer(route, args);
    return args[1] === '-i' ? withHead(answer) : ok(answer);
  };
  return {gh, calls};
};

const memoryApi = (files = {}, refuse = {}) => {
  const calls = [];
  const api = async (path, {method = 'GET', body, contentType} = {}) => {
    calls.push({path, method, body, contentType});
    const refused = refuse[`${method} ${path}`];
    if (refused !== undefined) return refused;
    if (method === 'GET')
      return path in files
        ? {status: 200, text: files[path]}
        : {status: 404, text: '{"code":"not_found"}'};
    files[path] = method === 'POST' ? (files[path] ?? '') + body : body;
    return {status: method === 'POST' ? 201 : 200, text: '{}'};
  };
  return {api, calls, files};
};

const quietRoutes = (meta = {}) => ({
  [R]: {
    private: false,
    html_url: WEB,
    stargazers_count: 0,
    forks_count: 0,
    subscribers_count: 0,
    open_issues_count: 0,
    has_discussions: false,
    default_branch: 'main',
    ...meta
  },
  [`${R}/security-advisories`]: [],
  [`${R}/issues?state=open`]: [],
  [`${R}/issues?state=all`]: [],
  [`${R}/forks?sort=newest`]: [],
  [`${R}/subscribers`]: [],
  [`${R}/releases`]: [],
  [`${R}/dependabot/alerts?state=open`]: [],
  [`${R}/code-scanning/alerts?state=open`]: [],
  [`${R}/actions/runs?branch=main`]: {workflow_runs: []},
  [`${R}/pulls?state=closed&base=main&sort=updated&direction=desc`]: [],
  [`${R}/actions/workflows`]: {total_count: 0, workflows: []}
});

const collect = (gh, extra = {}) =>
  collectRepo({
    owner: 'example',
    name: 'demo',
    project: 'demo',
    baseline: null,
    ghUser: 'owner',
    gh,
    now: NOW,
    ...extra
  });

test('runGh: the output, an exit code, and a missing executable', async t => {
  const node = process.execPath;
  t.deepEqual(await runGh(['-e', 'process.stdout.write(" hi\\n")'], {bin: node}), {
    code: 0,
    out: 'hi',
    err: ''
  });
  // exitCode, not exit(): an exit can cut off a piped write on Windows and macOS.
  const failed = await runGh(['-e', 'process.stderr.write("bad"); process.exitCode = 3'], {
    bin: node
  });
  t.equal(failed.code, 3);
  t.equal(failed.err, 'bad');
  t.notOk(failed.missing);
  const missing = await runGh(['--version'], {bin: 'pc-test-no-such-gh'});
  t.equal(missing.missing, true);
  t.equal(missing.code, null);
  t.matchString(missing.err, /not installed/);
});

test('ghLogin: a login, gh missing, gh signed out, and GitHub silent after a valid login', async t => {
  const {gh} = ghStub({user: {login: 'owner'}});
  t.deepEqual(await ghLogin(gh), {login: 'owner'});

  const missing = await ghLogin(args => runGh(args, {bin: 'pc-test-no-such-gh'}));
  t.equal(missing.problem, 'missing');
  t.matchString(missing.message, /not installed/);

  const signedOut = ghStub(
    {},
    {
      auth: {
        code: 1,
        out: '',
        err: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\nmore'
      }
    }
  );
  t.deepEqual(await ghLogin(signedOut.gh), {
    problem: 'signed-out',
    message: 'You are not logged into any GitHub hosts. To log in, run: gh auth login'
  });

  const silent = ghStub({
    user: () => ({code: 1, out: '', err: 'error connecting to api.github.com'})
  });
  await t.rejects(ghLogin(silent.gh), /error connecting/);
});

test('repoOfRemote takes github.com remotes only', t => {
  const cases = [
    ['git@github.com:example/demo.git', {owner: 'example', name: 'demo'}],
    ['https://github.com/example/demo.git', {owner: 'example', name: 'demo'}],
    ['https://github.com/example/demo/', {owner: 'example', name: 'demo'}],
    ['https://user@github.com/example/demo', {owner: 'example', name: 'demo'}],
    ['ssh://git@github.com/example/demo.git', {owner: 'example', name: 'demo'}],
    ['git+https://github.com/example/demo.git', {owner: 'example', name: 'demo'}],
    ['git://github.com/example/demo.git', {owner: 'example', name: 'demo'}],
    ['  git@github.com:example/demo.js.git\n', {owner: 'example', name: 'demo.js'}],
    ['https://gitlab.com/example/demo.git', null],
    ['https://github.com/example/demo/tree/main', null],
    ['', null],
    [undefined, null]
  ];
  for (const [url, repo] of cases) t.deepEqual(repoOfRemote(url), repo, String(url));
});

test('readBaseline: a stored snapshot, none, and a failure', async t => {
  const path = '/data/projects/demo/data/github.json';
  const {api} = memoryApi({[path]: '{"repo":"example/demo","items":{}}'});
  t.deepEqual(await readBaseline(api, 'demo'), {repo: 'example/demo', items: {}});
  t.equal(await readBaseline(api, 'other'), null);
  t.equal(await readBaseline(memoryApi({[path]: '[1]'}).api, 'demo'), null);

  const refused = memoryApi({}, {[`GET ${path}`]: {status: 500, text: 'boom'}});
  const error = await t.rejects(readBaseline(refused.api, 'demo'));
  t.equal(error?.status, 500);
  t.matchString(error?.message, /GET \/data\/projects\/demo\/data\/github\.json: 500/);
  await t.rejects(
    readBaseline(async () => null, 'demo'),
    /no answer/
  );
});

test('a first run records the baseline and reports no events', async t => {
  const routes = quietRoutes({stargazers_count: 4, forks_count: 1});
  routes[`${R}/forks?sort=newest`] = [
    {owner: {login: 'alice'}, full_name: 'alice/demo', created_at: '2026-01-01T00:00:00Z'}
  ];
  // Every page names a next one, so the cap stops the walk.
  let pages = 0;
  routes[`${R}/code-scanning/alerts?state=open`] = route => {
    ++pages;
    return withHead(
      [{rule: {severity: 'warning'}}],
      `${route.replace(/&after=\d+$/, '')}&after=${pages}`
    );
  };
  const {gh, calls} = ghStub(routes);
  const entry = await collect(gh);

  t.equal(entry.first_run, true);
  t.deepEqual(entry.events, []);
  t.deepEqual(entry.errors, []);
  t.equal(entry.collected_at, '2026-11-16T12:00:00.000Z');
  t.deepEqual(Object.keys(entry), [
    'repo',
    'project',
    'first_run',
    'collected_at',
    'events',
    'summary',
    'errors',
    'snapshot'
  ]);
  t.deepEqual(Object.keys(entry.snapshot), [
    'repo',
    'html_url',
    'gh_user',
    'collected_at',
    'window',
    'meta',
    'advisories',
    'items',
    'discussions',
    'forks',
    'watchers',
    'stars',
    'releases',
    'alerts',
    'ci'
  ]);
  t.deepEqual(entry.snapshot.window, {since: '2026-10-17T12:00:00.000Z', first_run: true});
  t.deepEqual(entry.snapshot.forks, [
    {login: 'alice', full_name: 'alice/demo', created_at: '2026-01-01T00:00:00Z'}
  ]);
  t.deepEqual(entry.snapshot.alerts, {
    dependabot: {open: 0, by_severity: {}},
    code_scanning: {open: 20, by_severity: {warning: 20}, truncated: true}
  });
  t.equal(pages, 20);
  t.equal(entry.snapshot.stars, null);
  t.equal(entry.snapshot.ci, null);
  t.deepEqual(entry.summary, {
    events: 0,
    by_kind: {},
    open_items: 0,
    advisories_without_cve: 0,
    stars: 4,
    forks: 1,
    comment_scan: 'full'
  });
  t.ok(
    calls.some(
      args =>
        args.at(-1) ===
        `${R}/issues?state=all&since=2026-10-17T12%3A00%3A00.000Z&per_page=100&page=1`
    ),
    'the window of a first run reaches back sinceDays'
  );
  t.notOk(
    calls.some(args => args[1] === 'graphql'),
    'no discussions read without discussions'
  );
});

const adv = id => `${WEB}/security/advisories/${id}`;
const issueUrl = n => `${WEB}/issues/${n}`;

const storedItem = (number, title, extra) => ({
  is_pr: false,
  title,
  excerpt: null,
  state: 'open',
  author: 'mallory',
  bot: false,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  comments: 0,
  review_comments: 0,
  reactions: 0,
  comment_reactions: 0,
  last_comment: null,
  labels: [],
  assignees: [],
  owner_commented: false,
  owner_reacted: false,
  html_url: issueUrl(number),
  ...extra
});

const baselineFixture = () => ({
  repo: 'example/demo',
  html_url: WEB,
  gh_user: 'owner',
  collected_at: BASE_TIME,
  window: {since: '2026-10-11T00:00:00.000Z', first_run: true},
  meta: {
    stars: 10,
    forks: 2,
    watchers: 3,
    open_issues: 4,
    has_discussions: true,
    default_branch: 'main'
  },
  advisories: {
    'GHSA-aaaa-aaaa-aaaa': {
      cve_id: null,
      state: 'published',
      severity: 'high',
      summary: 'Crash on deep input',
      published_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
      html_url: adv('GHSA-aaaa-aaaa-aaaa')
    },
    'GHSA-bbbb-bbbb-bbbb': {
      cve_id: null,
      state: 'triage',
      severity: 'medium',
      summary: 'Slow on long keys',
      published_at: null,
      updated_at: '2026-11-02T00:00:00Z',
      html_url: adv('GHSA-bbbb-bbbb-bbbb')
    },
    'GHSA-cccc-cccc-cccc': {
      cve_id: 'CVE-2026-1000',
      state: 'published',
      severity: 'low',
      summary: 'Leak',
      published_at: '2026-11-03T00:00:00Z',
      updated_at: '2026-11-03T00:00:00Z',
      html_url: adv('GHSA-cccc-cccc-cccc')
    }
  },
  items: {
    8: storedItem(8, 'Old', {state: 'closed', updated_at: '2026-07-01T00:00:00Z'}),
    9: storedItem(9, 'Closed lately', {state: 'closed', updated_at: '2026-10-01T00:00:00Z'}),
    10: storedItem(10, 'Will close', {
      comments: 1,
      updated_at: '2026-11-08T00:00:00Z',
      last_comment: {author: 'mallory', at: '2026-11-02T00:00:00Z', excerpt: 'Thanks'}
    }),
    11: storedItem(11, 'Gets comments'),
    12: storedItem(12, 'Gets reactions', {reactions: 1}),
    13: storedItem(13, 'Will merge', {is_pr: true, review_comments: 1, draft: false}),
    14: storedItem(14, 'Edited', {state: 'closed', updated_at: '2026-11-09T00:00:00Z'})
  },
  discussions: {
    5: {
      title: 'Roadmap',
      excerpt: 'What comes next.',
      closed: false,
      answered: null,
      author: 'owner',
      bot: false,
      category: 'Ideas',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      comments: 0,
      reactions: 0,
      comment_reactions: 0,
      last_comment: null,
      owner_commented: false,
      owner_reacted: false,
      url: `${WEB}/discussions/5`
    }
  },
  forks: [
    {login: 'alice', full_name: 'alice/demo', created_at: '2026-01-01T00:00:00Z'},
    {login: 'bob', full_name: 'bob/demo', created_at: '2026-02-01T00:00:00Z'}
  ],
  watchers: ['owner', 'carol', 'dave'],
  stars: null,
  releases: {
    100: {
      tag_name: '1.0.0',
      name: 'Release 1.0.0',
      draft: true,
      prerelease: false,
      published_at: null,
      html_url: `${WEB}/releases/tag/1.0.0`
    }
  },
  alerts: {
    dependabot: {open: 1, by_severity: {high: 1}},
    code_scanning: {open: 2, by_severity: {warning: 2}}
  },
  ci: {
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    updated_at: '2026-11-09T00:00:00Z',
    html_url: `${WEB}/actions/runs/1`
  }
});

const apiIssue = (number, extra) => ({
  number,
  title: `Issue ${number}`,
  body: null,
  state: 'open',
  user: {login: 'mallory', type: 'User'},
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  comments: 0,
  reactions: {total_count: 0},
  labels: [],
  assignees: [],
  html_url: issueUrl(number),
  ...extra
});
const comment = (login, body, at) => ({
  user: {login},
  body,
  updated_at: at,
  reactions: {total_count: 0}
});

const movedRoutes = () => ({
  ...quietRoutes({
    stargazers_count: 13,
    forks_count: 3,
    subscribers_count: 4,
    open_issues_count: 5,
    has_discussions: true
  }),
  [`${R}/security-advisories`]: [
    {
      ghsa_id: 'GHSA-aaaa-aaaa-aaaa',
      cve_id: 'CVE-2026-2000',
      state: 'published',
      severity: 'high',
      summary: 'Crash on deep input',
      published_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-12T00:00:00Z',
      html_url: adv('GHSA-aaaa-aaaa-aaaa')
    },
    {
      ghsa_id: 'GHSA-bbbb-bbbb-bbbb',
      cve_id: null,
      state: 'published',
      severity: 'medium',
      summary: 'Slow on long keys',
      published_at: '2026-11-13T00:00:00Z',
      updated_at: '2026-11-13T00:00:00Z',
      html_url: adv('GHSA-bbbb-bbbb-bbbb')
    },
    {
      ghsa_id: 'GHSA-cccc-cccc-cccc',
      cve_id: 'CVE-2026-1000',
      state: 'published',
      severity: 'low',
      summary: 'Leak',
      published_at: '2026-11-03T00:00:00Z',
      updated_at: '2026-11-14T00:00:00Z',
      html_url: adv('GHSA-cccc-cccc-cccc')
    },
    {
      ghsa_id: 'GHSA-dddd-dddd-dddd',
      cve_id: null,
      state: 'draft',
      severity: null,
      summary: 'New report',
      published_at: null,
      updated_at: '2026-11-15T00:00:00Z',
      html_url: adv('GHSA-dddd-dddd-dddd')
    }
  ],
  [`${R}/issues?state=open`]: [
    apiIssue(11, {title: 'Gets comments', comments: 2, updated_at: '2026-11-15T00:00:00Z'}),
    apiIssue(12, {title: 'Gets reactions', reactions: {total_count: 3}}),
    apiIssue(15, {
      title: 'Parser stops at depth 100',
      body: '<!-- template -->\r\nThe parser stops at [depth 100](https://example.com/x) and throws.',
      user: {login: 'nina', type: 'User'},
      created_at: '2026-11-14T00:00:00Z',
      updated_at: '2026-11-14T00:00:00Z',
      labels: [{name: 'bug'}],
      assignees: [{login: 'owner'}]
    }),
    apiIssue(16, {
      title: 'Bump marked',
      user: {login: 'dependabot[bot]', type: 'Bot'},
      created_at: '2026-11-15T00:00:00Z',
      updated_at: '2026-11-15T00:00:00Z',
      pull_request: {merged_at: null},
      draft: false
    }),
    apiIssue(17, {
      title: 'Older, never seen',
      user: {login: 'oscar', type: 'User'},
      created_at: '2026-11-05T00:00:00Z',
      updated_at: '2026-11-15T00:00:00Z',
      comments: 1
    })
  ],
  [`${R}/issues?state=all`]: [
    apiIssue(10, {
      title: 'Will close',
      state: 'closed',
      comments: 1,
      updated_at: '2026-11-12T00:00:00Z'
    }),
    apiIssue(11, {title: 'Gets comments', comments: 2, updated_at: '2026-11-15T00:00:00Z'}),
    apiIssue(13, {
      title: 'Will merge',
      state: 'closed',
      pull_request: {merged_at: '2026-11-12T00:00:00Z'},
      draft: false,
      updated_at: '2026-11-12T00:00:00Z'
    }),
    apiIssue(14, {title: 'Edited', state: 'closed', updated_at: '2026-11-13T00:00:00Z'})
  ],
  [`${R}/issues/10/comments`]: [comment('mallory', 'Thanks', '2026-11-02T00:00:00Z')],
  [`${R}/issues/11/comments`]: [
    comment('owner', 'Looking.', '2026-11-14T00:00:00Z'),
    comment('ivan', 'Same here on Windows; trace attached below.', '2026-11-15T00:00:00Z')
  ],
  [`${R}/issues/13/comments`]: [],
  [`${R}/pulls/13/comments`]: [comment('mallory', 'nit', '2026-11-03T00:00:00Z')],
  [`${R}/issues/16/comments`]: [],
  [`${R}/pulls/16/comments`]: [],
  [`${R}/issues/17/comments`]: [
    comment('peggy', '> quoted\nIt fails for me too.', '2026-11-15T00:00:00Z')
  ],
  [`${R}/issues/12/reactions`]: [
    {user: {login: 'owner'}},
    {user: {login: 'x'}},
    {user: {login: 'y'}}
  ],
  graphql: {
    data: {
      repository: {
        discussions: {
          pageInfo: {hasNextPage: false, endCursor: null},
          nodes: [
            {
              number: 5,
              title: 'Roadmap',
              url: `${WEB}/discussions/5`,
              body: 'What comes next.',
              createdAt: '2026-10-01T00:00:00Z',
              updatedAt: '2026-11-14T00:00:00Z',
              closed: false,
              isAnswered: null,
              author: {login: 'owner', __typename: 'User'},
              category: {name: 'Ideas'},
              reactions: {totalCount: 0},
              reactionGroups: [],
              comments: {
                totalCount: 1,
                nodes: [
                  {
                    updatedAt: '2026-11-14T00:00:00Z',
                    body: 'Streaming, please.',
                    author: {login: 'quinn'},
                    reactions: {totalCount: 0},
                    viewerDidAuthor: false
                  }
                ]
              }
            },
            {
              number: 6,
              title: 'How do I stream?',
              url: `${WEB}/discussions/6`,
              body: 'A question about streams.',
              createdAt: '2026-11-15T00:00:00Z',
              updatedAt: '2026-11-15T00:00:00Z',
              closed: false,
              isAnswered: false,
              author: {login: 'rita', __typename: 'User'},
              category: {name: 'Q&A'},
              reactions: {totalCount: 0},
              reactionGroups: [{viewerHasReacted: false}],
              comments: {totalCount: 0, nodes: []}
            }
          ]
        }
      }
    }
  },
  [`${R}/forks?sort=newest`]: [
    {owner: {login: 'hank'}, full_name: 'hank/demo', created_at: '2026-11-13T00:00:00Z'},
    {owner: {login: 'gina'}, full_name: 'gina/demo', created_at: '2026-11-12T00:00:00Z'},
    {owner: {login: 'alice'}, full_name: 'alice/demo', created_at: '2026-01-01T00:00:00Z'}
  ],
  [`${R}/subscribers`]: [{login: 'owner'}, {login: 'carol'}, {login: 'erin'}, {login: 'frank'}],
  [`${R}/releases`]: [
    {
      id: 101,
      tag_name: '1.1.0-rc.1',
      name: null,
      draft: false,
      prerelease: true,
      published_at: '2026-11-15T00:00:00Z',
      html_url: `${WEB}/releases/tag/1.1.0-rc.1`
    },
    {
      id: 100,
      tag_name: '1.0.0',
      name: 'Release 1.0.0',
      draft: false,
      prerelease: false,
      published_at: '2026-11-12T00:00:00Z',
      html_url: `${WEB}/releases/tag/1.0.0`
    }
  ],
  [`${R}/dependabot/alerts?state=open`]: route =>
    /after=2/.test(route)
      ? withHead([{security_advisory: {severity: 'high'}}])
      : withHead(
          [{security_advisory: {severity: 'high'}}, {security_advisory: {severity: 'low'}}],
          `${R}/dependabot/alerts?state=open&per_page=100&after=2`
        ),
  [`${R}/code-scanning/alerts?state=open`]: [{rule: {severity: 'warning'}}],
  [`${R}/actions/runs?branch=main`]: {
    workflow_runs: [
      {event: 'dynamic', name: 'Dependabot Updates', status: 'completed', conclusion: 'success'},
      {
        event: 'push',
        name: 'CI',
        status: 'completed',
        conclusion: 'failure',
        updated_at: '2026-11-15T00:00:00Z',
        html_url: `${WEB}/actions/runs/2`
      }
    ]
  }
});

test('a run against the baseline reports each family of events', async t => {
  const {gh, calls} = ghStub(movedRoutes());
  const entry = await collect(gh, {baseline: baselineFixture()});
  t.deepEqual(entry.errors, []);
  t.equal(entry.first_run, false);
  t.deepEqual(
    entry.events.map(e => `${e.kind} ${e.number ?? e.id ?? e.login ?? ''}`.trimEnd()),
    [
      'advisory.cve_assigned GHSA-aaaa-aaaa-aaaa',
      'advisory.state GHSA-bbbb-bbbb-bbbb',
      'advisory.updated GHSA-cccc-cccc-cccc',
      'advisory.new GHSA-dddd-dddd-dddd',
      'issue.state 10',
      'issue.comments 11',
      'issue.reactions 12',
      'pr.state 13',
      'issue.updated 14',
      'issue.new 15',
      'pr.new 16',
      'issue.updated 17',
      'discussion.comments 5',
      'discussion.new 6',
      'fork.new hank',
      'fork.new gina',
      'fork.removed bob',
      'stars.count',
      'watcher.new erin',
      'watcher.new frank',
      'watcher.removed dave',
      'release.published 100',
      'release.new 101',
      'alerts.dependabot',
      'alerts.code_scanning',
      'ci.conclusion'
    ]
  );
  const byKey = Object.fromEntries(entry.events.map(e => [`${e.kind} ${e.number ?? ''}`, e]));
  t.deepEqual(byKey['issue.comments 11'], {
    kind: 'issue.comments',
    repo: 'example/demo',
    number: 11,
    title: 'Gets comments',
    author: 'mallory',
    bot: false,
    url: issueUrl(11),
    delta: 2,
    total: 2,
    last_comment: {
      author: 'ivan',
      at: '2026-11-15T00:00:00Z',
      excerpt: 'Same here on Windows; trace attached below.'
    }
  });
  t.deepEqual(byKey['issue.new 15'], {
    kind: 'issue.new',
    repo: 'example/demo',
    number: 15,
    title: 'Parser stops at depth 100',
    author: 'nina',
    bot: false,
    url: issueUrl(15),
    state: 'open',
    comments: 0,
    reactions: 0,
    excerpt: 'The parser stops at depth 100 and throws.'
  });
  t.equal(byKey['issue.updated 17'].note, 'not in baseline');
  t.equal(byKey['issue.updated 17'].last_comment.author, 'peggy');
  t.equal(byKey['issue.updated 14'].updated_at, '2026-11-13T00:00:00Z');
  t.deepEqual([byKey['pr.state 13'].from, byKey['pr.state 13'].to], ['open', 'merged']);
  t.deepEqual([byKey['issue.reactions 12'].delta, byKey['issue.reactions 12'].total], [2, 3]);
  t.equal(byKey['pr.new 16'].bot, true);
  t.deepEqual(byKey['stars.count '], {
    kind: 'stars.count',
    repo: 'example/demo',
    from: 10,
    to: 13,
    delta: 3
  });
  t.deepEqual(byKey['alerts.dependabot '], {
    kind: 'alerts.dependabot',
    repo: 'example/demo',
    from: 1,
    to: 3,
    by_severity: {high: 2, low: 1}
  });
  t.deepEqual(byKey['ci.conclusion '], {
    kind: 'ci.conclusion',
    repo: 'example/demo',
    from: 'success',
    to: 'failure',
    name: 'CI',
    url: `${WEB}/actions/runs/2`
  });

  const {items, discussions} = entry.snapshot;
  t.deepEqual(Object.keys(items), ['9', '10', '11', '12', '13', '14', '15', '16', '17']);
  t.deepEqual(Object.keys(items[16]), [...Object.keys(storedItem(16, 'x')), 'draft']);
  t.equal(items[11].owner_commented, true);
  t.equal(items[12].owner_reacted, true);
  t.equal(items[12].owner_commented, false);
  t.equal(items[13].state, 'merged');
  t.equal(items[13].review_comments, 1);
  t.deepEqual(items[15].labels, ['bug']);
  t.deepEqual(items[15].assignees, ['owner']);
  t.equal(discussions[6].owner_reacted, false);
  t.equal(discussions[5].last_comment.author, 'quinn');
  t.equal(entry.snapshot.window.since, BASE_TIME);
  t.deepEqual(Object.keys(entry.snapshot.releases), ['100', '101']);
  t.equal(entry.summary.open_items, 5);
  t.equal(entry.summary.advisories_without_cve, 1);
  t.equal(entry.summary.events, 26);
  t.ok(
    calls.some(args => args.at(-1).includes('since=2026-11-10T00%3A00%3A00.000Z')),
    'the window starts at the baseline'
  );
  // gh api sends a POST for -X, --method, or --input, and for any field (-f, -F) on a REST route.
  t.ok(
    calls.every(args => !args.some(a => /^(?:-X|--method|--input)$/.test(a))),
    'no call names a method or a body'
  );
  t.ok(
    calls.every(
      args => args[1] === 'graphql' || !args.some(a => /^(?:-f|-F|--field|--raw-field)$/.test(a))
    ),
    'fields go only with the GraphQL query'
  );
  const query = calls.find(args => args[1] === 'graphql');
  t.notOk(/\bmutation\b/i.test(query.join(' ')), 'the GraphQL text is a query');
});

const EVENT_CASES = [
  {
    kind: 'advisory.state',
    repo: 'owner/alpha',
    id: 'GHSA-bbbb-bbbb-bbbb',
    summary: 'Slow on long keys',
    severity: 'medium',
    from: 'triage',
    to: 'published'
  },
  {
    kind: 'advisory.cve_assigned',
    repo: 'owner/alpha',
    id: 'GHSA-aaaa-aaaa-aaaa',
    summary: 'Crash on deep input',
    severity: 'high',
    cve_id: 'CVE-2026-2000'
  },
  {
    kind: 'pr.state',
    repo: 'owner/alpha',
    number: 16,
    title: 'Bump marked',
    author: 'dependabot[bot]',
    bot: true,
    from: 'open',
    to: 'merged'
  },
  {
    kind: 'issue.comments',
    repo: 'owner/alpha',
    number: 11,
    title: 'Gets comments',
    author: 'mallory',
    bot: false,
    delta: 1,
    total: 3,
    last_comment: {author: 'ivan', at: '2026-11-15T00:00:00Z', excerpt: 'Same here.'}
  },
  {
    kind: 'discussion.comments',
    repo: 'owner/alpha',
    number: 5,
    title: 'Roadmap',
    author: 'owner',
    bot: false,
    delta: 2,
    total: 2,
    last_comment: null
  },
  {
    kind: 'issue.reactions',
    repo: 'owner/alpha',
    number: 12,
    title: 'Gets reactions',
    author: 'mallory',
    bot: false,
    delta: -1,
    total: 2
  },
  {
    kind: 'pr.reactions',
    repo: 'owner/alpha',
    number: 13,
    title: 'Will merge',
    author: 'mallory',
    bot: false,
    delta: 3,
    total: 3
  },
  {
    kind: 'issue.updated',
    repo: 'owner/alpha',
    number: 17,
    title: 'Older, never seen',
    author: 'oscar',
    bot: false,
    excerpt: 'It fails on the second run.',
    note: 'not in baseline'
  },
  {kind: 'issue.updated', repo: 'owner/alpha', number: 14, title: 'Edited', author: null},
  {
    kind: 'discussion.new',
    repo: 'owner/alpha',
    number: 6,
    title: 'How do I stream?',
    author: 'rita',
    bot: false,
    excerpt: 'A question about streams.'
  },
  {kind: 'fork.new', repo: 'owner/alpha', login: 'gina', full_name: 'gina/alpha'},
  {kind: 'fork.removed', repo: 'owner/alpha', login: 'bob', full_name: 'bob/alpha'},
  {kind: 'star.new', repo: 'owner/alpha', login: 'ann'},
  {kind: 'watcher.removed', repo: 'owner/alpha', login: 'dave'},
  {kind: 'stars.count', repo: 'owner/alpha', from: 10, to: 13, delta: 3},
  {kind: 'forks.count', repo: 'owner/alpha', from: null, to: 3},
  {kind: 'watchers.count', repo: 'owner/alpha', from: 4, to: 3},
  {kind: 'release.new', repo: 'owner/alpha', id: 101, tag: '1.1.0', name: 'Release 1.1.0'},
  {kind: 'release.published', repo: 'owner/alpha', id: 100, tag: '1.0.0', name: null},
  {kind: 'alerts.code_scanning', repo: 'owner/alpha', from: 2, to: 1, by_severity: {}},
  {kind: 'ci.conclusion', repo: 'owner/alpha', from: 'success', to: 'failure', name: 'CI'},
  {kind: 'package.dependents', repo: 'owner/alpha', package: 'alpha', from: 40, to: 43, delta: 3},
  {kind: 'other.kind', repo: 'owner/alpha', value: 1}
];

// Each kind's line for an entry holding EVENT_CASES and no snapshot, as stored runs print it.
const EVENT_LINES = [
  'advisory.state GHSA-bbbb-bbbb-bbbb triage → published — Slow on long keys',
  'advisory.cve_assigned GHSA-aaaa-aaaa-aaaa CVE-2026-2000 — Crash on deep input',
  'pr.state #16 by dependabot[bot] (bot) — Bump marked (open → merged)',
  'issue.comments #11 by mallory — Gets comments (+1 comment, last ivan: "Same here.")',
  'discussion.comments #5 by owner — Roadmap (+2 comments)',
  'issue.reactions #12 by mallory — Gets reactions (-1 reaction)',
  'pr.reactions #13 by mallory — Will merge (+3 reactions)',
  'issue.updated #17 by oscar — Older, never seen (not in baseline) — It fails on the second run.',
  'issue.updated #14 — Edited',
  'discussion.new #6 by rita — How do I stream? — A question about streams.',
  'fork.new gina (gina/alpha)',
  'fork.removed bob (bob/alpha)',
  'star.new ann',
  'watcher.removed dave',
  'stars.count 10 → 13',
  'forks.count null → 3',
  'watchers.count 4 → 3',
  'release.new 1.1.0 — Release 1.1.0',
  'release.published 1.0.0',
  'alerts.code_scanning 2 → 1 open',
  'ci CI: success → failure',
  'package.dependents alpha 40 → 43',
  'other.kind {"kind":"other.kind","repo":"owner/alpha","value":1}'
];

test('eventLine prints each kind as a stored run shows it', t => {
  t.deepEqual(EVENT_CASES.map(eventLine), EVENT_LINES);
});

test('diff: login lists, counts alone, a discussion closing, reactions with no scan', t => {
  const base = {
    collected_at: BASE_TIME,
    meta: {stars: 2, forks: 1, watchers: 1},
    advisories: {},
    items: {
      3: {
        state: 'open',
        comments: 70,
        review_comments: 0,
        reactions: 1,
        comment_reactions: null,
        updated_at: 'a'
      }
    },
    discussions: {4: {title: 'Q', closed: false, comments: 0, reactions: 0, comment_reactions: 0}},
    forks: null,
    watchers: null,
    stars: ['ann', 'ben'],
    releases: {},
    alerts: {dependabot: {unavailable: 'off', status: 403}},
    ci: null
  };
  const now = {
    ...base,
    meta: {stars: 2, forks: 2, watchers: 3},
    items: {3: {...base.items[3], reactions: 4, updated_at: 'b'}},
    discussions: {4: {...base.discussions[4], closed: true}},
    stars: ['ann', 'cat'],
    alerts: {dependabot: {open: 2, by_severity: {low: 2}}}
  };
  t.deepEqual(diff(base, now, 'example/demo'), [
    {
      kind: 'issue.reactions',
      repo: 'example/demo',
      number: 3,
      title: undefined,
      author: undefined,
      bot: false,
      url: undefined,
      delta: 3,
      total: 4
    },
    {
      kind: 'discussion.state',
      repo: 'example/demo',
      number: 4,
      title: 'Q',
      author: undefined,
      bot: false,
      url: undefined,
      from: 'open',
      to: 'closed'
    },
    {kind: 'forks.count', repo: 'example/demo', from: 1, to: 2},
    {kind: 'star.new', repo: 'example/demo', login: 'cat'},
    {kind: 'star.removed', repo: 'example/demo', login: 'ben'},
    {kind: 'watchers.count', repo: 'example/demo', from: 1, to: 3}
  ]);
  t.deepEqual(diff(null, now, 'example/demo'), []);
});

test('a private repository is read only when tracked, and without its advisories', async t => {
  const routes = quietRoutes({private: true});
  delete routes[`${R}/security-advisories`];
  const {gh, calls} = ghStub(routes);
  t.deepEqual(await collect(gh), {
    repo: 'example/demo',
    project: 'demo',
    skipped: true,
    reason: 'private',
    events: [],
    summary: {events: 0}
  });
  t.equal(calls.length, 1, 'nothing past the repository is read');

  const entry = await collect(gh, {tracked: true});
  t.equal(entry.first_run, true);
  t.deepEqual(entry.errors, []);
  t.deepEqual(entry.snapshot.advisories, {});
});

test('a repository that cannot be read is an error entry', async t => {
  const {gh} = ghStub({});
  t.deepEqual(await collect(gh), {
    repo: 'example/demo',
    project: 'demo',
    error: {status: 404, message: 'Not Found'},
    events: [],
    summary: {events: 0}
  });
  const missing = await collect(args => runGh(args, {bin: 'pc-test-no-such-gh'}));
  t.matchString(missing.error.message, /not installed/);
});

test('a partial failure is listed and the read goes on', async t => {
  const routes = quietRoutes();
  routes[`${R}/releases`] = () => httpError(502, 'Bad Gateway');
  routes[`${R}/dependabot/alerts?state=open`] = () => {
    const {out, err} = httpError(403, 'Dependabot alerts are disabled for this repository.');
    return {
      code: 1,
      out: `HTTP/2.0 403 Forbidden\r\nContent-Type: application/json\r\n\r\n${out}`,
      err
    };
  };
  const {gh} = ghStub(routes);
  const entry = await collect(gh);
  t.deepEqual(entry.errors, [{where: 'releases', status: 502, message: 'Bad Gateway'}]);
  t.deepEqual(entry.snapshot.alerts.dependabot, {
    unavailable: 'Dependabot alerts are disabled for this repository.',
    status: 403
  });
});

test("another repository's baseline counts as none", async t => {
  const {gh} = ghStub(quietRoutes());
  const entry = await collect(gh, {baseline: {...baselineFixture(), repo: 'example/old'}});
  t.equal(entry.first_run, true);
  t.equal(entry.replaced_baseline, 'example/old');
  t.deepEqual(entry.events, []);
  const same = await collect(gh, {baseline: {...baselineFixture(), repo: 'Example/Demo'}});
  t.equal(same.first_run, false);
  t.equal(same.replaced_baseline, undefined);
});

const ciRun = (event, conclusion, created_at, extra = {}) => ({
  event,
  name: 'CI',
  status: 'completed',
  conclusion,
  created_at,
  updated_at: created_at,
  html_url: `${WEB}/actions/runs/${created_at}`,
  ...extra
});
const closedPr = (number, merged_at, sha) => ({number, merged_at, head: {sha}});

test("CI: a pull request merged after the default branch's last run stands in for it", async t => {
  const routes = quietRoutes();
  routes[`${R}/actions/runs?branch=main`] = {
    workflow_runs: [
      ciRun('dynamic', 'success', '2026-11-16T00:00:00Z'),
      ciRun('pull_request', 'failure', '2026-11-15T12:00:00Z'),
      ciRun('push', 'success', '2026-10-08T00:00:00Z')
    ]
  };
  routes[`${R}/pulls?state=closed&base=main&sort=updated&direction=desc`] = [
    closedPr(8, null, 'unmerged'),
    closedPr(6, '2026-11-01T00:00:00Z', 'older'),
    closedPr(7, '2026-11-15T00:00:00Z', 'merged'),
    closedPr(5, '2026-10-01T00:00:00Z', 'before')
  ];
  routes[`${R}/actions/runs?event=pull_request&head_sha=merged`] = {
    workflow_runs: [ciRun('pull_request', 'success', '2026-11-14T00:00:00Z')]
  };
  const {gh, calls} = ghStub(routes);
  const entry = await collect(gh);
  t.deepEqual(entry.errors, []);
  t.deepEqual(entry.snapshot.ci, {
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    updated_at: '2026-11-14T00:00:00Z',
    html_url: `${WEB}/actions/runs/2026-11-14T00:00:00Z`,
    pull_request: {number: 7, merged_at: '2026-11-15T00:00:00Z'}
  });
  t.notOk(calls.some(args => /head_sha=(older|unmerged|before)/.test(args.at(-1))));
});

test("CI: a merged pull request with no run yields to an older one, then to the branch's", async t => {
  const routes = quietRoutes();
  routes[`${R}/actions/runs?branch=main`] = {
    workflow_runs: [ciRun('push', 'failure', '2026-10-08T00:00:00Z')]
  };
  routes[`${R}/pulls?state=closed&base=main&sort=updated&direction=desc`] = [
    closedPr(7, '2026-11-15T00:00:00Z', 'docs'),
    closedPr(6, '2026-11-01T00:00:00Z', 'code')
  ];
  routes[`${R}/actions/runs?event=pull_request&head_sha=docs`] = {workflow_runs: []};
  routes[`${R}/actions/runs?event=pull_request&head_sha=code`] = {
    workflow_runs: [ciRun('pull_request', 'success', '2026-10-31T00:00:00Z')]
  };
  const {gh} = ghStub(routes);
  t.equal((await collect(gh)).snapshot.ci.pull_request?.number, 6);

  routes[`${R}/actions/runs?event=pull_request&head_sha=code`] = {workflow_runs: []};
  const fallback = (await collect(ghStub(routes).gh)).snapshot.ci;
  t.equal(fallback.conclusion, 'failure');
  t.equal(fallback.pull_request, undefined);
});

test("CI: a commit's runs read as one, a workflow's newest run counting and a failure winning", async t => {
  const routes = quietRoutes();
  routes[`${R}/actions/runs?branch=main`] = {workflow_runs: []};
  routes[`${R}/pulls?state=closed&base=main&sort=updated&direction=desc`] = [
    closedPr(7, '2026-11-15T00:00:00Z', 'merged')
  ];
  const checks = ciRun('pull_request', 'success', '2026-11-14T00:00:02Z', {
    name: 'Checks',
    workflow_id: 2
  });
  const tests = ciRun('pull_request', 'failure', '2026-11-14T00:00:01Z', {
    name: 'Tests',
    workflow_id: 1
  });
  routes[`${R}/actions/runs?event=pull_request&head_sha=merged`] = {workflow_runs: [checks, tests]};
  let ci = (await collect(ghStub(routes).gh)).snapshot.ci;
  t.equal(ci.name, 'Tests');
  t.equal(ci.conclusion, 'failure');

  const rerun = {...tests, conclusion: 'success', created_at: '2026-11-14T01:00:00Z'};
  routes[`${R}/actions/runs?event=pull_request&head_sha=merged`] = {
    workflow_runs: [rerun, checks, tests]
  };
  ci = (await collect(ghStub(routes).gh)).snapshot.ci;
  t.equal(ci.conclusion, 'success');

  routes[`${R}/pulls?state=closed&base=main&sort=updated&direction=desc`] = [];
  routes[`${R}/actions/runs?branch=main`] = {
    workflow_runs: [
      ciRun('push', 'success', '2026-11-16T00:00:02Z', {workflow_id: 2, head_sha: 'tip'}),
      ciRun('push', 'failure', '2026-11-16T00:00:01Z', {workflow_id: 1, head_sha: 'tip'}),
      ciRun('push', 'success', '2026-11-15T00:00:00Z', {workflow_id: 1, head_sha: 'before'})
    ]
  };
  ci = (await collect(ghStub(routes).gh)).snapshot.ci;
  t.equal(ci.conclusion, 'failure');
  t.equal(ci.updated_at, '2026-11-16T00:00:01Z');
});

test("CI: the default branch's own run wins over a pull request merged before it", async t => {
  const routes = quietRoutes();
  routes[`${R}/actions/runs?branch=main`] = {
    workflow_runs: [ciRun('push', 'success', '2026-11-15T00:01:00Z')]
  };
  routes[`${R}/pulls?state=closed&base=main&sort=updated&direction=desc`] = [
    closedPr(7, '2026-11-15T00:00:00Z', 'merged')
  ];
  const {gh, calls} = ghStub(routes);
  const entry = await collect(gh);
  t.deepEqual(entry.errors, []);
  t.equal(entry.snapshot.ci.updated_at, '2026-11-15T00:01:00Z');
  t.equal(entry.snapshot.ci.pull_request, undefined);
  t.notOk(calls.some(args => /head_sha=/.test(args.at(-1))));

  routes[`${R}/actions/runs?branch=main`] = {workflow_runs: []};
  routes[`${R}/pulls?state=closed&base=main&sort=updated&direction=desc`] = [];
  t.equal((await collect(ghStub(routes).gh)).snapshot.ci, null);
});

test('CI: with no run found, no active workflow file is no CI, and one is a failed read', async t => {
  const routes = quietRoutes();
  const workflow = (path, state = 'active') => ({path, state});
  routes[`${R}/actions/workflows`] = {
    total_count: 2,
    workflows: [
      workflow('dynamic/dependabot/dependabot-updates'),
      workflow('.github/workflows/old.yml', 'disabled_manually')
    ]
  };
  let entry = await collect(ghStub(routes).gh);
  t.equal(entry.snapshot.ci, null);
  t.deepEqual(entry.errors, []);

  routes[`${R}/actions/workflows`].workflows.push(workflow('.github/workflows/tests.yml'));
  entry = await collect(ghStub(routes).gh);
  t.equal(entry.snapshot.ci, null);
  t.deepEqual(entry.errors, [
    {where: 'ci', status: null, message: 'no run found on main for .github/workflows/tests.yml'}
  ]);

  routes[`${R}/actions/runs?branch=main`] = {
    workflow_runs: [ciRun('push', 'success', '2026-11-15T00:00:00Z')]
  };
  const {gh, calls} = ghStub(routes);
  t.equal((await collect(gh)).snapshot.ci.conclusion, 'success');
  t.notOk(
    calls.some(args => args.at(-1).includes('/actions/workflows')),
    'read only on a miss'
  );
});

const ALPHA_EVENTS = [
  {
    kind: 'issue.new',
    repo: 'owner/alpha',
    number: 15,
    title: 'Parser stops at depth 100',
    author: 'nina',
    bot: false,
    url: 'https://github.com/owner/alpha/issues/15',
    state: 'open',
    comments: 0,
    reactions: 0,
    excerpt:
      'The parser stops at depth 100 and throws a RangeError when the input nests deeper than the default limit allows.'
  },
  {
    kind: 'advisory.cve_assigned',
    repo: 'owner/alpha',
    id: 'GHSA-aaaa-aaaa-aaaa',
    summary: 'Crash on deep input',
    severity: 'high',
    html_url: 'https://github.com/owner/alpha/security/advisories/GHSA-aaaa-aaaa-aaaa',
    cve_id: 'CVE-2026-2000'
  },
  {
    kind: 'issue.comments',
    repo: 'owner/alpha',
    number: 11,
    title: 'A long title that runs past the fifty characters the brief keeps',
    author: 'mallory',
    bot: false,
    url: 'https://github.com/owner/alpha/issues/11',
    delta: 2,
    total: 2,
    last_comment: {
      author: 'ivan',
      at: '2026-11-15T00:00:00Z',
      excerpt:
        'Same here on Windows; trace attached below, and it goes away when the cache is cleared first.'
    }
  },
  {
    kind: 'pr.state',
    repo: 'owner/alpha',
    number: 13,
    title: 'Fix the cache',
    author: 'mallory',
    bot: false,
    url: 'https://github.com/owner/alpha/pull/13',
    from: 'open',
    to: 'merged'
  },
  {
    kind: 'release.new',
    repo: 'owner/alpha',
    id: 101,
    tag: '1.1.0-rc.1',
    name: null,
    url: 'https://github.com/owner/alpha/releases/tag/1.1.0-rc.1',
    draft: false,
    prerelease: true
  },
  {
    kind: 'ci.conclusion',
    repo: 'owner/alpha',
    from: 'success',
    to: 'failure',
    name: 'CI',
    url: 'https://github.com/owner/alpha/actions/runs/2'
  },
  {kind: 'alerts.dependabot', repo: 'owner/alpha', from: 1, to: 3, by_severity: {high: 2, low: 1}},
  {kind: 'stars.count', repo: 'owner/alpha', from: 10, to: 12, delta: 2},
  {
    kind: 'fork.new',
    repo: 'owner/alpha',
    login: 'gina',
    full_name: 'gina/alpha',
    created_at: '2026-11-12T00:00:00Z'
  },
  {
    kind: 'issue.reactions',
    repo: 'owner/alpha',
    number: 12,
    title: 'Gets reactions',
    author: 'mallory',
    bot: false,
    url: 'https://github.com/owner/alpha/issues/12',
    delta: 2,
    total: 3
  },
  {
    kind: 'pr.new',
    repo: 'owner/alpha',
    number: 16,
    title: 'Bump marked',
    author: 'dependabot[bot]',
    bot: true,
    url: 'https://github.com/owner/alpha/pull/16',
    state: 'open',
    comments: 0,
    reactions: 0,
    excerpt: null
  },
  {kind: 'watcher.new', repo: 'owner/alpha', login: 'erin'}
];

const ALPHA = {
  repo: 'owner/alpha',
  project: 'alpha',
  first_run: false,
  collected_at: '2026-11-16T12:00:00.000Z',
  events: ALPHA_EVENTS,
  summary: {events: 12},
  errors: [],
  snapshot: {window: {since: '2026-11-10T08:30:00.000Z', first_run: false}}
};

const BETA = {
  repo: 'owner/beta',
  project: 'beta',
  first_run: false,
  collected_at: '2026-11-16T12:00:00.000Z',
  events: [
    {
      kind: 'issue.comments',
      repo: 'owner/beta',
      number: 3,
      title: 'Docs',
      author: 'sam',
      bot: false,
      url: 'https://github.com/owner/beta/issues/3',
      delta: 1,
      total: 4,
      last_comment: {author: 'owner', at: '2026-11-15T00:00:00Z', excerpt: 'Fixed in 1.2.'}
    },
    {
      kind: 'issue.updated',
      repo: 'owner/beta',
      number: 4,
      title: 'Labels',
      author: 'sam',
      bot: false,
      url: 'https://github.com/owner/beta/issues/4',
      updated_at: '2026-11-15T00:00:00Z'
    }
  ],
  summary: {events: 2},
  errors: [],
  snapshot: {window: {since: '2026-11-09T00:00:00.000Z', first_run: false}}
};

const GAMMA = {
  repo: 'owner/gamma',
  project: 'gamma',
  first_run: true,
  collected_at: '2026-11-16T12:00:00.000Z',
  events: [],
  summary: {
    events: 0,
    by_kind: {},
    open_items: 1,
    advisories_without_cve: 2,
    stars: 1,
    forks: 0,
    comment_scan: 'full'
  },
  errors: [],
  snapshot: {window: {since: '2026-10-17T12:00:00.000Z', first_run: true}}
};

const EPSILON = {
  repo: 'other/epsilon',
  project: 'epsilon',
  first_run: false,
  since: '2026-11-11T00:00:00.000Z',
  events: [
    {
      kind: 'advisory.new',
      repo: 'other/epsilon',
      id: 'GHSA-dddd-dddd-dddd',
      summary: 'New report',
      severity: null,
      html_url: 'https://github.com/other/epsilon/security/advisories/GHSA-dddd-dddd-dddd',
      state: 'draft',
      cve_id: null
    },
    {
      kind: 'discussion.new',
      repo: 'other/epsilon',
      number: 6,
      title: 'How do I stream?',
      author: 'rita',
      bot: false,
      url: 'https://github.com/other/epsilon/discussions/6',
      state: 'open',
      comments: 0,
      reactions: 0,
      excerpt: 'A question about streams.'
    },
    {
      kind: 'discussion.updated',
      repo: 'other/epsilon',
      number: 7,
      title: 'Older thread',
      author: 'uma',
      bot: false,
      url: 'https://github.com/other/epsilon/discussions/7',
      state: 'open',
      comments: 3,
      reactions: 0,
      excerpt: null,
      note: 'not in baseline',
      last_comment: {author: 'tom', at: '2026-11-14T00:00:00Z', excerpt: 'Try the pipeline helper.'}
    },
    {
      kind: 'alerts.code_scanning',
      repo: 'other/epsilon',
      from: 2,
      to: 1,
      by_severity: {warning: 1}
    },
    {kind: 'forks.count', repo: 'other/epsilon', from: 4, to: 3},
    {kind: 'watcher.removed', repo: 'other/epsilon', login: 'dave'},
    {
      kind: 'advisory.state',
      repo: 'other/epsilon',
      id: 'GHSA-bbbb-bbbb-bbbb',
      summary: 'Slow on long keys',
      severity: 'medium',
      html_url: 'https://github.com/other/epsilon/security/advisories/GHSA-bbbb-bbbb-bbbb',
      from: 'triage',
      to: 'published'
    }
  ],
  summary: {events: 7},
  errors: []
};

const FLEET_DIGEST = {
  collected_at: '2026-11-16T12:00:00.000Z',
  mode: 'fleet',
  gh_user: 'owner',
  repos: [
    ALPHA,
    BETA,
    GAMMA,
    {
      repo: 'owner/delta',
      project: 'delta',
      error: {status: 404, message: 'Not Found'},
      events: [],
      summary: {events: 0}
    },
    EPSILON,
    {
      repo: 'owner/heya',
      project: 'heya-things',
      github: false,
      events: [
        {
          kind: 'package.dependents',
          repo: 'owner/heya',
          package: 'heya-things',
          from: 40,
          to: 43,
          delta: 3
        }
      ],
      summary: {events: 1},
      errors: [],
      packages: {
        collected_at: '2026-11-16T12:00:00.000Z',
        packages: [{name: 'heya-things', published: true}]
      }
    },
    {
      repo: 'owner/zeta',
      project: 'zeta',
      first_run: false,
      events: [],
      summary: {events: 0},
      errors: [{where: 'ci', status: 502, message: 'Bad Gateway'}],
      snapshot: {window: {since: '2026-11-12T00:00:00.000Z', first_run: false}}
    }
  ],
  package_errors: [{where: 'npm search', message: 'timeout'}],
  totals: {repos: 6, events: 22, first_run: 1, errors: 1, partial_errors: 2, packages: 1}
};

const BRIEF_CASES = [
  ['fleet', FLEET_DIGEST],
  [
    'stored',
    {
      ...FLEET_DIGEST,
      stored: {runs: 3, since: '2026-11-08T00:00:00.000Z', fleet_size: 10}
    }
  ],
  [
    'one repository',
    {
      collected_at: '2026-11-16T12:00:00.000Z',
      mode: 'cwd',
      gh_user: 'owner',
      repos: [ALPHA],
      totals: {repos: 1, events: 12, first_run: 0, errors: 0, partial_errors: 0, packages: 0}
    }
  ],
  [
    'first run',
    {
      collected_at: '2026-11-16T12:00:00.000Z',
      mode: 'cwd',
      gh_user: 'owner',
      repos: [{...GAMMA, repo: 'other/gamma'}],
      totals: {repos: 1, events: 0, first_run: 1, errors: 0, partial_errors: 0, packages: 0}
    }
  ],
  [
    'nothing worth a line',
    {
      collected_at: '2026-11-16T12:00:00.000Z',
      mode: 'repo',
      gh_user: 'owner',
      repos: [BETA],
      totals: {repos: 1, events: 2, first_run: 0, errors: 0, partial_errors: 0, packages: 0}
    }
  ],
  ['skipped', {skipped: true, mode: 'cwd', reason: 'not_github', remote: 'https://gitlab.com/x/y'}],
  [
    'signed out',
    {error: 'gh_auth', message: 'not logged in', hint: 'run gh auth login on this host'}
  ]
];

// The brief each case prints, as a collected file's brief reads.
const GOLDEN = {
  fleet: [
    'Fleet movement since 2026-11-09 00:00 — 6 repositories, 2 with movement',
    '- alpha: advisory GHSA-aaaa-aaaa-aaaa got CVE-2026-2000; new issue #15 by nina "Parser stops at depth 100" — The parser stops at depth 100 and throws a RangeError when the input nests…; issue #11 "A long title that runs past the fifty characters…" +2 comments by ivan: "Same here on Windows; trace attached below, and it goes away when the cache is…"; PR #13 "Fix the cache" open → merged; release 1.1.0-rc.1 (prerelease); CI CI: success → failure; Dependabot alerts 1 → 3',
    '- other/epsilon: advisory GHSA-dddd-dddd-dddd (draft) "New report"; advisory GHSA-bbbb-bbbb-bbbb triage → published; new discussion #6 by rita "How do I stream?" — A question about streams.; discussion #7 "Older thread" active, not in the baseline (3 comments, last by tom: "Try the pipeline helper.")',
    '- counters: stars +2 (alpha +2); forks 0 (alpha +1: gina, other/epsilon -1); watchers 0 (alpha +1: erin, other/epsilon -1); dependents +3 (heya-things +3); reactions +2 (alpha#12 +2); bots: PR alpha#16 by dependabot[bot]; alerts down (other/epsilon code scanning 2 → 1)',
    '- first run: 1 repository (baseline recorded)',
    '- errors: delta: Not Found',
    '- partial errors: 2 (details in the collected JSON)',
    '- quiet: 2 repositories'
  ].join('\n'),
  stored: [
    'Fleet movement since 2026-11-08 00:00 — 6 repositories, 2 with movement (3 stored runs, newest 2026-11-16 12:00)',
    '- alpha: advisory GHSA-aaaa-aaaa-aaaa got CVE-2026-2000; new issue #15 by nina "Parser stops at depth 100" — The parser stops at depth 100 and throws a RangeError when the input nests…; issue #11 "A long title that runs past the fifty characters…" +2 comments by ivan: "Same here on Windows; trace attached below, and it goes away when the cache is…"; PR #13 "Fix the cache" open → merged; release 1.1.0-rc.1 (prerelease); CI CI: success → failure; Dependabot alerts 1 → 3',
    '- other/epsilon: advisory GHSA-dddd-dddd-dddd (draft) "New report"; advisory GHSA-bbbb-bbbb-bbbb triage → published; new discussion #6 by rita "How do I stream?" — A question about streams.; discussion #7 "Older thread" active, not in the baseline (3 comments, last by tom: "Try the pipeline helper.")',
    '- counters: stars +2 (alpha +2); forks 0 (alpha +1: gina, other/epsilon -1); watchers 0 (alpha +1: erin, other/epsilon -1); dependents +3 (heya-things +3); reactions +2 (alpha#12 +2); bots: PR alpha#16 by dependabot[bot]; alerts down (other/epsilon code scanning 2 → 1)',
    '- first run: 1 repository (baseline recorded)',
    '- errors: delta: Not Found',
    '- partial errors: 2 (details in the collected JSON)',
    '- quiet: 8 repositories'
  ].join('\n'),
  'one repository': [
    'alpha — movement since 2026-11-10 08:30',
    '- alpha: advisory GHSA-aaaa-aaaa-aaaa got CVE-2026-2000; new issue #15 by nina "Parser stops at depth 100" — The parser stops at depth 100 and throws a RangeError when the input nests…; issue #11 "A long title that runs past the fifty characters…" +2 comments by ivan: "Same here on Windows; trace attached below, and it goes away when the cache is…"; PR #13 "Fix the cache" open → merged; release 1.1.0-rc.1 (prerelease); CI CI: success → failure; Dependabot alerts 1 → 3',
    '- counters: stars +2 (alpha +2); forks +1 (alpha +1: gina); watchers +1 (alpha +1: erin); reactions +2 (alpha#12 +2); bots: PR alpha#16 by dependabot[bot]'
  ].join('\n'),
  'first run': [
    'other/gamma — movement since the baseline',
    '- first run — baseline recorded (1 open item, 1 star, 0 forks, 2 published advisories without a CVE)'
  ].join('\n'),
  'nothing worth a line': ['beta — movement since 2026-11-09 00:00', '- none'].join('\n'),
  skipped: ['skipped: not_github (https://gitlab.com/x/y)'].join('\n'),
  'signed out': ['gh_auth: not logged in — run gh auth login on this host'].join('\n')
};

test('renderBrief prints the brief of a collected digest', t => {
  for (const [name, digest] of BRIEF_CASES) t.equal(renderBrief(digest), GOLDEN[name], name);
  t.equal(
    renderBrief(BRIEF_CASES[2][1], {header: false}),
    GOLDEN['one repository'].split(/\r?\n/).slice(1).join('\n'),
    'no header'
  );
  t.equal(renderBrief(BRIEF_CASES[4][1], {header: false}), '- none', 'no header, no movement');
});

test('digestOf totals its entries as a collection does', t => {
  const digest = digestOf(FLEET_DIGEST.repos, {
    mode: 'fleet',
    ghUser: 'owner',
    collectedAt: '2026-11-16T12:00:00.000Z',
    packageErrors: FLEET_DIGEST.package_errors
  });
  t.deepEqual(digest, FLEET_DIGEST);
  t.deepEqual(Object.keys(digest), Object.keys(FLEET_DIGEST));
  const one = digestOf([ALPHA], {mode: 'cwd', ghUser: 'owner', collectedAt: 'x'});
  t.deepEqual(one.totals, BRIEF_CASES[2][1].totals);
});

test('commitBaseline writes a changed baseline and leaves the same one', async t => {
  const {gh} = ghStub(movedRoutes());
  const entry = await collect(gh, {baseline: baselineFixture()});
  const path = '/data/projects/demo/data/github.json';
  const {api, calls, files} = memoryApi();
  t.equal(await commitBaseline(api, entry), 'written');
  const put = calls.find(c => c.method === 'PUT');
  t.equal(put.path, path);
  t.equal(put.contentType, 'text/plain; charset=utf-8');
  t.equal(files[path], `${JSON.stringify(entry.snapshot, null, 2)}\n`);
  t.equal(typeof put.body, 'string');

  calls.length = 0;
  t.equal(await commitBaseline(api, entry), 'unchanged');
  t.deepEqual(
    calls.map(c => c.method),
    ['GET']
  );

  const stored = JSON.parse(files[path]);
  t.equal(Array.isArray(stored.items), false, 'items stay keyed by number');
  t.equal(Object.keys(stored.advisories).length, 4);

  const refused = memoryApi({}, {[`PUT ${path}`]: {status: 507, text: '{"code":"storage_full"}'}});
  const error = await t.rejects(commitBaseline(refused.api, entry));
  t.matchString(error?.message, /^PUT \/data\/projects\/demo\/data\/github\.json: 507/);
  t.equal(error?.status, 507);
  await t.rejects(
    commitBaseline(api, {repo: 'example/demo', project: 'demo', error: {message: 'x'}}),
    TypeError
  );
});

test('appendRuns splits a fleet run into one line per project', async t => {
  const {api, calls, files} = memoryApi();
  const written = await appendRuns(api, FLEET_DIGEST);
  const projects = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'heya-things', 'zeta'];
  t.deepEqual(
    written,
    projects.map(p => `/data/projects/${p}/data/github-runs/2026-11.jsonl`)
  );
  t.ok(
    calls.every(c => c.method === 'POST' && c.contentType === 'text/plain; charset=utf-8'),
    'each line is appended as text'
  );
  const record = runRecord(FLEET_DIGEST);
  for (const path of written) {
    const text = files[path];
    t.ok(text.endsWith('\n') && text.split(/\r?\n/).length === 2, `${path}: one line`);
    const line = JSON.parse(text);
    const project = path.split('/')[3];
    t.deepEqual(Object.keys(line), ['collected_at', 'mode', 'gh_user', 'totals', 'repos']);
    t.deepEqual(line.totals, FLEET_DIGEST.totals, `${project}: the run's totals`);
    t.deepEqual(
      line.repos,
      record.repos.filter(r => r.project === project)
    );
  }
  t.deepEqual(JSON.parse(files[written[3]]).repos, [
    {
      repo: 'owner/delta',
      project: 'delta',
      error: {status: 404, message: 'Not Found'},
      events: [],
      summary: {events: 0}
    }
  ]);
});

test('appendRuns: a two-project run, a quiet run, and a failed append', async t => {
  const two = {
    ...FLEET_DIGEST,
    collected_at: '2026-12-01T03:00:00.000Z',
    mode: 'fleet',
    repos: [ALPHA, BETA],
    totals: {repos: 2, events: 14, first_run: 0, errors: 0, partial_errors: 0, packages: 0}
  };
  delete two.package_errors;
  const {api, files} = memoryApi({
    '/data/projects/alpha/data/github-runs/2026-12.jsonl': '{"earlier":true}\n'
  });
  t.deepEqual(await appendRuns(api, two), [
    '/data/projects/alpha/data/github-runs/2026-12.jsonl',
    '/data/projects/beta/data/github-runs/2026-12.jsonl'
  ]);
  const alpha = files['/data/projects/alpha/data/github-runs/2026-12.jsonl'].split(/\r?\n/);
  t.equal(alpha[0], '{"earlier":true}');
  t.deepEqual(
    JSON.parse(alpha[1]).repos.map(r => r.repo),
    ['owner/alpha']
  );
  t.deepEqual(
    JSON.parse(files['/data/projects/beta/data/github-runs/2026-12.jsonl']).repos.map(r => r.repo),
    ['owner/beta']
  );

  const quiet = digestOf([{...BETA, events: []}], {mode: 'cwd', ghUser: 'owner'});
  const silent = memoryApi();
  t.deepEqual(await appendRuns(silent.api, quiet), []);
  t.equal(silent.calls.length, 0, 'a quiet run of one repository is not stored');
  const packagesOnly = digestOf([], {mode: 'fleet', ghUser: 'owner', packagesOnly: true});
  t.deepEqual(await appendRuns(silent.api, packagesOnly), []);

  const refused = memoryApi(
    {},
    {'POST /data/projects/beta/data/github-runs/2026-12.jsonl': {status: 503, text: 'busy'}}
  );
  const error = await t.rejects(appendRuns(refused.api, two));
  t.matchString(
    error?.message,
    /^POST \/data\/projects\/beta\/data\/github-runs\/2026-12\.jsonl: 503 busy$/
  );
  await t.rejects(
    appendRuns(async () => null, two),
    /no answer/
  );
});
