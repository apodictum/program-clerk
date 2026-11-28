// The digest `/pickup` prints, from what its run gathered.

import test from 'tape-six';
import {
  deletionsOf,
  digestOf,
  intakeOf,
  lastMessageOf,
  owedOf,
  sectionOf,
  threadLines,
  threadsToFile
} from '../plugins/program-clerk/scripts/lib/digest.mjs';

const project = (extra = {}) => ({
  found: true,
  name: 'p',
  logs: [
    {
      title: 'p: did a thing (2026-11-02)',
      summary: 'Did the thing.',
      at: '2026-11-02T10:00:00Z',
      data_path: 'projects/p/data/sessions/logs/x.markdown'
    }
  ],
  sessions: {unlogged: []},
  notices: [],
  changes: null,
  files: {stack: null, decisions: null, learnings: null},
  trackers: {primary: {kind: 'vault'}, trackers: [], problems: []},
  ...extra
});

const inputs = (extra = {}) => ({
  project: 'p',
  bundle: {project: project()},
  items: [],
  owed: [],
  plans: [],
  logBody: null,
  lastMessage: null,
  drift: {drifted: false, report: 'clean'},
  github: null,
  ...extra
});

const headings = text => text.split(/\r?\n/).filter(line => line.startsWith('## '));

test('a section is the text under its heading, to the next one, whatever its case', t => {
  const body = '# T\n\n## Done\n\nA.\n\n## Open\n\n- One.\n- Two.\n\n## Key files\n\nB.\n';
  t.equal(sectionOf(body, 'open'), '- One.\n- Two.');
  t.equal(sectionOf(body, 'next'), null);
  t.equal(sectionOf('## Open\n\n', 'open'), null, 'an empty section is none');
  t.equal(sectionOf('## Open\nLast.', 'open'), 'Last.', 'the last section runs to the end');
});

test('the last message is the newest assistant text, cut from its end', t => {
  const row = (type, content) => JSON.stringify({type, message: {content}});
  const jsonl = [
    'half a line from the tail cut',
    row('assistant', [{type: 'text', text: 'Earlier.'}]),
    row('assistant', [{type: 'text', text: 'The end.'}, {type: 'tool_use'}]),
    row('assistant', [{type: 'tool_use'}]),
    row('user', [{type: 'text', text: 'From him.'}]),
    ''
  ].join('\n');
  t.equal(lastMessageOf(jsonl), 'The end.');
  t.equal(lastMessageOf(row('user', [{type: 'text', text: 'x'}])), null);
  const long = row('assistant', [{type: 'text', text: `${'a'.repeat(2000)}Z`}]);
  t.equal(lastMessageOf(long).length, 1500);
  t.ok(lastMessageOf(long).endsWith('Z'), 'an open question ends a message, so the end stays');
});

test('a farewell gives way to the last substantial message, and stands when it is all there is', t => {
  const row = text =>
    JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text}]}});
  const reply = `${'a'.repeat(200)} Which one?`;
  t.equal(lastMessageOf([row(reply), row('Bye for now.')].join('\n')), reply);
  t.equal(lastMessageOf(row('Bye for now.')), 'Bye for now.');
});

