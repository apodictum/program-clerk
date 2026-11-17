// A project's queue as `/pickup` reads it, the filing of a new GitHub thread on it, and the `queue`
// skill's commands.

import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import test from 'tape-six';
import {
  archiveItem,
  fileItem,
  githubRefs,
  itemsFrom,
  listAll,
  listItems,
  moveItem,
  owedFrom,
  queueOf,
  readTrackers,
  trackerLine
} from '../plugins/program-clerk/scripts/lib/queue.mjs';
import {run} from '../plugins/program-clerk/scripts/lib/queue-cli.mjs';
import {fakeServer, removeAll, scratch} from './helpers.mjs';

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

/** An API over a few projects' queue notes, with the item writes the commands make. */
const queueApi = () => {
  const notes = [
    {
      path: 'projects/p/queue/_about.md',
      title: 'p — Queue',
      frontmatter: {
        type: 'meta',
        trackers: [
          {kind: 'vault', role: 'primary'},
          {kind: 'github', ref: 'o/r', intake: 'triage'}
        ]
      }
    },
    {...note('a', {title: 'A.', section: 'backlog', sequence_key: 1}), record_id: 'ra'},
    {...note('b', {title: 'B.', section: 'active', sequence_key: 2, priority: 1}), record_id: 'rb'},
    {
      path: 'projects/q/queue/c.md',
      title: 'c',
      record_id: 'rc',
      frontmatter: {title: 'C.', section: 'inbox', sequence_key: 1}
    },
    {
      path: 'projects/p/queue-archive/old.md',
      title: 'old',
      frontmatter: {title: 'Old.', status: 'archived', sequence_key: 7}
    }
  ];
  const calls = [];
  const api = async (path, {method = 'GET', body} = {}) => {
    calls.push({method, path, body});
    if (method === 'GET' && path === '/vault/projects/') {
      return {status: 200, text: JSON.stringify({files: ['_about.md', 'p/', 'q/', 'r/']})};
    }
    if (method === 'POST' && path === '/resolve') {
      const items = body.wikilinks.map(w => ({
        file_path:
          w === 'projects/r/queue.md'
            ? 'projects/r/queue.md'
            : w.replace('queue.md', 'queue/_about.md')
      }));
      return {status: 200, text: JSON.stringify({items})};
    }
    if (method === 'POST' && path === '/notes/query') {
      const items = notes.filter(
        n =>
          n.path.startsWith(`${body.folder}/`) &&
          Object.entries(body.match ?? {}).every(([k, v]) => n.frontmatter[k] === v)
      );
      return {status: 200, text: JSON.stringify({items: items.slice(body.offset)})};
    }
    return {status: 200, text: '{}'};
  };
  return {api, calls};
};

test('listing: one project in order, a section alone, and every project with a queue folder', async t => {
  const {api} = queueApi();
  t.deepEqual(
    (await listItems(api, 'p')).map(i => i.title),
    ['B.', 'A.']
  );
  t.deepEqual(
    (await listItems(api, 'p', {section: 'backlog'})).map(i => i.title),
    ['A.']
  );
  const all = await listAll(api);
  t.deepEqual(
    all.map(i => `${i.project} ${i.title}`),
    ['q C.', 'p B.', 'p A.'],
    'r has one queue note, which is not a folder, so it is left out'
  );
  t.deepEqual(
    (await listAll(api, {section: 'active'})).map(i => i.title),
    ['B.']
  );
  t.deepEqual(
    (await listAll(api, {priority: 0, limit: 1})).map(i => i.title),
    ['C.']
  );
});

