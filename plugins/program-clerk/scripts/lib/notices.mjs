import {appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {cacheDir, readText} from './common.mjs';
import {call, jsonOf} from './http.mjs';

export const CHECK_EVERY = 60;
const KEEP_FOR_MS = 7 * 24 * 3600 * 1000;

export const ADVICE =
  '[pc] tell the user; a notice with a window means no sweep or long batch inside it.';

/** Each notice not seen yet as [id, line]; times in UTC. */
export const noticeLines = (notices, seen, now = Date.now()) =>
  notices
    .filter(notice => typeof notice?.id === 'string' && !seen.has(notice.id))
    .map(notice => {
      let line = `[pc] notice: ${notice.text}`;
      if (notice.minutes != null) {
        const starts = Date.parse(notice.starts_at);
        const when = String(notice.starts_at).slice(0, 16).replace('T', ' ');
        const minutes = `${notice.minutes} minute${notice.minutes === 1 ? '' : 's'}`;
        line += ` (${starts > now ? 'starts' : 'started'} ${when}Z, for about ${minutes})`;
      }
      return [notice.id, line];
    });

const prune = dir => {
  const cutoff = Date.now() - KEEP_FOR_MS;
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).mtimeMs < cutoff) rmSync(file, {force: true});
    }
  } catch {
    // a week of sessions is only kept tidy, never needed
  }
};

/**
 * The notices this session has not seen, as text, or ''. Outside session start, at most one check a
 * minute.
 */
export const newNotices = async (conn, sessionId, {atStart, deadline, env = process.env}) => {
  const dir = join(cacheDir(env), 'notices');
  const seenFile = join(dir, sessionId);
  const stamp = join(dir, `${sessionId}.checked`);
  const now = Math.floor(Date.now() / 1000);
  if (!atStart && now - (Number(readText(stamp).trim()) || 0) < CHECK_EVERY) return '';
  try {
    mkdirSync(dir, {recursive: true});
    writeFileSync(stamp, String(now));
  } catch {
    return '';
  }
  prune(dir);
  const answer = await call(conn, '/system/notices', {deadline, env});
  const notices = answer?.status === 200 ? jsonOf(answer.text)?.notices : undefined;
  if (!Array.isArray(notices)) return '';
  const seen = new Set(readText(seenFile).split(/\r?\n/).filter(Boolean));
  const fresh = noticeLines(notices, seen);
  if (!fresh.length) return '';
  try {
    appendFileSync(seenFile, fresh.map(([id]) => id + '\n').join(''));
  } catch {
    // said again next time
  }
  return [...fresh.map(([, line]) => line), ADVICE].join('\n');
};
