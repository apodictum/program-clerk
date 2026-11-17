# Reports

The server checks the account's notes against thresholds as it scans, and files a report when one is
passed:

- **`inefficiency_detected`**: a signal to tune and stay. An account on the hosted service gets two
  signals of this kind, `edge_fanout_high` (the outbound edges of one note) and
  `review_backlog_high` (the pending suggestions); its size and note count are the service's to
  watch. Judge any other signal of this kind the same way.
- **`infrastructure_upgrade`**: a signal to migrate: the notes have outgrown the server that keeps
  them. **Never resolve this kind.** Leave it pending and surface it: whether to migrate is always
  the person's decision.

A report's payload is `{signal, current, threshold, recommendation}`. On `edge_fanout_high` it adds
`top`, the notes with the most outbound edges, and the suggestion's `subject_id` names the hub note.

**A resolution acknowledges the level it saw.** Accepting or rejecting a report records the observed
level, and the same signal is filed again only when the metric reaches 1.25 times that level. A
rejected by-design condition therefore stays rejected through later scans, and an accepted one stays
quiet while its remediation waits on the queue. `run_scans` names each signal it held back in its
`upgrade` summary's `suppressed`.

## Steps

The queue is small, with none to two items as a rule, so this pass calls the tools directly; it has
no harness.

1. **Claim or list.**
   - In a sweep, claim with `claim_suggestions` once for each kind: `kind`, your `holder` and
     `limit` from the prompt, and `expand: "context"`. Keep the `claim_token` each claim returns:
     resolving and reopening that claim's items need it.
   - Run alone, list both kinds in one call with `list_suggestions`:
     `kind: ["inefficiency_detected", "infrastructure_upgrade"]`, `status: ["pending"]`,
     `limit: 20`, and `expand: "context"`, which inlines the note briefs.

2. **Check each signal against live data.** The payload holds the numbers at filing time; judge
   against what is true now. Use `status` for the note and edge counts, `lint` for orphans,
   `suggestions_summary` for the backlog, and `read_file` on the hub note for `edge_fanout_high`.

3. **Decide each item:**
   - **By design, or a false positive: reject it,** and give the reason in your report. Typical
     cases: `edge_fanout_high` on a deliberate hub, such as an index or bundle note, or a large
     running file, whose links are its function; `review_backlog_high` from a passing spike in the
     middle of a sweep.
   - **A real condition to tune: accept it,** after you file its remediation as a Backlog item on
     the queue of the project the session works in. Name the remediation in the item, such as a
     compaction or split target for a note that grew too many links, or tuning how long notes are
     kept, and say where the item came from: the report's id, signal, current level, and threshold.
     Write the item's text to a file in a new temporary folder, then run:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs" file <project> --title "<title>" --body-file <file>
     ```

     An acceptance with no tracked remediation is an alarm dismissed. The batch resolve keeps no
     note, so your report's line for the accept names the queue item.

   - **`infrastructure_upgrade`: leave it pending.** Reopen it if you claimed it, and give it word
     for word in your report.

4. **Resolve** with `resolve_suggestions_batch`, one call for each claim: `resolved_by` (your
   holder), that claim's `claim_token`, and `items: [{id, decision}]`. Then call `reopen_suggestion`
   with the id and the `claim_token` for each claimed item you left. The server settles a claimed
   item only for its own claim's token, and answers 409 `claimed_by_other` otherwise. The batch call
   always answers 200: check `failed` and each `results[].error` before you count the queue as
   drained.

5. **Report** one line for each item: the signal, current level and threshold, the decision, the
   reason, and for an accept, the queue item.

## Sub-agent prompt

A sweep dispatches this pass to a `program-clerk:sweep` agent, last of all, so a backlog report is
judged against the queue the sweep left. Fill `<project>` with the project the session works in:

```text
subagent_type: program-clerk:sweep
description: Triage the server's reports
prompt: |
  Follow ${CLAUDE_PLUGIN_ROOT}/skills/sweep/references/reports.md. Claim up to <limit> pending
  suggestions of each kind, inefficiency_detected and infrastructure_upgrade, with
  claim_suggestions and holder <holder>, keeping each claim's claim_token. Check each signal
  against live data, then resolve with resolve_suggestions_batch, resolved_by "<holder>", and
  that claim's claim_token: reject a by-design condition with a reason; accept a real one only
  after filing its remediation as a Backlog item on the queue of project <project>. Never resolve
  infrastructure_upgrade: reopen it with reopen_suggestion and list it in your report.
  Return one line for each item: signal, current and threshold, decision, and reason.
```
