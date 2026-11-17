// A checkout's state (git, and npm for a public package) against the baseline in the project's
// `state.md`: commits, tags, and publishes since it, the branch against its upstream, the working
// tree, and git tags against npm's versions.

import {execFile} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const REGISTRY = 'https://registry.npmjs.org';
const RECONCILE_WINDOW = 10;
const RECONCILE_SHOWN = 6;
const COMMITS_SHOWN = 10;
const FILES_CHARS = 200;

export const gitIn = top => args =>
  new Promise(resolve => {
    execFile(
      'git',
      ['-C', top, ...args],
      {encoding: 'utf8', maxBuffer: 1 << 24, timeout: 15_000, windowsHide: true},
      (err, stdout) => resolve(err ? null : stdout.replace(/\r?\n$/, ''))
    );
  });

const linesOf = text => (text ? text.split(/\r?\n/).filter(line => line.length > 0) : []);

/** The JSON block of a baseline note; null when it has none or it does not parse. */
export const baselineOf = markdown => {
  const lines = markdown.split(/\r?\n/);
  const start = lines.indexOf('```json');
  if (start < 0) return null;
  const end = lines.indexOf('```', start + 1);
  try {
    return JSON.parse(lines.slice(start + 1, end < 0 ? undefined : end).join('\n'));
  } catch {
    return null;
  }
};

const npmNameOf = top => {
  const file = join(top, 'package.json');
  if (!existsSync(file)) return '';
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    return manifest.private === true ? '' : (manifest.name ?? '');
  } catch {
    return '';
  }
};

/** A package's published versions in publish order; [] when the registry has none or no answer. */
export const npmVersions = async (name, fetchImpl = fetch) => {
  try {
    const response = await fetchImpl(`${REGISTRY}/${name.replace('/', '%2F')}`, {
      headers: {accept: 'application/vnd.npm.install-v1+json'},
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return [];
    return Object.keys((await response.json()).versions ?? {});
  } catch {
    return [];
  }
};

const statusOf = porcelain => {
  const tree = {modified: [], staged: [], untracked: []};
  for (const line of linesOf(porcelain)) {
    const [x, y, path] = [line[0], line[1], line.slice(3)];
    if (x === '?' && y === '?') tree.untracked.push(path);
    if (x === 'M' || y === 'M') tree.modified.push(path);
    if ('ADR'.includes(x) || (x === ' ' && y === 'D')) tree.staged.push(path);
  }
  return tree;
};

const upstreamCounts = async git => {
  if ((await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])) === null) {
    return {ahead: 0, behind: 0};
  }
  return {
    ahead: Number(await git(['rev-list', '--count', '@{u}..HEAD'])) || 0,
    behind: Number(await git(['rev-list', '--count', 'HEAD..@{u}'])) || 0
  };
};

/** The checkout as a baseline records it, with what the report needs beside it. */
export const currentOf = async ({top, project, now = new Date(), versionsOf = npmVersions}) => {
  const git = gitIn(top);
  const npmName = npmNameOf(top);
  const [remote, head, subject, date, branch, tags, status, stashes, submodules, counts, versions] =
    await Promise.all([
      git(['config', '--get', 'remote.origin.url']),
      git(['rev-parse', 'HEAD']),
      git(['log', '-1', '--format=%s']),
      git(['log', '-1', '--format=%cs']),
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['tag', '-l', '--sort=-creatordate']),
      git(['status', '--porcelain']),
      git(['stash', 'list']),
      existsSync(join(top, '.gitmodules')) ? git(['submodule', 'status']) : '',
      upstreamCounts(git),
      npmName ? versionsOf(npmName) : []
    ]);
  const unpushed =
    counts.ahead > 0 ? linesOf(await git(['log', '@{u}..HEAD', '--format=%h %s'])) : [];
  const subs = {};
  for (const line of linesOf(submodules ?? '')) {
    const [sha, name] = line.trim().split(/\s+/);
    subs[name] = {head: sha.replace(/^[-+]/, '')};
  }
  return {
    snapshot: {
      project,
      last_checked: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      repo: {
        remote: remote ?? '',
        branch: branch ?? '',
        head: {sha: head ?? '', subject: subject ?? '', date: date ?? ''},
        tags: linesOf(tags)
      },
      submodules: subs,
      publishable: {
        npm: npmName ? {name: npmName, latest: versions.at(-1) ?? null, versions} : null
      }
    },
    ...counts,
    unpushed,
    tree: statusOf(status),
    stashes: linesOf(stashes).length
  };
};

const versionKey = v => v.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : -1));

const byVersion = (a, b) => {
  const [ka, kb] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(ka.length, kb.length); ++i) {
    const d = (ka[i] ?? -Infinity) - (kb[i] ?? -Infinity);
    if (d !== 0) return d;
  }
  return 0;
};

/**
 * The tags and npm versions of the latest releases that do not match: one window over both lists,
 * since two lists cut apart misalign where one side has a gap.
 */
