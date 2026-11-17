// A triage pass's paperwork: `prepare` lists or claims a kind's pending suggestions and prints, or
// writes, a worksheet; `resolve` applies the agent's decisions to it; `release` reopens what a
// worksheet's claim still holds. With --claim and no --out, the worksheet goes to a file named by the
// holder, which `release --holder` finds.
//
//   node triage.mjs prepare <kind> [--limit=N] [--claim] [--holder=H] [--ttl=S] [--scan[=DIST]] [--out=FILE]
//   node triage.mjs resolve <kind> --worksheet=FILE --decisions=FILE [--label=L] [--dry-run]
//   node triage.mjs release <kind> --holder=H | --worksheet=FILE
//
// kinds: new_tag | tag_suggestion | edge_type | duplicate
//
// The decisions file is JSON, the bare map or {decisions: {...}}:
//   new_tag        by tag: {"action":"taxonomy","description"?} |
//                          {"action":"alias","canonical":"...","description"?} | {"action":"reject"} | null
//   tag_suggestion by id:  "accept" | "reject" | "defer" | null
//   edge_type      by id:  "<edge-type>" | "reject" | "cites" (the default is right: a reject) | "skip" | null
//   duplicate      by id:  "reject" | "related" | "merge-candidate" |
//                          {"action":"contradiction","note":"..."} | "skip" | null
// null, skip, and defer reopen a claimed item and leave it pending; the report's `reopened` names
// them, and a claimed pass's report is also written beside its worksheet, where the sweep reads it.
//
// Exit 0 ok, 1 a failed call or a resolve with failures, 2 a usage error, 3 decisions refused before
// any write (an unknown key, an accept of a tag outside the taxonomy, an unknown edge type).

import {run} from '../lib/triage.mjs';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = err.exitCode ?? (err instanceof TypeError ? 2 : 1);
}
