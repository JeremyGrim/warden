// The rule checks over a list of files. Nothing here reads the disk or Git: `read` gives the content of a path (or
// null), `readBefore` the content at the previous commit. Each check runs only when its section is present in
// config/rules.json.

import { extname, posix } from 'node:path';

import { t } from './messages.mjs';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compile(rules) {
  const docs = rules.docs;
  return {
    ...rules,
    root: rules.root ?? null,
    required: rules.required ?? [],
    lines_exempt: rules.lines_exempt ?? [],
    size_exceptions: rules.size_exceptions ?? {},
    forbidden_segments: rules.forbidden_segments ?? [],
    forbidden_extensions: (rules.forbidden_extensions ?? []).map((e) => e.toLowerCase()),
    forbidden_lockfiles: rules.forbidden_lockfiles ?? [],
    secrets: (rules.secrets ?? []).map(({ name, pattern }) => ({ name, pattern: new RegExp(pattern) })),
    secret_exceptions: rules.secret_exceptions ?? {},
    foreign_code: rules.foreign_code ?? {},
    docs: docs
      ? {
          dir: docs.dir ?? 'docs/',
          max_files: docs.max_files ?? null,
          forbidden_names: (docs.forbidden_names ?? []).map((p) => new RegExp(p, 'i')),
          forbidden_status: docs.forbidden_status ? new RegExp(docs.forbidden_status, 'i') : null,
        }
      : null,
    chokepoints: (rules.chokepoints ?? []).map((c) => ({ ...c, pattern: new RegExp(c.pattern), zones: c.zones ?? [''], exceptions: c.exceptions ?? {} })),
    debts: (rules.debts ?? []).map((d) => ({ ...d, pattern: new RegExp(d.pattern, 'i') })),
  };
}

export function isText(content) {
  return !content.subarray(0, 8000).includes(0);
}

export function countLines(content) {
  if (content.length === 0) return 0;
  let lines = 0;
  for (const byte of content) if (byte === 10) lines += 1;
  return content.at(-1) === 10 ? lines : lines + 1;
}