test('open threads are meta only, newest first, closed ones and CVE-assigned advisories out', t => {
  const lines = threadLines({
    items: {
      1: {
        is_pr: true,
        title: 'A PR',
        state: 'open',
        author: 'ann',
        comments: 2,
        updated_at: '2026-11-02T00:00:00Z',
        body: 'never shown'
      },
      2: {is_pr: false, title: 'Closed', state: 'closed', author: 'x'},
      3: {
        is_pr: false,
        title: 'An issue',
        state: 'open',
        author: 'dep',
        bot: true,
        comments: 0,
        updated_at: '2026-11-01T00:00:00Z'
      }
    },
    discussions: {
      4: {
        title: 'A question',
        closed: false,
        author: 'bob',
        category: 'Q&A',
        updated_at: '2026-11-03T00:00:00Z',
        excerpt: 'never shown'
      },
      5: {title: 'Done', closed: true}
    },
    advisories: {
      'GHSA-a': {cve_id: null, summary: 'Bad', severity: 'high', state: 'draft'},
      'GHSA-b': {cve_id: 'CVE-1', summary: 'Known', severity: 'low', state: 'published'}
    }
  });
  t.deepEqual(lines, [
    'discussion #4 "A question", by bob, Q&A, updated 2026-11-03',
    'PR #1 "A PR", by ann, 2 comments, updated 2026-11-02',
    'issue #3 "An issue", by dep (bot), 0 comments, updated 2026-11-01',
    'advisory GHSA-a "Bad", high, draft, no CVE'
  ]);
  t.deepEqual(threadLines({}), []);
});

test('a new thread lands where the tracker says', t => {
  t.equal(intakeOf({trackers: []}), 'active', 'no declaration reflects');
  const github = extra => ({trackers: [{kind: 'github', role: 'secondary', ...extra}]});
  t.equal(intakeOf(github({intake: 'reflect'})), 'active');
  t.equal(intakeOf(github({intake: 'triage'})), 'inbox');
  t.equal(intakeOf(github({intake: 'none'})), null);
  t.equal(intakeOf(github({role: 'primary', intake: 'reflect'})), null);
});

test('a person’s new thread and a CVE, with no mirroring item, are filed', t => {
  const events = [
    {kind: 'issue.new', repo: 'o/r', number: 1, title: 'New', url: 'u'},
    {kind: 'pr.new', repo: 'o/r', number: 2, title: 'Bot', bot: true},
    {kind: 'pr.new', repo: 'o/r', number: 3, title: 'Mirrored'},
    {kind: 'discussion.new', repo: 'o/r', number: 4, title: 'Talk'},
    {kind: 'advisory.new', repo: 'o/r', id: 'GHSA-x', summary: 'Hole'},
    {
      kind: 'advisory.cve_assigned',
      repo: 'o/r',
      id: 'GHSA-y',
      summary: 'Known',
      cve_id: 'CVE-1',
      html_url: 'h'
    },
    {kind: 'advisory.cve_assigned', repo: 'o/r', id: 'GHSA-z', summary: 'Open', cve_id: 'CVE-2'},
    {kind: 'advisory.updated', repo: 'o/r', id: 'GHSA-y', summary: 'Known'},
    {kind: 'pr.comments', repo: 'o/r', number: 3, title: 'Mirrored'}
  ];
  const items = [{source: 'github o/r#3'}, {source: null}, {source: 'github o/r GHSA-z'}];
  t.deepEqual(threadsToFile(events, items), [
    {source: 'github o/r#1', title: 'GitHub: o/r #1 New.', body: 'issue.new #1, u'},
    {source: 'github o/r discussion#4', title: 'GitHub: o/r #4 Talk.', body: 'discussion.new #4'},
    {source: 'github o/r GHSA-x', title: 'GitHub: o/r GHSA-x Hole.', body: 'advisory.new GHSA-x'},
    {
      source: 'github o/r GHSA-y',
      title: 'GitHub: o/r GHSA-y CVE-1 Known.',
      body: 'advisory.cve_assigned GHSA-y CVE-1, h'
    }
  ]);
});

test('a quiet project reads how it finished, and no empty section', t => {
  t.deepEqual(headings(digestOf(inputs())), ['## How we finished']);
  t.ok(digestOf(inputs()).includes('Did the thing.'));
});

test('a project the account does not hold says so', t => {
  const text = digestOf(inputs({bundle: {project: {found: false}}}));
  t.equal(text, '# p\n\nProgram Clerk holds nothing for this project yet.');
});

