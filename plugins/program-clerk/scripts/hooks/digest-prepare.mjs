// SessionStart at a fresh start, run in the background: collects the checkout's GitHub repository
// ahead of a `/pickup`, so the digest has nothing slow left to do. It only reads GitHub and the
// account, and writes only its collection under the cache folder.

import {SESSION_ID, readPayload} from '../lib/common.mjs';
import {prepareCollection} from '../lib/digest-run.mjs';

const payload = readPayload();
const session = typeof payload.session_id === 'string' ? payload.session_id : '';
if (!payload.agent_id && SESSION_ID.test(session)) {
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  await prepareCollection({cwd, session}).catch(() => {});
}
