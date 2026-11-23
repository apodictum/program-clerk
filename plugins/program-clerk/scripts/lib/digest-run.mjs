// What `/pickup` runs: the project's resume state, its queue, its plans, its last log, the
// checkout's drift, and its GitHub repository read at once, then the digest written. It acts on
// nothing but filing a person's new GitHub threads and CVEs on the queue and advancing the GitHub
// baseline. The session-start hook collects GitHub ahead, and the prompt hook takes that collection.

import {execFile} from 'node:child_process';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync} from 'node:fs';
import {readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {refusedKeyLine} from './brief.mjs';
import {projectOf, topOf} from './checkout.mjs';
import {cacheDir, connectionOf, fileSafe, shortHost, transcriptsDirOf} from './common.mjs';
import {DRAWS_READ, digestOf, intakeOf, lastMessageOf, laterThanLog, newestOf} from './digest.mjs';
import {owedOf, threadsToFile} from './digest.mjs';
import {driftReport} from './drift.mjs';
import * as github from './github.mjs';
import {request} from './http.mjs';
import {expectJson, fileItem, githubRefs, itemsFrom, owedFrom, queueOf} from './queue.mjs';
import {styledOf} from './style.mjs';

// Five times the 5 s a collection takes; past it the stored baseline answers.
const COLLECT_CAP_MS = 30_000;
// Nearly every pickup comes within five minutes of its session's start.
const PREPARED_MAX_AGE_MS = 5 * 60_000;
// What a session that never asked for its digest leaves behind.
const PREPARED_KEPT_MS = 24 * 3_600_000;
const COLLECTOR_POLL_MS = 50;
const TAIL_BYTES = 512 * 1024;
const NOT_ADVANCED = 'The GitHub baseline did not advance.';

export const preparedDir = (env = process.env) => join(cacheDir(env), 'pickup');

const preparedPaths = (session, dir) => ({
  json: join(dir, `${fileSafe(session)}.json`),
  pid: join(dir, `${fileSafe(session)}.pid`)
});

const gitConfig = (top, key) =>
  new Promise(resolve => {
    execFile(
      'git',
      ['-C', top, 'config', '--get', key],
      {encoding: 'utf8', timeout: 5_000, windowsHide: true},
      (err, stdout) => resolve(err ? '' : stdout.trim())
    );
  });

const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * The checkout's GitHub repository collected, as one entry of a run: `{skipped}` with no GitHub
 * remote, `{problem}` when `gh` is missing or signed out, else `{run}`, the run to show and commit.
 */
export const collectCheckout = async ({top, project, trackers, api, gh = github.runGh}) => {
  const target = top ? github.repoOfRemote(await gitConfig(top, 'remote.origin.url')) : null;
  if (target === null) return {skipped: true};
  const login = await github.ghLogin(gh);
  if (login.problem !== undefined) return {problem: login.problem};
  const repo = `${target.owner}/${target.name}`;
  const tracked = githubRefs(trackers).some(ref => sameRepo(ref, repo));
  let entry;
  try {
    const baseline = await github.readBaseline(api, project);
    entry = await github.collectRepo({
      ...target,
      project,
      tracked,
      baseline,
      ghUser: login.login,
      gh
    });
  } catch (err) {
    entry = {repo, project, error: {message: err.message}, events: [], summary: {events: 0}};
  }
  if (entry.skipped) return {skipped: true, ...(entry.reason === 'private' ? {private: repo} : {})};
  return {run: github.digestOf([entry], {mode: 'cwd', ghUser: login.login})};
};

/** `collectCheckout` with its `gh` calls stopped at the cap; null when the cap came first. */
const collectCapped = async options => {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), COLLECT_CAP_MS);
  try {
    const gh = options.gh ?? (args => github.runGh(args, {signal: stop.signal}));
    const collected = await collectCheckout({...options, gh});
    return stop.signal.aborted ? null : collected;
  } finally {
    clearTimeout(timer);
  }
};

const sweepPrepared = (dir, now) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > PREPARED_KEPT_MS) rmSync(path, {force: true});
    } catch {
      // gone already
    }
  }
};

/**
 * Collects ahead of a pickup. It only reads GitHub, since advancing the baseline here would spend
 * the movement of a session that never asks for its digest.
 */
export const prepareCollection = async ({cwd, session, env = process.env, outageMs = 3_000}) => {
  const conn = connectionOf(env);
  if (conn === null) return;
  const api = (path, opts = {}) => request(conn, path, {...opts, outageMs, env});
  const dir = preparedDir(env);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  sweepPrepared(dir, Date.now());
  const {json, pid} = preparedPaths(session, dir);
  writeFileSync(pid, String(process.pid));
  try {
    const top = topOf(cwd);
    const project = top ? projectOf(top) : basename(cwd);
    const {trackers} = await queueOf(api, project);
    const collected = await collectCapped({top, project, trackers, api});
    if (collected === null) return;
    writeFileSync(`${json}.partial`, JSON.stringify({project, ...collected}));
    renameSync(`${json}.partial`, json);
  } finally {
    rmSync(pid, {force: true});
  }
};

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const collectorRunning = (path, alive) => {
  try {
    return alive(Number(readFileSync(path, 'utf8')));
  } catch {
    return false;
  }
};

