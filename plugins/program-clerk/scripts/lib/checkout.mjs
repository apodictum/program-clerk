import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {shortHost} from './common.mjs';

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