test("the account's deletion is the digest's last section, whether or not the project is held (apodictum-web D98)", t => {
  const deletions = ['An admin asked to delete this account.'];
  t.ok(
    digestOf(inputs({deletions})).endsWith(
      '\n\n## This account is to be deleted\nAn admin asked to delete this account.'
    ),
    'after every other section'
  );
  t.equal(
    digestOf(inputs({bundle: {project: {found: false}}, deletions})),
    '# p\n\nProgram Clerk holds nothing for this project yet.\n\n## This account is to be deleted\nAn admin asked to delete this account.'
  );
});

test("deletionsOf: the server's deletion notices' texts, none from anything else", t => {
  t.deepEqual(
    deletionsOf([
      {id: 'deletion-2026-12-27T14:00:00Z', text: 'Deleted at noon.'},
      {id: 'storage-near', text: 'Near the limit.'},
      {text: 'No id.'}
    ]),
    ['Deleted at noon.']
  );
  t.deepEqual(deletionsOf(null), []);
  t.deepEqual(deletionsOf({}), []);
});

test('every section the digest owes, in order, from the log, the queue, and GitHub', t => {
  const text = digestOf(
    inputs({
      bundle: {
        project: project({
          notices: [
            {
              file: 'stack',
              type: 'contradicts',
              by: {title: 'A note', file_path: 'projects/p/n.md'}
            }
          ],
          changes: {
            since: {ended: 'x'},
            more: 2,
            notes: [
              {path: 'a', title: 'Made one', changed: {created: true}},
              {path: 'b', title: 'Edited one', changed: {body: true}},
              {path: 'c', title: 'Summary only', changed: {body: false, agent: true}},
              {path: 'd', title: 'Unknown one', changed: null}
            ]
          },
          files: {
            stack: {summary: 'Node.', summary_stale: false},
            decisions: {summary: 'D1 to D9.', summary_stale: true},
            learnings: null
          }
        })
      },
      items: [
        {title: 'Doing.', section: 'active'},
        ...Array.from({length: 12}, (_, i) => ({title: `Later ${i}.`, section: 'backlog'})),
        {title: 'Seen.', section: 'watching'}
      ],
      owed: [
        {kind: 'handoff', target: 'h', why: 'a run-check from x'},
        {kind: 'place', target: 's', why: 'Fresh item.'},
        {kind: 'read', target: 'projects/p/decisions.md', why: 'its summary predates its body'}
      ],
      plans: ['projects/p/plans/order'],
      logBody: '## Open\n\n- Is X right?\n\n## Next\n\nBuild Y.\n',
      drift: {drifted: true, report: 'two new commits'},
      github: {
        repo: 'o/r',
        snapshot: {
          ci: {conclusion: 'success', pull_request: {number: 6, merged_at: '2026-11-15T10:00:00Z'}},
          items: {7: {is_pr: true, title: 'Fix', state: 'open', author: 'ann', updated_at: 'x'}}
        },
        brief: 'new PR #7',
        filed: ['GitHub: o/r #7 Fix']
      }
    })
  );
  t.deepEqual(headings(text), [
    '## How we finished',
    '## Upcoming',
    '## Open',
    '## Outside',
    '## Changed since the last session'
  ]);
  for (const expected of [
    'Next, from the last log:\nBuild Y.',
    '- Doing.',
    'Plan: projects/p/plans/order\nBacklog: 12 items, the plan orders them.',
    'New in the Backlog since the last session:\n- Fresh item.',
    'Watching: 1 items',
    'From the last log:\n- Is X right?',
    '- A handoff waiting: a run-check from x',
    '- A note contradicts stack',
    'Drift:\ntwo new commits',
    'GitHub o/r: CI success, PR #6 merged 2026-11-15.',
    'Since the last look:\nnew PR #7',
    'Filed on the queue:\n- GitHub: o/r #7 Fix',
    '- PR #7 "Fix", by ann, 0 comments',
    '- Made one (made)',
    '- Edited one (edited)',
    '- Unknown one (written, what changed unknown)',
    "- and 2 more past the server's cap"
  ]) {
    t.ok(text.includes(expected), `missing: ${expected}`);
  }
  t.ok(!text.includes('Summary only'), 'a restated summary is no change');
  t.ok(!text.includes('Node.'), 'what the notes hold is read when the work needs it');
  t.ok(!text.includes('D1 to D9.'));
});

