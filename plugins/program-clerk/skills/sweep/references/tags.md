# Tags

This pass triages two kinds of suggestion, both about tags:

- **`new_tag`**: a tag in a note's `tags:` is not in the taxonomy and is not an alias of a tag that
  is. Decide once per unique tag (the worksheet groups the notes for you): canonical, alias, or
  typo.
- **`tag_suggestion`**: a note's `agent.tags_suggested` holds a tag its `tags:` lacks. Decide per
  suggestion (one note and one tag): accept or reject.

Triage `new_tag` first. Its answers change the taxonomy that `tag_suggestion` is judged against, so
a sweep runs it alone, a stage before `tag_suggestion`.

## Steps

The harness lists and claims the batch, gathers the context and the taxonomy, makes the writes, and
reports. You make the judgment.

1. **Prepare.** Claim a batch and write its worksheet:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/triage.mjs" prepare <kind> --claim --holder=<holder> --limit=<limit>
   ```

   `<kind>` is `new_tag` or `tag_suggestion`. A sweep's agent takes the holder and the limit from
   its prompt. Run alone, leave out `--holder`, and the script names one. The limit runs from 1 to
   100, 25 when left out. The script prints the worksheet's path, a file it names by the holder, so
   agents beside you never write the same file.

2. **Judge.** Read the worksheet, every item whole. Write the decisions map as JSON to a file in a
   new temporary folder, starting from the worksheet's `decisions_template`. `null` leaves an item
   pending.

3. **Resolve:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/triage.mjs" resolve <kind> --worksheet=<worksheet> --decisions=<file>
   ```

   Then remove the temporary folder.

The worksheet carries what the judgment needs. For `new_tag`: each tag's note briefs, its `taxonomy`
status, and its `neighbors`, the nearest canonical tags, closest first. For `tag_suggestion`: each
item's `in_taxonomy`, `canonical`, and `companion_verdict`. On both, `path_moved` marks a note that
moved since the suggestion was filed.

`resolve` checks the whole decisions file before the first write, so a bad file changes nothing.
Then it adds the taxonomy entries and aliases, strips rejected tags from each note's `tags:` on the
server (no read and rewrite of the note), resolves the batch in one call, and reopens each claimed
item you left pending. It prints a JSON report, whose `reopened[]` names the items it reopened, and
leaves the report beside the worksheet, named by the holder. A sweep reads that file: a kind whose
pending set is only your skips stops at once, without another dispatch.

`resolve` exits 0 when all went well, 1 when some writes failed (listed in the report's
`failures[]`), and 3 when it refused the decisions file before any write. Run it in a call of its
own: a non-zero exit cancels the calls made beside it.

A pass that stops before `resolve` gives its batch back with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep/triage.mjs" release <kind> --holder=<holder>`, or
`--worksheet=<worksheet>` in place of `--holder`. It reopens what the claim still holds.

The decisions map for `new_tag`, keyed by tag:

```json
{
  "coherent-concept": {"action": "taxonomy", "description": "one-line"},
  "ml": {"action": "alias", "canonical": "machine-learning"},
  "harnesses": {
    "action": "alias",
    "canonical": "harness",
    "description": "Agent harnesses: Claude Code, OpenCode, and peers"
  },
  "wip-fix-later": {"action": "reject"}
}
```

The decisions map for `tag_suggestion`, keyed by suggestion id:

```json
{"<suggestion-id>": "accept", "<other-id>": "reject", "<third-id>": "defer"}
```

## Judgment: `new_tag`, per unique tag

| Action       | When to choose                                                                                                                                                                                                                                           | Effect                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **taxonomy** | A new concept worth canonical vocabulary, distinct from every existing tag's meaning.                                                                                                                                                                    | The tag is minted; the notes that carry it link to it; its pending suggestions are accepted.                                                                 |
| **alias**    | A synonym, an abbreviation, or another spelling of an existing canonical (`ml` → `machine-learning`). The canonical must exist. When the alias widens what the canonical covers (`harnesses` → `harness`), add `description` to rewrite the canonical's. | Later uses are rewritten to the canonical; the notes get the canonical's link; with `description`, the canonical's description is replaced in the same call. |
| **reject**   | A typo, a joke, a single-use marker, or a tag that only splits the vocabulary further (`misc-stuff`).                                                                                                                                                    | The tag is stripped from every affected note's `tags:`; its suggestions are rejected.                                                                        |

A tag is lowercase letters, digits, and hyphens; an alias is lowercase. Use the worksheet's
`neighbors` to make the alias-or-new call, and check both meanings before you alias: an alias that
loses specificity (`indexer-design` → `indexing`) is wrong.

`neighbors` comes from the server's nearest-tag lookup: the candidate scored against the embedding
of every tag's name and description, merged with exact, alias, and word matches, best first, ten at
most. Each entry carries:

