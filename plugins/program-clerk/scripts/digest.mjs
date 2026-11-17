// `/pickup`'s digest for the project of the checkout it runs in, or the project it names:
//
//   node digest.mjs [project]

import {digestRun} from './lib/digest-run.mjs';

const [project] = process.argv.slice(2);
try {
  const {digest} = await digestRun({project});
  process.stdout.write(`${digest}\n`);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