/**
 * The session's collection, taken: null when there is none, or it is stale or another project's.
 * Half of all pickups come within seconds of the start, with the collection still running, so it
 * waits for that one to end.
 */
export const takePrepared = async (
  session,
  project,
  {dir = preparedDir(), alive = isAlive, now = Date.now} = {}
) => {
  const {json, pid} = preparedPaths(session, dir);
  // The collector stops itself at this cap; a pid still alive past it is another process's.
  const giveUpAt = now() + COLLECT_CAP_MS;
  while (collectorRunning(pid, alive) && now() < giveUpAt) await delay(COLLECTOR_POLL_MS);
  if (!existsSync(json)) return null;
  const age = now() - statSync(json).mtimeMs;
  const text = readFileSync(json, 'utf8');
  rmSync(json, {force: true});
  if (age > PREPARED_MAX_AGE_MS) return null;
  const prepared = JSON.parse(text);
  // A collection that failed is collected again, which may now succeed.
  const failed = prepared.problem !== undefined || prepared.run?.repos?.[0]?.error !== undefined;
  return prepared.project === project && !failed ? prepared : null;
};

const storedGithub = async (api, project, problem) => {
  try {
    const snapshot = await github.readBaseline(api, project);
    if (snapshot === null) return {problem};
    return {problem, repo: snapshot.repo, snapshot, stored: true, filed: []};
  } catch {
    return {problem};
  }
};

const LOGIN_PROBLEMS = {
  missing: 'GitHub was not read: the gh command is not installed on this machine.',
  'signed-out': 'gh has no valid login on this machine: run `gh auth login`.'
};

const fileThreads = async (api, project, threads, section) => {
  const filed = [];
  for (const thread of threads) {
    try {
      await fileItem(api, project, {...thread, section});
    } catch (err) {
      const why = err.message.split(/\r?\n/)[0];
      return {filed, problem: `Filing ${thread.source} failed: ${why}. ${NOT_ADVANCED}`};
    }
    filed.push(thread.title);
  }
  return {filed};
};

// A private repository is read only when the project's trackers name it, so a team opts in.
export const privateLine = (repo, project) =>
  `GitHub ${repo} is private, and the project's trackers don't name it, so /pickup reads nothing from it. To read it, add {kind: github, ref: ${repo}} to the trackers: list in projects/${project}/queue/_about.md; the README shows the whole list.`;

/** The GitHub part: whatever fails in it becomes a line beside the stored view, never a lost digest. */
export const githubOf = async ({top, project, trackers, items, api, prepared, gh}) => {
  let collected;
  try {
    collected = prepared ??
      (await collectCapped({top, project, trackers, api, gh})) ?? {stopped: true};
  } catch (err) {
    return storedGithub(api, project, `GitHub could not be read just now: ${err.message}`);
  }
  if (collected.skipped) {
    return collected.private ? {problem: privateLine(collected.private, project)} : null;
  }
  if (collected.stopped) return storedGithub(api, project, 'GitHub could not be read in time.');
  if (collected.problem !== undefined) {
    return storedGithub(api, project, LOGIN_PROBLEMS[collected.problem]);
  }
  const {run} = collected;
  const [entry] = run.repos;
  if (entry.error) {
    return storedGithub(api, project, `GitHub answered: ${entry.error.message ?? entry.error}`);
  }
  const section = intakeOf(trackers);
  // With the queue unread, a filing could overwrite an item's prose, so nothing is filed.
  const {filed, problem} =
    items === null
      ? {
          filed: [],
          problem: `New threads were not filed, since the queue is unread. ${NOT_ADVANCED}`
        }
      : await fileThreads(
          api,
          project,
          section === null ? [] : threadsToFile(entry.events, items),
          section
        );
  let failure = problem;
  if (failure === undefined) {
    try {
      await github.commitBaseline(api, entry);
      await github.appendRuns(api, run);
    } catch {
      failure = NOT_ADVANCED;
    }
  }
  return {
    repo: entry.repo,
    snapshot: entry.snapshot,
    ciError: entry.errors.find(e => e.where === 'ci')?.message,
    firstRun: entry.first_run,
    brief: entry.events.length > 0 ? github.renderBrief(run).trim() : '',
    filed,
    problem: failure
  };
};

const tailOf = path => {
  const size = statSync(path).size;
  const length = Math.min(size, TAIL_BYTES);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
};

