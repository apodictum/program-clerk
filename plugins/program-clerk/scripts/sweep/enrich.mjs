// The enrichment pass's paperwork: `prepare` takes the server's worklist, leases its notes as one
// batch, and writes a worksheet; `show` prints it for reading; `apply` writes the agent's
// enrichments and gives the batch back; `release` gives it back without writing. With no --out, the
// worksheet goes to a file named by the holder in the session's sweep folder, and `prepare` prints
// its path.
//
//   node enrich.mjs prepare [--limit=N] [--stale | --refresh [--outline]] [--full-threshold=F] [--type=T] [--records=FILE] [--holder=H] [--out=FILE]
//   node enrich.mjs apply --worksheet=FILE --enrichments=FILE [--dry-run]
//   node enrich.mjs release --worksheet=FILE
//   node enrich.mjs show --worksheet=FILE [--item=N [--from=C]]
//
// `show` with no --item prints a line an item; with --item, that item whole, a page at a time, each
// page naming the next --from. A summary judged from part of a note goes out stamped current, so
// read every page.
//
// --stale takes the pending stale suggestions; an item whose body changed by at most F (0.4 when
// left out) of its chunk bytes carries `delta`, the added chunks, in place of `body`. --records
// narrows a worklist to the paths or ids it lists, one a line, and takes all of them, at most 200,
// unless --limit says fewer; with neither, the limit is 30. --refresh takes the --records list as
// given, each note with its current `agent:` block and its whole body; --outline gives each one the
// note's size and its headings to level 2 in place of the body, for a summary past the lint's bound.
// A folder's summary lives on its `_about.md` and is judged against the note the folder composes.
//
// The enrichments file is JSON, the bare map or {enrichments: {...}}, keyed by file_path as in the
// worksheet; null skips an item:
//   {"topics/x.md": {"summary": "...", "key_concepts": ["..."], "tags_suggested": [...],
//     "related_proposed": ["[[...]]"], "edge_classifications": {"[[target]]": "derived-from"},
//     "complexity": "prose"}}
// An item with current_agent (--stale, --refresh) may answer {"summary_holds": true}, which confirms
// its summary for the body read.
//
// Exit 0 ok, 1 a failed call or an apply with failures, 2 a usage error, 3 enrichments refused
// before any write.

import {run} from '../lib/enrich.mjs';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = err.exitCode ?? (err instanceof TypeError ? 2 : 1);
}
