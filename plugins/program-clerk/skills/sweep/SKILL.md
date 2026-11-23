---
name: sweep
description:
  Runs Program Clerk's maintenance over the account's notes. It splits notes past their size bound,
  runs the one-shot cleanups, then drains each queue with sub-agents (summaries to write or refresh,
  new tags, tag suggestions, link types, duplicates, old folders to compact, and the server's
  reports), and reports what it changed and what it left. Use when the person types /sweep, /sweep
  <pass>, or asks to clean up or maintain the notes.
---

# /sweep

A sweep drains the queues the server fills as notes change. The driver,
`node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/sweep.mjs"`, owns every count, stage, and round and keeps
them in a state file; you dispatch the sub-agents each plan names, run `next`, and repeat until the
plan says done. The judgment is the sub-agents'.

```text
/sweep                         every pass
/sweep <pass>                  one pass: enrich, tags, edges, duplicates, compact, or reports
/sweep --dry-run               what would run, with live counts; writes nothing
/sweep --exclude=duplicate     every pass but these kinds
/sweep --max-passes=N          passes of one kind in a round (default 5)
/sweep --max-rounds=N          rounds of the whole sweep (default 5)
```

A pass maps to the driver's kinds: `enrich` is
`--include=enrich_backfill,enrich_stale,enrich_oversized`, `tags` is
`--include=new_tag,tag_suggestion`, `edges` is `--include=edge_type`, `duplicates` is
`--include=duplicate`, `compact` is `--include=compaction_candidate`, and `reports` is
`--include=report`.

## What a sweep does

| Stage                        | Work                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before `begin`               | Split each note past its size bound, and regroup appended pieces (step 0 below).                                                                                             |
| One-shots                    | `begin` runs them itself: orphaned embeddings removed, missing ones embedded, expired session logs removed, unused tags removed, and stored links checked against the notes. |
| Summaries                    | The `enrich` pass: a summary block written for a note with none, refreshed where it no longer matches its note, and restated from the headings where it grew past its bound. |
| New tags                     | The `tags` pass: an unknown tag becomes canonical, an alias, or a typo fixed.                                                                                                |
| Tag suggestions ∥ link types | The `tags` pass accepts or rejects a suggested tag; the `edges` pass types a link that reads only as a citation.                                                             |
| Duplicates                   | The `duplicates` pass: reject, relate, or flag a merge for the main session.                                                                                                 |
| Compaction                   | The `compact` pass, yours, not a sub-agent's: a folder's oldest pieces summarized into one note, the pieces archived.                                                        |
| Reports                      | The `reports` pass, last, so a backlog report is judged against the queue the sweep left.                                                                                    |

A sweep never touches the raw inbox, which a person marks ready for ingesting, or an archive
suggestion, which asks a person about one note.

The stages run in this order because an earlier one fills a later one's queue, and `new_tag` runs
alone because it changes the tags the next stage judges against. Agents of one kind run together:
each claims its own batch under its holder, so their batches never overlap.

## Procedure

0. **Split and regroup, before `begin`.** Read the `lint` tool's `checks.size_bound.samples` and
   `checks.ungrouped_pieces.samples`, then dispatch one `program-clerk:sweep` agent per note, all in
   one message:
   - A note past its bound (`remedy` exactly `split`): read its `##` headings with their sizes, name
     topics, and `split` it with `topics`. A decisions note splits with no topics, one note a
     decision.
   - A piece past its bound (`remedy` `split with topics and pieces ["<name>"] on <note>`): read
     that piece alone, name two or more topics covering its sections, and regroup the note with
     `topics` and that `pieces` list.
   - Appended pieces (`ungrouped_pieces`): read each appended piece and the topic pieces' titles
     (`list_pieces` with the folder as `file_prefix`), pick the topic each joins, or a new one, and
     regroup with `topics` naming each topic's sections plus the ones joining it, and `pieces`
     naming the appended pieces and those topic pieces, never the folder's other pieces.

   The brief for each agent: topics group whole sections read together, each under 20 KB, every
   section of the named pieces once; keep each existing topic's name; read the note with `read_file`
   and `include_etag`, and send `split` with `expected_etag`, reading again and retrying once on a
   412; never `join` a note to regroup it, since a join deletes every piece with its history and
   summary; report the answer's `pieces`, `removed`, and `oversized`.

   A section past 20 KB by itself, in `oversized` or in a note no split can cut, gets a remedy that
   drops no fact, made by you after the agents report: a trim of repeated wording, or the rule its
   own folder names (a plan's shipped arc shrinks to one line naming its decision and commit). A
   lessons piece is the person's: a reorganization drops lessons by design, so the summary asks
   whether to reorganize it, naming the piece and its size.

1. **`begin`.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/sweep.mjs" begin` with the person's
   options. It runs the one-shots and prints the first plan, with `state`, the state file's path.
   `--dry-run` prints the counts and the lint and stops, the one-shots included.

2. **Dispatch** every agent entry of the plan's `dispatch` list in one message, one Agent call each,
   `subagent_type: "program-clerk:sweep"`, labeled with its kind. The prompt: the entry's `pass`
   names the reference to follow, `${CLAUDE_PLUGIN_ROOT}/skills/sweep/references/<pass>.md`, whose
   sub-agent prompt takes the agent's fields: its `holder`; its `records_file` or its `limit`; for
   the `enrich` pass its `mode` and `outline`; for a triage pass its `triage_kind` as `<kind>`; and,
   for the `reports` pass, the project this session works in as `<project>`, the queue an accepted
   report's follow-up goes on. An entry with `candidates` and no agents is compaction: follow
   `references/compact.md` yourself for each folder it lists, and treat a folder whose `plan` exits
   3, another holder having one of its pieces, as skipped, naming the folder and the holder. Say the
   plan's `estimate_s` and the running `elapsed_s` when you dispatch.

3. **`next`** after every agent returns:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/sweep.mjs" next`. It measures again, floors a kind
   whose count stopped dropping, moves through the stages and rounds, and prints the next plan or
   `{"status": "done"}`. A kind whose whole pending set is what the last pass released back is
   floored at once, its items listed under `skipped` for you to triage by hand. Two rounds is the
   usual end.

4. **Summary,** from the done report:
   - `reason` (`converged`, `no_change_round`, or `max_rounds`), `rounds`, `floors`, `residue`, and
     `skipped`: what is left, and why.
   - Every change by name, from the agents' reports, your compactions, and the one-shots: each merge
     as `removed path → kept path`; each folder compacted, by name; each log `expire_logs` removed,
     by path and age; each tag `gc_tags` removed, by name; each note `check_edges` repaired, when it
     says `repaired: true`. A removal stated only as a count is one nobody can trace later.
   - `lint`: when its `ok` is false, each check in `failing` with its count and samples, since the
     sweep drains none of them.
   - `size_bound`, `ungrouped_pieces`, and `small_splits`: the notes step 0 trimmed, and those it
     left past their bound, with appended pieces, or split into pieces under half their bound. Name
     each; a note left for the person carries its remedy and the question it needs. Join none, which
     is the person's call.
   - Each note step 0 split or regrouped, and each piece a regroup removed.

A floored kind isn't a failure: some items need the person, and the agents leave anything ambiguous
for them. The summary names that residue so the person can triage it or leave it for the next sweep.
