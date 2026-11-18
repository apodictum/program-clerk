# Enrich

This pass writes a namespaced `agent:` block into each note's frontmatter: a summary of one or two
sentences, three to five key concepts, proposed tags and related notes, edge types for the body's
wikilinks, and a complexity label. The block lives in the note's Markdown, which stays the source of
truth, and the server indexes it: the summary is embedded as its own vector, and search scores a
note by the better of its best chunk and its summary. The server stamps each block with the hash of
the body it was derived from. When the body changes, the hash drifts and the server files an
`agent_enrichment_stale` suggestion, which settles by itself once the block is refreshed.

A pass runs in one mode:

| Mode                   | Notes                                                                                         | `prepare` options                                        |
| ---------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `backfill`             | Notes with no summary block.                                                                  | none; `--type=<type>` narrows to one type                |
| `stale`                | Summaries that no longer match: the `agent_enrichment_stale` queue, the lint's stale folders. | `--stale`; `--full-threshold=<fraction>`, 0.4 by default |
| `refresh`              | The notes listed, as given, each with its summary and its whole body.                         | `--refresh --records=<file>`                             |
| `refresh` with outline | Summaries past their size bound, restated from the note's headings in place of its body.      | `--refresh --outline --records=<file>`                   |

The worksheet's `mode` names `backfill` as `missing`. `--records=<file>` names the notes, one path
or record id a line. It is how a sweep hands each agent its shard, and it narrows `backfill` and
`stale` to those notes. `--limit=<limit>` caps a worklist at 1 to 200 notes, 30 when left out; a
records file without `--limit` is taken whole, up to 200 notes.

## Which notes take a block

The server decides. The `lint` tool's `coverage.enrichment` counts the notes that take a block
(today the `permanent`, `project`, `design`, `research`, and `query` notes) and lists those without
one in `unenriched_records`; its folder list names each atomized folder and whether it has a
summary. `prepare` takes its worklist from there. Never build the list yourself: a list of your own
drifts from the server's.

## Steps

The harness pulls the worklist, leases the notes, gathers each note's context, checks your file,
makes the writes, and releases the lease. You write the enrichment.

1. **Prepare.** Lease a batch and write its worksheet:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/enrich.mjs" prepare <mode options> --holder=<holder> --records=<file>
   ```

   Use `--limit=<limit>` in place of `--records` when you have no list. A sweep's agent takes the
   mode, the holder, and the records file or the limit from its prompt. Run alone, leave out
   `--holder`, and the script names one. The script prints the worksheet's path and its counts.

2. **Read** each item whole, through the harness:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/enrich.mjs" show --worksheet=<worksheet>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/enrich.mjs" show --worksheet=<worksheet> --item=<n>
   ```

   The first prints a line per item; the second prints item `<n>` whole, a page at a time.

3. **Judge.** Write the enrichments map as JSON to a file in a new temporary folder, starting from
   the worksheet's `enrichments_template`, keyed by each item's `file_path` as the worksheet gives
   it. `null` skips a note.

4. **Apply:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/enrich.mjs" apply --worksheet=<worksheet> --enrichments=<file>
   ```

   Then remove the temporary folder. With `--dry-run`, `apply` lists what it would write and
   confirm, and writes nothing.

A pass that stops before `apply` gives its notes back with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/enrich.mjs" release --worksheet=<worksheet>`.

The enrichments map:

```json
{
  "topics/retry-budgets.md": {
    "summary": "...",
    "key_concepts": ["retry-budget", "backoff"],
    "tags_suggested": ["reliability"],
    "related_proposed": ["[[circuit-breakers]]"],
    "edge_classifications": {"[[backoff]]": "derived-from"},
    "complexity": "prose"
  },
  "projects/demo/decisions.md": {"summary_holds": true},
  "topics/draft.md": null
}
```

`{"summary_holds": true}` answers only an item that carries `current_agent` (`stale` and `refresh`);
the sections below say when.

### Leases

`prepare` leases its worklist's notes as one batch (`note:<path>`, under the holder) for ten minutes
plus two a note, from half an hour to four hours, and keeps only what it got. A note another pass
holds is listed under `unclaimed`, with its holder under `held`, and left out of `items`, so two
passes never enrich one note twice. The worksheet's `claim` carries the batch's token. `apply`
releases it after its writes, and its report says `claim: "released"`, or `"lapsed"` when the time
ran out first. A refused enrichments file (exit 3) keeps the batch, so you can fix the file and
apply again.

