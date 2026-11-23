// The kit fingerprints. The kit is copied as is into a project: `kit.json` gives its version and the fingerprint of each
// of its files, and the `kit.test.mjs` guard proves on every push that none was edited. What belongs to the project goes
// into config/, never into a kit script.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

// The workstation list the interface covers (`git config --global warden.projects`, docs/interface.md). A clone the kit
// rules is put on it once, by its main root: at install, or at the first session of the plugin in it. The mark, in the
// clone's Git folder, keeps off the list a project the person removed from it.
export const LISTED_MARK = 'warden-listed.json';
const samePlace = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

export function listOnWorkstation(tree, { now = new Date().toISOString() } = {}) {
  const git = (args) => {
    const out = spawnSync('git', args, { cwd: tree, encoding: 'utf8', windowsHide: true });
    return { ok: out.status === 0, out: (out.stdout ?? '').trim() };
  };
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok || !common.out) return { state: 'not_git' };
  const root = resolve(dirname(common.out));
  const mark = join(common.out, LISTED_MARK);
  if (existsSync(mark)) return { state: 'marked', root };
  const listed = git(['config', '--global', '--get-all', 'warden.projects']);
  const values = listed.ok ? listed.out.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) : [];
  const already = values.some((value) => samePlace(value, root));
  if (!already && !git(['config', '--global', '--add', 'warden.projects', root]).ok) return { state: 'failed', root };
  try {
    writeFileSync(mark, `${JSON.stringify({ path: root, at: now }, null, 2)}\n`);
  } catch {
    // A Git folder that cannot be written: the project is listed, and a removal may be undone at the next session.
  }
  return { state: already ? 'already' : 'listed', root };
}

// -1, 0 or 1 between two "a.b.c" versions; an unreadable one counts as 0.0.0.
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? '0.0.0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}