test('an owed line says its label once, and a new Backlog item reads as its title', t => {
  const owed = owedOf(
    {
      project: {
        name: 'p',
        handoffs: {open: [], returned: []},
        trackers: {problems: ['an unknown kind: gitlab']}
      },
      stalls: {count: 3, latestAt: 'a'}
    },
    [
      {kind: 'upstream', title: 'Mirror.', source: 'github o/p#1', path: 'projects/p/queue/m.md'},
      {kind: 'triage', title: 'New.', path: 'projects/p/queue/new.md'},
      {kind: 'place', title: 'Late.', filed: '2026-11-01', path: 'projects/p/queue/late.md'}
    ]
  );
  const text = digestOf(inputs({owed}));
  for (const expected of [
    '\n- Mirrors a ticket: github o/p#1: Mirror.\n',
    '\n- In the Inbox: New.\n',
    '\n- Trackers malformed: an unknown kind: gitlab',
    'New in the Backlog since the last session:\n- Late.\n'
  ]) {
    t.ok(text.includes(expected), `missing: ${expected}`);
  }
  t.ok(!text.includes('stalls'), "the server's loop stalls are its operator's, not the digest's");
});

test('an owed line the last log already carries shows once', t => {
  const owed = owedOf(
    {project: {name: 'p', handoffs: {open: [], returned: []}, trackers: {problems: []}}},
    [{kind: 'triage', title: 'New.', path: 'projects/p/queue/new.md'}]
  );
  const text = digestOf(
    inputs({owed, logBody: '## Open\n\n- A question?\n- In the Inbox: New.\n'})
  );
  t.equal(text.split('- In the Inbox: New.').length - 1, 1);
  t.ok(text.includes('From the last log:\n- A question?\n- In the Inbox: New.'));
});

test('an owed line the last log carries under another bullet shows once', t => {
  const owed = owedOf(
    {project: {name: 'p', handoffs: {open: [], returned: []}, trackers: {problems: []}}},
    [
      {kind: 'triage', title: 'New.', path: 'projects/p/queue/new.md'},
      {kind: 'triage', title: 'Newer.', path: 'projects/p/queue/newer.md'}
    ]
  );
  const text = digestOf(
    inputs({owed, logBody: '## Open\n\n* In the Inbox: New.\n+ In the Inbox: Newer.\n'})
  );
  t.equal(text.split('In the Inbox: New.').length - 1, 1);
  t.equal(text.split('In the Inbox: Newer.').length - 1, 1);
});

const EMPTY_BUNDLE = {
  project: {name: 'p', handoffs: {open: [], returned: []}, trackers: {problems: []}}
};

const versionOf = (extra = {}) => ({
  versionId: 7,
  recordId: 'r7',
  path: 'topics/seven.md',
  at: '2026-11-21T10:00:00Z',
  keyName: 'desk agent',
  verdict: 'wrong',
  note: 'The date\nis off.',
  decidedAt: '2026-11-22T23:05:00Z',
  decidedBy: 'Dana',
  fixedAt: null,
  fixedBy: null,
  ...extra
});

