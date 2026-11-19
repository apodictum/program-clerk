// One GitHub repository's state through the gh CLI, diffed against the account's stored baseline.
// Every GitHub call is a read; github.com only.

import {execFile} from 'node:child_process';

const TEXT = 'text/plain; charset=utf-8';

/**
 * Runs the gh CLI with no shell (`gh.exe` resolves on Windows). Resolves to {code, out, err}, with
 * `missing: true` when the executable is not there. `bin` names another executable.
 */
export const runGh = (args, {bin = 'gh', ...options} = {}) =>
  new Promise(resolve => {
    execFile(
      bin,
      args,
      {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options},
      (error, stdout, stderr) => {
        if (!error) return resolve({code: 0, out: stdout.trim(), err: stderr.trim()});
        if (error.code === 'ENOENT')
          return resolve({
            code: null,
            out: '',
            err: `${bin} is not installed or not on PATH`,
            missing: true
          });
        resolve({
          code: typeof error.code === 'number' ? error.code : null,
          out: (stdout ?? '').toString().trim(),
          err: (stderr ?? error.message ?? '').toString().trim()
        });
      }
    );
  });

const ghError = (r, route, body = r.out) => {
  let message = r.err || 'gh api failed',
    status = null;
  try {
    const j = JSON.parse(body);
    if (j.message) message = j.message;
    if (j.status) status = Number(j.status);
  } catch {
    // not a JSON error body
  }
  const m = /HTTP (\d{3})/.exec(r.err ?? '');
  if (m) status = Number(m[1]);
  return Object.assign(new Error(message), {status, route});
};

