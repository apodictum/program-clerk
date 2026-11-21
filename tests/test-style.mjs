// The digest's styled form, as Claude Code draws it in a hook's message.

import test from 'tape-six';
import {styledOf} from '../plugins/program-clerk/scripts/lib/style.mjs';

test('every Markdown bullet draws as one', t => {
  t.equal(styledOf('- a\n* b\n+ c'), ' • a\n • b\n • c');
});

test('an emphasis at a line start is no bullet', t => {
  t.equal(styledOf('*a* b'), '\x1b[3ma\x1b[23m b');
  t.equal(styledOf('**a** b'), '\x1b[1ma\x1b[22m b');
});
