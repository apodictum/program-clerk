// Where a sweep keeps its state, its shards, and each triage pass's worksheet and report: one folder
// a session under the plugin's cache, so the driver finds a pass's report from the holder alone, and
// the session's sub-agents, which share its id, write beside it.

import {mkdirSync, readdirSync, rmSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {cacheDir, fileSafe} from './common.mjs';

const KEEP_MS = 7 * 864e5;

export const sweepRoot = (env = process.env) => join(cacheDir(env), 'sweep');

export const sweepDir = (env = process.env) =>
  join(sweepRoot(env), fileSafe(env.CLAUDE_CODE_SESSION_ID || 'manual'));

export const worksheetPathFor = (holder, env = process.env) =>
  join(sweepDir(env), `triage-${fileSafe(holder)}.json`);

export const reportPathFor = (holder, env = process.env) =>
  join(sweepDir(env), `triage-${fileSafe(holder)}.report.json`);

/** The session's folder, made; another session's folder untouched for a week is removed. */
export const readySweepDir = (env = process.env, now = Date.now()) => {
  const root = sweepRoot(env);
  mkdirSync(root, {recursive: true, mode: 0o700});
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (now - statSync(dir).mtimeMs > KEEP_MS) rmSync(dir, {recursive: true, force: true});
    } catch {
      // gone already
    }
  }
  const dir = sweepDir(env);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  return dir;
};
