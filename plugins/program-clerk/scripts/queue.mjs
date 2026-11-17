// A project's queue from the shell, one note an item:
//
//   node queue.mjs list <project> [--section S] [--json]
//   node queue.mjs all [--section S] [--priority N] [--limit N] [--json]
//   node queue.mjs file <project> --title T [--section S] [--priority N] [--source S]
//                       [--blocked-by B] (--body B | --body-file F)
//   node queue.mjs move <project> <title or file name> --section S [--priority N]
//   node queue.mjs archive <project> <title or file name> --reason R [--trail T]
//   node queue.mjs trackers <project> [--json]

import {run} from './lib/queue-cli.mjs';

try {
  await run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