### What the worksheet holds

Each item carries the note's `body` (or a `delta`, below), `title`, `type`, `existing_tags`,
`existing_related`, `body_wikilinks` (the links in the body, the exact keys `edge_classifications`
may use), and `related_candidates` (embedding neighbors at a cosine distance of 0.30 or less, minus
links the note already has). In `stale` and `refresh` modes it also carries `current_agent`, the
block to revise instead of recreating. The worksheet's header carries the whole tag taxonomy
(`taxonomy`), the coverage counts, and `needs_a_body`, the notes whose body is empty, which the
harness leaves out.

### Read every item whole

Read every item with `show`, never through a cut of your own. A summary is judged from what you read
and goes out stamped current, so a view cut short (a prefix, a slice, a line range) yields a wrong
summary the server can't tell from a right one. Added chunks and pieces come in body order, so on an
appended note a cut of each chunk's head misses exactly the newest entries and shows everything that
agrees with the old summary. `show --item=<n>` prints the item whole: its summary, its links, and
every chunk, piece, or line of its body. Past 24,000 characters it prints a page and names the
`--from` of the next. Read every page before you judge the item.

## Kinds of item

An item's `read` says what it carries.

### Full items (`read: "full"`)

The item carries the whole `body`: every `backfill` item, every `refresh` item without an outline,
and a `stale` item with no baseline to compare against or with a change past the threshold.

### Delta items (`read: "delta"`, `stale` only)

When the server has an enrichment baseline for a note and its body changed by at most the threshold
since, the item carries `delta` in place of `body`: `added_chunks` (the text of every chunk not
there at the last enrichment, each prefixed with its heading path), the count and bytes of removed
chunks, and `changed_fraction`. Rolling notes (queues, decision logs, archives) usually arrive this
way. Judge a delta item as a revision of `current_agent`:

- Keep the summary when the added chunks are more entries of the kind it already describes, the
  usual case for a rolling note. Revise it only when the added text opens a subject or a section it
  doesn't cover, or moves the span it states, and drop a "newest" clause an older summary still
  carries (see `summary` in the field guide). The note's own title, type, and `existing_tags` say
  what it is.
- **An item with `reason: "possibly_stale"` is restated or confirmed.** Its hash reads current, but
  its summary stood through many writes, and its delta holds everything added since that summary was
  written. Write the summary to cover what the delta adds, or, when it still describes the note as
  it stands, answer `{"summary_holds": true}` in place of an enrichment, and `apply` confirms it for
  the body you read. A summary returned word for word as a new enrichment keeps the note on the
  stale queue; never reword an accurate summary only to clear the flag. Before either answer, check
  each dated or positional claim of the summary (the span's end, a "next", what heads an order, what
  is open) against the newest added text, which on an appended note is the end of the last chunk.
  Write a revision from what you read. Never patch the old summary by substituting into its text:
  that keeps every claim the substitution doesn't touch.
- Keep `current_agent.related_proposed`. A delta item carries no `related_candidates`, since an
  append rarely moves a note's neighbors and the neighbor query is the slow part of `prepare`.
- Take `tags_suggested` and `edge_classifications` from the added text only. `body_wikilinks` still
  lists every link in the whole body, so `apply` checks the keys as before.
- Removed chunks come as a count, never as text. When `removed_bytes` is large next to
  `added_bytes`, or the added text contradicts the summary, answer `null` for the note and let a
  full read handle it (`--full-threshold=0`).

A `stale` item with `reason: "oversized"`, read in full or as a delta, carries a summary past its
bound. Restate it as an outline item says, and never answer `summary_holds` for it.

### Refresh items (`refresh`)

A summary whose hash reads current can still describe an older note, since a write can stamp the
block current whatever the edit did. `resume_bundle` marks such a note `summaryPossiblyStale`.
`refresh` takes the listed notes as given, with no queue filtering them, each item with
`current_agent` and the whole body (`read: "full"`). Judge it as a stale item read in full: write
the summary from the note as it stands, covering its newest entries, and drop a "newest", "next", or
"open" claim the body no longer supports. When the summary still holds, answer
`{"summary_holds": true}`.

### Outline items (`read: "outline"`)

