// What Warden prints, in English or French. English is canonical: commands, configuration keys, rule ids and file
// names never change with the locale; only this display text does.
//
// The locale is resolved in this order:
//   1. WARDEN_LOCALE (en or fr)
//   2. git config warden.locale
//   3. the system locale (LC_ALL, LC_MESSAGES, LANG, then the runtime's own)
//   4. English

import { spawnSync } from 'node:child_process';

import { EN } from './messages.en.mjs';
import { FR } from './messages.fr.mjs';

export const CATALOGS = { en: EN, fr: FR };
const SUPPORTED = Object.keys(CATALOGS);

const pick = (value) => {
  const code = String(value ?? '').trim().toLowerCase().slice(0, 2);
  return SUPPORTED.includes(code) ? code : null;
};

export function resolveLocale({ env = process.env, gitLocale = readGitLocale, systemLocale = readSystemLocale } = {}) {
  return pick(env.WARDEN_LOCALE) ?? pick(gitLocale()) ?? pick(env.LC_ALL) ?? pick(env.LC_MESSAGES) ?? pick(env.LANG) ?? pick(systemLocale()) ?? 'en';
}

function readGitLocale() {
  const out = spawnSync('git', ['config', '--get', 'warden.locale'], { encoding: 'utf8', windowsHide: true });
  return out.status === 0 ? out.stdout : null;
}

function readSystemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return null;
  }
}

let current = null;

// A message in the active locale, its `{name}` placeholders filled. A key missing in the locale falls back to English.
export function t(key, vars = {}) {
  current ??= resolveLocale();
  const text = CATALOGS[current][key] ?? EN[key];
  if (text === undefined) throw new Error(`message key missing: ${key}`);
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

// For the guards: forget the resolved locale.
export function resetLocale() {
  current = null;
}
