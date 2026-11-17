// `enrich.mjs show`'s reader: every chunk, piece, and body whole, and pages that join back into the
// whole item.

import test from 'tape-six';
import {
  PAGE_CHARS,
  pageOf,
  renderIndex,
  renderItem
} from '../plugins/program-clerk/scripts/lib/worksheet-view.mjs';

const tail = 'Step 26 shipped. Next: the last step.';
const chunk = (index, text) => ({index, text});
const delta = {
  file_path: 'projects/p/plans/plan.md',
  title: 'A plan',
  type: 'plan',
  read: 'delta',
  reason: 'possibly_stale',
  existing_tags: ['plan'],
  current_agent: {
    summary: 'A plan through step 21.',
    key_concepts: ['plan'],
    derived_from_hash: 'h',
    derived_at: 't'
  },
  body_wikilinks: ['[[a]]'],
  related_candidates: [],
  delta: {
    body_bytes: 9000,
    chunks: {total: 9, added: 2, removed: 0},
    added_bytes: 1400,
    removed_bytes: 0,
    changed_fraction: 0.15,
    added_chunks: [chunk(7, 'x'.repeat(600) + ' Step 25.'), chunk(8, 'y'.repeat(700) + ' ' + tail)]
  }
};

test('renderItem: a delta item shows every added chunk whole, its tail included', t => {
  const text = renderItem(delta, 1, 1);
  t.ok(text.includes(tail), 'the newest entry, past any head cut');
  t.ok(text.includes('x'.repeat(600) + ' Step 25.'));
  t.ok(text.includes('--- added chunk 2 of 2 (index 8) ---'));
  t.ok(text.includes('--- current summary ---\nA plan through step 21.'));
  t.ok(text.includes('reason: possibly_stale'));
  t.notOk(text.includes('derived_from_hash'), 'the hash is no judgment input');
  t.ok(text.endsWith('--- end of item 1 ---'));
});

test('renderItem: full, folder-delta, and outline reads', t => {
  const body = 'line 1\n'.repeat(50) + tail;
  t.ok(renderItem({file_path: 'a.md', read: 'full', body}, 2, 3).includes(body));
  const pieces = [
    {file_path: 'f/one.md', updated: '2026-10-28', body: 'one'},
    {file_path: 'f/two.md', updated: '2026-10-29', body: tail}
  ];
  const folder = renderItem(
    {file_path: 'f.md', read: 'folder-delta', changed_pieces: pieces},
    1,
    1
  );
  t.ok(folder.includes(`--- changed piece 2 of 2: f/two.md (2026-10-29) ---\n${tail}`));
  const outline = renderItem(
    {file_path: 'o.md', read: 'outline', outline: {body_bytes: 99, headings: ['# A', '## B']}},
    1,
    1
  );
  t.ok(outline.includes('--- outline of 99 bytes ---\n# A\n## B'));
});

test('renderIndex: a line an item, numbered as show --item takes them', t => {
  const index = renderIndex({items: [delta, {file_path: 'b.md', read: 'full', body: 'abc'}]});
  t.deepEqual(index.split(/\r?\n/), [
    '1. projects/p/plans/plan.md · read: delta · reason: possibly_stale · 2 added chunks',
    '2. b.md · read: full · 3 characters of body'
  ]);
});

const pages = (t, text, size) => {
  const out = [];
  for (let from = 0; from !== null;) {
    const {page, next, total} = pageOf(text, from, size);
    t.equal(total, text.length);
    out.push(page);
    from = next;
  }
  return out;
};

test('pageOf: pages join back into the whole text', t => {
  const text = Array.from({length: 400}, (_, i) => `line ${i} ${'z'.repeat(i % 37)}`).join('\n');
  const parts = pages(t, text, 500);
  t.equal(parts.join(''), text);
  t.ok(
    parts.slice(0, -1).every(part => part.endsWith('\n')),
    'a page ends at a line'
  );
  t.ok(
    parts.every(part => part.length <= 500),
    'no page passes the size'
  );
});

test('pageOf: a line longer than a page is cut at the page size, never inside a pair', t => {
  const line = 'a'.repeat(9) + '🙂' + 'b'.repeat(30);
  const parts = pages(t, line, 10);
  t.equal(parts.join(''), line);
  t.equal(parts[0], 'a'.repeat(9), 'the pair is left whole for the next page');
  t.equal(parts[1], '🙂' + 'b'.repeat(8));
});

test('pageOf: a text that fits is one page', t => {
  t.deepEqual(pageOf('short', 0), {page: 'short', next: null, total: 5});
  t.equal(PAGE_CHARS, 24000);
});