test('a version marked wrong in a draw and not marked fixed is open, on one line', t => {
  const draws = [
    {
      id: 'd2',
      versions: [
        versionOf(),
        versionOf({versionId: 8, path: 'topics/fixed.md', fixedAt: '2026-11-23T01:00:00Z'}),
        versionOf({versionId: 9, path: 'topics/fine.md', verdict: 'confirmed'}),
        versionOf({versionId: 10, path: 'topics/open.md', verdict: null, decidedAt: null})
      ]
    },
    {
      id: 'd1',
      versions: [
        versionOf({versionId: 3, path: 'topics/old.md', at: null, keyName: null, note: null})
      ]
    }
  ];
  const text = digestOf(inputs({owed: owedOf(EMPTY_BUNDLE, [], draws)}));
  t.ok(
    text.includes(
      '\n- Marked wrong in a draw: topics/seven.md, written 2026-11-21 by desk agent, marked 2026-11-22 by Dana: The date is off.\n' +
        '- Marked wrong in a draw: topics/old.md, marked 2026-11-22 by Dana'
    ),
    'the newest draw first, its note on one line, a version past the window without its writer'
  );
  for (const path of ['topics/fixed.md', 'topics/fine.md', 'topics/open.md']) {
    t.notOk(text.includes(path), `${path}: fixed, confirmed, or undecided`);
  }
});

test('the wrong versions are capped, and so are the draws read', t => {
  const many = Array.from({length: 12}, (_, i) =>
    versionOf({versionId: i, path: `topics/w${i}.md`, note: 'x'.repeat(300)})
  );
  const text = digestOf(inputs({owed: owedOf(EMPTY_BUNDLE, [], [{id: 'd', versions: many}])}));
  t.ok(text.includes('topics/w9.md'));
  t.notOk(text.includes('topics/w10.md'));
  t.ok(text.includes('- Marked wrong in a draw: 2 more, on the draw page'));
  t.ok(text.includes(`: ${'x'.repeat(200)}…\n`), 'a long note cut');
  const full = Array.from({length: 100}, (_, i) => ({id: `d${i}`, versions: []}));
  t.ok(
    digestOf(inputs({owed: owedOf(EMPTY_BUNDLE, [], full)})).includes(
      '- Marked wrong in a draw: only the newest 100 draws were read'
    ),
    'a full read says older draws went unread'
  );
  t.notOk(
    digestOf(inputs({owed: owedOf(EMPTY_BUNDLE, [], null)})).includes('Marked wrong'),
    'nothing when the server has no draws'
  );
});

test('a server before the fixed mark shows every wrong version', t => {
  const {fixedAt, fixedBy, ...older} = versionOf();
  const text = digestOf(inputs({owed: owedOf(EMPTY_BUNDLE, [], [{id: 'd', versions: [older]}])}));
  t.ok(text.includes('Marked wrong in a draw: topics/seven.md'));
});

test('a Backlog with no plan shows its first items', t => {
  const items = Array.from({length: 12}, (_, i) => ({title: `Later ${i}.`, section: 'backlog'}));
  const text = digestOf(inputs({items}));
  t.ok(text.includes('Backlog, 12 items, the first by priority and order:'));
  t.ok(text.includes('- Later 9.\n- and 2 more'));
  t.ok(!text.includes('Later 10.'));
});

const unwrapped = extra =>
  digestOf(
    inputs({
      bundle: {
        project: project({
          sessions: {
            unlogged: [
              {holder: 'h/old', ended: '2026-11-01T00:00:00Z', commits: []},
              {holder: 'h/new', ended: '2026-11-03T00:00:00Z', commits: ['abc']}
            ]
          }
        })
      },
      logBody: '## Open\n\n- An old question?\n',
      ...extra
    })
  );

test('work after the last log is flagged, with the final message that left it open', t => {
  const text = unwrapped({lastMessage: 'Which one, (a) or (b)?'});
  t.ok(text.includes('The latest work has no log, so that may not be where things stand.'));
  t.ok(text.includes('- h/new ended 2026-11-03T00:00:00Z, commits: 1'));
  t.ok(text.includes('final message:\nWhich one, (a) or (b)?'));
  t.ok(text.includes('From the last log, older than the latest work:\n- An old question?'));
  t.ok(!text.includes('h/old'), 'a session the log already follows is only counted');
  t.ok(text.includes('Older sessions with no log: 1.'));
});

