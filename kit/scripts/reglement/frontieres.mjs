// Les frontières de l'architecture, un adaptateur par langage. Une zone est un dossier de la racine ; sa règle dit les
// zones et les paquets qu'elle ne peut atteindre, même de loin, et les dépendances directes qu'elle ne nomme pas.
// Une exception (`sauf`) ne fait que raccourcir : celle qui ne sert plus est refusée.
//
//   "frontieres": {
//     "rust": { "crates": { "zones_interdites": ["apps"], "paquets_interdits": ["tauri*"] } },
//     "node": { "packages": { "zones_interdites": ["apps"] } }
//   }

import { posix } from 'node:path';

const normaliser = (chemin) => chemin.replaceAll('\\', '/');

function correspond(nom, motif) {
  return motif.endsWith('*') ? nom.startsWith(motif.slice(0, -1)) : nom === motif;
}

// Ce qu'une zone ne peut ni atteindre ni nommer. `dependances` : tout ce que le paquet atteint (`zone` null hors du
// dépôt) ; `directes` : ce que son manifeste nomme.
function juger({ nom, zone, regle, dependances, directes, manifeste }) {
  const ecarts = [];
  for (const { paquet: interdit, sauf = [], raison } of regle.directes_interdites ?? []) {
    const excepte = sauf.includes(nom);
    if (directes.has(interdit) && !excepte) {
      ecarts.push({ regle: 'frontiere', chemin: nom, message: `son ${manifeste} nomme ${interdit}, interdit depuis ${zone}/ : ${raison}` });
    }
    if (!directes.has(interdit) && excepte) {
      ecarts.push({ regle: 'frontiere', chemin: nom, message: `ne nomme plus ${interdit} : retirer son exception de config/reglement.json` });
    }
  }
  for (const dep of dependances) {
    if (dep.zone && (regle.zones_interdites ?? []).includes(dep.zone)) {
      ecarts.push({ regle: 'frontiere', chemin: nom, message: `dépend de ${dep.nom} (${dep.zone}/), interdit depuis ${zone}/` });
    }
    if ((regle.paquets_interdits ?? []).some((motif) => correspond(dep.nom, motif))) {
      ecarts.push({ regle: 'frontiere', chemin: nom, message: `dépend de ${dep.nom}, interdit depuis ${zone}/` });
    }
  }
  return ecarts;
}

// Rust : `meta` est la sortie de `cargo metadata`. Avec le graphe résolu, la frontière porte sur toutes les
// dépendances ; sans lui (--no-deps), sur les directes.
export function frontieresRust(meta, zones) {
  const ecarts = [];
  const racine = normaliser(meta.workspace_root);
  const zoneDeChemin = (dossier) => posix.relative(racine, normaliser(dossier)).split('/')[0];
  const zoneDeManifeste = (manifeste) => zoneDeChemin(posix.dirname(normaliser(manifeste)));
  const paquets = new Map(meta.packages.map((p) => [p.id, p]));
  const graphe = new Map((meta.resolve?.nodes ?? []).map((n) => [n.id, n.dependencies]));

  for (const id of meta.workspace_members) {
    const paquet = paquets.get(id);
    const zone = zoneDeManifeste(paquet.manifest_path);
    const regle = zones[zone];
    if (!regle) continue;
    const dependances = [];
    if (meta.resolve) {
      const vus = new Set();
      const pile = [...(graphe.get(id) ?? [])];
      while (pile.length) {
        const courant = pile.pop();
        if (vus.has(courant)) continue;
        vus.add(courant);
        pile.push(...(graphe.get(courant) ?? []));
      }
      for (const dep of vus) {
        const cible = paquets.get(dep);
        if (cible) dependances.push({ nom: cible.name, zone: cible.source ? null : zoneDeManifeste(cible.manifest_path) });
      }
    } else {
      for (const dep of paquet.dependencies ?? []) dependances.push({ nom: dep.name, zone: dep.path ? zoneDeChemin(dep.path) : null });
    }
    const directes = new Set((paquet.dependencies ?? []).map((dep) => dep.name));
    ecarts.push(...juger({ nom: paquet.name, zone, regle, dependances, directes, manifeste: 'Cargo.toml' }));
  }
  return ecarts;
}

const SECTIONS_NPM = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

// Node : les `package.json` de l'espace, `{ chemin: contenu }`. Un paquet de l'espace se reconnaît à son nom ; ce
// qu'il atteint par les autres paquets de l'espace compte aussi. Hors de l'espace, seules ses dépendances directes se
// voient : le verrou n'est pas lu.
export function frontieresNode(manifestes, zones) {
  const paquets = [];
  for (const [chemin, contenu] of Object.entries(manifestes)) {
    const segments = chemin.split('/');
    if (segments.length < 2) continue;
    const json = JSON.parse(contenu);
    if (!json.name) continue;
    const directes = new Set(SECTIONS_NPM.flatMap((section) => Object.keys(json[section] ?? {})));
    paquets.push({ nom: json.name, zone: segments[0], directes });
  }
  const parNom = new Map(paquets.map((p) => [p.nom, p]));
  const ecarts = [];
  for (const paquet of paquets) {
    const regle = zones[paquet.zone];
    if (!regle) continue;
    const vus = new Set();
    const pile = [...paquet.directes];
    while (pile.length) {
      const courant = pile.pop();
      if (vus.has(courant)) continue;
      vus.add(courant);
      pile.push(...(parNom.get(courant)?.directes ?? []));
    }
    const dependances = [...vus].map((nom) => ({ nom, zone: parNom.get(nom)?.zone ?? null }));
    ecarts.push(...juger({ nom: paquet.nom, zone: paquet.zone, regle, dependances, directes: paquet.directes, manifeste: 'package.json' }));
  }
  return ecarts;
}