test('moving sets the section and the priority; archiving trails, closes, and moves the note', async t => {
  const {api, calls} = queueApi();
  t.deepEqual(await moveItem(api, 'p', 'A.', {section: 'active', priority: 2}), {
    path: 'projects/p/queue/a.md',
    section: 'active'
  });
  t.deepEqual(calls.at(-1), {
    method: 'PATCH',
    path: '/sections/ra/fm',
    body: {
      ops: [
        {op: 'set', path: '/section', value: 'active'},
        {op: 'set', path: '/priority', value: 2}
      ]
    }
  });
  await moveItem(api, 'p', 'b', {section: 'backlog', priority: 0});
  t.deepEqual(calls.at(-1).body.ops[1], {op: 'remove', path: '/priority'});
  await t.rejects(moveItem(api, 'p', 'A.', {section: 'later'}), RangeError);
  await t.rejects(moveItem(api, 'p', 'Nothing.', {section: 'active'}), /0 open items of p match/);

  calls.length = 0;
  const day = new Date().toISOString().slice(0, 10);
  t.deepEqual(await archiveItem(api, 'p', 'A.', {reason: 'shipped', trail: 'abc1234.'}), {
    path: 'projects/p/queue-archive/a.md'
  });
  const writes = calls.filter(c => c.method !== 'GET' && c.path !== '/notes/query');
  t.deepEqual(writes[0], {
    method: 'POST',
    path: '/vault/edit',
    body: {path: 'projects/p/queue/a.md', op: 'append', text: `**Shipped** ${day}. abc1234.\n`}
  });
  t.deepEqual(writes[1].body.ops, [
    {op: 'set', path: '/status', value: 'archived'},
    {op: 'set', path: '/closed_at', value: day},
    {op: 'set', path: '/close_reason', value: 'shipped'},
    {op: 'remove', path: '/section'},
    {op: 'set', path: '/sequence_key', value: 8}
  ]);
  t.deepEqual(writes[2], {
    method: 'POST',
    path: '/vault/move',
    body: {from: 'projects/p/queue/a.md', to: 'projects/p/queue-archive/a.md'}
  });
  await t.rejects(archiveItem(api, 'p', 'A.', {reason: 'done'}), RangeError);
});

test('the tracker line names the queue, the primary, and each secondary with its intake', t => {
  t.equal(trackerLine(readTrackers('p', undefined)), 'queue');
  t.equal(
    trackerLine(
      readTrackers('p', [
        {kind: 'vault', role: 'primary'},
        {kind: 'github', ref: 'o/r', intake: 'triage'},
        {kind: 'linear', ref: 'ENG'}
      ])
    ),
    'queue (primary); secondary: github o/r (triage), linear ENG'
  );
  t.equal(trackerLine(readTrackers('p', [{kind: 'jira', ref: 'VS', role: 'primary'}])), 'jira VS');
});

test('the script: each command through the API with the key, its output, and no key refused', async t => {
  const dir = scratch();
  const server = await fakeServer({
    'POST /notes/query': ({json}) => ({
      body: {
        items:
          json.folder === 'projects/p/queue' && !json.match
            ? [
                {...note('a', {title: 'A.', section: 'backlog', sequence_key: 1}), record_id: 'ra'},
                {
                  path: 'projects/p/queue/_about.md',
                  title: 'about',
                  frontmatter: {type: 'meta', trackers: [{kind: 'linear', ref: 'ENG'}]}
                }
              ]
            : []
      }
    }),
    'POST /resolve': {body: {items: [{file_path: 'projects/p/queue/_about.md'}]}},
    'PUT /vault/projects/p/queue/new-one.md': {body: {}},
    'PATCH /sections/ra/fm': {body: {}}
  });
  const env = {
    PROGRAM_CLERK_URL: server.base,
    PROGRAM_CLERK_KEY: 'test-key',
    XDG_CACHE_HOME: join(dir, 'cache')
  };
  try {
    const lines = [];
    const queue = argv => run(argv, {env, out: line => lines.push(line)});
    await queue(['list', 'p']);
    t.deepEqual(lines, ['backlog\t0\tA.', '1 items']);
    lines.length = 0;
    const body = join(dir, 'body.txt');
    writeFileSync(body, 'Why it waits.\n');
    await queue(['file', 'p', '--title', 'New one.', '--body-file', body]);
    t.deepEqual(JSON.parse(lines[0]), {path: 'projects/p/queue/new-one.md', replaced: false});
    const put = server.requests.find(r => r.method === 'PUT');
    t.match(put.json, {
      frontmatter: {title: 'New one.', section: 'backlog'},
      body: 'Why it waits.\n'
    });
    t.equal(put.auth, 'Bearer test-key');
    lines.length = 0;
    await queue(['move', 'p', 'a', '--section', 'active']);
    t.deepEqual(JSON.parse(lines[0]), {path: 'projects/p/queue/a.md', section: 'active'});
    lines.length = 0;
    await queue(['trackers', 'p']);
    t.deepEqual(lines, [
      'queue (primary); secondary: linear ENG',
      'problem: no tracker is primary; the queue is'
    ]);
    await t.rejects(queue(['list']), /usage/);
    await t.rejects(
      queue(['move', 'p', 'a', '--section', 'active', '--priority', 'high']),
      /whole number/
    );
    await t.rejects(run(['list', 'p'], {env: {...env, PROGRAM_CLERK_KEY: ''}}), /no key/);
  } finally {
    await server.close();
    removeAll(dir);
  }
});
