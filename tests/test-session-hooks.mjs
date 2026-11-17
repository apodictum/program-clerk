import test from 'tape-six';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  DEAD,
  contextOf,
  fakeServer,
  git,
  hookEnv,
  host,
  makeRepo,
  removeAll,
  runHook,
  scratch
} from './helpers.mjs';
import {ADVICE, noticeLines} from '../plugins/program-clerk/scripts/lib/notices.mjs';
import {readTranscript} from '../plugins/program-clerk/scripts/lib/transcript.mjs';

test("the rules hook asks for the checkout's project, and fails open", async t => {
  const home = scratch();
  const main = makeRepo(join(home, 'main-name'));
  const linked = join(home, 'other-name');
  git(main, 'worktree', 'add', '-q', '--detach', linked);

  let r = await runHook('rules.mjs', {cwd: main}, hookEnv(home, null));
  t.deepEqual([r.code, r.stdout], [0, ''], 'no key is silent');
  r = await runHook('rules.mjs', {cwd: main}, hookEnv(home, DEAD));
  t.deepEqual([r.code, r.stdout], [0, ''], 'an unreachable server is silent');

  const server = await fakeServer({
    'GET /projects/main-name/rules': {body: {text: '[pc] the rules\n- one'}},
    'GET /projects/named/rules': {body: {text: '[pc] named rules'}}
  });
  const env = hookEnv(home, server.base);
  r = await runHook('rules.mjs', {cwd: home}, env);
  t.deepEqual([r.code, r.stdout], [0, ''], 'outside a checkout, nothing');
  r = await runHook('rules.mjs', {cwd: main}, env);
  t.equal(r.stdout, '[pc] the rules\n- one\n', "the cwd project's rules");
  t.equal(server.requests.at(-1).auth, 'Bearer test-key');
  r = await runHook('rules.mjs', {cwd: linked}, env);
  t.equal(r.stdout, '[pc] the rules\n- one\n', "a linked worktree is its main checkout's project");
  mkdirSync(join(linked, '.claude'));
  writeFileSync(join(linked, '.claude', 'pc-project'), 'named\n');
  r = await runHook('rules.mjs', {cwd: linked}, env);
  t.equal(r.stdout, '[pc] named rules\n', 'the marker names the project');
  await server.close();
  removeAll(home);
});

test('notices: each once a session, with its window in UTC', async t => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  t.deepEqual(
    noticeLines(
      [
        {id: 'a', text: 'Deploy.', starts_at: '2026-11-16T13:00:00.000Z', minutes: 5},
        {id: 'b', text: 'Done.', starts_at: '2026-11-16T11:00:00Z', minutes: 1},
        {id: 'c', text: 'Note.', starts_at: '2026-11-16T11:00:00Z', minutes: null},
        {id: 'd', text: 'Seen.', minutes: null}
      ],
      new Set(['d']),
      now
    ),
    [
      ['a', '[pc] notice: Deploy. (starts 2026-11-16 13:00Z, for about 5 minutes)'],
      ['b', '[pc] notice: Done. (started 2026-11-16 11:00Z, for about 1 minute)'],
      ['c', '[pc] notice: Note.']
    ]
  );

  const home = scratch();
  const repo = makeRepo(join(home, 'repo'));
  const server = await fakeServer({
    'GET /system/notices': {body: {notices: [{id: 'n1', text: 'Restart.', minutes: null}]}},
    'POST /notes/query': {body: {items: []}}
  });
  const env = hookEnv(home, server.base);
  const call = {session_id: 'abc123', cwd: repo, tool_name: 'Read'};
  let r = await runHook('after-tool.mjs', call, env);
  t.equal(contextOf(r.stdout), `[pc] notice: Restart.\n${ADVICE}`, 'said after a tool call');
  r = await runHook('after-tool.mjs', call, env);
  t.equal(contextOf(r.stdout), '', 'not again in the same minute');
  removeAll(join(home, 'cache', 'program-clerk', 'notices', 'abc123.checked'));
  r = await runHook('after-tool.mjs', call, env);
  t.equal(contextOf(r.stdout), '', 'nor once seen');
  r = await runHook('after-tool.mjs', {...call, session_id: 'def456'}, env);
  t.matchString(contextOf(r.stdout), /Restart\./, 'another session hears it');
  await server.close();
  removeAll(home);
});

const tool = (name, input, timestamp = '2026-09-30T01:05:00.000Z') =>
  JSON.stringify({
    timestamp,
    message: {role: 'assistant', content: [{type: 'tool_use', name, input}]}
  });

