// What `/pickup` does besides reading: a person's new thread filed, then the baseline committed and
// the run appended; every failure a line beside the stored view; and the collection made at a
// session's start, taken once by its brief.

import {existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'tape-six';
import {
  githubOf,
  prepareCollection,
  privateLine,
  takePrepared
} from '../plugins/program-clerk/scripts/lib/digest-run.mjs';
import {fakeServer, hookEnv, makeRepo, removeAll, scratch} from './helpers.mjs';

const event = {kind: 'issue.new', repo: 'o/r', number: 1, title: 'New', url: 'u'};
const STORED = {repo: 'o/r', collected_at: '2026-11-01T00:00:00Z', items: {}};

const entryOf = (extra = {}) => ({
  repo: 'o/r',
  project: 'p',
  first_run: false,
  events: [event],
  summary: {events: 1},
  snapshot: {repo: 'o/r', ci: {conclusion: 'success'}, items: {}},
  ...extra
});
const runOf = entry => ({
  collected_at: '2026-11-17T10:00:00.000Z',
  mode: 'cwd',
  gh_user: 'me',
  repos: [entry],
  totals: {repos: 1, events: entry.events.length}
});
const preparedOf = (extra = {}) => ({project: 'p', run: runOf(entryOf(extra))});

/** An API answering what a brief's GitHub step asks, each write recorded; `fail` names a path's start. */
const fakeApi = ({fail = null, stored = STORED, down = false} = {}) => {
  const writes = [];
  const api = async (path, {method = 'GET'} = {}) => {
    if (down) return null;
    if (method !== 'GET') writes.push(`${method} ${path}`);
    if (fail !== null && path.startsWith(fail)) return {status: 500, text: '{"code":"broken"}'};
    if (method === 'POST' && path === '/notes/query') return {status: 200, text: '{"items":[]}'};
    if (method === 'POST' && path === '/resolve') {
      return {status: 200, text: '{"items":[{"file_path":"projects/p/queue/_about.md"}]}'};
    }
    if (method === 'GET' && path === '/data/projects/p/data/github.json') {
      return stored === null
        ? {status: 404, text: '{}'}
        : {status: 200, text: JSON.stringify(stored)};
    }
    return {status: 200, text: '{}'};
  };
  return {api, writes};
};

const NO_TRACKERS = {trackers: []};

test('a new thread is filed, then the baseline committed and the run appended', async t => {
  const {api, writes} = fakeApi();
  const result = await githubOf({
    project: 'p',
    trackers: NO_TRACKERS,
    items: [],
    api,
    prepared: preparedOf()
  });
  t.deepEqual(writes, [
    'POST /resolve',
    'POST /notes/query',
    'PUT /vault/projects/p/queue/github-o-r-1-new.md',
    'PUT /data/projects/p/data/github.json',
    'POST /data/projects/p/data/github-runs/2026-11.jsonl'
  ]);
  t.deepEqual(result.filed, ['GitHub: o/r #1 New.']);
  t.equal(result.problem, undefined);
  t.equal(result.repo, 'o/r');
  t.ok(result.brief.length > 0, 'what moved, in brief');
});

test('a filing that fails keeps the fresh view, says so, and advances nothing', async t => {
  const {api, writes} = fakeApi({fail: '/vault/projects/p/queue/github'});
  const result = await githubOf({
    project: 'p',
    trackers: NO_TRACKERS,
    items: [],
    api,
    prepared: preparedOf()
  });
  t.ok(!writes.some(w => w.includes('github.json') || w.includes('github-runs')));
  t.deepEqual(result.filed, []);
  t.matchString(
    result.problem,
    /^Filing github o\/r#1 failed: .*The GitHub baseline did not advance\.$/
  );
  t.equal(result.repo, 'o/r');
  t.equal(result.stored, undefined);
});

test('an unread queue files nothing and advances nothing, since a filing could overwrite an item', async t => {
  const {api, writes} = fakeApi();
  const result = await githubOf({
    project: 'p',
    trackers: NO_TRACKERS,
    items: null,
    api,
    prepared: preparedOf()
  });
  t.deepEqual(writes, []);
  t.matchString(result.problem, /not filed, since the queue is unread/);
});

test('a thread the tracker takes no intake from is not filed, and the baseline advances', async t => {
  const {api, writes} = fakeApi();
  const trackers = {trackers: [{kind: 'github', role: 'secondary', intake: 'none'}]};
  const result = await githubOf({project: 'p', trackers, items: [], api, prepared: preparedOf()});
  t.deepEqual(writes, [
    'PUT /data/projects/p/data/github.json',
    'POST /data/projects/p/data/github-runs/2026-11.jsonl'
  ]);
  t.deepEqual(result.filed, []);
});

test('GitHub refusing the repository falls back to the stored view, with a line', async t => {
  const {api, writes} = fakeApi();
  const prepared = preparedOf({error: {message: 'renamed'}});
  const result = await githubOf({project: 'p', trackers: NO_TRACKERS, items: [], api, prepared});
  t.equal(result.problem, 'GitHub answered: renamed');
  t.equal(result.stored, true);
  t.equal(result.snapshot.collected_at, STORED.collected_at);
  t.deepEqual(writes, [], 'nothing filed or committed');
});

const ghStub = answers => async args => answers[args.join(' ')] ?? {code: 1, out: '', err: 'no'};

test('gh missing or signed out: a line naming the fix, beside the stored view', async t => {
  const dir = scratch();
  try {
    const top = makeRepo(join(dir, 'r'), 'git@github.com:o/r.git');
    const missing = ghStub({'auth status': {code: null, out: '', err: 'x', missing: true}});
    let result = await githubOf({
      top,
      project: 'p',
      trackers: NO_TRACKERS,
      items: [],
      api: fakeApi().api,
      gh: missing
    });
    t.equal(
      result.problem,
      'GitHub was not read: the gh command is not installed on this machine.'
    );
    t.equal(result.stored, true);
    const signedOut = ghStub({'auth status': {code: 1, out: '', err: 'not logged in'}});
    result = await githubOf({
      top,
      project: 'p',
      trackers: NO_TRACKERS,
      items: [],
      api: fakeApi().api,
      gh: signedOut
    });
    t.equal(result.problem, 'gh has no valid login on this machine: run `gh auth login`.');
    result = await githubOf({
      top,
      project: 'p',
      trackers: NO_TRACKERS,
      items: [],
      api: fakeApi({stored: null}).api,
      gh: signedOut
    });
    t.equal(result.repo, undefined, 'no stored view either: the line alone');
  } finally {
    removeAll(dir);
  }
});

test('a checkout with no GitHub remote has no GitHub part', async t => {
  const dir = scratch();
  try {
    const top = makeRepo(join(dir, 'r'), null);
    const result = await githubOf({
      top,
      project: 'p',
      trackers: NO_TRACKERS,
      items: [],
      api: fakeApi().api,
      gh: ghStub({})
    });
    t.equal(result, null);
  } finally {
    removeAll(dir);
  }
});

test('a private repository the trackers do not name is not read, and a line says how to track it', async t => {
  const dir = scratch();
  try {
    const top = makeRepo(join(dir, 'r'), 'git@github.com:o/r.git');
    const gh = ghStub({
      'auth status': {code: 0, out: '', err: ''},
      'api user': {code: 0, out: '{"login":"me"}', err: ''},
      'api repos/o/r': {code: 0, out: '{"private":true,"default_branch":"main"}', err: ''}
    });
    const result = await githubOf({
      top,
      project: 'p',
      trackers: NO_TRACKERS,
      items: [],
      api: fakeApi().api,
      gh
    });
    t.deepEqual(result, {problem: privateLine('o/r', 'p')});
    t.matchString(
      result.problem,
      /add \{kind: github, ref: o\/r\} to the trackers: list in projects\/p\/queue\/_about\.md/
    );
    const prepared = await githubOf({
      project: 'p',
      trackers: NO_TRACKERS,
      items: [],
      api: fakeApi().api,
      prepared: {project: 'p', skipped: true, private: 'o/r'}
    });
    t.deepEqual(
      prepared,
      {problem: privateLine('o/r', 'p')},
      'a collection made ahead says the same'
    );
  } finally {
    removeAll(dir);
  }
});

/** What `takePrepared` answers for `prepared`, and whether the file was gone after. */
const taken = async (prepared, options = {}) => {
  const dir = scratch();
  try {
    if (prepared !== null) writeFileSync(join(dir, 's.json'), JSON.stringify(prepared));
    const took = await takePrepared('s', 'p', {dir, ...options});
    return {took, gone: !existsSync(join(dir, 's.json'))};
  } finally {
    removeAll(dir);
  }
};

test('a collection is taken once, whole, and only when it is fresh, this project’s, and good', async t => {
  const later = () => Date.now() + 3_600_000;
  for (const [what, prepared, options, expected] of [
    ['nothing prepared', null, {}, null],
    ['taken whole', preparedOf(), {}, preparedOf()],
    ['a skip is an answer', {project: 'p', skipped: true}, {}, {project: 'p', skipped: true}],
    ['an old one', preparedOf(), {now: later}, null],
    ['another project’s', {...preparedOf(), project: 'q'}, {}, null],
    ['one GitHub refused', preparedOf({error: {message: 'no'}}), {}, null],
    ['one gh could not make', {project: 'p', problem: 'signed-out'}, {}, null]
  ]) {
    t.deepEqual(await taken(prepared, options), {took: expected, gone: true}, what);
  }
});

test('a brief waits for a running collection and takes it; a pid past the cap or dead means none', async t => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 's.pid'), '4242');
    let checks = 0;
    const alive = pid => {
      t.equal(pid, 4242);
      if (++checks < 3) return true;
      writeFileSync(join(dir, 's.json'), JSON.stringify(preparedOf()));
      return false;
    };
    t.deepEqual(await takePrepared('s', 'p', {dir, alive}), preparedOf());
    t.equal(checks, 3);
    let clock = Date.now();
    const now = () => (clock += 20_000);
    t.equal(await takePrepared('s', 'p', {dir, alive: () => true, now}), null, 'past the cap');
    t.equal(await takePrepared('s', 'p', {dir, alive: () => false}), null, 'died writing nothing');
  } finally {
    removeAll(dir);
  }
});

test('preparing writes one whole collection under the session, and clears what old sessions left', async t => {
  const home = scratch();
  const server = await fakeServer({'POST /notes/query': {body: {items: []}}});
  try {
    const env = hookEnv(home, server.base);
    const dir = join(env.XDG_CACHE_HOME, 'program-clerk', 'pickup');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'old.json'), '{}');
    writeFileSync(join(dir, 'recent.json'), '{}');
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(join(dir, 'old.json'), twoDaysAgo, twoDaysAgo);
    const repo = makeRepo(join(home, 'p'), null);
    await prepareCollection({cwd: repo, session: 's', env});
    t.deepEqual(readdirSync(dir).sort(), ['recent.json', 's.json']);
    t.deepEqual(JSON.parse(readFileSync(join(dir, 's.json'), 'utf8')), {
      project: 'p',
      skipped: true
    });
    t.deepEqual(
      server.requests.map(r => `${r.method} ${r.path}`),
      ['POST /notes/query'],
      'it only reads: no filing, no commit'
    );
  } finally {
    await server.close();
    removeAll(home);
  }
});