// The version a file declares, by its reading: `json:<key.key>` or `toml:<table.key>` (`toml:version` for a key
// outside any table).
export function readVersion(text, reading) {
  const [format, path = ''] = reading.split(':');
  const keys = path.split('.').filter(Boolean);
  if (format === 'json') {
    let value = JSON.parse(text);
    for (const key of keys) value = value?.[key];
    return typeof value === 'string' ? value : null;
  }
  if (format === 'toml') {
    const key = keys.pop();
    let block = text;
    if (keys.length) {
      const header = new RegExp(`^\\[${escape(keys.join('.'))}\\][ \\t]*\\r?$`, 'm').exec(text);
      if (!header) return null;
      block = text.slice(header.index + header[0].length);
    }
    const end = /^\[/m.exec(block);
    if (end) block = block.slice(0, end.index);
    return new RegExp(`^${escape(key)}\\s*=\\s*"([^"]+)"`, 'm').exec(block)?.[1] ?? null;
  }
  throw new Error(t('version.unknown_reading', { reading }));
}

const isForeign = (path, rules) => Object.keys(rules.foreign_code).some((dir) => path.startsWith(dir));

function checkFile(path, rules, read, report, warn) {
  const segments = path.split('/');
  const name = segments.at(-1);

  if (rules.root) {
    if (segments.length === 1) {
      if (!rules.root.files.includes(name)) report('root', path, t('root.file'));
    } else if (!rules.root.dirs.includes(segments[0])) {
      report('root', path, t('root.dir', { dir: segments[0] }));
    }
  }

  const segment = segments.find((s) => rules.forbidden_segments.includes(s));
  if (segment) report('artifact', path, t('artifact.segment', { segment }));
  const extension = extname(name).toLowerCase();
  if (rules.forbidden_extensions.includes(extension)) report('artifact', path, t('artifact.extension', { extension }));
  if (rules.forbidden_lockfiles.includes(name)) report('lockfile', path, t('lockfile.second', { name }));

  const content = read(path);
  if (content === null) return;

  const foreign = isForeign(path, rules);
  const kib = content.length / 1024;
  const ceiling = rules.size_exceptions[path] ?? rules.max_size_kib;
  if (ceiling && kib > ceiling && !foreign) report('size', path, t('size.over', { size: Math.ceil(kib), max: ceiling }));
  if (!isText(content)) return;

  if (rules.max_lines && !foreign && !rules.lines_exempt.includes(name) && !rules.lines_exempt.includes(path)) {
    const lines = countLines(content);
    if (lines > rules.max_lines) {
      report('lines', path, t('lines.over', { lines, max: rules.max_lines }));
    } else if (rules.warn_lines && lines > rules.warn_lines) {
      // Not a finding: the file is split at its next touch, before it hits the ceiling.
      warn('lines', path, t('lines.warn', { lines, max: rules.max_lines }));
    }
  }

  const text = content.toString('utf8');
  const allowed = rules.secret_exceptions[path] ?? {};
  for (const { name: kind, pattern } of rules.secrets) {
    if (pattern.test(text) && !allowed[kind]) report('secret', path, t('secret.found', { kind }));
  }
  if (rules.docs?.forbidden_status && path.startsWith(rules.docs.dir) && rules.docs.forbidden_status.test(text.slice(0, 600))) {
    report('docs', path, t('docs.status'));
  }
  // A chokepoint: what must go through its source (an interface text, a colour) is never written inline.
  for (const c of rules.chokepoints) {
    const inZone = c.zones.some((zone) => path.startsWith(zone));
    const rightExtension = !c.extensions || c.extensions.includes(extension);
    if (inZone && rightExtension && !foreign && !c.exceptions[path] && c.pattern.test(text)) {
      report('chokepoint', path, `${c.name}: ${c.message ?? t('chokepoint.default')}`);
    }
  }
}

function checkDocs(all, rules, report) {
  const docs = rules.docs;
  if (!docs) return;
  const files = all.filter((p) => p.startsWith(docs.dir));
  if (docs.max_files && files.length > docs.max_files) report('docs', docs.dir, t('docs.count', { count: files.length, max: docs.max_files }));
  for (const path of files) {
    if (docs.forbidden_names.some((p) => p.test(posix.basename(path)))) report('docs', path, t('docs.name', { dir: docs.dir }));
  }
}

// One source of rules: the agent file of a given tool only points to it.
function checkSingleSource(all, rules, read, report) {
  const source = rules.single_source;
  if (!source || !all.includes(source.file)) return;
  const content = read(source.file);
  if (content === null) return;
  const lines = content.toString('utf8').split('\n').filter((l) => l.trim());
  if (lines.length > (source.max_lines ?? 3) || !content.includes(source.points_to)) {
    report('single-source', source.file, t('single_source', { file: source.file, target: source.points_to }));
  }
}

function checkVersions(all, rules, read, report) {
  const found = [];
  for (const { file, read: reading } of rules.versions ?? []) {
    if (!all.includes(file)) continue;
    const content = read(file);
    if (content !== null) found.push({ file, version: readVersion(content.toString('utf8'), reading) });
  }
  if (found.length > 1 && found.some((f) => f.version !== found[0].version)) {
    report('version', found[1].file, t('version.mismatch', { list: found.map((f) => `${f.file} ${f.version}`).join(', ') }));
  }
}

// The elements of a list of zones: `zone/name`, for each first-level folder that holds something.
export function elementsOf(all, zones) {
  const elements = new Set();
  for (const path of all) {
    const [zone, name, ...rest] = path.split('/');
    if (zones.includes(zone) && name && rest.length) elements.add(`${zone}/${name}`);
  }
  return elements;
}

// The names a provenance file uses, when it has its own (`"keys": { "origin": "origine", "new": "neuf" }`).
export const PROVENANCE_KEYS = { elements: 'elements', sources: 'sources', origin: 'origin', revision: 'revision', path: 'path', new: 'new' };

function checkProvenance(all, rules, read, report) {
  const section = rules.provenance;
  if (!section) return;
  const k = { ...PROVENANCE_KEYS, ...section.keys };
  const present = elementsOf(all, section.zones);
  const content = all.includes(section.file) ? read(section.file) : null;
  const provenance = content ? JSON.parse(content.toString('utf8')) : {};
  const elements = provenance[k.elements] ?? {};
  const sources = provenance[k.sources] ?? {};
  for (const element of present) {
    const card = elements[element];
    if (!card) report('provenance', element, t('provenance.missing', { file: section.file }));
    else if (card[k.origin] !== k.new && !(sources[card[k.origin]] && card[k.revision] && card[k.path])) {
      report('provenance', element, t('provenance.incomplete', { origin: k.origin, revision: k.revision, path: k.path, new: k.new }));
    }
  }
  for (const element of Object.keys(elements)) {
    if (!present.has(element)) report('provenance', element, t('provenance.absent', { file: section.file }));
  }
}

// Each file in tests/ makes a test binary, and each binary links the whole crate: one per crate.
function checkTestBinaries(all, rules, report) {
  const zones = rules.single_test_binary?.zones;
  if (!zones?.length) return;
  const pattern = new RegExp(`^((?:${zones.map(escape).join('|')})/[^/]+)/tests/(?:[^/]+\\.rs|[^/]+/main\\.rs)$`);
  const perCrate = new Map();
  for (const path of all) {
    const found = pattern.exec(path);
    if (found) perCrate.set(found[1], (perCrate.get(found[1]) ?? 0) + 1);
  }
  for (const [element, count] of perCrate) {
    if (count > 1) report('test-binary', `${element}/tests/`, t('test_binary.many', { count }));
  }
}

// The strings a registry holds at a path: `a.b` a key, `a[]` each item of a list, `*` each value of an object
// (`categories.*`, `modules[].elements`). A list found at the end gives its strings.
export function namesAt(value, path) {
  let found = [value];
  for (const segment of path.split('.')) {
    const each = segment.endsWith('[]');
    const key = each ? segment.slice(0, -2) : segment;
    found = found.flatMap((v) => {
      if (!v || typeof v !== 'object') return [];
      const got = key === '*' ? Object.values(v) : [v[key]];
      return each ? got.flatMap((x) => (Array.isArray(x) ? x : [])) : got;
    });
  }
  return found.flat().filter((x) => typeof x === 'string');
}

// Where a missing component may go, as the message names it: the keys under a `*`, else the path itself.
function placesOf(value, paths) {
  return paths.flatMap((path) => {
    if (!path.endsWith('.*')) return [path];
    const parent = path.slice(0, -2).split('.').reduce((v, key) => (v && typeof v === 'object' ? v[key] : undefined), value);
    return parent && typeof parent === 'object' ? Object.keys(parent) : [];
  });
}

// Every component has a declared place, and the declaration names only what is in the repository. The registry lists
// `zone/name` by default; with `"names": "folder"`, the folder name alone, as a product catalogue does.
function checkRegistry(all, rules, read, report) {
  const section = rules.registry;
  if (!section) return;
  const lists = section.lists ?? ['categories.*'];
  const byFolder = section.names === 'folder';
  const present = new Set([...elementsOf(all, section.zones)].map((e) => (byFolder ? e.split('/')[1] : e)));
  const content = all.includes(section.file) ? read(section.file) : null;
  const registry = content ? JSON.parse(content.toString('utf8')) : {};
  const filed = new Set(lists.flatMap((path) => namesAt(registry, path)));
  const places = placesOf(registry, lists).join(', ') || '…';
  for (const element of present) {
    if (!filed.has(element)) report('registry', element, t('registry.missing', { file: section.file, categories: places }));
  }
  for (const element of filed) {
    if (!present.has(element)) report('registry', element, t('registry.absent', { file: section.file }));
  }
}

// A debt is watched shrinking in one single place: nothing named after it elsewhere, and its file never grows.
function checkDebts(files, all, rules, read, readBefore, report) {
  for (const debt of rules.debts) {
    for (const path of all) {
      if (path.startsWith(debt.root) && path !== debt.file && debt.pattern.test(posix.basename(path))) {
        report('debt', path, t('debt.elsewhere', { name: debt.name, file: debt.file }));
      }
    }
    if (!debt.must_not_grow || !files.includes(debt.file)) continue;
    const before = readBefore(debt.file);
    const now = read(debt.file);
    if (before && now && countLines(now) > countLines(before)) {
      report('debt', debt.file, t('debt.grows', { name: debt.name, now: countLines(now), before: countLines(before) }));
    }
  }
}

/** Findings refuse; `warn` receives what does not refuse yet (a file nearing the ceiling). */
export function checkFiles({ files, all = files, rules, read, readBefore = () => null, warn = () => {} }) {
  const findings = [];
  const report = (rule, path, message) => findings.push({ rule, path, message });
  const notice = (rule, path, message) => warn({ rule, path, message });

  for (const path of files) checkFile(path, rules, read, report, notice);
  for (const path of rules.required) {
    if (!all.includes(path)) report('root', path, t('root.required'));
  }
  checkDocs(all, rules, report);
  checkSingleSource(all, rules, read, report);
  checkVersions(all, rules, read, report);
  checkProvenance(all, rules, read, report);
  checkTestBinaries(all, rules, report);
  checkRegistry(all, rules, read, report);
  checkDebts(files, all, rules, read, readBefore, report);
  return findings;
}
