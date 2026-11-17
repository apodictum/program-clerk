// The hygiene lint over the account's notes: frontmatter, empty or collapsed bodies, broken links,
// thinly linked topics and isolated project notes, notes past their type's retention, near-duplicate
// folders and titles, and the queue's shape. It reports and never fixes.
//
//   node lint.mjs [--quiet] [--category=a,b] [--max=N] [--no-fetch]
//
//   --quiet         one `category<TAB>path<TAB>detail` line a finding, none left out
//   --category=a,b  a subset of frontmatter, body, wikilinks, density, currency, duplicates, queue
//   --max=N         the findings the full report shows per category (40)
//   --no-fetch      no read of a sparse note's whole text, so its `related:` links go uncounted
//
// Exit 0 clean, 1 with findings, 2 on a usage error or a failed call.

import {run} from './lib/hygiene.mjs';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = err.exitCode ?? 2;
}
