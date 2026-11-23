// The kit fingerprints. The kit is copied as is into a project: `kit.json` gives its version and the fingerprint of each
// of its files, and the `kit.test.mjs` guard proves on every push that none was edited. What belongs to the project goes
// into config/, never into a kit script.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST = 'kit.json';

// A Windows line ending does not change the fingerprint: Git may convert it on checkout.
export function fingerprint(content) {
  return createHash('sha256').update(content.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
}

// The fingerprint of each file of the kit folder, the manifest excepted.
export function folderFingerprints(folder) {
  const files = {};
  for (const name of readdirSync(folder, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()) {
    if (name !== MANIFEST) files[name] = fingerprint(readFileSync(join(folder, name)));
  }
  return files;
}

// What separates a folder from its manifest: changed, extra and missing files.
export function manifestGaps(folder, manifest) {
  const present = folderFingerprints(folder);
  const expected = manifest.files ?? {};
  return {
    changed: Object.keys(present).filter((name) => name in expected && expected[name] !== present[name]),
    extra: Object.keys(present).filter((name) => !(name in expected)),
    missing: Object.keys(expected).filter((name) => !(name in present)),
  };
}

// -1, 0 or 1 between two "a.b.c" versions; an unreadable one counts as 0.0.0.
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? '0.0.0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}
