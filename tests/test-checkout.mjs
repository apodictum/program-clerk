import test from 'tape-six';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {host, makeRepo, removeAll, scratch} from './helpers.mjs';
import {keysOf, normalizeRemote} from '../plugins/program-clerk/scripts/lib/checkout.mjs';

test('a remote URL normalizes as the shell hooks normalize it', t => {
  // Each pair is what `sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#^[^/@]*@##' -e 's#:#/#'
  // -e 's#\.git$##' -e 's#/$##'` prints, so a key computed on either side matches.
  const cases = [
    ['git@github.com:example/demo.git', 'github.com/example/demo'],
    ['https://github.com/example/demo.git', 'github.com/example/demo'],
    ['https://github.com/example/demo', 'github.com/example/demo'],
    ['https://github.com/example/demo/', 'github.com/example/demo'],
    ['ssh://git@github.com/example/demo.git', 'github.com/example/demo'],
    ['https://user@gitlab.example.com/group/sub/demo.git', 'gitlab.example.com/group/sub/demo'],
    ['https://github.com:443/example/demo.git', 'github.com/443/example/demo'],
    ['git+ssh://git@host.example:2222/x/y.git', 'host.example/2222/x/y'],
    ['', '']
  ];
  for (const [url, key] of cases) t.equal(normalizeRemote(url), key, url || '(none)');
});

test('the keys of a checkout in each mode', t => {
  const home = scratch();
  const repo = makeRepo(join(home, 'repo'), 'https://github.com/example/demo.git');
  const local = makeRepo(join(home, 'local'), null);
  t.deepEqual(keysOf(repo, 'repository'), {
    resource: 'repo:github.com/example/demo',
    role: 'repo:github.com/example/demo'
  });
  t.deepEqual(keysOf(repo, 'checkout'), {
    resource: `repo:github.com/example/demo@${host}:${repo}`,
    role: 'repo:github.com/example/demo'
  });
  t.deepEqual(keysOf(local, 'checkout'), {
    resource: `repo:${host}:${local}`,
    role: `repo:${host}:${local}`
  });
  t.deepEqual(keysOf(local, 'repository'), keysOf(local, 'checkout'));
  removeAll(home);
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const files = dir =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
// What a user reads: the plugin, the marketplace, and the documents; the tests are left out.
const shipped = () => [
  ...files(join(ROOT, 'plugins')),
  ...files(join(ROOT, '.claude-plugin')),
  ...files(join(ROOT, '.github')),
  ...readdirSync(ROOT)
    .filter(name => name.endsWith('.md'))
    .map(name => join(ROOT, name))
];

test('no text the plugin ships or the documents say names the old product', t => {
  const found = [];
  for (const file of shipped()) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      // The API's route for a note's text and the queue's tracker kind on the wire keep the name.
      const rest = line
        .replaceAll('\\/vault\\/', '')
        .replaceAll('`/vault/', '')
        .replaceAll("'vault'", '');
      if (/vault/i.test(rest)) found.push(`${relative(ROOT, file)}:${i + 1}`);
    });
  }
  t.deepEqual(found, []);
});
