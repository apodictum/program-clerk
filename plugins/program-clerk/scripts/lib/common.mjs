import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {homedir, hostname} from 'node:os';
import {join} from 'node:path';

export const DEFAULT_URL = 'https://api.programclerk.dev';

// A hook runs under a 5 s timeout; its calls stop by this point, so a slow server never kills one.
export const HOOK_BUDGET_MS = 4500;

export const connectionOf = (env = process.env) => {
  const key = env.CLAUDE_PLUGIN_OPTION_KEY || env.PROGRAM_CLERK_KEY || '';
  if (!key) return null;
  return {base: (env.PROGRAM_CLERK_URL || DEFAULT_URL).replace(/\/+$/, ''), key};
};

// `hostname -s`: the house hooks that stay in Bash compare holders by this name.
export const shortHost = () => hostname().split('.')[0];

export const holderOf = sessionId => `${shortHost()}/${sessionId.slice(0, 8)}`;

export const cacheDir = (env = process.env) =>
  join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'program-clerk');

export const stateDir = (env = process.env) =>
  join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'program-clerk');

export const hashOf = text => createHash('sha1').update(text).digest('hex');

export const fileSafe = text => text.replace(/[^A-Za-z0-9._-]/g, '_');

export const readPayload = () => {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
};

export const SESSION_ID = /^[A-Za-z0-9_-]+$/;

export const contextFor = (event, text) =>
  JSON.stringify({hookSpecificOutput: {hookEventName: event, additionalContext: text}});

export const readText = file => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

export const secondsNow = () => Math.floor(Date.now() / 1000);
