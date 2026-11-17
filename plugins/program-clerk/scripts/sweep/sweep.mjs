// `/sweep`'s control: `begin` measures, runs the one-shot maintenance, and prints the first plan;
// `next` measures again and prints the next plan, or the done report. Exit 2 on a usage error.
//
//   node sweep.mjs begin [--state=FILE] [--include=k,k] [--exclude=k,k] [--max-passes=N] [--max-rounds=N] [--dry-run]
//   node sweep.mjs next [--state=FILE]

import {run} from '../lib/sweep.mjs';

try {
  await run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = err instanceof TypeError ? 2 : 1;
}
