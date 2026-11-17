# Edges

The server reads each wikilink in a note's body. A link with a cue ("derived from [[X]]") becomes a
typed edge at once (`derived-from`); the rest become `cites`. This pass triages each default that
waits in the `edge_type` queue: pick a more specific type, or confirm that `cites` is right.

The decision lands in the source note's frontmatter `edges:` map, since the Markdown stays the
source of truth. The server writes it during the batch resolve, keyed by the note's record id, so a
note that moved since the filing still gets the write at its current path. The worksheet marks such
a note with `path_moved`, for your information.

## Steps

The harness lists and claims the batch, builds each item's context, fetches the source note's
`agent.edge_classifications` as a prior, makes the writes, and reports. You make the judgment.

1. **Prepare.** Claim a batch and write its worksheet:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/triage.mjs" prepare edge_type --claim --holder=<holder> --limit=<limit>
   ```

   A sweep's agent takes the holder and the limit from its prompt. Run alone, leave out `--holder`,
   and the script names one. The limit runs from 1 to 100, 25 when left out. The script prints the
   worksheet's path, a file it names by the holder, so agents beside you never write the same file.

2. **Judge.** Read the worksheet, every item whole. Write the decisions map as JSON to a file in a
   new temporary folder.

3. **Resolve:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/triage.mjs" resolve edge_type --worksheet=<worksheet> --decisions=<file>
   ```

   Then remove the temporary folder.

Each worksheet item carries the link's `snippet` (about 120 characters on each side), the `from` and
`to` note briefs (title and summary), and a `prior` when the source note's
`agent.edge_classifications` covers this target. When the snippet and the briefs aren't enough, read
the bodies with `read_piece` and the record id.

The decisions map holds one value per item id:

```json
{"<id>": "derived-from", "<id-2>": "reject", "<id-3>": "cites", "<id-4>": "skip"}
```

- A type accepts the item with that type.
- `"reject"` and `"cites"` both say the default `cites` is correct, and reject the item.
- `"skip"` or `null` leaves the item pending: `resolve` reopens its claim and lists it in the
  report's `reopened[]`.

`resolve` checks the whole decisions file before the first write, and exits 3 on an unknown id or
type, so a bad file changes nothing. Then it resolves the batch in one call: the server pins the
type in the note's `edges:` for each accept and settles the suggestion as `fm-override`. It prints a
JSON report and leaves it beside the worksheet, named by the holder. A sweep reads that file: a kind
whose pending set is only your skips stops at once, without another dispatch.

`resolve` exits 0 when all went well, 1 when some writes failed (listed in the report's
`failures[]`), and 3 when it refused the decisions file before any write. Run it in a call of its
own: a non-zero exit cancels the calls made beside it.

A pass that stops before `resolve` gives its batch back with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/triage.mjs" release edge_type --holder=<holder>`, or
`--worksheet=<worksheet>` in place of `--holder`. It reopens what the claim still holds.

## Judgment: seven types and one alias

Each type is defined by its established equivalent, which is what its description means. `resolve`
refuses any other name.

| Type           | When to choose                                                                                                                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cites`        | The default: the source only refers to the target. **Answer `reject` or `cites`.**                                                                                                                                                                                                                                                     |
| `derived-from` | The source builds on the target or is grounded in it: its material or idea came from there. PROV-O `wasDerivedFrom`, DCMI `source`, schema.org `isBasedOn`.                                                                                                                                                                            |
| `basis-for`    | Forward derivation: the _target_ was derived from the source ("promoted, generalized, captured, extracted, or distilled to [[target]]"), the origin note recording where its material went. An alias, stored as `derived-from` with the edge reversed, so pick it by the direction the prose reads, not the direction it is stored in. |
| `supersedes`   | The source replaces the target, which is no longer current. DCMI `replaces`, IANA `predecessor-version`.                                                                                                                                                                                                                               |
| `revises`      | The source amends, refines, clarifies, or extends the target without replacing it; both still apply. PROV-O `wasRevisionOf`, CiTO `updates` and `corrects`. "extends [[X]]" lands here, not in `derived-from`.                                                                                                                         |
| `applies-to`   | The source is about the target: its content applies to the target's subject or domain. schema.org `about`.                                                                                                                                                                                                                             |
| `contradicts`  | The source disagrees with the target: their claims cannot both hold. CiTO `disagreesWith` and `disputes`. Symmetric: the server mirrors it.                                                                                                                                                                                            |
| `related-to`   | A loose link of ideas, stronger than `cites`, where nothing specific fits. Symmetric.                                                                                                                                                                                                                                                  |

Don't force a type to clear the queue: a default `cites` that fits nothing else stays `cites`, a
reject.

**A `prior` on the worksheet is a prior, not a verdict.** Most types accepted on a prior alone
failed a later check against the notes. Accept a specific type only when the sentence around the
link states the relation; a prior with no such sentence is a `reject`.

## Sub-agent prompt

A sweep dispatches this pass to a `program-clerk:sweep` agent:

```text
subagent_type: program-clerk:sweep
description: Triage <limit> edge_type suggestions
prompt: |
  Follow ${CLAUDE_PLUGIN_ROOT}/skills/sweep/references/edges.md. Run its steps: prepare edge_type
  with --claim --holder=<holder> --limit=<limit>, judge every worksheet item by its type table,
  write the decisions file, and resolve. Keep the worksheet where the script puts it: the script
  names it by the holder, so agents beside you never collide. When in doubt, answer "reject"
  (cites is correct) and don't force a type; read a prior as the Judgment section says, accepting
  its type only when the sentence around the link states it. Answer "skip" for an item you can't
  judge.
  Return the harness's JSON report and at most five lines on skips and failures.
```

## When to run this pass

- Default `cites` links have piled up that deserve a more specific type: the session's `[pc]` lines
  count pending suggestions, or a sweep shows `edge_type` items pending.

To add an edge, add a wikilink to the body. To remove one, delete the wikilink, or its entry in the
frontmatter `edges:`. Other suggestion kinds have their own passes: `tags` and `duplicates`.
