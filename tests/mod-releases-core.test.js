const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  listModReleases,
  findModReleaseFile,
} = require('../mod-releases-core');

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((err) => {
      console.error(`not ok - ${name}`);
      process.nextTick(() => {
        throw err;
      });
    });
}

test('mod release scanner lists jar files with safe metadata newest first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-releases-'));
  const older = path.join(dir, 'autoauction-1.0.0.jar');
  const newer = path.join(dir, 'altmanager-1.0.0.jar');
  fs.writeFileSync(older, 'old jar');
  fs.writeFileSync(newer, 'new jar content');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
  fs.utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  fs.utimesSync(newer, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));

  const releases = listModReleases(dir);

  assert.deepStrictEqual(releases.map((release) => release.filename), [
    'altmanager-1.0.0.jar',
    'autoauction-1.0.0.jar',
  ]);
  assert.strictEqual(releases[0].modName, 'Alt Manager');
  assert.strictEqual(releases[1].modName, 'AutoAuction');
  assert.ok(releases[0].sizeBytes > releases[1].sizeBytes);
  assert.match(releases[0].sha256, /^[a-f0-9]{64}$/);
});

test('mod release lookup only returns jar files inside release directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-releases-'));
  fs.writeFileSync(path.join(dir, 'autoauction-1.0.0.jar'), 'jar');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'no');

  assert.strictEqual(findModReleaseFile(dir, 'autoauction-1.0.0.jar'), path.join(dir, 'autoauction-1.0.0.jar'));
  assert.strictEqual(findModReleaseFile(dir, 'readme.txt'), null);
  assert.strictEqual(findModReleaseFile(dir, '../autoauction-1.0.0.jar'), null);
  assert.strictEqual(findModReleaseFile(dir, 'missing.jar'), null);
});