`refresh` with `--outline` serves the summaries past their size bound. The notes that carry one are
the long rolling notes, megabytes of body, so an item carries `outline` in place of the body:
`body_bytes`, and the headings to level 2, each cut to 160 characters. Restate
`current_agent.summary` in the rolling form under the bound, from the outline: what the note holds
and its span, never a clause per entry. Never answer `summary_holds` for one, since the summary is
what fails the lint.

### Folder items (`folder` set)

A note kept as an atomized folder carries its summary on the folder's `_about.md`, judged against
the note the folder composes, so a new piece makes it stale. The `lint` tool lists each folder.
`prepare` adds a folder without a summary to the `backfill` worklist (`--type=meta` narrows to
folders), and a stale one to `stale`. Its item is the `_about.md` record with `folder` (the composed
note's path), `pieces`, and `folder_hash`. It reads one of two ways:

- The composed note whole: `read: "full"`, with `body`.
- When stale with a summary, the pieces written since that summary, when they come to at most the
  threshold of the note: `read: "folder-delta"`, with `changed_pieces`, each with its path, title,
  and body.

Summarize the folder's note as a whole, in the rolling form a decisions or learnings note takes:
what it holds and its span. Judge a folder delta as a delta item: a revision of `current_agent` for
what the new pieces add, or `{"summary_holds": true}`. A folder item has no `related_candidates`,
since the text of `_about.md` itself is a stub. `apply` writes the block onto `_about.md` with
`folder_hash` as its `derived_from_hash`, and confirms a summary that holds by writing it again with
that hash.

## What `apply` checks and writes

`apply` refuses the whole file before any write (exit 3) on a path not in the worksheet, a summary
under 10 characters, an empty `key_concepts`, a bad `complexity`, an `edge_classifications` key that
is not one of the item's `body_wikilinks`, or an edge type outside the eight below.

It writes each block as JSON, never as Markdown text, since a summary's prose can break a YAML
parse. It sends `derived_from_hash: "auto"`, and the server stamps the hash of the body it writes,
with `derived_at`. Each write is conditional on the note's etag, with one retry on a 412. It goes to
the note's current path, read by its record id, since a write to a path the note has left would
create a stray note there. A stale item needs no resolve of its own: the next reindex settles its
suggestion as `hash-matched`.

`apply` exits 0 when all went well, 1 when some writes failed (listed in the report's `failures`),
and 3 when it refused the file before any write. Run it in a call of its own: a non-zero exit
cancels the calls made beside it.

## The `agent:` block

```yaml
agent:
  derived_at: 2026-04-30T22:00:00Z # stamped by the server
  derived_from_hash: '<body hash>' # stamped by the server from "auto"
  summary: "<one or two sentences: the note's core claim and scope>"
  key_concepts: [concept-1, concept-2, concept-3]
  tags_suggested: [proposed-tag] # candidates for the top-level tags:
  related_proposed: ['[[other-note]]'] # candidates for the top-level related:
  edge_classifications: # body wikilinks to edge types
    '[[some-note]]': derived-from
  complexity: prose # prose | code-heavy | tabular | mixed | hub | log-entry
```

The pass never touches the top-level frontmatter a person writes (`title`, `tags`, `related`,
`status`, `type`, `priority`, `edges`): it writes only inside its `agent:` namespace. The harness
sends only that key, the server merges it over the stored frontmatter, and each write replaces the
`agent` map whole.

## Field guide

- **`summary`**: one or two sentences, about 40 to 80 words. Lead with the note's core claim or
  scope, and don't restate the title. **Name both the concrete thing and the abstract pattern,** in
  one sentence: a summary that abstracts away the concrete name (an error's text, a function, a
  product) loses the searches that use that name. **A rolling note** (a queue, a decision log, an
  archive, or a learnings, stack, or feedback note) gets a summary of what it holds and its span
  ("the decision log of the billing service, January to June: storage, sync, and pricing"), never
  its newest entry. A "Newest: …" clause goes stale at the next append and puts the note back on the
  stale queue by construction; recency is what session logs and `summary_stale` carry. Any summary
  stays under 3,000 characters: the `lint` tool counts a longer one under `oversized_summaries`, and
  the server refuses a new one.
- **`key_concepts`**: three to five lowercase, hyphen-separated noun phrases the note hangs on. They
  are retrieval anchors and need not be taxonomy tags.
- **`tags_suggested`**: only tags in the worksheet's `taxonomy`, or a new one clearly worth adding.
  Skip when uncertain: a tag outside the taxonomy becomes a `new_tag` item for the `tags` pass, and
  a loose proposal is only a typo for it to reject.
- **`related_proposed`**: judge each entry of the item's `related_candidates`, and propose only real
  semantic kin. Leave out an ambiguous one.
- **`edge_classifications`**: classify only the item's `body_wikilinks`, and only where the sentence
  around the link states the relation. The server's default for a link is `cites`, and this field is
  an advisory prior for the `edges` pass, never the edge itself. The value is one of eight: `cites`,
  `supersedes`, `revises`, `derived-from`, `basis-for`, `applies-to`, `contradicts`, or
  `related-to`. The type table in `edges.md`, beside this file, says when to pick each. Forward
  derivation ("promoted to [[target]]", "generalized to [[target]]") is `basis-for`, an alias stored
  as `derived-from` with the edge reversed. `extends` is not a type: "extends [[X]]", adding to X
  without replacing it, is `revises`, and "builds on" or "based on" is `derived-from`. Most
  `derived-from` and `applies-to` types accepted on a prior alone failed a later check against the
  notes, so classify nothing the text doesn't state. `apply` refuses any other value. The server
  checks a note you write yourself too, but it still accepts a few retired names, so write only
  these eight. The `edges` pass reads each classification as its link's prior, so a wrong one
  misleads it.
- **`complexity`**: `prose`, `code-heavy`, `tabular`, `mixed`, `hub` (a note that is mostly
  wikilinks), or `log-entry`.

**Empty bodies are reported, never enriched.** The harness leaves them out and lists them under
`needs_a_body`: a block on a stub means nothing and has to be stripped later. Whether to write
content or leave the note empty is the person's call.

## Report

When you run the pass yourself, report it in this form:

```text
Enriched <n> notes: <new> new, <stale> refreshed (<delta> from a delta), <skipped> skipped,
  needs a body: <paths>, errors: <count>
<remaining> still without a summary: run /sweep enrich for the next batch.
```

The written, confirmed, skipped, `needs_a_body`, and `failures` figures come from the apply report;
`remaining` comes from the `lint` tool's `coverage.enrichment.unenriched`.

## Sub-agent prompt

A sweep dispatches this pass to `program-clerk:sweep` agents, one Agent call for each agent of the
plan's entry. Fill `<mode>` with the agent's `mode`, written `refresh with outline` when it has
`outline: true`; `<holder>` with its `holder`; and `<count>` with its `records` or its `limit`. Keep
`--records=<records_file>` when the agent has a `records_file`, and put `--limit=<limit>` in its
place when it has a `limit` instead.

```text
subagent_type: program-clerk:sweep
description: Enrich <count> notes, mode <mode>
prompt: |
  Follow ${CLAUDE_PLUGIN_ROOT}/skills/sweep/references/enrich.md. Run its steps in mode <mode>:
  prepare with that mode's options, --holder=<holder>, and --records=<records_file>. Keep the
  worksheet where the script puts it. Read every item whole with show --item=N, every page of it,
  never through a cut of your own. Write the enrichment for every item by the field guide, whose
  rules bind you, and judge each kind of item as its section says. Answer null only for a note
  you can't judge. Apply.
  Return the apply report and at most five lines on skips and failures.
```

The sweep's driver splits a large worklist into disjoint shards, one records file an agent, and
names each agent's holder, so two agents of one sweep never take the same note, and every lease
names the sweep and its shard. Agents writing at once are safe: each write is conditional on its
note's etag.

## When to run this pass

- Notes without a summary block have piled up: the `lint` tool's `coverage.enrichment` counts them.
- Notes changed enough that their summaries no longer match: `agent_enrichment_stale` items are
  pending, or the `lint` tool's `coverage.enrichment.folders` marks a folder `stale`, for which the
  server files no suggestion.
- A summary grew past its bound: the `lint` tool counts it under `oversized_summaries`.
- `resume_bundle` marks a summary `summaryPossiblyStale`: refresh that note with `--refresh` and
  `--records`.

A new note is better born enriched. When you write a note with `write_file`, put its `agent:` block
in the same call's `frontmatter`, by the block shape and the field guide above, with
`derived_from_hash: "auto"`, and the note never waits for this pass.
