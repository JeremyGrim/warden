// What a project already carries when it adopts Warden: the advisories its dependencies have. Each becomes a named debt,
// with its reason, where its check reads it: `[advisories] ignore` of config/deny.toml for Rust, and
// `verify.npm_advisories.ignore` of config/factory.json for npm. The first push is then not refused for what it did not
// bring, and a new advisory still blocks. Only at adoption: once that file is on the remote main branch, the installer
// adds nothing to it, and accepting an advisory is the person's decision, written by hand with its reason.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { run as runStep } from '../kit/scripts/warden/config.mjs';
import { auditNpmLockLocally } from '../kit/scripts/warden/npm-audit.mjs';

const clean = (text) => String(text).replace(/["\\\r\n]/g, "'");

// The advisories of a `cargo deny --format json check` run, one debt per advisory; what else refuses (a license, a
// source, a ban) is said, never accepted for the person.
export function denyDebts(lines, date) {
  const debts = new Map();
  const others = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const f = entry?.fields;
    if (entry?.type !== 'diagnostic' || f?.severity !== 'error') continue;
    const krate = f.graphs?.[0]?.Krate;
    const what = krate ? `${krate.name} ${krate.version}` : null;
    if (f.advisory?.id) {
      if (!debts.has(f.advisory.id)) debts.set(f.advisory.id, { id: f.advisory.id, reason: clean(`present when Warden was adopted, ${date}: ${what ?? f.advisory.package ?? '?'}, ${f.code ?? 'advisory'}`) });
    } else {
      others.push(`${f.code ?? 'error'}: ${f.message ?? '?'}${what ? ` (${what})` : ''}`);
    }
  }
  return { debts: [...debts.values()], others };
}

// config/deny.toml with these debts in `[advisories] ignore`, the ones already named kept. Null without that section.
export function withIgnored(toml, debts) {
  const head = /^\[advisories\][^\S\r\n]*$/m.exec(toml);
  if (!head) return null;
  const start = head.index + head[0].length;
  const next = /^\[/m.exec(toml.slice(start));
  const end = next ? start + next.index : toml.length;
  const body = toml.slice(start, end);
  const known = new Set([...body.matchAll(/id\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
  const added = debts.filter((d) => !known.has(d.id)).map((d) => `  { id = "${clean(d.id)}", reason = "${clean(d.reason)}" },`);
  if (!added.length) return toml;
  const array = /^ignore\s*=\s*\[([^\]]*)\]/m.exec(body);
  let updated;
  if (array) {
    const kept = array[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => `  ${l}`);
    const last = kept.at(-1)?.trim() ?? '';
    if (last && !last.endsWith(',') && !last.startsWith('#')) kept[kept.length - 1] += ',';
    updated = `${body.slice(0, array.index)}ignore = [\n${[...kept, ...added].join('\n')}\n]${body.slice(array.index + array[0].length)}`;
  } else {
    updated = `${body.replace(/\s*$/, '\n')}ignore = [\n${added.join('\n')}\n]\n\n`;
  }
  return toml.slice(0, start) + updated + toml.slice(end);
}

// The npm advisories that would refuse (HIGH, CRITICAL), one debt per advisory.
export function npmDebts(result, date) {
  const debts = new Map();
  for (const f of result.findings ?? []) {
    if (['HIGH', 'CRITICAL'].includes(f.severity) && !debts.has(f.id)) {
      debts.set(f.id, { id: f.id, reason: clean(`present when Warden was adopted, ${date}: ${f.package.name}@${f.package.version}, ${f.severity}`) });
    }
  }
  return [...debts.values()];
}

// The findings of the rules on what the project already holds, named where the rules read them: a file over the lines
// in `lines_exempt`, a file over the size in `size_exceptions`, a secret pattern in `secret_exceptions` with its reason,
// two manifests that disagree by leaving `versions` out (the product's manifests are never edited by the install). The
// rest (a committed artifact, a second lockfile…) is said, and still refuses. `_adopted` keeps the list, dated.
export function rulesDebts(rules, findings, date) {
  const next = structuredClone(rules);
  const named = { lines: [], size: [], secret: [], versions: null };
  const left = [];
  const reason = `present when Warden was adopted, ${date}`;
  for (const f of findings) {
    if (f.rule === 'lines' && f.detail?.lines) {
      next.lines_exempt = [...new Set([...(next.lines_exempt ?? []), f.path])];
      named.lines.push(`${f.path} (${f.detail.lines})`);
    } else if (f.rule === 'size' && f.detail?.kib) {
      next.size_exceptions = { ...next.size_exceptions, [f.path]: f.detail.kib };
      named.size.push(`${f.path} (${f.detail.kib} KiB)`);
    } else if (f.rule === 'secret' && f.detail?.kind) {
      next.secret_exceptions = { ...next.secret_exceptions, [f.path]: { ...next.secret_exceptions?.[f.path], [f.detail.kind]: reason } };
      named.secret.push({ path: f.path, kind: f.detail.kind });
    } else if (f.rule === 'version' && next.versions) {
      named.versions = f.message;
      delete next.versions;
    } else {
      left.push(f);
    }
  }
  const count = named.lines.length + named.size.length + named.secret.length + (named.versions ? 1 : 0);
  if (count) {
    next._adopted = {
      date, why: 'What the repository held when Warden was adopted: named here so that only what is new refuses. Each one is a debt to repay, then to remove.',
      lines: named.lines, size: named.size, secrets: named.secret.map((s) => `${s.path} (${s.kind})`), ...(named.versions ? { versions: named.versions } : {}),
    };
  }
  return { rules: next, named, count, left };
}

// The first line that says the failure, else the last one: what the person reads first.
export function firstError(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const said = lines.find((l) => /\berror\b|✖|failed|FAIL|panicked/i.test(l)) ?? lines.at(-1) ?? '';
  return said.slice(0, 300);
}

// The project steps tried once on the repository as it stands, after its dependencies are installed. A step that fails
// today is left out: declared, it would refuse every push and halt every train for what nobody brought. It is kept,
// with its first error, under `_adopted.failing`, to be declared again once repaired.
export function adoptSteps(factory, exec) {
  const steps = factory.verify?.steps ?? [];
  if (!steps.length) return null;
  const install = factory.train?.install?.command;
  if (install) {
    const r = exec(install);
    if (r.status !== 0) return { error: `${install.join(' ')}: ${firstError(`${r.stdout ?? ''}\n${r.stderr ?? ''}`)}` };
  }
  const kept = [];
  const failing = [];
  for (const step of steps) {
    const r = exec(step.command);
    if (r.status === 0) kept.push(step);
    else failing.push({ title: step.title, command: step.command, first_error: firstError(`${r.stdout ?? ''}\n${r.stderr ?? ''}`) });
  }
  return { kept, failing };
}

function git(root, args) {
  const out = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return { ok: out.status === 0, out: (out.stdout ?? '').trim() };
}

// Records the debts of an adopting project, after the install wrote its configuration. Returns what it found, for the
// installer to say: `{ rust, npm }`, each null when not looked at, else `{ debts, others }` or `{ error }`.
export function adoptDebts(root, { now = new Date(), run = spawnSync, audit = auditNpmLockLocally, exec = (command) => runStep(command, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }) } = {}) {
  const factoryPath = join(root, 'config', 'factory.json');
  const factory = JSON.parse(readFileSync(factoryPath, 'utf8'));
  const tracking = `${factory.remote ?? 'origin'}/${factory.main_branch ?? 'main'}`;
  const adopting = (path) => !git(root, ['cat-file', '-e', `${tracking}:${path}`]).ok;
  const date = now.toISOString().slice(0, 10);
  const report = { rust: null, npm: null, rules: null, steps: null };
  let factoryChanged = false;

  const rulesPath = join(root, 'config', 'rules.json');
  if (existsSync(rulesPath) && adopting('config/rules.json')) {
    const out = run(process.execPath, ['scripts/warden/rules.mjs', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
    let found = null;
    try {
      found = JSON.parse(out.stdout ?? '');
    } catch {
      report.rules = { error: (out.stderr ?? '').trim().split(/\r?\n/).at(-1) || `exit ${out.status}` };
    }
    if (found) {
      const { rules, named, count, left } = rulesDebts(JSON.parse(readFileSync(rulesPath, 'utf8')), found.findings ?? [], date);
      if (count) writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`);
      report.rules = { named, count, left };
    }
  }

  const deny = factory.verify?.rust?.deny;
  if (deny && existsSync(join(root, deny)) && adopting(deny)) {
    const out = run('cargo', ['deny', '--locked', '--format', 'json', '--config', deny, 'check'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
    const text = `${out.stderr ?? ''}\n${out.stdout ?? ''}`;
    const { debts, others } = denyDebts(text.split(/\r?\n/), date);
    if (out.error || out.status === null || (out.status !== 0 && !debts.length && !others.length)) {
      report.rust = { error: (out.error?.message ?? text.trim().split(/\r?\n/).filter((l) => !l.startsWith('{')).at(-1)) || `exit ${out.status}` };
    } else {
      const toml = readFileSync(join(root, deny), 'utf8');
      const updated = debts.length ? withIgnored(toml, debts) : toml;
      if (updated === null) report.rust = { error: `${deny}: no [advisories] section` };
      else {
        if (updated !== toml) writeFileSync(join(root, deny), updated);
        report.rust = { debts, others };
      }
    }
  }

  if (adopting('config/factory.json')) {
    const tried = adoptSteps(factory, exec);
    if (tried?.failing?.length) {
      factory.verify.steps = tried.kept;
      factory._adopted = { date, why: 'Steps that failed on the repository as it stood when Warden was adopted: declared again once repaired.', failing: tried.failing };
      factoryChanged = true;
    }
    report.steps = tried;
  }

  const npm = factory.verify?.npm_advisories;
  const database = process.env.WARDEN_GHSA_DATABASE || git(root, ['config', '--get', 'warden.ghsa']).out || null;
  if (npm?.lockfile && database && existsSync(join(root, npm.lockfile)) && adopting('config/factory.json')) {
    try {
      const debts = npmDebts(audit({ lockfile: join(root, npm.lockfile), database, now }), date);
      const known = new Set((npm.ignore ?? []).map((d) => d.id));
      const added = debts.filter((d) => !known.has(d.id));
      if (added.length) {
        factory.verify.npm_advisories = { ...npm, ignore: [...(npm.ignore ?? []), ...added] };
        factoryChanged = true;
      }
      report.npm = { debts, others: [] };
    } catch (error) {
      report.npm = { error: error.message };
    }
  }
  if (factoryChanged) writeFileSync(factoryPath, `${JSON.stringify(factory, null, 2)}\n`);
  return report;
}
