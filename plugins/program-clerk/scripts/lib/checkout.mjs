import {execFileSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {cacheDir, hashOf, readText, shortHost} from './common.mjs';

const git = (dir, ...args) => {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true
    }).trim();
  } catch {
    return '';
  }
};

const slashed = path => path.replace(/\\/g, '/');

const realOf = path => {
  try {
    return slashed(realpathSync(path));
  } catch {
    return slashed(path);
  }
};

/** The top of the checkout holding `dir`, or '' outside one. */
export const topOf = dir => {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  return top ? realOf(top) : '';
};

// A Write may create a file whose folders do not exist yet.
export const topOfPath = path => {
  let dir = path;
  for (;;) {
    try {
      if (statSync(dir).isDirectory()) break;
    } catch {
      // not there yet
    }
    const up = dirname(dir);
    if (up === dir) return '';
    dir = up;
  }
  return topOf(dir);
};

// Past this much `git status` output a checkout gets no mark, and its session is judged without one.
const MARK_LIMIT = 4 * 1024 * 1024;
const MARK_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The checkout's state as a hash: HEAD, and each changed or untracked file with its size and time;
 * null when git cannot say within `budget` milliseconds.
 */
export const markOf = (top, budget = 2000) => {
  const until = Date.now() + budget;
  const run = (...args) =>
    execFileSync('git', ['-C', top, ...args], {
      encoding: 'utf8',
      env: {...process.env, GIT_OPTIONAL_LOCKS: '0'},
      maxBuffer: MARK_LIMIT,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.max(1, until - Date.now()),
      windowsHide: true
    });
  let status;
  try {
    status = run('status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all');
  } catch {
    return null;
  }
  let head = '';
  try {
    head = run('rev-parse', '--verify', '-q', 'HEAD').trim();
  } catch {
    if (Date.now() >= until) return null;
    // no commit yet
  }
  const parts = [head];
  for (const entry of status.split('\0')) {
    if (!entry) continue;
    if (Date.now() >= until) return null;
    let stamp = '';
    try {
      const stat = statSync(join(top, entry.slice(3)));
      stamp = `${stat.size} ${stat.mtimeMs}`;
    } catch {
      // deleted: its entry alone
    }
    parts.push(entry, stamp);
  }
  return hashOf(parts.join('\t'));
};

const markFileOf = (session, env) => join(cacheDir(env), 'marks', session);

const pruneMarks = dir => {
  const cutoff = Date.now() - MARK_KEEP_MS;
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).mtimeMs < cutoff) rmSync(file, {force: true});
    }
  } catch {
    // a crashed session's mark is only kept tidy
  }
};

/** Keeps the checkout's mark for the session once: a compaction or a resume keeps the first. */
export const keepMark = (session, top, env = process.env) => {
  const file = markFileOf(session, env);
  if (existsSync(file)) return;
  const mark = markOf(top);
  if (mark === null) return;
  pruneMarks(dirname(file));
  try {
    mkdirSync(dirname(file), {recursive: true, mode: 0o700});
    writeFileSync(file, `${top}\t${mark}`, {flag: 'wx', mode: 0o600});
  } catch {
    // another start of the session wrote it first
  }
};

/**
 * Whether the checkout differs from the mark kept at the session's start, undefined when either
 * side is unknown or git takes longer than `budget` milliseconds; the mark goes.
 */
export const changedSinceMark = (session, top, budget, env = process.env) => {
  const file = markFileOf(session, env);
  const kept = readText(file);
  try {
    rmSync(file, {force: true});
  } catch {
    // left for the prune
  }
  const tab = kept.lastIndexOf('\t');
  if (tab < 0 || kept.slice(0, tab) !== top) return undefined;
  const mark = markOf(top, budget);
  return mark === null ? undefined : mark !== kept.slice(tab + 1);
};

export const isLinkedWorktree = top => {
  try {
    return /\/worktrees\//.test(slashed(readFileSync(join(top, '.git'), 'utf8')));
  } catch {
    return false;
  }
};

// The same rewrite as the shell hooks' sed, so both sides compute one key for one repository.
export const normalizeRemote = url =>
  url
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/^[^/@]*@/, '')
    .replace(':', '/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');

export const remoteOf = top => normalizeRemote(git(top, 'remote', 'get-url', 'origin'));

/**
 * A checkout's lease key in a mode, and the role its handoffs are addressed to. A repository with no
 * remote cannot be shared, so its key names the host and the path in either mode.
 */
export const keysOf = (top, mode, remote = remoteOf(top)) => {
  if (!remote) {
    const key = `repo:${shortHost()}:${top}`;
    return {resource: key, role: key};
  }
  const role = `repo:${remote}`;
  return {resource: mode === 'repository' ? role : `${role}@${shortHost()}:${top}`, role};
};

// A linked worktree's folder says nothing of its project, so its main checkout stands for it.
export const projectOf = top => {
  const marker = join(top, '.claude', 'pc-project');
  if (existsSync(marker)) return readFileSync(marker, 'utf8').trim();
  const common = git(top, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return basename(common && basename(common) === '.git' ? dirname(common) : top);
};

export const PROJECT = /^[a-z0-9][a-z0-9.-]*$/;
