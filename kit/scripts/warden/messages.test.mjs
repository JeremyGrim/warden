import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CATALOGS, resolveLocale } from './messages.mjs';

const KIT = dirname(fileURLToPath(import.meta.url));
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every locale has the same keys and the same placeholders as English', () => {
  const english = CATALOGS.en;
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), `${locale}: keys`);
    for (const key of Object.keys(english)) assert.deepEqual(placeholders(catalog[key]), placeholders(english[key]), `${locale}: ${key}`);
  }
});

test('every key the kit prints exists in the catalog', () => {
  const used = new Set();
  for (const file of readdirSync(KIT).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) {
    for (const m of readFileSync(join(KIT, file), 'utf8').matchAll(/\bt\(\s*['`]([a-z_]+(?:\.[a-z_]+)+)['`]/g)) used.add(m[1]);
  }
  for (const key of ['status.role.factory', 'status.role.agent', 'status.role.unset', 'npm.passed', 'npm.failed', 'train.halt.baseline', 'train.halt.transient', 'train.halt.incomplete', 'version.not_semver', 'version.off_line', 'version.not_greater', 'version.line_behind']) used.add(key);
  const missing = [...used].filter((key) => !(key in CATALOGS.en));
  assert.deepEqual(missing, []);
});

test('the locale comes from WARDEN_LOCALE, then git, then the system, then English', () => {
  const none = () => null;
  assert.equal(resolveLocale({ env: { WARDEN_LOCALE: 'fr' }, gitLocale: () => 'en', systemLocale: none }), 'fr');
  assert.equal(resolveLocale({ env: {}, gitLocale: () => 'fr\n', systemLocale: none }), 'fr');
  assert.equal(resolveLocale({ env: { LANG: 'fr_FR.UTF-8' }, gitLocale: none, systemLocale: none }), 'fr');
  assert.equal(resolveLocale({ env: {}, gitLocale: none, systemLocale: () => 'fr-FR' }), 'fr');
  assert.equal(resolveLocale({ env: { LANG: 'de_DE.UTF-8' }, gitLocale: none, systemLocale: () => 'de-DE' }), 'en', 'an unsupported locale falls back to English');
  assert.equal(resolveLocale({ env: { WARDEN_LOCALE: 'xx' }, gitLocale: none, systemLocale: none }), 'en');
});