export const reconcileLines = (tags, versions) => {
  if (versions.length === 0) return [];
  const releases = tags.filter(tag => /^\d+\.\d+\.\d+/.test(tag));
  const window = [...new Set([...releases, ...versions])]
    .sort(byVersion)
    .reverse()
    .slice(0, RECONCILE_WINDOW);
  const lines = [];
  for (const v of window) {
    if (!versions.includes(v)) lines.push(`tag ${v}: no matching npm publish`);
    else if (!releases.includes(v)) lines.push(`npm ${v}: no matching git tag`);
  }
  if (lines.length <= RECONCILE_SHOWN) return lines;
  const more = lines.length - RECONCILE_SHOWN;
  return [...lines.slice(0, RECONCILE_SHOWN), `(+${more} more; compare git tag with npm view)`];
};

const driftLines = async (git, baseline, snapshot) => {
  if (baseline === null) return ['(no baseline recorded yet)'];
  const lines = [];
  const oldHead = baseline.repo?.head?.sha ?? '';
  const newHead = snapshot.repo.head.sha;
  if (oldHead && oldHead !== newHead) {
    const commits = linesOf(await git(['log', `${oldHead}..HEAD`, '--oneline'])).slice(
      0,
      COMMITS_SHOWN
    );
    if (commits.length > 0) lines.push(...commits.map(line => `commit: ${line}`));
    else {
      lines.push(
        `HEAD moved ${oldHead.slice(0, 7)} → ${newHead.slice(0, 7)} (no forward history; a rebase or a reset?)`
      );
    }
  }
  const oldTags = new Set(baseline.repo?.tags ?? []);
  for (const tag of snapshot.repo.tags) if (!oldTags.has(tag)) lines.push(`tag: +${tag}`);
  const oldVersions = new Set(baseline.publishable?.npm?.versions ?? []);
  for (const v of snapshot.publishable.npm?.versions ?? []) {
    if (!oldVersions.has(v)) lines.push(`npm: +${v} published`);
  }
  for (const [name, {head}] of Object.entries(snapshot.submodules)) {
    const old = baseline.submodules?.[name]?.head;
    if (old && head && old !== head) {
      lines.push(`submodule ${name}: ${old.slice(0, 7)} → ${head.slice(0, 7)}`);
    }
  }
  return lines;
};

const syncLines = async (top, current) => {
  const lines = [];
  const {ahead, behind} = current;
  if (ahead > 0 || behind > 0) {
    lines.push(`${current.snapshot.repo.branch}: ${ahead} ahead, ${behind} behind upstream`);
    lines.push(...current.unpushed.map(c => `  unpushed: ${c}`));
  }
  if (!existsSync(join(top, '.gitmodules'))) return lines;
  const paths = linesOf(
    await gitIn(top)(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])
  ).map(line => line.split(/\s+/)[1]);
  for (const sub of paths) {
    const counts = await upstreamCounts(gitIn(join(top, sub)));
    if (counts.ahead > 0 || counts.behind > 0) {
      lines.push(`${sub}: ${counts.ahead} ahead, ${counts.behind} behind upstream`);
    }
  }
  return lines;
};

const treeLines = ({tree, stashes}) => {
  const lines = [];
  for (const [what, files] of Object.entries(tree)) {
    if (files.length > 0) {
      lines.push(`${what} (${files.length}): ${files.join(', ').slice(0, FILES_CHARS)}`);
    }
  }
  if (stashes > 0) lines.push(`stash entries: ${stashes}`);
  return lines;
};

const section = (title, lines) =>
  lines.length === 0 ? [] : [`${title}:`, ...lines.map(line => `  ${line}`)];

/**
 * The report on a checkout against its baseline note's text (null when there is none): `drifted`
 * when it has anything to say, and `report`, its text.
 */
export const driftReport = async ({top, project, baselineText, now, versionsOf}) => {
  const current = await currentOf({top, project, now, versionsOf});
  const baseline = baselineText === null ? null : baselineOf(baselineText);
  const {snapshot} = current;
  const report = [
    ...section('DRIFT since last baseline', await driftLines(gitIn(top), baseline, snapshot)),
    ...section('LOCAL vs REMOTE', await syncLines(top, current)),
    ...section('WORKING TREE', treeLines(current)),
    ...section(
      'RECONCILE tags ↔ npm',
      reconcileLines(snapshot.repo.tags, snapshot.publishable.npm?.versions ?? [])
    )
  ];
  if (report.length > 0) return {drifted: true, report: report.join('\n'), snapshot};
  return {
    drifted: false,
    report: `project "${project}": matches its baseline; tree clean; last checked ${snapshot.last_checked}`,
    snapshot
  };
};

/** The state note a checkout's baseline is kept in, as the API writes a note. */
export const baselineNote = (project, snapshot) => ({
  frontmatter: {
    title: `${project} — state snapshot`,
    type: 'state',
    tags: ['state', 'snapshot', project]
  },
  body: `The checkout's state when a session last ended with \`/wrap\`, which writes this note; \`/pickup\` reports what moved since.\n\n## Baseline snapshot\n\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n`
});

/** Records the checkout's state now as the project's baseline; answers the write's answer. */
export const refreshBaseline = async ({api, top, project, now, versionsOf}) => {
  const {snapshot} = await currentOf({top, project, now, versionsOf});
  return api(`/vault/projects/${project}/state.md`, {
    method: 'PUT',
    body: baselineNote(project, snapshot)
  });
};