- `score`: the lookup's score; 1 is an identical vector.
- `matched`: how the entry got in: `exact`, `alias`, `name`, or `embedding`.
- `edits`: the raw edit distance between the two tags.
- `distance`: the same, divided by the longer tag's length.
- `token_distance`: the Jaccard distance between the tags' hyphen-separated words: 0 for a
  reordering such as `build-vs-adopt` against `adopt-vs-build`, 1 when no word is shared.

Read them this way:

- A `matched` of `alias` or `name`, beside a description that covers the candidate, signals an
  alias.
- `edits: 1` on a long tag is almost always a singular and plural pair or a suffix pair. Check the
  canonical's own aliases before you mint.
- `exact` on the group is a canonical, or an alias the candidate already resolves to, added since
  the filing. The answer is then an alias or the existing tag, never a mint.
- The embedding finds neighbors a name can't: `competitive-analysis` draws `competitive`,
  `market-research`, and `analysis`.

**When in doubt, add to the taxonomy** a tag that names a coherent concept, and reject only clear
typos and markers. A wrong reject strips the tag from every note that carries it, and that is data
lost.

**`origin: proposed` items** carry a tag that came from `agent.tags_suggested` and is not in the
note's `tags:`. Such an item is the companion of a `tag_suggestion` whose tag is outside the
taxonomy: it puts that tag's taxonomy question in this queue, where it can be answered, and without
it the suggestion could never be accepted. Judge it as above. The strip a reject makes changes
nothing here, since removing an absent tag is a no-op. A reject means the companion `tag_suggestion`
is rejected too, in the next stage of the same sweep.

## Judgment: `tag_suggestion`, per note and tag

| Action     | When to choose                                                                                | Effect                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **accept** | The tag describes the note accurately and matches how the tag is used elsewhere.              | The server adds the tag to the note's `tags:`.                                                                                       |
| **reject** | The tag is tangential, repeats a tag the note already has, or misframes the content.          | The suggestion is rejected and the tag is removed from `agent.tags_suggested`.                                                       |
| **defer**  | The tag is valid but not in the taxonomy, and you don't want to mint a canonical for it here. | The item stays pending and its claim is released. Its taxonomy question waits in `new_tag` as a companion: read `companion_verdict`. |

**Read `companion_verdict` before you decide.** Each `tag_suggestion` item carries the status of the
`new_tag` suggestion for the same tag, joined when the worksheet is prepared:

| `companion_verdict` | Meaning                                                                          | Do                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"rejected"`        | The taxonomy question is settled **no**, perhaps minutes ago in this same sweep. | **Reject this one too.** Never defer it: the tag is not coming, and a deferred suggestion would stay pending for good.                                         |
| `"pending"`         | The companion is still open, likely being triaged beside you.                    | Defer is right here; the next pass sees the companion resolved.                                                                                                |
| `null`              | No rejected or pending companion exists.                                         | Judge on `in_taxonomy` and `canonical`. An accepted companion needs no row of its own: the acceptance put the tag in the taxonomy, where those fields show it. |

`companion_new_tags` carries the rows behind the verdict (`suggestion_id`, `resolved_by`,
`resolved_at`) when you want to see who settled one. When the worksheet says
`companion_scan_truncated: true`, the join stopped at its page limit and a verdict may be missing:
read `null` there as unknown, not absent.

**Lean toward accept.** `agent.tags_suggested` was written under instructions to suggest only tags
that are clearly relevant, so reject only a clear misframing. The harness keeps the taxonomy first:
`resolve` refuses, before any write and with exit 3, to accept a tag that is neither a canonical nor
an alias. Mint it through a `new_tag` decision first, or defer.

## Sub-agent prompt

A sweep dispatches this pass to a `program-clerk:sweep` agent, once per kind, with the plan entry's
`triage_kind` as the kind:

```text
subagent_type: program-clerk:sweep
description: Triage <limit> <kind> suggestions
prompt: |
  Follow ${CLAUDE_PLUGIN_ROOT}/skills/sweep/references/tags.md. Run its steps for kind <kind>:
  prepare with --claim --holder=<holder> --limit=<limit>, judge every worksheet item by its
  Judgment sections, whose leanings bind you, write the decisions file, and resolve. Keep the
  worksheet where the script puts it: the script names it by the holder, so agents beside you
  never collide. Answer "defer" or null for an item you can't decide, never a forced answer:
  resolve reopens it.
  Return the harness's JSON report and at most five lines on skips and failures.
```

## When to run this pass

- The session's `[pc]` lines count pending suggestions, or a sweep shows `new_tag` or
  `tag_suggestion` items pending.
- A tag added to a note was refused as unknown.
- The taxonomy is due for curation.

Renaming or deleting an existing canonical is a taxonomy migration, outside this pass. Other
suggestion kinds have their own passes: `edges` and `duplicates`.
