---
name: wrap
description:
  Ends a stretch of work in Program Clerk. It saves what the session learned to the project's notes,
  writes the session's log for the next /pickup, and records the checkout's state so the next
  /pickup reports what moved since. Use when the person types /wrap or asks to wrap up, save the
  session, or log the work.
---

# /wrap

A wrap keeps what only this session can write: what it learned, and the story of what it did. Do the
three steps in order.

## 1. Save what the session learned

Read the project's notes first, with `resume_bundle` and
`project_bodies: ["feedback", "learnings", "decisions", "stack"]`, so nothing is written twice. Then
put each thing worth keeping where the next session reads it:

- A rule the person gave for how to work on the project goes to `projects/<project>/feedback.md`,
  with why and how to apply it.
- A rule the person meant for every project, or a way of working not tied to this one, goes where
  every session reads it: in Claude Code, a line in the person's `~/.claude/CLAUDE.md`. The wrap's
  report proposes the line, and it is written on the person's word; a topic note can hold the long
  form.
- A decision and its reasons go to `projects/<project>/decisions.md`, appended as a section of its
  own.
- A lesson about the code or the tools goes to `projects/<project>/learnings.md`, a fact about the
  stack to `stack.md`.
- Work that waits goes on the queue, with the `queue` skill.
- A pattern that holds across projects goes to a note under `topics/`. Check its neighbors with
  `propose` first, and extend a note that covers it rather than writing a near copy.
- This session's new or changed memories (Claude Code's memory files on this machine) that hold a
  durable rule or fact go to the notes above, once each. Leave the memory as a short pointer to the
  note.

Write with `append`, `replace`, or `replace_section`, which change only what they name.

## 2. Write the log and the baseline

Write one file, in a new temporary folder:

```text
title: <what the session did, in one line>
summary: <two to four sentences: what was done and what is open>
---
<the log's body>
```

The body says what was done, the decisions made, and the key files touched. End it with a `## Open`
section, one bullet per unanswered question or pending item, and a `## Next` section naming the next
task when one is set: the next `/pickup` shows both as written. Cite notes by their paths in
backticks.

Then run, from the project's checkout:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/wrap.mjs" <file> --slug <a-short-slug>
```

The script adds the project's name and the date to the title, so leave both out of it. It writes the
log, adds its line to the project's month of sessions, and records the checkout's state, printing a
line for each. With `--project <name>`, it logs to another project and records no state. When a step
fails, the steps before it landed: run the script again only when the log or its line failed. When
only the state failed, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/wrap.mjs" baseline`, which records
the state alone; if that fails too, say so, since the next `/pickup` then shows this session's
commits as moved.

## 3. Report

In a few lines: the notes touched, the log's path, whether the state was recorded, and any line
proposed for the person's `~/.claude/CLAUDE.md`, word for word.

## When to wrap

- A wrap closes a stretch of work, not a day. A long session can wrap more than once, each with a
  small log of its own.
- Whether the work is done is the person's call. Offer a wrap when work shipped or the person says
  so, never because the conversation paused.
- Skip the wrap when the session produced nothing worth keeping.
- Queue items move when their work ships, not at the wrap.
