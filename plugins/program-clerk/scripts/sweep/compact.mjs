// A folder's compaction: `plan` selects its oldest pieces, leases them as one batch, and writes a
// worksheet with their bodies and the links that will break; the agent writes the summary; `execute`
// writes it as a note, moves each piece into the folder's archive, and gives the batch back;
// `release` gives the batch back unexecuted. Without --out, --plan, or --summary, the worksheet and
// the summary sit in the session's working folder, named by the folder; `plan` prints both paths.
//
//   node compact.mjs plan <folder> [--keep=N | --before=YYYY-MM-DD] [--holder=H] [--out=FILE]
//   node compact.mjs execute (<folder> | --plan=FILE) [--summary=FILE] [--related=[[a]],[[b]]] [--dry-run]
//   node compact.mjs release (<folder> | --plan=FILE)
//
// The default selection is the oldest half, at most 20 pieces a pass.
//
// Exit 0 ok, 1 a failed call or a move that failed, 2 a usage error, 3 refused before any write
// (another holder has a selected piece, the selection is empty, the summary is under 100 characters).

import {run} from '../lib/compact.mjs';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = err.exitCode ?? (err instanceof TypeError ? 2 : 1);
}
