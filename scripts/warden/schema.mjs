// The shape of the project configuration (docs/configuration.md): what each key of config/factory.json, rules.json and
// disk.json must be. A change is checked against it before it is deposited (change.mjs), rather than when the factory
// reads it and halts. A key the kit does not read is said as a warning, not refused: it changes nothing, and a
// misspelt key changes nothing either. Keys starting with `$` or `_` are comments.

import { t } from './messages.mjs';

export const CONFIG_FILES = { 'config/factory.json': 'factory', 'config/rules.json': 'rules', 'config/disk.json': 'disk' };

// A checker takes a value, where it sits, and the list of problems it adds to.
const fail = (out, path, expected) => out.push({ level: 'error', path: path || '/', expected });
const warn = (out, path, expected) => out.push({ level: 'warning', path: path || '/', expected });
const at = (path, key) => (path ? `${path}.${key}` : key);

const string = (v, p, out) => {
  if (typeof v !== 'string' || !v.trim()) fail(out, p, t('schema.string'));
};
const bool = (v, p, out) => {
  if (typeof v !== 'boolean') fail(out, p, t('schema.boolean'));
};
const int = (min) => (v, p, out) => {
  if (!Number.isInteger(v) || v < min) fail(out, p, t('schema.integer', { min }));
};
const number = (min) => (v, p, out) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) fail(out, p, t('schema.number', { min }));
};
const oneOf = (...values) => (v, p, out) => {
  if (!values.includes(v)) fail(out, p, t('schema.one_of', { values: values.map((x) => JSON.stringify(x)).join(', ') }));
};
const pattern = (v, p, out) => {
  if (typeof v !== 'string' || !v) return fail(out, p, t('schema.pattern'));
  try {
    new RegExp(v);
  } catch (error) {
    fail(out, p, t('schema.pattern_bad', { message: error.message }));
  }
  return undefined;
};
const line = (v, p, out) => {
  if (typeof v !== 'string' || !/^\d+\.\d+$/.test(v)) fail(out, p, t('schema.line'));
};
const reading = (v, p, out) => {
  if (typeof v !== 'string' || !/^(json|toml):[\w.-]+$/.test(v)) fail(out, p, t('schema.reading'));
};
// A command: an array, program first, as config.mjs runs it.
const command = (v, p, out) => {
  if (!Array.isArray(v) || !v.length || !v.every((word) => typeof word === 'string' && word.length)) fail(out, p, t('schema.command'));
};
const list = (item) => (v, p, out) => {
  if (!Array.isArray(v)) return fail(out, p, t('schema.list'));
  v.forEach((x, i) => item(x, `${p}[${i}]`, out));
  return undefined;
};
const nullable = (check) => (v, p, out) => {
  if (v !== null) check(v, p, out);
};
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const map = (item) => (v, p, out) => {
  if (!isObject(v)) return fail(out, p, t('schema.object'));
  for (const [key, value] of Object.entries(v)) item(value, at(p, key), out);
  return undefined;
};
const structure = (v, p, out) => {
  if (!v || typeof v !== 'object') fail(out, p, t('schema.structure'));
};
const object = (fields, required = []) => (v, p, out) => {
  if (!isObject(v)) return fail(out, p, t('schema.object'));
  for (const key of required) if (!(key in v)) fail(out, at(p, key), t('schema.required'));
  for (const [key, value] of Object.entries(v)) {
    if (fields[key]) fields[key](value, at(p, key), out);
    else if (!/^[$_]/.test(key)) warn(out, at(p, key), t('schema.unknown'));
  }
  return undefined;
};

const step = object({ title: string, when: list(string), command, unchanged: list(string) }, ['title', 'command']);

const FACTORY = object({
  main_branch: string,
  remote: string,
  work_dir: string,
  slot: object({ name: string, log: nullable(string) }),
  verify: object({
    rust: nullable(object({
      full_on: list(string),
      clippy: bool,
      tests: bool,
      separate: list(object({ package: string, args: list(string) }, ['package'])),
      deny: nullable(string),
    })),
    npm_advisories: nullable(object({ lockfile: string }, ['lockfile'])),
    steps: list(step),
    all: list(step),
    when_missing: oneOf('record', 'block'),
    transient_patterns: list(pattern),
  }),
  train: object({
    branch: string,
    dock: string,
    max_batch: int(1),
    install: nullable(object({ lockfile: string, command }, ['lockfile', 'command'])),
    build: nullable(object({ title: string, command }, ['title', 'command'])),
    min_free_memory_gib: number(0),
    memory_per_job_gib: number(0),
    retry_minutes: number(0),
    halt_notice_minutes: number(0),
  }),
  history: object({ keep_days: int(1) }),
  version: nullable(object({ line, files: list(object({ file: string, read: reading }, ['file', 'read'])) })),
  release: nullable(object({ build: command, artifacts: list(string), sign: nullable(command), check_signature: nullable(command) }, ['build', 'artifacts'])),
  fixes: list(oneOf('version', 'lock', 'generated', 'lint')),
});

const strings = list(string);
const RULES = object({
  root: object({ dirs: strings, files: strings }),
  required: strings,
  forbidden_segments: strings,
  forbidden_extensions: strings,
  forbidden_lockfiles: strings,
  max_size_kib: int(1),
  size_exceptions: map(int(1)),
  max_lines: int(1),
  warn_lines: int(1),
  lines_exempt: strings,
  secrets: list(object({ name: string, pattern }, ['name', 'pattern'])),
  secret_exceptions: structure,
  foreign_code: structure,
  single_source: object({ file: string, points_to: string, max_lines: int(1) }),
  docs: structure,
  versions: list(object({ file: string, read: reading }, ['file', 'read'])),
  boundaries: structure,
  single_test_binary: structure,
  provenance: structure,
  registry: structure,
  debts: structure,
  chokepoints: structure,
});

const DISK = object({
  min_free_gib: number(0),
  max_build_gib: number(0),
  max_incremental_gib: number(0),
  max_worktrees: int(0),
  max_worktree_age_days: int(0),
  frozen_copies: strings,
  roots: strings,
  builds: strings,
  shared_caches: list(object({ path: string, max_gib: nullable(number(0)) }, ['path'])),
});

const SPECS = { factory: FACTORY, rules: RULES, disk: DISK };

// The problems of a configuration file's text: `{ level, path, expected }`, errors first. An error blocks a deposit; a
// warning is said.
export function checkConfig(name, text) {
  const out = [];
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return [{ level: 'error', path: '/', expected: t('schema.json', { message: error.message }) }];
  }
  SPECS[name](value, '', out);
  if (name === 'rules' && isObject(value) && Number.isInteger(value.warn_lines) && Number.isInteger(value.max_lines) && value.warn_lines > value.max_lines) {
    fail(out, 'warn_lines', t('schema.warn_above_max'));
  }
  // What names one workstation is never committed: it belongs to config/disk.local.json.
  if (name === 'disk' && isObject(value)) {
    for (const key of ['roots', 'builds', 'shared_caches']) if (key in value) warn(out, key, t('schema.local_only'));
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}
