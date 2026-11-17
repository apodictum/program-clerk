---
name: queue
description:
  Lists, files, moves, and archives the items on a project's queue in Program Clerk, and shows where
  the project's work is tracked. Use when work is planned or put off, when an item ships or is
  dropped, or when the person asks what is queued.
---

# The queue

A project's queue is one note per open item, under `projects/<project>/queue/`. Each item has a
`section` (`inbox`, `active`, `backlog`, or `watching`), a `sequence_key`, the day it was `filed`,
and a `priority`, `source`, or `blocked_by` when set. Closed items move to
`projects/<project>/queue-archive/`. `queue.md` and `queue-archive.md` show each folder as one note:
read them, and write through the script.

## Commands

Run each from any folder:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" list <project> [--section backlog] [--json]
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" all [--section active] [--priority 0] [--limit 20] [--json]
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" file <project> --title <title> [--section backlog] [--source <ticket>] --body-file <file>
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" move <project> "<title or file name>" --section active
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" archive <project> "<title or file name>" --reason shipped --trail "<what closed it>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" trackers <project> [--json]
```

- `all` lists the open items of every project.
- `file` writes a new item in the Backlog unless `--section` says otherwise, or replaces the open
  item with the same title or source. Write the item's text to a file first; the text says where the
  item came from. `file` starts a queue for a project that has none.
- `--source` names a ticket the item mirrors, and nothing else: `github owner/repo#15`,
  `github owner/repo discussion#15`, `github owner/repo GHSA-xxxx-xxxx-xxxx`, `linear ENG-123`, or
  `jira VS-7`.
- `archive` takes a reason, `shipped`, `rejected`, `parked`, or `deferred`, and a trail naming what
  closed the item, such as a commit or a decision.
- `trackers` shows where the project's work is tracked, from `trackers:` in
  `projects/<project>/queue/_about.md`, and any problem in that list.

## Rules

- Archive an item in the turn its work ships.
- To edit an item's text, use `replace` on the item's own path.
- Read an item's section from `list`: in `queue.md`, every item shows as a heading with no section.
