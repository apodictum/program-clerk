// `/pc check`: the checkout against the baseline `/wrap` recorded, and with `--update` the checkout
// recorded as the new baseline after the report.

import {projectOf, topOf} from './checkout.mjs';
import {NO_KEY, connectionOf} from './common.mjs';
import {driftReport, refreshBaseline} from './drift.mjs';
import {request} from './http.mjs';

export const USAGE = 'usage: check.mjs [--update]';

/** Resolves to the exit code: 0 when the checkout matches its baseline, 1 when it moved. */
export const run = async (
  argv,
  {env = process.env, cwd = process.cwd(), out = text => console.log(text), versionsOf} = {}
) => {
  const unknown = argv.filter(arg => arg !== '--update');
  if (unknown.length > 0) throw new TypeError(`unknown option: ${unknown[0]}\n${USAGE}`);
  const conn = connectionOf(env);
  if (conn === null) throw new Error(NO_KEY);
  const top = topOf(cwd);
  if (!top) throw new Error('no checkout here: run this in the project checkout');
  const project = projectOf(top);
  const api = (path, o = {}) => request(conn, path, {...o, env});
  const answer = await api(`/vault/projects/${project}/state.md`);
  if (answer === null || (answer.status !== 200 && answer.status !== 404)) {
    throw new Error(`the baseline could not be read: ${answer?.status ?? 'no answer'}`);
  }
  const {drifted, report} = await driftReport({
    top,
    project,
    baselineText: answer.status === 404 ? null : answer.text,
    versionsOf
  });
  out(report);
  if (argv.includes('--update')) {
    const written = await refreshBaseline({api, top, project, versionsOf});
    if (written === null || written.status >= 300) {
      throw new Error(`the baseline could not be written: ${written?.status ?? 'no answer'}`);
    }
    out(`baseline: projects/${project}/state.md`);
  }
  return drifted ? 1 : 0;
};