/** The final message of the newest session with no log, when this machine can read it. */
const lastMessageOfUnlogged = (p, cwd, env) => {
  const later = laterThanLog(p);
  if (later.length === 0) return null;
  const [host, prefix] = newestOf(later).holder.split('/');
  if (host !== shortHost()) return null;
  const folder = transcriptsDirOf(cwd, env);
  try {
    const name = readdirSync(folder).find(f => f.startsWith(prefix) && f.endsWith('.jsonl'));
    return name === undefined ? null : lastMessageOf(tailOf(join(folder, name)));
  } catch {
    return null;
  }
};

// A server without the draw, or one on SQLite, has none to read.
const drawsOf = answer =>
  answer?.status === 404 || answer?.status === 501 ? null : expectJson(answer, 'the draws').draws;

const driftOf = async (api, top, project) => {
  if (!top) return {problem: 'not inside a git checkout'};
  try {
    const answer = await api(`/vault/projects/${project}/state.md`);
    if (answer === null) return {problem: 'the baseline could not be read: no answer'};
    if (answer.status !== 200 && answer.status !== 404) {
      return {problem: `the baseline could not be read: ${answer.status}`};
    }
    return await driftReport({
      top,
      project,
      baselineText: answer.status === 404 ? null : answer.text
    });
  } catch (err) {
    return {problem: err.message};
  }
};

/**
 * The digest for the checkout at `cwd`, or for `project`: `{digest, styled}`. `session`, when
 * given, takes that session's collection made at its start.
 */
export const digestRun = async ({
  cwd = process.cwd(),
  project: named,
  session,
  env = process.env,
  outageMs,
  gh
} = {}) => {
  const conn = connectionOf(env);
  if (conn === null) {
    // The plugin's key option reaches the hooks and never a script run through the agent's shell.
    throw new Error(
      "no key in this shell: type /pickup, whose hook reads the plugin's key option, or set the PROGRAM_CLERK_KEY variable"
    );
  }
  const api = (path, opts = {}) => request(conn, path, {...opts, outageMs, env});
  const top = topOf(cwd);
  const project = named ?? (top ? projectOf(top) : basename(cwd));
  const problems = new Set();
  const orElse = (promise, fallback, what) =>
    promise.catch(err => {
      problems.add(`${what} could not be read: ${err.message}`);
      return fallback;
    });
  const statePromise = api(`/system/resume-project?project=${encodeURIComponent(project)}`, {
    method: 'POST'
  }).then(answer => {
    if (answer?.status === 401) throw new Error(refusedKeyLine(conn.base));
    return expectJson(answer, `the resume state of ${project}`);
  });
  const queuePromise = orElse(queueOf(api, project), null, 'The queue');
  const preparedPromise =
    session === undefined || named !== undefined
      ? Promise.resolve(null)
      : takePrepared(session, project, {dir: preparedDir(env)}).catch(() => null);
  const githubPromise = Promise.all([queuePromise, preparedPromise]).then(([queue, prepared]) =>
    queue === null
      ? githubOf({top, project, trackers: {trackers: []}, items: null, api, prepared, gh})
      : githubOf({
          top,
          project,
          trackers: queue.trackers,
          items: itemsFrom(queue.notes),
          api,
          prepared,
          gh
        })
  );
  const [state, queue, plansFolder, drift, githubPart, draws] = await Promise.all([
    statePromise,
    queuePromise,
    orElse(
      api(`/vault/projects/${project}/plans/`).then(answer =>
        answer?.status === 200 ? JSON.parse(answer.text) : {files: []}
      ),
      {files: []},
      'The plans'
    ),
    driftOf(api, top, project),
    githubPromise,
    orElse(api(`/draws?limit=${DRAWS_READ}`).then(drawsOf), null, 'The draws')
  ]);
  const p = state.project;
  const trackers = queue?.trackers ?? {trackers: [], problems: []};
  const bundle = {...state, project: p === null ? null : {...p, trackers}};
  const owedItems = owedFrom(queue?.notes ?? [], p?.changes?.since.ended ?? null);
  const logBody = p?.logs?.[0]?.data_path
    ? await orElse(
        api(`/data/${p.logs[0].data_path}`).then(answer =>
          answer?.status === 200 ? answer.text : null
        ),
        null,
        'The last log'
      )
    : null;
  const plans = (plansFolder.files ?? [])
    .filter(f => f !== 'archive/' && !f.startsWith('.'))
    .map(f => `projects/${project}/plans/${f.replace(/\/$/, '')}`);
  const digest = digestOf({
    project,
    bundle,
    items: queue === null ? null : itemsFrom(queue.notes),
    owed: owedOf(bundle, owedItems, draws),
    plans,
    logBody,
    lastMessage: p?.found ? lastMessageOfUnlogged(p, cwd, env) : null,
    drift,
    github: githubPart,
    problems: [...problems]
  });
  return {digest, styled: styledOf(digest)};
};
