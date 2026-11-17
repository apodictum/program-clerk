---
name: pc
description:
  Program Clerk's account commands. It shows the account's status, answers a question from its
  notes, reports the checkout's drift since the last /wrap, runs the integrity and hygiene lints,
  and declares where a project's work is tracked. Use when the person types /pc, /pc query, /pc
  check, /pc lint, or /pc trackers.
---

# /pc

```text
/pc                      the account's status
/pc query <question>     an answer from the account's notes
/pc check [--update]     the checkout's drift since its baseline
/pc lint                 the integrity lint and the hygiene lint
/pc trackers [project]   where a project's work is tracked
```

## /pc (no subcommand)

Show the account's status, in a few lines. Every call reads:

- `status`: the count of records, edges, and pending suggestions.
- `list_folder` with an empty path for the top folders, then `list_folder` on each for its entries.
- `list_pieces` with `sort: "updated"`, `limit: 10`, and `fields: "file_path,title,updated"`: the
  notes changed last, newest first.
- `lint`: its `ok`, its `total_issues`, and each check with a count.

## /pc query <question>

Answer a question from the account's notes.

1. **Search** with `search`: `mode: "semantic"` for a concept, the default lexical mode for an exact
   phrase.
2. **Read** the best hits with `read_file`, or `read_meta` when a note's title, type, status, or
   dates answer it. When one note isn't enough, widen with `neighborhood` (the notes linked to it),
   `backlinks` (the notes that link to it), or `similar` (its nearest notes by meaning). Each takes
   a record id: `search` gives it with `edges: true`, and `read_meta` gives it for a `path`.
3. **Answer,** citing each note you used by its path in backticks.
4. **File the answer** when it is substantive, so a later session finds it: a note at
   `queries/<YYYY-MM-DD>-<slug>.md` with `type: query` and wikilinks to the notes it draws on. Put
   its `agent:` block in the same `write_file` call, by the field guide in
   `${CLAUDE_PLUGIN_ROOT}/skills/sweep/references/enrich.md`.

## /pc check [--update]

Compare the checkout with the baseline `/wrap` recorded in `projects/<project>/state.md`. Run the
script from the project's checkout, in a call of its own, since a non-zero exit cancels the calls
made beside it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs"
node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs" --update
```

The report lists the commits, tags, and npm publishes since the baseline, the commits not pushed,
the changes in the working tree, and each git tag without a matching npm version or the reverse.
Exit 0 means the checkout matches its baseline; exit 1 means it drifted, or, with a message and no
report, that the script could not run. A checkout with no baseline reports
`(no baseline recorded yet)`. `--update` records the checkout's state as the new baseline after the
report: use it after the person commits, pushes, or publishes during the session.

Tell the person what moved, in a few lines, and treat it as information: what to do about drift is
the person's call.

## /pc lint

The account has two lints with different jobs. Run both, and report them apart.

**The integrity lint** is the `lint` tool. It looks for faults in the account's index: embeddings
missing, stale, or orphaned, other orphaned rows, and summaries past their size bound. Its
`coverage.enrichment` counts the notes with and without a summary block; coverage never counts as an
issue.

**The hygiene lint** checks how the notes are written: frontmatter, empty bodies, broken wikilinks,
link density, retention, duplicate folders and titles, and queue items. It is read-only, and it
exits 0 when clean and 1 on findings, so run it in a call of its own:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lint.mjs"
node "${CLAUDE_PLUGIN_ROOT}/scripts/lint.mjs" --quiet
```

`--quiet` prints one tab-separated line a finding.

The lints report and never fix. Decide on each finding:

- Fix a legitimate finding directly: a missing frontmatter key with `patch_fm`, a broken link with
  `replace`.
- Retention: a session log past its retention is removed by `/sweep`'s `expire-logs` one-shot, so
  leave it. Move any other note past its retention to an `archive/` folder with `move`, which keeps
  its record id; never delete it.
- A duplicate folder: pick the canonical one, `move` the other's notes into it, and point each
  inbound link at the new path. `backlinks` names the notes that link, and `replace` rewrites each
  link.

## /pc trackers [project]

A project's `trackers:` list, in the frontmatter of `projects/<project>/queue/_about.md`, says where
its work is tracked: the queue, a GitHub repository, a Linear team, or a Jira project. With no
project named, use the checkout's.

1. **Read what stands**, and report the `primary`, the list, and any `problems`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" trackers <project> --json
   ```

2. **Ask** with `AskUserQuestion`, one tracker at a time:
   - `kind`: `github`, `linear`, or `jira`. The queue needs no question.
   - `ref`: `owner/repo` for GitHub, read from `git remote get-url origin` before you ask; a Linear
     team key; a Jira project key.
   - `role`: `primary`, or `secondary` while the queue stays primary.
   - `create`: `here` when new work may be created in the tracker, `none` when not. A primary
     creates by default.
   - `intake`, for a secondary: `reflect` files its threads as review items under Active, `triage`
     files them in the Inbox until each is accepted or rejected, and `none` files nothing.
   - `write`: the fields that may be written back to the tracker; empty keeps it read-only.
3. **Check the access** before you write. For GitHub, run `gh auth status`, and
   `gh repo view <owner/repo> --json isPrivate`: a private repository is read only when this list
   names it. For Linear or Jira, look for that tracker's tools, such as its MCP server, in this
   session. Report missing access beside the declaration, and write the declaration anyway.
4. **Write** with `patch_fm` on the queue's folder note. `list_pieces` with
   `file_prefix: "projects/<project>/queue/_about.md"` gives its `record_id`. Add an entry with the
   op `add`, the path `/trackers`, and the object as its value; `remove` with the same object drops
   one. Never rewrite the note for it. A project with no list yet needs the queue's own entry,
   `{kind: 'vault', role: primary}`, added before the first other one:

   ```yaml
   trackers:
     - {kind: 'vault', role: primary}
     - {kind: github, ref: owner/repo, intake: triage}
   ```

5. **Read it back** with the same `trackers --json` command and report the validated view. A
   non-empty `problems` list is a malformed entry: fix it in the same turn.

When the primary is a tracker outside the queue, the work a session takes up is one Active item
whose `--source` names its ticket, with the `queue` skill.
