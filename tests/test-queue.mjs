// A project's queue as `/pickup` reads it, and the filing of a new GitHub thread on it.

import test from 'tape-six';
import {
  fileItem,
  githubRefs,
  itemsFrom,
  owedFrom,
  queueOf,
  readTrackers
} from '../plugins/program-clerk/scripts/lib/queue.mjs';

const note = (slug, frontmatter) => ({
  path: `projects/p/queue/${slug}.md`,
  title: slug,
  frontmatter
});

/** An API holding the notes of `projects/p/queue/`, recording each write. */
const fakeApi = (notes, {queue = true} = {}) => {
  const writes = [];
  const api = async (path, {method = 'GET', body} = {}) => {
    if (method === 'POST' && path === '/notes/query') {
      const items = notes.filter(n => n.path.startsWith(`${body.folder}/`));
      return {status: 200, text: JSON.stringify({items: items.slice(body.offset)})};
    }
    if (method === 'POST' && path === '/resolve') {
      const file_path = queue ? 'projects/p/queue/_about.md' : null;
      return {status: 200, text: JSON.stringify({items: [{file_path}]})};
    }
    if (method === 'PUT') {
      writes.push({path, body});
      return {status: 200, text: '{}'};
    }
    return {status: 404, text: '{}'};
  };
  return {api, writes};
};

test('no declaration: the queue is the primary tracker', t => {
  const view = readTrackers('p', undefined);
  t.equal(view.declared, false);
  t.equal(view.primary.role, 'primary');
  t.deepEqual(view.problems, []);
  t.deepEqual(githubRefs(view), []);
});

test('a declaration read, its problems named, its GitHub repositories listed', t => {
  const view = readTrackers('p', [
    {kind: 'github', ref: 'o/r', intake: 'triage'},
    {kind: 'gitlab', ref: 'x'},
    {kind: 'linear', role: 'mirror', ref: 'ENG'}
  ]);
  t.deepEqual(githubRefs(view), ['o/r']);
  t.equal(view.trackers.find(x => x.kind === 'github').intake, 'triage');
  t.deepEqual(
    [/kind must be one of/, /mirror is called secondary now/, /no tracker is primary/].map(
      (re, k) => re.test(view.problems[k])
    ),
    [true, true, true],
    'its problems named'
  );
  t.equal(view.primary.kind, readTrackers('p', undefined).primary.kind, 'the queue stands in');
  t.deepEqual(readTrackers('p', 'x').problems.slice(0, 1), ['trackers must be a list']);
});

test('the queue in one query: its items, and its declaration from the folder note', async t => {
  const {api} = fakeApi([
    note('_about', {trackers: [{kind: 'github', ref: 'o/r', role: 'secondary'}]}),
    note('b', {title: 'Later.', section: 'backlog', priority: 1}),
    note('a', {title: 'Now.', section: 'active'}),
    note('c', {title: 'Sooner.', section: 'backlog', priority: 3})
  ]);
  const {notes, trackers} = await queueOf(api, 'p');
  t.deepEqual(
    itemsFrom(notes).map(i => i.title),
    ['Now.', 'Sooner.', 'Later.'],
    'by section, then priority'
  );
  t.deepEqual(githubRefs(trackers), ['o/r']);
});

test('what the queue owes: tickets mirrored, the Inbox, and the Backlog filed since', t => {
  const owed = owedFrom(
    [
      note('m', {
        title: 'Mirror.',
        section: 'backlog',
        source: 'github o/r#1',
        filed: '2026-10-01'
      }),
      note('i', {title: 'Inbox.', section: 'inbox'}),
      note('n', {title: 'New.', section: 'backlog', filed: '2026-11-02'}),
      note('o', {title: 'Old.', section: 'backlog', filed: '2026-10-30'}),
      note('s', {
        title: 'Loop stalls recorded through today',
        section: 'backlog',
        filed: '2026-11-03'
      })
    ],
    '2026-11-01T12:00:00Z'
  );
  t.deepEqual(
    owed.map(o => [o.kind, o.title]),
    [
      ['upstream', 'Mirror.'],
      ['triage', 'Inbox.'],
      ['place', 'New.']
    ]
  );
  t.deepEqual(owedFrom([note('n', {section: 'backlog', filed: '2026-11-02'})], null), []);
});

test('filing: a new item gets the next sequence and a slug, the same source replaces its item', async t => {
  const {api, writes} = fakeApi([note('one', {title: 'One.', section: 'active', sequence_key: 4})]);
  const made = await fileItem(api, 'p', {
    title: 'GitHub: o/r #7 Fix.',
    section: 'inbox',
    source: 'github o/r#7',
    body: 'issue.new #7'
  });
  t.deepEqual(made, {path: 'projects/p/queue/github-o-r-7-fix.md', replaced: false});
  t.equal(writes[0].path, '/vault/projects/p/queue/github-o-r-7-fix.md');
  t.match(writes[0].body.frontmatter, {
    title: 'GitHub: o/r #7 Fix.',
    type: 'queue-item',
    section: 'inbox',
    sequence_key: 5,
    source: 'github o/r#7'
  });
  t.equal(writes[0].body.body, 'issue.new #7\n');

  const again = fakeApi([
    note('old', {
      title: 'Old title.',
      section: 'active',
      sequence_key: 2,
      source: 'github o/r#7',
      filed: '2026-10-01'
    })
  ]);
  const replaced = await fileItem(again.api, 'p', {
    title: 'GitHub: o/r #7 Renamed.',
    section: 'active',
    source: 'github o/r#7',
    body: 'issue.new #7'
  });
  t.deepEqual(replaced, {path: 'projects/p/queue/old.md', replaced: true});
  t.match(again.writes[0].body.frontmatter, {sequence_key: 2, filed: '2026-10-01'});
});

test('filing starts a queue where there is none, and refuses what is not an item', async t => {
  const {api, writes} = fakeApi([], {queue: false});
  await fileItem(api, 'p', {title: 'First.', body: 'b'});
  t.deepEqual(
    writes.map(w => w.path),
    [
      '/vault/projects/p/queue/_about.md',
      '/vault/projects/p/queue-archive/_about.md',
      '/vault/projects/p/queue/first.md'
    ]
  );
  await t.rejects(fileItem(api, 'p', {title: 'x', body: 'b', section: 'later'}), RangeError);
  await t.rejects(fileItem(api, 'p', {title: 'x', body: ' '}), TypeError);
  await t.rejects(fileItem(api, 'p', {title: 'x', body: 'b', source: 'github o/r'}), RangeError);
});
