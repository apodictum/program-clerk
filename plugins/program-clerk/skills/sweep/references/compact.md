# Compact

Some folders gather pieces that no longer earn their place one by one but still carry value as
compressed history: a folder of session logs is the usual case. A compaction reads a folder's oldest
pieces, distills them into one summary note, and moves the originals to `<folder>/archive/<YYYY>/`,
by each piece's own year. The originals stay readable by their paths, and the `/pickup` digest
doesn't descend into `archive/`.

This pass runs in the main session. A sweep's plan lists the candidate folders in its entry's
`candidates`: run the steps below once for each, with its `folder_path` as the folder.
`/sweep compact` runs this pass alone.

## Candidates

The server's compaction scan files a `compaction_candidate` suggestion for each folder whose cold
pieces, those past their type's hot window, pass a count threshold. Its payload names `folder_path`,
`piece_count`, `total_bytes`, `oldest_created`, and `newest_created`. `run_scans` refreshes the
candidates; it runs the other three maintenance scans as well. Since the scan counts only cold
pieces, a folder of 93 notes with 30 cold ones falls below the threshold after one pass of 20.

To decline a candidate, when the folder's count is meant to be high, find its id with
`list_suggestions` (`kind: ["compaction_candidate"]`, `status: ["pending"]`) and reject it with
`reject_suggestion`.

A completed compaction resolves its suggestion at once: `execute` runs the compaction scan again
after the moves, and its report's `rescan` says what the scan found.

## Steps

The harness inventories the folder, selects the pieces, leases them, gathers their bodies and the
links into them, writes the summary note, and moves each original. You write the summary.

1. **Plan.** Select and lease the pieces, and write the plan:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/compact.mjs" plan <folder>
   ```

   The selection, by option:
   - none: the oldest half of the folder's pieces;
   - `--keep=<n>`: all but the newest `<n>`;
   - `--before=<YYYY-MM-DD>`: every piece created before that date.

   A pass takes 20 pieces at most, since repeated passes beat one long summary; the plan's
   `truncated_to_cap` says when the cap cut the selection. `--holder=<holder>` names the lease's
   holder; leave it out, and the script names one. The script keeps the plan in the session's
   working folder, named by the folder, and prints two paths: the plan's, and the summary file's.

2. **Write the summary** by Summary quality below, as Markdown, to the summary file `plan` printed.

3. **Execute:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/compact.mjs" execute <folder> --related="[[<note-a>]],[[<note-b>]]"
   ```

   `execute` finds the folder's plan and summary file by itself. `--related` names one or two
   current notes the summary relates to; leave it out when none fits. With `--dry-run`, `execute`
   prints the summary note's path and every move it would make, and writes nothing.

A plan you abandon gives its lease back with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/compact.mjs" release <folder>`; otherwise the lease
lapses after an hour.

### What `plan` does

`plan` inventories the folder page by page. It leaves out the `archive/` subfolder, earlier
`_summary-*` notes, notes whose `status` is `archived` or `superseded`, and `state` notes. It
selects the pieces by the options above, reads each one's body, and gathers its **external** inbound
links: links from notes that are not themselves being archived and whose text names the piece, since
a `related-to` or `contradicts` row can be the server's mirror of the piece's own link, which moves
with the piece. The plan suggests period groups of about five to ten pieces a section, by month,
quarter, or year, in `suggested_groups`; lists the links that will break in `inbound_backlinks`; and
names the summary note's path in the account, `<folder>/_summary-<range>.md`, in `summary_path`.

### Leases

`plan` leases the selected pieces as one batch (`note:<path>`, under the holder) for an hour, so a
duplicate merge or another pass can't move one mid-compaction. The plan carries the batch. `execute`
passes its token on every move and releases it, and its report says `claim: "released"`. The batch
is all or nothing: when another pass holds any selected piece, `plan` exits 3, names each held piece
with its holder and expiry, and keeps nothing. Leave the folder for the next run, or compact it
again once that pass ends. `plan` also exits 3, leasing nothing, when the selection is empty.

### What `execute` does

`execute` refuses a summary under 100 characters before any write (exit 3), and the lease stays, so
you can fix the summary and run it again. It writes the summary note at `summary_path` with
frontmatter it builds itself: a title naming the folder and the range, the tags `summary`, the
folder's name, and `archived-history`, the type `meta`, and your `--related`. Then it moves each
original into the archive, keeping its record id, so its edges, tags, embeddings, and `agent:` block
survive. Its report itemizes every move as `from → to`, lists the links now broken in
`inbound_links_now_broken`, and gives the `rescan`. Carry the itemized moves into the sweep's
summary as they stand, never as a count.

`execute` exits 0 when all went well, 1 when some moves failed (listed in the report's `failures`)
or the plan or summary file could not be read, and 3 when it refused a summary under 100 characters
before any write. Run it in a call of its own: a non-zero exit cancels the calls made beside it.

## Summary quality

Write one section for each suggested group. Distill each group's pieces into a cohesive paragraph or
tight bullets. Surface:

- **what was done, decided, or discovered**;
- the cross-references that still matter, linked to _current_ notes, never archived ones;
- **concrete identifiers**, such as dates, commit hashes, names, and numbers: the hooks a later
  search recalls the pieces by;
- unresolved surprises, often the most valuable trace in a noisy log.

Drop conversation paraphrase, progress narration, and context available elsewhere. The bar: a reader
six months out learns each archived piece's _outcome_ without opening it.

## Links into archived pieces

A wikilink to an archived piece breaks at the next reindex, by design: the break is the signal to
rewrite the link, archive the note that links, or accept it. The plan's `inbound_backlinks` lists
exactly which links will break. Leave them broken unless the person asked you to rewrite them.

## A sub-agent for this pass

This pass stays in the main session because one bad summary costs a lot: a botched pass moves the
originals out of what a session reads at its start. A prompt that hands it to a sub-agent must carry
three things:

- the Summary quality section, word for word;
- a conservative cut: when in doubt, keep, since a later pass beats compacting too much;
- no rewrite of wikilinks unless the person authorized it.

## When to run this pass

- A `compaction_candidate` is pending: a folder passed the scan's threshold.
- The `/pickup` digest spends its reading on old logs.
- The person asks to summarize and archive a folder.

Leave `topics/` alone: every note there stands alone, and compacting it destroys the notes' shape as
the source of truth. Skip folders too small to bother with. Never compact to delete: a compaction
moves its pieces and deletes nothing.
