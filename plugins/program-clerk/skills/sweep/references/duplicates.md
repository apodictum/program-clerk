# Duplicates

The server's duplicate scan compares the embeddings of the account's notes and files a pending
`duplicate` suggestion for each pair that is very similar (a cosine similarity of 0.90 or more, by
default). A pair can be redundant (merge), distinct but related (cross-reference), contradicting
(flag), or a false positive of the embedding (reject). **Prefer the resolutions that change no
content:** merge only with high confidence and the person's word.

## Steps

The harness lists and claims the batch, gathers both notes of each pair, makes the safe writes, and
reports. You make the judgment. Only the merge is done by hand, and only by the main session.

1. **Prepare.** Claim a batch and write its worksheet:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/triage.mjs" prepare duplicate --claim --holder=<holder> --limit=<limit>
   ```

   A sweep's agent takes the holder and the limit from its prompt. Run alone, leave out `--holder`,
   and the script names one. The limit runs from 1 to 100, 25 when left out. To find duplicates now,
   add `--scan`, or `--scan=<distance>` for a cosine distance other than 0.1: the server scans
   before the claim. The script prints the worksheet's path, a file it names by the holder, so
   agents beside you never write the same file.

2. **Judge.** Read the worksheet, every pair whole. Write the decisions map as JSON to a file in a
   new temporary folder.

3. **Resolve:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/triage.mjs" resolve duplicate --worksheet=<worksheet> --decisions=<file>
   ```

   Then remove the temporary folder.

Each worksheet item carries the pair's `distance` and both notes' briefs: title, type, status,
dates, summary, and the first 30 or so lines of the body (`body_head`). That is usually enough to
judge; read a full body with `read_file` and the note's path only when it isn't. `path_moved` marks
a note that moved since the filing; the writes use the current paths.

The decisions map holds one value per item id:

```json
{
  "<id>": "reject",
  "<id-2>": "related",
  "<id-3>": {"action": "contradiction", "note": "one says X, the other not-X"},
  "<id-4>": "merge-candidate",
  "<id-5>": "skip"
}
```

What `resolve` does with each value:

- `reject`: rejects the suggestion as a false positive. A later scan doesn't file the pair again.
- `related`: adds each note to the other's frontmatter `related:` on the server, one array member at
  a time with no rewrite of the note, then accepts the suggestion. The server then adds a
  `related-to` edge for each entry.
- `contradiction`: rejects the suggestion and puts your note in the report, since the server has no
  place for contradictions yet.
- `merge-candidate`: leaves the item pending, reopens its claim, and lists it in the report's
  `merge_candidates` for the main session.
- `skip` or `null`: leaves the item pending.

The report's `reopened[]` names both the skips and the merge candidates. `resolve` leaves the report
beside the worksheet, named by the holder. A sweep reads that file: a kind whose pending set is only
what you left stops at once, without another dispatch.

`resolve` checks the whole decisions file before the first write, so a bad file changes nothing. It
exits 0 when all went well, 1 when some writes failed (listed in the report's `failures[]`), and 3
when it refused the decisions file before any write. Run it in a call of its own: a non-zero exit
cancels the calls made beside it.

A pass that stops before `resolve` gives its batch back with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/triage.mjs" release duplicate --holder=<holder>`, or
`--worksheet=<worksheet>` in place of `--holder`. It reopens what the claim still holds.

## Judgment, per pair

The distance is cosine: 0 is identical, 0.10 a strong match, 0.15 a topical neighbor, and above 0.30
unrelated.

| Decision            | When                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **reject**          | The topics are distinct despite a high cosine: the notes share vocabulary, or they have different lifecycles (a `log`, a `permanent` note, and a `query` are rarely duplicates, even when close in topic). |
| **related**         | The same topic, but distinct enough that both should exist: a different angle or audience, such as a tutorial and a reference.                                                                             |
| **contradiction**   | Both cover the same ground but reach different conclusions ("always X" against "never X").                                                                                                                 |
| **merge-candidate** | A true duplicate: one note is canonical, the other redundant. The harness never merges; the main session merges by the steps below.                                                                        |

**When in doubt, answer reject or related.** Watch `status`: a note already `superseded` likely
means reject. Watch the `created` dates: the much older note may be the one superseded.

## Merge

A merge is the one path that changes content, so it stays by hand: the main session alone, with high
confidence, and after the person confirms it. Then:

0. **Lease both notes,** so an ingest or a compaction running beside you cannot extend or move
   either one mid-merge. Call `lease_claim` once, with
   `resources: ["note:<path A>", "note:<path B>"]`, your holder (`<host>/<session>`), and
   `ttl_seconds: 1800`, since a batch with no TTL holds for four hours. Keep the `claim_token`. When
   the answer's `held` names either note, another pass is working on it: release what you got with
   `lease_release` (your holder and the `claim_token`), leave the suggestion pending, and move on. A
   lease another holder left behind is the person's to end, on the account's agents page, never
   yours.
1. **Choose the canonical note:** the more recent `updated:`, more inbound links (`backlinks` with
   the record id), and the better structure. When in doubt, prefer the older note and absorb the
   newer one's unique content.
2. **Write the merged content** into the canonical note. Take the union of both notes' tags, and
   lose nothing from either note. End it with a supersession line that points at the _archived_
   path, without the extension: `> Supersedes [[<dir>/archive/<YYYY>/<name>]].` The server types
   that phrasing as `supersedes`. The `supersede` tool doesn't fit here, since the successor already
   exists.
3. **Redirect the inbound links:** for each note `backlinks` names, point its link at the canonical
   note with `replace`, one call for each link.
4. **Archive the redundant note,** which keeps its record id, embeddings, and history: `move` it to
   `<dir>/archive/<YYYY>/<name>.md` with the lease's `claim_token`, then set its `status` to
   `superseded` with `patch_fm`. Delete a note with `delete_file` only when it is junk with no
   history.
5. **Accept the suggestion** with `accept_suggestion` and its id.
6. **Release the lease** with `lease_release`, your holder, and the `claim_token`.

## Sub-agent prompt

A sweep dispatches this pass to a `program-clerk:sweep` agent, which never merges:

```text
subagent_type: program-clerk:sweep
description: Triage <limit> duplicate suggestions
prompt: |
  Follow ${CLAUDE_PLUGIN_ROOT}/skills/sweep/references/duplicates.md. Run its steps: prepare
  duplicate with --claim --holder=<holder> --limit=<limit>, judge every pair by its Judgment
  table, write the decisions file, and resolve. Keep the worksheet where the script puts it: the
  script names it by the holder, so agents beside you never collide.
  Never merge: mark a true duplicate "merge-candidate" for the main session. When in doubt between
  "related" and "reject", answer "reject": a cross-reference must reflect real kinship, not a
  coincidence of embeddings.
  Return the harness's JSON report and at most five lines on skips and failures.
```

The main session reviews the report's `merge_candidates` and merges any true duplicate by the steps
in Merge, after the person confirms it.

## When to run this pass

- The duplicate scan has filled the queue: the session's `[pc]` lines count pending suggestions, or
  a sweep shows `duplicate` items pending, and the person wants redundant notes cleaned up. To find
  duplicates now, add `--scan` to `prepare`.

Other suggestion kinds have their own passes: `tags` and `edges`.
