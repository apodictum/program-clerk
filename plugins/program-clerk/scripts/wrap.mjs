// `/wrap`'s writes: the session's log, its line in the project's month of sessions, and the
// checkout's baseline.
//
//   node wrap.mjs <file> [--slug S] [--project P]
//   node wrap.mjs baseline
//
// <file> holds a `title:` line, a `summary:` line, a `---` line, then the log's body; `baseline`
// records the checkout's state alone.

import {run} from './lib/wrap.mjs';

try {
  await run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
