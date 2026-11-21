#!/usr/bin/env node
// The repository rules, checked by code. The rules are in config/rules.json; the text that explains them is AGENTS.md,
// and both change together.
//
//   node scripts/warden/rules.mjs            the whole tree, boundaries included (the pre-push hook)
//   node scripts/warden/rules.mjs --staged   what is about to be committed (the pre-commit hook)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nodeBoundaries, rustBoundaries } from './boundaries.mjs';
import { checkFiles, compile } from './checks.mjs';
import { readJson, ROOT } from './config.mjs';
import { t } from './messages.mjs';

export { checkFiles, compile, countLines, readVersion } from './checks.mjs';
export { nodeBoundaries, rustBoundaries } from './boundaries.mjs';

function git(args) {
  const out = spawnSync('git', args, { cwd: ROOT, maxBuffer: 1 << 30, windowsHide: true });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout;
}

const split = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);

function readTree(path) {
  try {
    return readFileSync(join(ROOT, path));
  } catch {
    return null;
  }
}

const readBlob = (reference) => (path) => {
  const out = spawnSync('git', ['cat-file', 'blob', `${reference}:${path}`], { cwd: ROOT, maxBuffer: 1 << 30, windowsHide: true });
  return out.status === 0 ? out.stdout : null;
};

// Cargo says the lockfile is behind the manifests, and that `--locked` kept it from rewriting it.
export const staleLock = (stderr) => /needs to be updated but --locked was passed/.test(stderr);

function boundaries(all, rules, read) {
  const findings = [];
  const rust = rules.boundaries?.rust;
  if (rust && all.includes('Cargo.toml') && all.some((p) => p !== 'Cargo.toml' && posix.basename(p) === 'Cargo.toml')) {
    // Always `--locked`: a rule check that rewrote Cargo.lock in silence made a train refuse a sound branch
    // (20 November). A lockfile behind the manifests is a named finding, never a rewrite.
    let found = null;
    for (const options of [['--locked', '--offline'], ['--no-deps', '--locked', '--offline']]) {
      const out = spawnSync('cargo', ['metadata', '--format-version', '1', ...options], { cwd: ROOT, maxBuffer: 1 << 30, windowsHide: true });
      if (out.status === 0) {
        findings.push(...rustBoundaries(JSON.parse(out.stdout.toString('utf8')), rust));
        found = 'read';
        break;
      }
      if (staleLock(out.stderr.toString('utf8'))) {
        found = 'stale';
        break;
      }
    }
    if (found === 'stale') findings.push({ rule: 'boundary', path: 'Cargo.lock', message: t('boundary.lock_stale') });
    else if (!found) findings.push({ rule: 'boundary', path: 'Cargo.toml', message: t('boundary.metadata_failed') });
  }
  const node = rules.boundaries?.node;
  if (node) {
    const manifests = {};
    for (const path of all.filter((p) => posix.basename(p) === 'package.json')) {
      const content = read(path);
      if (content !== null) manifests[path] = content.toString('utf8');
    }
    findings.push(...nodeBoundaries(manifests, node));
  }
  return findings;
}

function main(argv) {
  const staged = argv.includes('--staged');
  const path = join(ROOT, 'config', 'rules.json');
  if (!existsSync(path)) {
    console.error(t('rules.no_config'));
    process.exitCode = 1;
    return;
  }
  const rules = compile(readJson(path));
  const all = staged ? split(git(['ls-files', '-z', '--cached'])) : split(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
  const files = staged ? split(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])) : all;
  const read = staged ? readBlob('') : readTree;
  const present = staged ? all : all.filter((p) => read(p) !== null);
  const hasCommit = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: ROOT, windowsHide: true }).status === 0;
  const readBefore = staged && hasCommit ? readBlob('HEAD') : () => null;

  const warnings = [];
  const findings = checkFiles({ files: staged ? files : present, all: present, rules, read, readBefore, warn: (w) => warnings.push(w) });
  if (!staged) findings.push(...boundaries(present, rules, read));

  // At commit time, each touched file nearing the ceiling is named; over the whole tree, one line counts them.
  if (staged) for (const { path: p, message } of warnings) console.log(`  [${t('rules.warning')}] ${p}: ${message}`);
  else if (warnings.length) console.log(t('rules.warnings', { count: warnings.length, lines: rules.warn_lines }));

  if (findings.length) {
    console.error(t('rules.findings', { count: findings.length }));
    for (const { rule, path: p, message } of findings) console.error(`  [${rule}] ${p}: ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(t('rules.ok', { count: present.length }));
  const hooks = spawnSync('git', ['config', 'core.hooksPath'], { cwd: ROOT, windowsHide: true }).stdout?.toString().trim();
  if (!process.env.CI && hooks !== '.githooks') console.log(t('rules.hooks_inactive'));
}

const launched = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (launched) main(process.argv.slice(2));
