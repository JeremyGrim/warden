// Architecture boundaries, one adapter per language. A zone is a root folder; its rule names the zones and packages it
// may not reach, even transitively, and the direct dependencies it may not name. An exception (`except`) only ever
// shrinks: one that no longer serves is refused.
//
//   "boundaries": {
//     "rust": { "crates": { "forbidden_zones": ["apps"], "forbidden_packages": ["tauri*"] } },
//     "node": { "packages": { "forbidden_zones": ["apps"] } }
//   }

import { posix } from 'node:path';

import { t } from './messages.mjs';

const normalize = (path) => path.replaceAll('\\', '/');

function matches(name, pattern) {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

// What a zone may neither reach nor name. `dependencies`: everything the package reaches (`zone` null outside the
// repository); `direct`: what its manifest names.
function judge({ name, zone, rule, dependencies, direct, manifest }) {
  const findings = [];
  for (const { package: forbidden, except = [], reason } of rule.forbidden_direct ?? []) {
    const excepted = except.includes(name);
    if (direct.has(forbidden) && !excepted) {
      findings.push({ rule: 'boundary', path: name, message: t('boundary.direct', { manifest, forbidden, zone, reason }) });
    }
    if (!direct.has(forbidden) && excepted) {
      findings.push({ rule: 'boundary', path: name, message: t('boundary.stale_exception', { forbidden }) });
    }
  }
  for (const dep of dependencies) {
    if (dep.zone && (rule.forbidden_zones ?? []).includes(dep.zone)) {
      findings.push({ rule: 'boundary', path: name, message: t('boundary.zone', { dependency: dep.name, target: dep.zone, zone }) });
    }
    if ((rule.forbidden_packages ?? []).some((pattern) => matches(dep.name, pattern))) {
      findings.push({ rule: 'boundary', path: name, message: t('boundary.package', { dependency: dep.name, zone }) });
    }
  }
  return findings;
}

// Rust: `meta` is the output of `cargo metadata`. With the resolved graph, the boundary covers every dependency;
// without it (--no-deps), the direct ones.
export function rustBoundaries(meta, zones) {
  const findings = [];
  const root = normalize(meta.workspace_root);
  const zoneOfPath = (dir) => posix.relative(root, normalize(dir)).split('/')[0];
  const zoneOfManifest = (manifest) => zoneOfPath(posix.dirname(normalize(manifest)));
  const packages = new Map(meta.packages.map((p) => [p.id, p]));
  const graph = new Map((meta.resolve?.nodes ?? []).map((n) => [n.id, n.dependencies]));

  for (const id of meta.workspace_members) {
    const pkg = packages.get(id);
    const zone = zoneOfManifest(pkg.manifest_path);
    const rule = zones[zone];
    if (!rule) continue;
    const dependencies = [];
    if (meta.resolve) {
      const seen = new Set();
      const stack = [...(graph.get(id) ?? [])];
      while (stack.length) {
        const current = stack.pop();
        if (seen.has(current)) continue;
        seen.add(current);
        stack.push(...(graph.get(current) ?? []));
      }
      for (const dep of seen) {
        const target = packages.get(dep);
        if (target) dependencies.push({ name: target.name, zone: target.source ? null : zoneOfManifest(target.manifest_path) });
      }
    } else {
      for (const dep of pkg.dependencies ?? []) dependencies.push({ name: dep.name, zone: dep.path ? zoneOfPath(dep.path) : null });
    }
    const direct = new Set((pkg.dependencies ?? []).map((dep) => dep.name));
    findings.push(...judge({ name: pkg.name, zone, rule, dependencies, direct, manifest: 'Cargo.toml' }));
  }
  return findings;
}

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

// Node: the workspace `package.json` files, `{ path: content }`. A workspace package is known by its name; what it
// reaches through the other workspace packages counts too. Outside the workspace, only its direct dependencies are seen:
// the lockfile is not read.
export function nodeBoundaries(manifests, zones) {
  const packages = [];
  for (const [path, content] of Object.entries(manifests)) {
    const segments = path.split('/');
    if (segments.length < 2) continue;
    const json = JSON.parse(content);
    if (!json.name) continue;
    const direct = new Set(NPM_SECTIONS.flatMap((section) => Object.keys(json[section] ?? {})));
    packages.push({ name: json.name, zone: segments[0], direct });
  }
  const byName = new Map(packages.map((p) => [p.name, p]));
  const findings = [];
  for (const pkg of packages) {
    const rule = zones[pkg.zone];
    if (!rule) continue;
    const seen = new Set();
    const stack = [...pkg.direct];
    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(byName.get(current)?.direct ?? []));
    }
    const dependencies = [...seen].map((name) => ({ name, zone: byName.get(name)?.zone ?? null }));
    findings.push(...judge({ name: pkg.name, zone: pkg.zone, rule, dependencies, direct: pkg.direct, manifest: 'package.json' }));
  }
  return findings;
}