// Discussions exist only on GraphQL; the query is fixed text, so the guard below keeps it a read.
const DISCUSSIONS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url body createdAt updatedAt closed isAnswered
        author { login __typename }
        category { name }
        reactions { totalCount }
        reactionGroups { viewerHasReacted }
        comments(first: 100) {
          totalCount
          nodes { updatedAt body author { login } reactions { totalCount } viewerDidAuthor }
        }
      }
    }
  }
}`;

const CURSOR_PAGES_MAX = 20;

const readerOf = gh => {
  // Walks `page=` until a short page, never `--paginate`, whose output shape depends on gh's version.
  const api = async (route, {paginate = false, headers = []} = {}) => {
    const sep = route.includes('?') ? '&' : '?';
    const page = async n => {
      const argv = ['api'];
      for (const h of headers) argv.push('-H', h);
      argv.push(paginate ? `${route}${sep}per_page=100&page=${n}` : route);
      const r = await gh(argv);
      if (r.code !== 0) throw ghError(r, route);
      return r.out ? JSON.parse(r.out) : null;
    };
    if (!paginate) return page(1);
    const all = [];
    for (let n = 1; n <= 50; ++n) {
      const chunk = await page(n);
      if (!Array.isArray(chunk)) return chunk;
      all.push(...chunk);
      if (chunk.length < 100) break;
    }
    return all;
  };

  // The alert endpoints reject `page=`, so these follow the Link header; `complete` is false only
  // when the page cap stopped the walk.
  const cursor = async route => {
    const list = [];
    let next = route;
    for (let n = 0; next && n < CURSOR_PAGES_MAX; ++n) {
      const r = await gh(['api', '-i', next]);
      const split = r.out.search(/\r?\n\r?\n/);
      const head = split < 0 ? r.out : r.out.slice(0, split),
        body = split < 0 ? '' : r.out.slice(split).trim();
      if (r.code !== 0) throw ghError(r, route, body);
      list.push(...(body ? JSON.parse(body) : []));
      const link = head.split(/\r?\n/).find(line => /^link:/i.test(line)) ?? '';
      next = /<https:\/\/api\.github\.com\/([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
    }
    return {list, complete: !next};
  };

  const graphql = async (query, variables) => {
    if (/\bmutation\b/i.test(query))
      throw new Error('GitHub is only read: refusing GraphQL text that contains "mutation"');
    const argv = ['api', 'graphql', '-f', `query=${query}`];
    for (const [k, v] of Object.entries(variables))
      if (v !== null && v !== undefined) argv.push('-F', `${k}=${v}`);
    const r = await gh(argv);
    if (r.code !== 0)
      throw Object.assign(new Error(r.err || r.out || 'graphql failed'), {
        status: null,
        route: 'graphql'
      });
    const json = JSON.parse(r.out);
    if (json.errors?.length)
      throw Object.assign(new Error(json.errors.map(e => e.message).join('; ')), {
        status: null,
        route: 'graphql'
      });
    return json.data;
  };

  return {api, cursor, graphql};
};

/**
 * The login gh reads GitHub as: {login}, or {problem: 'missing' | 'signed-out', message} when gh is
 * not installed or has no valid login (the fix is `gh auth login`). Throws when the login is valid
 * and GitHub still does not answer.
 */
export const ghLogin = async (gh = runGh) => {
  const status = await gh(['auth', 'status']);
  if (status.missing) return {problem: 'missing', message: status.err};
  if (status.code !== 0)
    return {
      problem: 'signed-out',
      message: (status.err || status.out || 'gh auth status failed').split(/\r?\n/)[0]
    };
  return {login: (await readerOf(gh).api('user')).login};
};

/** The owner and name of a github.com remote URL, else null. */
export const repoOfRemote = url => {
  const m =
    /^(?:git\+)?(?:git@github\.com:|https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      typeof url === 'string' ? url.trim() : ''
    );
  return m ? {owner: m[1], name: m[2]} : null;
};

export const baselinePath = project => `/data/projects/${project}/data/github.json`;

const runsPath = (project, collectedAt) =>
  `/data/projects/${project}/data/github-runs/${collectedAt.slice(0, 7)}.jsonl`;

const isOk = answer => Boolean(answer) && answer.status >= 200 && answer.status < 300;

const failure = (method, path, answer) =>
  Object.assign(
    new Error(
      `${method} ${path}: ${answer ? `${answer.status} ${String(answer.text ?? '').slice(0, 300)}`.trimEnd() : 'no answer'}`
    ),
    {status: answer?.status ?? null}
  );

const readText = async (api, path) => {
  const answer = await api(path);
  if (answer?.status === 404) return null;
  if (!isOk(answer)) throw failure('GET', path, answer);
  return answer.text;
};

const parseObject = text => {
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

/** A project's stored GitHub snapshot, or null when there is none; any other failure throws. */
export const readBaseline = async (api, project) =>
  parseObject(await readText(api, baselinePath(project)));

const sameRepo = (a, b) => a?.toLowerCase() === b?.toLowerCase();

const countBy = (list, key) =>
  list.reduce((m, x) => {
    const k = key(x) ?? 'unknown';
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

// GitHub Apps log in as `name[bot]` and are typed Bot; older bots are plain user accounts.
const LEGACY_BOTS = new Set([
  'snyk-bot',
  'gitter-badger',
  'greenkeeperio-bot',
  'renovate-bot',
  'codecov-io',
  'coveralls'
]);
const isBot = (login, type) =>
  type === 'Bot' || /\[bot\]$/.test(login ?? '') || LEGACY_BOTS.has(login);

const EXCERPT_LEN = 120;
const clip = (text, n) => {
  if (!text || text.length <= n) return text;
  const cut = text.slice(0, n - 1),
    at = cut.lastIndexOf(' ');
  return `${(at > n / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
};
const excerptOf = text => {
  if (!text) return null;
  const line = text
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/\r?\n/)
    .map(l => l.replace(/^[\s>#*-]+/, '').trim())
    .find(l => l && !/^(```|\||!\[)/.test(l));
  return line ? clip(line, EXCERPT_LEN) : null;
};

const latestComment = comments => {
  let last = null;
  for (const c of comments) {
    const at = c.updated_at ?? c.updatedAt;
    if (!last || at > last.at)
      last = {author: c.user?.login ?? c.author?.login ?? null, at, excerpt: excerptOf(c.body)};
  }
  return last;
};

const COMMENT_SCAN_CAP = 60;
const DAY_MS = 864e5;

// A commit's workflows read as one: each workflow's newest run counts, and one that did not succeed
// wins, so a passing style check never hides failing tests.
const runOfCommit = runs => {
  const latest = new Map();
  for (const r of runs) if (!latest.has(r.workflow_id)) latest.set(r.workflow_id, r);
  const each = [...latest.values()];
  return each.find(r => r.conclusion !== 'success') ?? each[0];
};

const ciOf = (run, pull_request) => ({
  name: run.name,
  status: run.status,
  conclusion: run.conclusion,
  updated_at: run.updated_at,
  html_url: run.html_url,
  ...(pull_request ? {pull_request} : {})
});

const readRepo = async ({
  owner,
  name,
  project,
  tracked = false,
  baseline: stored = null,
  sinceDays = 30,
  starLogins = false,
  ghUser,
  gh = runGh,
  now = Date.now()
}) => {
  const {api, cursor, graphql} = readerOf(gh);
  const repo = `${owner}/${name}`,
    R = `repos/${owner}/${name}`;
  // A diff across repositories would report every difference, so another repository's baseline is none.
  const baseline = stored && !sameRepo(stored.repo, repo) ? null : stored;
  const errors = [];
  const guard = async (where, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      errors.push({where, status: err.status ?? null, message: err.message});
      return fallback;
    }
  };
  const collectedAt = new Date(now).toISOString();
  const since = baseline?.collected_at ?? new Date(now - sinceDays * DAY_MS).toISOString();

  const repoMeta = await api(R);
  if (repoMeta.private && !tracked)
    return {repo, project, skipped: true, reason: 'private', events: [], summary: {events: 0}};
  const meta = {
    stars: repoMeta.stargazers_count,
    forks: repoMeta.forks_count,
    watchers: repoMeta.subscribers_count,
    open_issues: repoMeta.open_issues_count,
    has_discussions: Boolean(repoMeta.has_discussions),
    default_branch: repoMeta.default_branch
  };

  // GitHub answers 404 for a private repository's advisories.
  const advisories = {};
  for (const a of repoMeta.private
    ? []
    : await guard('advisories', () => api(`${R}/security-advisories`, {paginate: true}), []))
    advisories[a.ghsa_id] = {
      cve_id: a.cve_id ?? null,
      state: a.state,
      severity: a.severity ?? null,
      summary: a.summary,
      published_at: a.published_at ?? null,
      updated_at: a.updated_at ?? null,
      html_url: a.html_url
    };

  // Open items are read in full every run, since a reaction never bumps updated_at.
  const raw = new Map();
  for (const it of await guard(
    'issues:open',
    () => api(`${R}/issues?state=open`, {paginate: true}),
    []
  ))
    raw.set(it.number, it);
  for (const it of await guard(
    'issues:since',
    () => api(`${R}/issues?state=all&since=${encodeURIComponent(since)}`, {paginate: true}),
    []
  ))
    raw.set(it.number, it);

  const items = {};
  const scanOrder = [...raw.values()].sort((a, b) => b.comments - a.comments);
  let scanned = 0;
  for (const it of scanOrder) {
    const isPr = Boolean(it.pull_request);
    const record = {
      is_pr: isPr,
      title: it.title,
      excerpt: excerptOf(it.body),
      state: isPr && it.pull_request?.merged_at ? 'merged' : it.state,
      author: it.user?.login ?? null,
      bot: isBot(it.user?.login, it.user?.type),
      created_at: it.created_at,
      updated_at: it.updated_at,
      comments: it.comments ?? 0,
      review_comments: 0,
      reactions: it.reactions?.total_count ?? 0,
      comment_reactions: null,
      last_comment: null,
      labels: (it.labels ?? []).map(l => l.name),
      assignees: (it.assignees ?? []).map(a => a.login).filter(Boolean),
      // null when this run could not tell.
      owner_commented: null,
      owner_reacted: null,
      html_url: it.html_url
    };
    if (isPr) record.draft = Boolean(it.draft);
    if (scanned < COMMENT_SCAN_CAP && (record.comments > 0 || isPr)) {
      ++scanned;
      const comments = await guard(
        `comments:#${it.number}`,
        () => api(`${R}/issues/${it.number}/comments`, {paginate: true}),
        null
      );
      const reviews = isPr
        ? await guard(
            `review-comments:#${it.number}`,
            () => api(`${R}/pulls/${it.number}/comments`, {paginate: true}),
            null
          )
        : [];
      if (comments && reviews) {
        record.review_comments = reviews.length;
        record.comment_reactions = [...comments, ...reviews].reduce(
          (s, c) => s + (c.reactions?.total_count ?? 0),
          0
        );
        record.last_comment = latestComment([...comments, ...reviews]);
        record.owner_commented = [...comments, ...reviews].some(c => c.user?.login === ghUser);
      }
    } else if (record.comments === 0 && !isPr) {
      record.comment_reactions = 0;
      record.owner_commented = false;
    }
    // A reaction's author is only in the per-item list: one read, for an open item that has any.
    if (record.reactions === 0) record.owner_reacted = false;
    else if (it.state === 'open')
      record.owner_reacted = await guard(
        `reactions:#${it.number}`,
        async () =>
          (await api(`${R}/issues/${it.number}/reactions`, {paginate: true})).some(
            r => r.user?.login === ghUser
          ),
        null
      );
    items[it.number] = record;
  }
  // A late comment on a closed item outside the window stays a delta, not "new", for 90 days.
  const keepAfter = new Date(now - 90 * DAY_MS).toISOString();
  for (const [n, old] of Object.entries(baseline?.items ?? {}))
    if (!items[n] && old.state !== 'open' && old.updated_at >= keepAfter) items[n] = old;

  const discussions = {};
  if (meta.has_discussions)
    await guard(
      'discussions',
      async () => {
        let after = null;
        for (let page = 0; page < 5; ++page) {
          const conn = (await graphql(DISCUSSIONS_QUERY, {owner, name, after})).repository
            .discussions;
          for (const d of conn.nodes)
            discussions[d.number] = {
              title: d.title,
              excerpt: excerptOf(d.body),
              closed: d.closed,
              answered: d.isAnswered,
              author: d.author?.login ?? null,
              bot: isBot(d.author?.login, d.author?.__typename),
              category: d.category?.name ?? null,
              created_at: d.createdAt,
              updated_at: d.updatedAt,
              comments: d.comments.totalCount,
              reactions: d.reactions.totalCount,
              comment_reactions: d.comments.nodes.reduce((s, c) => s + c.reactions.totalCount, 0),
              last_comment: latestComment(d.comments.nodes),
              // viewer* is the login gh runs as.
              owner_commented: d.comments.nodes.some(c => c.viewerDidAuthor)
                ? true
                : d.comments.totalCount > d.comments.nodes.length
                  ? null
                  : false,
              owner_reacted: (d.reactionGroups ?? []).some(g => g.viewerHasReacted),
              url: d.url
            };
          if (!conn.pageInfo.hasNextPage) break;
          after = conn.pageInfo.endCursor;
        }
      },
      null
    );

  let forks = baseline?.forks ?? null;
  if (!forks || meta.forks !== baseline?.meta?.forks)
    forks = await guard(
      'forks',
      async () =>
        (await api(`${R}/forks?sort=newest`, {paginate: true})).map(f => ({
          login: f.owner?.login ?? null,
          full_name: f.full_name,
          created_at: f.created_at
        })),
      forks ?? []
    );
  // A watcher subscribes to notifications, so a spam account watching is worth a name; a star is not.
  let watchers = baseline?.watchers ?? null;
  if (!watchers || meta.watchers !== baseline?.meta?.watchers)
    watchers = await guard(
      'watchers',
      async () => (await api(`${R}/subscribers`, {paginate: true})).map(u => u.login ?? null),
      watchers ?? []
    );
  let stars = null;
  if (starLogins) {
    stars = baseline?.stars ?? null;
    if (!stars || meta.stars !== baseline?.meta?.stars)
      stars = await guard(
        'stars',
        async () =>
          (
            await api(`${R}/stargazers`, {
              paginate: true,
              headers: ['Accept: application/vnd.github.star+json']
            })
          ).map(s => s.user?.login ?? null),
        stars ?? []
      );
  }

  const releases = {};
  for (const r of await guard('releases', () => api(`${R}/releases?per_page=30`), []))
    releases[r.id] = {
      tag_name: r.tag_name,
      name: r.name,
      draft: Boolean(r.draft),
      prerelease: Boolean(r.prerelease),
      published_at: r.published_at ?? null,
      html_url: r.html_url
    };

  const alertSet = async (route, severity) => {
    try {
      const {list, complete} = await cursor(`${route}&per_page=100`);
      const set = {open: list.length, by_severity: countBy(list, severity)};
      if (!complete) set.truncated = true;
      return set;
    } catch (err) {
      return {unavailable: err.message, status: err.status ?? null};
    }
  };
  const alerts = {
    dependabot: await alertSet(
      `${R}/dependabot/alerts?state=open`,
      a => a.security_advisory?.severity
    ),
    code_scanning: await alertSet(`${R}/code-scanning/alerts?state=open`, a => a.rule?.severity)
  };

  // The newest run on a default branch is often Dependabot's updater (`event: "dynamic"`), and a
  // fork's pull request from a branch of the same name lists there too. A repository that tests
  // pull requests alone has no run of its own, so a pull request merged since stands in.
  const branch = encodeURIComponent(meta.default_branch);
  const ci = await guard(
    'ci',
    async () => {
      const runs = (
        (await api(`${R}/actions/runs?branch=${branch}&per_page=10`)).workflow_runs ?? []
      ).filter(r => r.event !== 'dynamic' && r.event !== 'pull_request');
      const head = runs[0] ?? null;
      const merged = (
        await api(`${R}/pulls?state=closed&base=${branch}&sort=updated&direction=desc&per_page=10`)
      )
        .filter(p => p.merged_at && (!head || p.merged_at > head.created_at))
        .sort((a, b) => b.merged_at.localeCompare(a.merged_at));
      for (const p of merged) {
        const prRuns =
          (await api(`${R}/actions/runs?event=pull_request&head_sha=${p.head.sha}&per_page=20`))
            .workflow_runs ?? [];
        if (prRuns.length > 0)
          return ciOf(runOfCommit(prRuns), {number: p.number, merged_at: p.merged_at});
      }
      if (head) return ciOf(runOfCommit(runs.filter(r => r.head_sha === head.head_sha)));
      // Dependabot's and code scanning's workflows are `dynamic/`; a file of ours with no run is a miss.
      const files = (await api(`${R}/actions/workflows?per_page=100`)).workflows
        .filter(w => w.state === 'active' && w.path.startsWith('.github/workflows/'))
        .map(w => w.path);
      if (files.length > 0)
        throw new Error(`no run found on ${meta.default_branch} for ${files.join(', ')}`);
      return null;
    },
    null
  );

  const snapshot = {
    repo,
    html_url: repoMeta.html_url,
    gh_user: ghUser,
    collected_at: collectedAt,
    window: {since, first_run: !baseline},
    meta,
    advisories,
    items,
    discussions,
    forks,
    watchers,
    stars,
    releases,
    alerts,
    ci
  };
  const events = diff(baseline, snapshot, repo);
  return {
    repo,
    project,
    first_run: !baseline,
    ...(baseline !== stored ? {replaced_baseline: stored.repo} : {}),
    collected_at: collectedAt,
    events,
    summary: {
      events: events.length,
      by_kind: countBy(events, e => e.kind),
      open_items: Object.values(items).filter(i => i.state === 'open').length,
      advisories_without_cve: Object.values(advisories).filter(
        a => a.state === 'published' && !a.cve_id
      ).length,
      stars: meta.stars,
      forks: meta.forks,
      comment_scan: scanned >= COMMENT_SCAN_CAP ? 'capped' : 'full'
    },
    errors,
    snapshot
  };
};

/**
 * Reads one repository through `gh` and diffs it against `baseline`, the stored snapshot or null.
 * A private repository is read only when `tracked` (a project declares it). Resolves to the entry a
 * digest's `repos` holds: {repo, project, first_run, collected_at, events, summary, errors,
 * snapshot}; {…, skipped: true, reason: 'private'}; or {repo, project, error, events: [], summary}
 * when the repository could not be read.
 */
export const collectRepo = async options => {
  try {
    return await readRepo(options);
  } catch (err) {
    return {
      repo: `${options.owner}/${options.name}`,
      project: options.project,
      error: {status: err.status ?? null, message: err.message},
      events: [],
      summary: {events: 0}
    };
  }
};

/** The events between a stored snapshot and a new one; none without a baseline. */
export const diff = (b, s, repo) => {
  const events = [];
  const push = (kind, extra) => events.push({kind, repo, ...extra});
  if (!b) return events;

  for (const [id, a] of Object.entries(s.advisories)) {
    const o = b.advisories?.[id];
    const ref = {id, summary: a.summary, severity: a.severity, html_url: a.html_url};
    if (!o) push('advisory.new', {...ref, state: a.state, cve_id: a.cve_id});
    else {
      if (!o.cve_id && a.cve_id) push('advisory.cve_assigned', {...ref, cve_id: a.cve_id});
      if (o.state !== a.state) push('advisory.state', {...ref, from: o.state, to: a.state});
      else if (o.updated_at !== a.updated_at && o.cve_id === a.cve_id)
        push('advisory.updated', {...ref, updated_at: a.updated_at});
    }
  }

  const itemEvents = (type, current, previous, key) => {
    for (const [n, it] of Object.entries(current)) {
      const o = previous?.[n];
      const number = Number(n);
      const ref = {
        number,
        title: it.title,
        author: it.author,
        bot: Boolean(it.bot),
        url: it.html_url ?? it.url
      };
      const state = key.state(it),
        prevState = o ? key.state(o) : null;
      const comments = (it.comments ?? 0) + (it.review_comments ?? 0),
        prevComments = o ? (o.comments ?? 0) + (o.review_comments ?? 0) : 0;
      const reactions = (it.reactions ?? 0) + (it.comment_reactions ?? 0),
        prevReactions = o ? (o.reactions ?? 0) + (o.comment_reactions ?? 0) : 0;
      if (!o) {
        if (it.created_at >= b.collected_at)
          push(`${type}.new`, {...ref, state, comments, reactions, excerpt: it.excerpt ?? null});
        else
          push(`${type}.updated`, {
            ...ref,
            state,
            comments,
            reactions,
            excerpt: it.excerpt ?? null,
            note: 'not in baseline',
            last_comment: it.last_comment ?? null
          });
        continue;
      }
      let moved = false;
      if (state !== prevState) {
        push(`${type}.state`, {...ref, from: prevState, to: state});
        moved = true;
      }
      if (comments > prevComments) {
        push(`${type}.comments`, {
          ...ref,
          delta: comments - prevComments,
          total: comments,
          last_comment: it.last_comment ?? null
        });
        moved = true;
      }
      if (
        it.comment_reactions !== null &&
        o.comment_reactions !== null &&
        reactions !== prevReactions
      ) {
        push(`${type}.reactions`, {...ref, delta: reactions - prevReactions, total: reactions});
        moved = true;
      } else if (it.reactions !== o.reactions) {
        push(`${type}.reactions`, {
          ...ref,
          delta: it.reactions - o.reactions,
          total: it.reactions
        });
        moved = true;
      }
      if (!moved && it.updated_at !== o.updated_at)
        push(`${type}.updated`, {...ref, updated_at: it.updated_at});
    }
  };
  itemEvents(
    'item',
    Object.fromEntries(
      Object.entries(s.items).map(([n, it]) => [n, {...it, kind: it.is_pr ? 'pr' : 'issue'}])
    ),
    b.items,
    {state: it => it.state}
  );
  for (const e of events)
    if (e.kind.startsWith('item.')) {
      const it = s.items[e.number];
      e.kind = `${it?.is_pr ? 'pr' : 'issue'}.${e.kind.slice(5)}`;
    }
  itemEvents('discussion', s.discussions, b.discussions, {
    state: d => (d.closed ? 'closed' : 'open')
  });

  const forkLogins = new Set((s.forks ?? []).map(f => f.login));
  const prevForkLogins = new Set((b.forks ?? []).map(f => f.login));
  for (const f of s.forks ?? [])
    if (!prevForkLogins.has(f.login))
      push('fork.new', {login: f.login, full_name: f.full_name, created_at: f.created_at});
  for (const f of b.forks ?? [])
    if (!forkLogins.has(f.login)) push('fork.removed', {login: f.login, full_name: f.full_name});
  if (s.meta.forks !== b.meta?.forks && !(s.forks && b.forks))
    push('forks.count', {from: b.meta?.forks ?? null, to: s.meta.forks});

  if (s.stars && b.stars) {
    const prev = new Set(b.stars),
      now = new Set(s.stars);
    for (const login of s.stars) if (!prev.has(login)) push('star.new', {login});
    for (const login of b.stars) if (!now.has(login)) push('star.removed', {login});
  } else if (s.meta.stars !== b.meta?.stars) {
    push('stars.count', {
      from: b.meta?.stars ?? null,
      to: s.meta.stars,
      delta: s.meta.stars - (b.meta?.stars ?? 0)
    });
  }
  if (s.watchers && b.watchers) {
    const prev = new Set(b.watchers),
      now = new Set(s.watchers);
    for (const login of s.watchers) if (!prev.has(login)) push('watcher.new', {login});
    for (const login of b.watchers) if (!now.has(login)) push('watcher.removed', {login});
  } else if (s.meta.watchers !== b.meta?.watchers && b.meta?.watchers !== undefined)
    push('watchers.count', {from: b.meta.watchers, to: s.meta.watchers});

  for (const [id, r] of Object.entries(s.releases)) {
    const o = b.releases?.[id];
    const ref = {id: Number(id), tag: r.tag_name, name: r.name, url: r.html_url};
    if (!o) push('release.new', {...ref, draft: r.draft, prerelease: r.prerelease});
    else if (o.draft && !r.draft) push('release.published', {...ref, published_at: r.published_at});
  }

  for (const kind of ['dependabot', 'code_scanning']) {
    const now = s.alerts?.[kind],
      prev = b.alerts?.[kind];
    if (now?.open !== undefined && prev?.open !== undefined && now.open !== prev.open)
      push(`alerts.${kind}`, {from: prev.open, to: now.open, by_severity: now.by_severity});
  }
  if (s.ci && b.ci && s.ci.conclusion !== b.ci.conclusion)
    push('ci.conclusion', {
      from: b.ci.conclusion,
      to: s.ci.conclusion,
      name: s.ci.name,
      url: s.ci.html_url
    });
  return events;
};

/**
 * A digest over collected entries, skipped ones left out by the caller: {collected_at, mode,
 * gh_user, repos, totals}, the shape renderBrief, runRecord, and appendRuns take.
 */
export const digestOf = (
  repos,
  {mode, ghUser, collectedAt = new Date().toISOString(), packagesOnly = false, packageErrors = []}
) => ({
  collected_at: collectedAt,
  mode,
  gh_user: ghUser,
  ...(packagesOnly ? {packages_only: true} : {}),
  repos,
  ...(packageErrors.length ? {package_errors: packageErrors} : {}),
  totals: {
    repos: repos.filter(r => r.github !== false).length,
    events: repos.reduce((n, r) => n + r.events.length, 0),
    first_run: repos.filter(r => r.first_run).length,
    errors: repos.filter(r => r.error).length,
    partial_errors: repos.reduce((n, r) => n + (r.errors?.length ?? 0), 0) + packageErrors.length,
    packages: repos.reduce(
      (n, r) => n + (r.packages?.packages.filter(p => p.published).length ?? 0),
      0
    )
  }
});

/**
 * Writes an entry's snapshot as the project's baseline, unless the stored text is the same.
 * Resolves to 'written' or 'unchanged'.
 */
export const commitBaseline = async (api, entry) => {
  if (!entry?.snapshot) throw new TypeError(`${entry?.repo}: no snapshot to commit`);
  const path = baselinePath(entry.project);
  const text = `${JSON.stringify(entry.snapshot, null, 2)}\n`;
  if ((await readText(api, path)) === text) return 'unchanged';
  const answer = await api(path, {method: 'PUT', body: text, contentType: TEXT});
  if (!isOk(answer)) throw failure('PUT', path, answer);
  return 'written';
};

/** One event as a line of text. */
export const eventLine = e => {
  const who = e.author ? ` by ${e.author}${e.bot ? ' (bot)' : ''}` : '';
  switch (true) {
    case e.kind.startsWith('advisory.'):
      return `${e.kind} ${e.id}${e.cve_id ? ` ${e.cve_id}` : ''}${e.from ? ` ${e.from} → ${e.to}` : ''} — ${e.summary}`;
    case /^(issue|pr|discussion)\./.test(e.kind): {
      const detail = e.kind.endsWith('.state')
        ? `${e.from} → ${e.to}`
        : e.kind.endsWith('.comments')
          ? `+${e.delta} comment${e.delta === 1 ? '' : 's'}${e.last_comment ? `, last ${e.last_comment.author}${e.last_comment.excerpt ? `: "${e.last_comment.excerpt}"` : ''}` : ''}`
          : e.kind.endsWith('.reactions')
            ? `${e.delta > 0 ? '+' : ''}${e.delta} reaction${Math.abs(e.delta) === 1 ? '' : 's'}`
            : (e.note ?? '');
      return `${e.kind} #${e.number}${who} — ${e.title}${detail ? ` (${detail})` : ''}${e.excerpt ? ` — ${e.excerpt}` : ''}`;
    }
    case e.kind === 'fork.new' || e.kind === 'fork.removed':
      return `${e.kind} ${e.login} (${e.full_name})`;
    case /^(star|watcher)\.(new|removed)$/.test(e.kind):
      return `${e.kind} ${e.login}`;
    case /count$/.test(e.kind):
      return `${e.kind} ${e.from} → ${e.to}`;
    case e.kind.startsWith('release.'):
      return `${e.kind} ${e.tag}${e.name ? ` — ${e.name}` : ''}`;
    case e.kind.startsWith('alerts.'):
      return `${e.kind} ${e.from} → ${e.to} open`;
    case e.kind === 'ci.conclusion':
      return `ci ${e.name}: ${e.from} → ${e.to}`;
    case e.kind === 'package.dependents':
      return `package.dependents ${e.package} ${e.from} → ${e.to}`;
    default:
      return `${e.kind} ${JSON.stringify(e)}`;
  }
};

/**
 * A run as it is stored: its events, the snapshots left to the baselines. A project with packages and
 * no repository enters only when it moved.
 */
export const runRecord = digest => ({
  collected_at: digest.collected_at,
  mode: digest.mode,
  ...(digest.packages_only ? {packages_only: true} : {}),
  gh_user: digest.gh_user ?? null,
  totals: digest.totals,
  repos: digest.repos
    .filter(r => r.github !== false || r.events.length)
    .map(r =>
      r.error
        ? {repo: r.repo, project: r.project, error: r.error, events: [], summary: r.summary}
        : {
            repo: r.repo,
            project: r.project,
            ...(r.github === false ? {github: false} : {}),
            first_run: Boolean(r.first_run),
            since: r.since ?? r.snapshot?.window?.since ?? null,
            events: r.events,
            summary: r.summary,
            errors: r.errors ?? []
          }
    )
});

/**
 * Appends the run to each of its projects' month files, one line a project holding that project's
 * entries, when it carries events or is a fleet run. Resolves to the paths written.
 */
export const appendRuns = async (api, digest) => {
  if (!((digest.mode === 'fleet' && !digest.packages_only) || digest.totals?.events > 0)) return [];
  const {repos, ...run} = runRecord(digest);
  const written = [];
  for (const project of new Set(repos.map(r => r.project))) {
    const path = runsPath(project, digest.collected_at);
    const line = `${JSON.stringify({...run, repos: repos.filter(r => r.project === project)})}\n`;
    const answer = await api(path, {method: 'POST', body: line, contentType: TEXT});
    if (!isOk(answer)) throw failure('POST', path, answer);
    written.push(path);
  }
  return written;
};

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
const short = iso => (iso ?? '').replace(/T(\d\d:\d\d).*$/, ' $1');

// Weights order the brief's phrases: a number is worth a line, 'counter' folds into the tail line,
// null stays in the JSON (the account's own single comment, an edit or a label change).
const shortRepo = (repo, ghUser) =>
  ghUser && repo.startsWith(`${ghUser}/`) ? repo.slice(ghUser.length + 1) : repo;
const signed = n => (n > 0 ? `+${n}` : String(n));
const itemWord = kind =>
  kind.startsWith('pr.') ? 'PR' : kind.startsWith('discussion.') ? 'discussion' : 'issue';

const isItemKind = kind => /^(issue|pr|discussion)\./.test(kind);

const briefWeight = (e, ghUser) => {
  const k = e.kind;
  if (k.startsWith('advisory.')) return 0;
  if (isItemKind(k)) {
    if (k.endsWith('.new')) return e.bot ? 'counter' : 1;
    if (k.endsWith('.comments'))
      return e.last_comment?.author && e.last_comment.author === ghUser && e.delta === 1 ? null : 2;
    if (k.endsWith('.state')) return 3;
    if (k.endsWith('.updated')) return e.note ? 2 : null;
    return 'counter';
  }
  if (k.startsWith('release.') || k === 'ci.conclusion') return 4;
  if (k.startsWith('alerts.')) return e.to > e.from ? 4 : 'counter';
  return 'counter';
};

const quoteExcerpt = (text, n) => (text ? `: "${clip(text, n)}"` : '');

const briefPhrase = e => {
  const k = e.kind;
  if (k === 'advisory.new')
    return `advisory ${e.id} (${e.state}${e.severity ? `, ${e.severity}` : ''}${e.cve_id ? `, ${e.cve_id}` : ''}) "${e.summary}"`;
  if (k === 'advisory.cve_assigned') return `advisory ${e.id} got ${e.cve_id}`;
  if (k === 'advisory.state') return `advisory ${e.id} ${e.from} → ${e.to}`;
  if (k === 'advisory.updated') return `advisory ${e.id} updated`;
  if (k === 'release.new')
    return `release ${e.tag}${e.draft ? ' (draft)' : ''}${e.prerelease ? ' (prerelease)' : ''}`;
  if (k === 'release.published') return `release ${e.tag} published`;
  if (k === 'ci.conclusion') return `CI ${e.name}: ${e.from} → ${e.to}`;
  if (k.startsWith('alerts.'))
    return `${k === 'alerts.dependabot' ? 'Dependabot' : 'code scanning'} alerts ${e.from} → ${e.to}`;
  if (!isItemKind(k)) return eventLine(e);
  if (k.endsWith('.new'))
    return `new ${itemWord(k)} #${e.number} by ${e.author} "${e.title}"${e.excerpt ? ` — ${clip(e.excerpt, 80)}` : ''}`;
  if (k.endsWith('.comments')) {
    const lc = e.last_comment;
    return `${itemWord(k)} #${e.number} "${clip(e.title, 50)}" +${plural(e.delta, 'comment')}${lc ? ` by ${lc.author}${quoteExcerpt(lc.excerpt, 80)}` : ''}`;
  }
  if (k.endsWith('.state'))
    return `${itemWord(k)} #${e.number} "${clip(e.title, 50)}" ${e.from} → ${e.to}`;
  if (k.endsWith('.updated'))
    return `${itemWord(k)} #${e.number} "${clip(e.title, 50)}" active, not in the baseline (${plural(e.comments ?? 0, 'comment')}${e.last_comment ? `, last by ${e.last_comment.author}${quoteExcerpt(e.last_comment.excerpt, 80)}` : ''})`;
  return eventLine(e);
};

const briefCounters = (repos, ghUser) => {
  const stars = new Map(),
    forks = new Map(),
    forkLogins = new Map(),
    watchers = new Map(),
    watcherLogins = new Map(),
    dependents = new Map(),
    reactions = new Map(),
    bots = [],
    alertsDown = [];
  const add = (m, key, n) => m.set(key, (m.get(key) ?? 0) + n);
  const name_ = (m, key, login) => m.set(key, [...(m.get(key) ?? []), login]);
  for (const r of repos) {
    const name = shortRepo(r.repo, ghUser);
    for (const e of r.events) {
      const k = e.kind;
      if (k === 'package.dependents') add(dependents, e.package, e.delta ?? e.to - e.from);
      else if (k === 'stars.count') add(stars, name, e.delta ?? e.to - e.from);
      else if (k === 'star.new') add(stars, name, 1);
      else if (k === 'star.removed') add(stars, name, -1);
      else if (k === 'fork.new') {
        add(forks, name, 1);
        name_(forkLogins, name, e.login);
      } else if (k === 'fork.removed') add(forks, name, -1);
      else if (k === 'forks.count') add(forks, name, e.to - e.from);
      else if (k === 'watcher.new') {
        add(watchers, name, 1);
        name_(watcherLogins, name, e.login);
      } else if (k === 'watcher.removed') add(watchers, name, -1);
      else if (k === 'watchers.count') add(watchers, name, e.to - e.from);
      else if (isItemKind(k) && k.endsWith('.reactions'))
        add(reactions, `${name}#${e.number}`, e.delta);
      else if (isItemKind(k) && k.endsWith('.new') && e.bot)
        bots.push(`${itemWord(k)} ${name}#${e.number} by ${e.author}`);
      else if (k.startsWith('alerts.') && e.to < e.from)
        alertsDown.push(`${name} ${k.slice(7).replace('_', ' ')} ${e.from} → ${e.to}`);
    }
  }
  const total = m => [...m.values()].reduce((a, b) => a + b, 0);
  const list = (m, fmt) => [...m].map(fmt).join(', ');
  const parts = [];
  if (stars.size)
    parts.push(`stars ${signed(total(stars))} (${list(stars, ([k, v]) => `${k} ${signed(v)}`)})`);
  if (forks.size)
    parts.push(
      `forks ${signed(total(forks))} (${list(forks, ([k, v]) => `${k} ${signed(v)}${forkLogins.has(k) ? `: ${forkLogins.get(k).join(', ')}` : ''}`)})`
    );
  if (watchers.size)
    parts.push(
      `watchers ${signed(total(watchers))} (${list(watchers, ([k, v]) => `${k} ${signed(v)}${watcherLogins.has(k) ? `: ${watcherLogins.get(k).join(', ')}` : ''}`)})`
    );
  if (dependents.size)
    parts.push(
      `dependents ${signed(total(dependents))} (${list(dependents, ([k, v]) => `${k} ${signed(v)}`)})`
    );
  if (reactions.size)
    parts.push(
      `reactions ${signed(total(reactions))} (${list(reactions, ([k, v]) => `${k} ${signed(v)}`)})`
    );
  if (bots.length) parts.push(`bots: ${bots.join(', ')}`);
  if (alertsDown.length) parts.push(`alerts down (${alertsDown.join('; ')})`);
  return parts;
};

/**
 * The brief of a digest: one line per repository with movement, the events worth acting on first,
 * then a counters line, first runs, errors, and the quiet count of a fleet run.
 */
export const renderBrief = (digest, {header = true} = {}) => {
  if (digest.skipped)
    return `skipped: ${digest.reason}${digest.remote ? ` (${digest.remote})` : ''}`;
  if (digest.error) return `${digest.error}: ${digest.message} — ${digest.hint}`;
  const ghUser = digest.gh_user ?? null;
  const fleet = digest.mode === 'fleet';
  const live = digest.repos.filter(r => !r.error && !r.first_run && !r.skipped);
  const moved = [];
  let active = 0;
  for (const r of live) {
    const weighted = r.events.map(e => ({w: briefWeight(e, ghUser), e})).filter(x => x.w !== null);
    if (weighted.length && r.github !== false) ++active;
    const lead = weighted.filter(x => typeof x.w === 'number').sort((a, b) => a.w - b.w);
    if (lead.length)
      moved.push({
        name: shortRepo(r.repo, ghUser),
        weight: lead[0].w,
        phrases: lead.map(x => briefPhrase(x.e))
      });
  }
  moved.sort((a, b) => a.weight - b.weight || a.name.localeCompare(b.name));
  const sinces = live
    .map(r => r.since ?? r.snapshot?.window?.since)
    .filter(Boolean)
    .sort();
  const since = digest.stored?.since ?? sinces[0] ?? null;
  const stamp = since ? short(since) : 'the baseline';
  const stored = digest.stored
    ? ` (${plural(digest.stored.runs, 'stored run')}, newest ${short(digest.collected_at)})`
    : '';
  const lines = [];
  if (header) {
    if (fleet)
      lines.push(
        `Fleet movement since ${stamp} — ${plural(digest.totals?.repos ?? digest.repos.length, 'repository', 'repositories')}, ${moved.length} with movement${stored}`
      );
    else
      lines.push(
        `${digest.repos.map(r => shortRepo(r.repo, ghUser)).join(', ')} — movement since ${stamp}${stored}`
      );
  }
  for (const m of moved) lines.push(`- ${m.name}: ${m.phrases.join('; ')}`);
  const counters = briefCounters(live, ghUser);
  if (counters.length) lines.push(`- counters: ${counters.join('; ')}`);
  const firstRuns = digest.repos.filter(r => r.first_run);
  if (firstRuns.length)
    lines.push(
      fleet
        ? `- first run: ${plural(firstRuns.length, 'repository', 'repositories')} (baseline recorded)`
        : `- first run — baseline recorded (${plural(firstRuns[0].summary.open_items, 'open item')}, ${plural(firstRuns[0].summary.stars, 'star')}, ${plural(firstRuns[0].summary.forks, 'fork')}${firstRuns[0].summary.advisories_without_cve ? `, ${firstRuns[0].summary.advisories_without_cve} published advisories without a CVE` : ''})`
    );
  const errors = digest.repos.filter(r => r.error);
  if (errors.length)
    lines.push(
      `- errors: ${errors.map(r => `${shortRepo(r.repo, ghUser)}: ${r.error.message}`).join('; ')}`
    );
  const partial =
    live.reduce((n, r) => n + (r.errors?.length ?? 0), 0) + (digest.package_errors?.length ?? 0);
  if (partial) lines.push(`- partial errors: ${partial} (details in the collected JSON)`);
  const fleetSize = digest.stored
    ? digest.stored.fleet_size
    : live.filter(r => r.github !== false).length;
  const quiet = fleet && fleetSize !== null ? fleetSize - active : 0;
  if (quiet > 0) lines.push(`- quiet: ${plural(quiet, 'repository', 'repositories')}`);
  if (lines.length === (header ? 1 : 0)) lines.push('- none');
  return lines.join('\n');
};
