// A checkout against its baseline: what moved since, the branch against its upstream, the working
// tree, and git tags against npm's versions.

import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'tape-six';
import {
  baselineNote,
  baselineOf,
  currentOf,
  driftReport,
  reconcileLines,
  refreshBaseline
} from '../plugins/program-clerk/scripts/lib/drift.mjs';
import {git, makeRepo, removeAll, scratch} from './helpers.mjs';

const noVersions = async () => [];
const noteOf = snapshot =>
  `---\ntitle: p\n---\n\n## Baseline snapshot\n\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n`;

test('a baseline note: its JSON block, or null', t => {
  t.deepEqual(baselineOf(noteOf({a: 1})), {a: 1});
  t.equal(baselineOf('no block'), null);
  t.equal(baselineOf('```json\n{bad\n```\n'), null);
});

test('a refreshed baseline is the checkout now, in a note its reader parses, with no other section', async t => {
  const dir = scratch();
  try {
    const top = makeRepo(join(dir, 'r'));
    const writes = [];
    const api = async (path, {method, body}) => {
      writes.push({path, method, body});
      return {status: 200, text: '{}'};
    };
    const answer = await refreshBaseline({api, top, project: 'p', versionsOf: noVersions});
    t.equal(answer.status, 200);
    t.equal(writes.length, 1);
    t.match(writes[0], {path: '/vault/projects/p/state.md', method: 'PUT'});
    t.deepEqual(writes[0].body.frontmatter, {
      title: 'p — state snapshot',
      type: 'state',
      tags: ['state', 'snapshot', 'p']
    });
    const {snapshot} = await currentOf({top, project: 'p', versionsOf: noVersions});
    t.deepEqual(baselineOf(writes[0].body.body).repo, snapshot.repo);
    t.deepEqual(writes[0].body.body.match(/^## .*/gm), ['## Baseline snapshot']);
    t.ok(baselineNote('p', {a: 1}).body.includes('```json\n{\n  "a": 1\n}\n```'));
  } finally {
    removeAll(dir);
  }
});

test('a checkout that matches its baseline says so; one with no baseline drifts', async t => {
  const dir = scratch();
  try {
    const top = makeRepo(join(dir, 'r'));
    const {snapshot} = await currentOf({top, project: 'p', versionsOf: noVersions});
    const clean = await driftReport({
      top,
      project: 'p',
      baselineText: noteOf(snapshot),
      versionsOf: noVersions
    });
    t.equal(clean.drifted, false);
    t.matchString(clean.report, /^project "p": matches its baseline; tree clean; last checked /);
    const none = await driftReport({top, project: 'p', baselineText: null, versionsOf: noVersions});
    t.equal(none.report, 'DRIFT since last baseline:\n  (no baseline recorded yet)');
  } finally {
    removeAll(dir);
  }
});

test('commits, a tag, a publish, and the working tree since the baseline', async t => {
  const dir = scratch();
  try {
    const top = makeRepo(join(dir, 'r'));
    const {snapshot} = await currentOf({top, project: 'p', versionsOf: noVersions});
    git(top, 'commit', '-q', '--allow-empty', '-m', 'second');
    git(top, 'tag', '1.0.0');
    writeFileSync(join(top, 'new.txt'), 'x');
    writeFileSync(join(top, 'package.json'), '{"name": "zz-pkg"}');
    const {drifted, report} = await driftReport({
      top,
      project: 'p',
      baselineText: noteOf(snapshot),
      versionsOf: async name => (name === 'zz-pkg' ? ['0.9.0', '1.0.0', '1.1.0'] : [])
    });
    t.equal(drifted, true);
    const lines = report.split(/\r?\n/);
    t.equal(lines[0], 'DRIFT since last baseline:');
    t.matchString(lines[1], /^ {2}commit: [0-9a-f]+ second$/);
    t.ok(lines.includes('  tag: +1.0.0'));
    t.ok(lines.includes('  npm: +1.1.0 published'));
    t.ok(lines.includes('WORKING TREE:'));
    t.ok(lines.includes('  untracked (2): new.txt, package.json'));
    t.ok(lines.includes('RECONCILE tags ↔ npm:'));
    t.ok(lines.includes('  npm 1.1.0: no matching git tag'));
  } finally {
    removeAll(dir);
  }
});

test('a rewritten history says HEAD moved with no forward history', async t => {
  const dir = scratch();
  try {
    const top = makeRepo(join(dir, 'r'));
    git(top, 'commit', '-q', '--allow-empty', '-m', 'second');
    const {snapshot} = await currentOf({top, project: 'p', versionsOf: noVersions});
    git(top, 'reset', '-q', '--hard', 'HEAD~1');
    const {report} = await driftReport({
      top,
      project: 'p',
      baselineText: noteOf(snapshot),
      versionsOf: noVersions
    });
    t.matchString(
      report,
      /HEAD moved [0-9a-f]{7} → [0-9a-f]{7} \(no forward history; a rebase or a reset\?\)/
    );
  } finally {
    removeAll(dir);
  }
});

test('tags against npm over one window of the latest releases, capped', t => {
  t.deepEqual(reconcileLines(['1.0.0'], []), [], 'nothing published: nothing to reconcile');
  t.deepEqual(reconcileLines(['1.0.0', '0.9.0', 'v-old'], ['0.9.0', '1.0.0']), []);
  t.deepEqual(reconcileLines(['1.2.0', '1.0.0'], ['1.0.0', '1.1.0', '1.10.0']), [
    'npm 1.10.0: no matching git tag',
    'tag 1.2.0: no matching npm publish',
    'npm 1.1.0: no matching git tag'
  ]);
  const many = Array.from({length: 9}, (_, i) => `2.0.${i}`);
  const lines = reconcileLines([], many);
  t.equal(lines.length, 7);
  t.equal(lines.at(-1), '(+3 more; compare git tag with npm view)');
});