test('a final message that cannot be read says what is unknown, and where it ran', t => {
  const text = unwrapped({lastMessage: null});
  t.ok(text.includes('The newest ran on h, and its final message cannot be read from here'));
  t.ok(text.includes('so what it left open is unknown.'));
});

test('text the digest quotes reaches it with no escape sequence', t => {
  const text = digestOf(
    inputs({
      logBody: '## Open\n\n- \x1b[8mhidden\x1b[28m and \x1b]8;;http://x/\x07a link\x1b]8;;\x07\n'
    })
  );
  t.ok(text.includes('- hidden and a link'));
  t.equal(text.includes('\x1b'), false);
});

test('with no later session the log stands unflagged', t => {
  const text = digestOf(inputs({logBody: '## Open\n\n- A question?\n'}));
  t.ok(!text.includes('The latest work has no log'));
  t.ok(text.includes('From the last log:\n- A question?'));
});

test('GitHub unreadable reports it beside the stored view; a clean tree shows no drift', t => {
  const text = digestOf(
    inputs({
      github: {
        problem: 'gh has no valid login on this host: run `gh auth login`.',
        repo: 'o/r',
        snapshot: {collected_at: '2026-11-01T00:00:00Z'},
        stored: true,
        filed: []
      }
    })
  );
  t.ok(text.includes('gh has no valid login'));
  t.ok(text.includes('as stored 2026-11-01'));
  t.ok(text.includes('No open threads.'));
  t.ok(!text.includes('Drift:'));
});

test('the GitHub line says CI when it ran, unknown when unread, and nothing when there is none', t => {
  const lineOf = github =>
    digestOf(inputs({github: {repo: 'o/r', filed: [], ...github}}))
      .split(/\r?\n/)
      .find(line => line.startsWith('GitHub o/r'));
  const stored = {snapshot: {collected_at: '2026-11-01T00:00:00Z'}, stored: true};
  t.equal(lineOf({snapshot: {ci: {conclusion: 'success'}}}), 'GitHub o/r: CI success.');
  t.equal(lineOf({snapshot: {ci: null}}), 'GitHub o/r.');
  t.equal(
    lineOf({snapshot: {ci: null}, ciError: 'no run found on main for .github/workflows/t.yml'}),
    'GitHub o/r: CI unknown (no run found on main for .github/workflows/t.yml).'
  );
  t.equal(lineOf(stored), 'GitHub o/r, as stored 2026-11-01.');
  t.equal(
    lineOf({...stored, snapshot: {...stored.snapshot, ci: {conclusion: 'failure'}}}),
    'GitHub o/r: CI failure, as stored 2026-11-01.'
  );
});

test('a drift check that could not run says so, and a report stays a report', t => {
  const refused = digestOf(
    inputs({drift: {problem: 'retrying.\nthe baseline could not be read: 401'}})
  );
  t.ok(refused.includes('Drift not checked: the baseline could not be read: 401'));
  t.ok(!refused.includes('retrying'));
  const report = digestOf(inputs({drift: {drifted: true, report: 'two new commits'}}));
  t.ok(report.includes('Drift:\ntwo new commits'));
  t.ok(!report.includes('Drift not checked'));
  t.ok(!digestOf(inputs()).includes('Drift'), 'a clean checkout says nothing');
});

test('a tracker other than GitHub is named and never read', t => {
  const text = digestOf(
    inputs({
      bundle: {
        project: project({
          trackers: {
            primary: {kind: 'linear', ref: 'ENG'},
            trackers: [
              {kind: 'linear', ref: 'ENG'},
              {kind: 'jira', ref: 'VS'},
              {kind: 'github', ref: 'o/r'},
              {kind: 'vault', ref: null}
            ]
          }
        })
      }
    })
  );
  t.ok(text.includes('New work goes to linear ENG, the primary tracker.'));
  t.ok(text.includes('Also tracked in jira VS.'));
  t.ok(!text.includes('Also tracked in github'), 'GitHub is collected, so it has its own lines');
  t.ok(!text.includes('Also tracked in vault'));
});
