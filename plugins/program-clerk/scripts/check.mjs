// `/pc check`: the drift report for the checkout this runs in, against the baseline `/wrap`
// recorded; exit 1 when the checkout moved, 2 on a usage error.
//
//   node check.mjs [--update]
//
// `--update` records the checkout as the new baseline after the report.

import {run} from './lib/check.mjs';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = err instanceof TypeError ? 2 : 1;
}
