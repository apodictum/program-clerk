---
name: ingest
description:
  Compiles the raw inbox's ready notes into the account's topic notes, project notes, and queue
  items in Program Clerk, and archives each source once its notes are written. Use when the person
  types /ingest or asks to ingest ready notes.
---

# /ingest

The raw inbox, `raw/`, holds quick captures. A person marks a note ripe with `ready: true` in its
frontmatter; a note without it is a draft the person is still working on. An ingest compiles each
ready note into the notes the next session reads, then archives the source.

## 1. List the ready notes

Call `raw_inbox`. It returns `ready` and `drafts`, each a list of `{path, title, updated}`, and
lists a note another session holds under `held`. Work on `ready` alone: skip the drafts and every
`held` note. When `ready` is empty, say "no ready notes; N drafts waiting" and stop.

## 2. Lease them as one batch

Call `lease_claim` once, with `resources` holding `note:<path>` for each ready note, your holder
(`<host>/<session>`), and `ttl_seconds: 1800`, since a batch with no TTL holds for four hours. Keep
the `claim_token`. Work on the notes the answer lists under `claimed`; a note under `held` is
another session's to compile, so skip it. When the run outlasts the TTL, renew the batch with
`lease_renew`, your holder, the `claim_token`, and a new `ttl_seconds`.

## 3. Compile each note

Take one note end to end before you start the next: its derived notes written, the source rewritten,
the source moved. A failure midway leaves the earlier notes archived and the rest in the inbox, so
running `/ingest` again resumes.

1. **Read** the note with `read_file` and `include_etag`, and keep its etag for step 7.
2. **Extract** its concepts and put each where it belongs:
   - A pattern or fact that holds across projects goes to a topic note under `topics/`.
   - What belongs to one project goes to a note under `projects/<project>/`.
   - Work that waits goes on the project's queue, with the `queue` skill.

   Check a topic's neighbors with `propose` first, and extend a note that covers it instead of
   writing a near copy.

3. **Lease a topic note before you extend or supersede it,** so a duplicate merge can't archive it
   under you: a second `lease_claim` batch, with its own token and the same short TTL. When `held`
   names the note, write a new note instead, or leave that point for the next run.
4. **Supersede a note the new one replaces outright** with `supersede` and that note's
   `claim_token`, never by rewriting it in place. The old note moves to an archive folder with its
   record id, and the new one gets a `supersedes` edge to it. Extend a note that stays with
   `append`, `replace`, or `replace_section`.
5. **Link and tag** the derived notes. Add wikilinks from each to the notes it draws on, and from a
   related note back to it. Check tag names with `tag_nearest`, write with `strict_tags: true`, and
   mint a tag with `tag_create` only when nothing fits. Declare the note's relations in `edges:` and
   write with `strict_edges: true`.
6. **Enrich at capture.** A new topic note, or one you rewrite, carries its `agent:` block in the
   same `write_file` or `supersede` call's `frontmatter`. Follow the block's shape and the field
   guide in `${CLAUDE_PLUGIN_ROOT}/skills/sweep/references/enrich.md`. Set
   `derived_from_hash: "auto"`, and the server stamps the hash of the body it writes. `complexity`
   is one of `prose`, `code-heavy`, `tabular`, `mixed`, `hub`, or `log-entry`; the server refuses
   any other word.
7. **Archive the source,** in this order:
   - Write it back with `write_file` and the etag from step 1 as `expected_etag`. Send the
     frontmatter `{ready: "__unset__", processed: true}` and the body as read, with a last line
     naming the main derived note: `> Ingested <YYYY-MM-DD> → [[<derived note>]]`. The frontmatter
     you send merges over the stored one, so leaving `ready` out keeps it; the `"__unset__"` value
     removes it. On a 412, read the note again and repeat.
   - `move` it from `raw/<name>.md` to `raw/archive/<YYYY-MM-DD>-<name>.md` with the batch's
     `claim_token`, so the inbox shows only what waits.

## 4. Release every batch

Release each batch you took with `lease_release`, your holder, and its `claim_token`, on a failure
too. With no `resource`, the call releases the whole batch. A retry's batch sees your own unreleased
one as `held`, since any live lease counts, yours included: release it first while you have the
token, or let it lapse.

## 5. Report

In a few lines: each source and the notes derived from it, each note skipped as held, and the count
of drafts still waiting.
