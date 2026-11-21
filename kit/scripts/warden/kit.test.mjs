import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fingerprint, MANIFEST, manifestGaps } from './kit.mjs';

const KIT = dirname(fileURLToPath(import.meta.url));

test('the kit is as its version delivered it', () => {
  const manifest = JSON.parse(readFileSync(join(KIT, MANIFEST), 'utf8'));
  const { changed, extra, missing } = manifestGaps(KIT, manifest);
  const advice = 'The kit is copied as is: what belongs to the project goes into config/, a kit fix is made in the Warden repository and installed again.';
  assert.deepEqual(changed, [], `edited since version ${manifest.version}: ${changed.join(', ')}. ${advice}`);
  assert.deepEqual(extra, [], `files added in scripts/warden/: ${extra.join(', ')}. ${advice}`);
  assert.deepEqual(missing, [], `kit files missing: ${missing.join(', ')}. Install the kit again.`);
});

test('a Windows line ending does not change the fingerprint', () => {
  assert.equal(fingerprint(Buffer.from('a\r\nb\r\n')), fingerprint(Buffer.from('a\nb\n')));
  assert.notEqual(fingerprint(Buffer.from('a\nb\n')), fingerprint(Buffer.from('a\nc\n')));
});