test('the session record: what the session wrote, from its transcript', t => {
  const transcript = [
    JSON.stringify({type: 'summary', sessionId: 'deadbeef'}),
    JSON.stringify({timestamp: '2026-09-30T01:00:00.000Z', message: {role: 'user', content: 'hi'}}),
    tool('mcp__program-clerk__append', {path: 'projects/demo/queue.md', text: 'x'}),
    tool('mcp__plugin_program-clerk_program-clerk__replace', {
      path: 'logs/old.md',
      from: 'a',
      to: 'b'
    }),
    tool('Bash', {command: 'node scripts/x-put.mjs topics/x.md --fm fm.json --body body.md'}),
    tool('mcp__program-clerk__write_file', {path: 'topics/new-name.md', body: 'x'}),
    tool('mcp__program-clerk__supersede', {
      old_path: 'topics/old.md',
      new_path: 'archive/2026/old.md'
    }),
    tool('mcp__program-clerk__move_item', {
      from_path: 'projects/demo/queue.md',
      to_path: 'projects/demo/queue-archive.md'
    }),
    tool('Bash', {
      command: 'pc-curl /data/projects/demo/data/x.markdown -X PUT --data-binary @b.md'
    }),
    tool('Bash', {command: 'pc-curl /vault/topics/pc.md -X PUT --data-binary @body.md'}),
    tool('mcp__program-clerk__read_file', {path: 'topics/read-only.md'}),
    tool('mcp__other__append', {path: 'topics/elsewhere.md'}),
    'not json'
  ].join('\r\n');
  t.deepEqual(readTranscript(transcript), {
    started: '2026-09-30T01:00:00Z',
    wrote: [
      'archive/2026/old.md',
      'logs/old.md',
      'projects/demo/queue-archive.md',
      'projects/demo/queue.md',
      'topics/new-name.md',
      'topics/old.md',
      'topics/pc.md',
      'topics/x.md'
    ]
  });
});

test("the session record hook appends the end line to the project's month file", async t => {
  const home = scratch();
  const repo = makeRepo(join(home, 'vs-demo'));
  const transcript = join(home, 'session.jsonl');
  writeFileSync(
    transcript,
    [
      JSON.stringify({
        timestamp: '2026-09-30T01:00:00.000Z',
        message: {role: 'user', content: 'hi'}
      }),
      tool('mcp__program-clerk__append', {path: 'projects/vs-demo/queue.md', text: 'x'})
    ].join('\n') + '\n'
  );
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'during the session');
  const end = (cwd, session_id, extra = {}) => ({
    session_id,
    cwd,
    transcript_path: transcript,
    reason: 'prompt_input_exit',
    ...extra
  });

  let r = await runHook('session-record.mjs', end(repo, 'deadbeef-0000'), hookEnv(home, null));
  t.deepEqual([r.code, r.stdout], [0, ''], 'no key is silent');
  const server = await fakeServer({
    'POST /data/projects/vs-demo/data/sessions/2026-11.jsonl': {body: {}}
  });
  const env = hookEnv(home, server.base);
  r = await runHook('session-record.mjs', end(home, 'deadbeef-0000'), env);
  t.equal(server.requests.length, 0, 'outside a checkout, nothing');
  r = await runHook('session-record.mjs', end(repo, 'deadbeef-0000', {agent_id: 'sub'}), env);
  t.equal(server.requests.length, 0, 'a sub-agent records nothing');

  r = await runHook('session-record.mjs', end(repo, 'deadbeef-0000'), env);
  t.equal(server.requests.length, 1, 'one request, the append');
  const month = new Date().toISOString().slice(0, 7);
  const request = server.requests[0];
  t.equal(request.method, 'POST');
  t.equal(
    request.path,
    `/data/projects/vs-demo/data/sessions/${month}.jsonl`,
    'into the month file'
  );
  t.ok(request.body.endsWith('}\n'), 'one line, ending with its newline');
  const line = JSON.parse(request.body);
  t.deepEqual(
    {
      kind: line.kind,
      holder: line.holder,
      started: line.started,
      reason: line.reason,
      wrote: line.wrote
    },
    {
      kind: 'end',
      holder: `${host}/deadbeef`,
      started: '2026-09-30T01:00:00Z',
      reason: 'prompt_input_exit',
      wrote: ['projects/vs-demo/queue.md']
    }
  );
  t.matchString(line.ended, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  t.equal(line.commits.length, 2, 'both commits since its start');
  t.notOk('log' in line, 'no log named: the wrap pairs its line by holder');

  const dotted = makeRepo(join(home, 'site.example.com'));
  await runHook('session-record.mjs', end(dotted, 'deadbeef-0001'), env);
  t.equal(
    server.requests.at(-1).path,
    `/data/projects/site.example.com/data/sessions/${month}.jsonl`,
    'a dotted name is a project'
  );
  const linked = join(home, 'other-name');
  git(repo, 'worktree', 'add', '-q', '--detach', linked);
  await runHook('session-record.mjs', end(linked, 'deadbeef-0002'), env);
  t.equal(
    server.requests.at(-1).path,
    `/data/projects/vs-demo/data/sessions/${month}.jsonl`,
    "a linked worktree records under its main checkout's project"
  );
  await server.close();
  removeAll(home);
});
