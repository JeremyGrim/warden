#!/usr/bin/env node
// Le règlement du dépôt, vérifié par le code. Les règles sont dans config/reglement.json ; le texte qui les explique est
// dans AGENTS.md, et les deux changent ensemble.
//
//   node scripts/reglement/reglement.mjs           tout l'arbre, frontières comprises (le crochet pre-push)
//   node scripts/reglement/reglement.mjs --index   ce qui va être commité (le crochet pre-commit)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lireJson, RACINE } from './config.mjs';
import { compiler, verifierFichiers } from './controles.mjs';
import { frontieresNode, frontieresRust } from './frontieres.mjs';

export { compiler, compterLignes, lireVersion, verifierFichiers } from './controles.mjs';
export { frontieresNode, frontieresRust } from './frontieres.mjs';

function git(args) {
  const sortie = spawnSync('git', args, { cwd: RACINE, maxBuffer: 1 << 30, windowsHide: true });
  if (sortie.status !== 0) throw new Error(`git ${args.join(' ')} : ${sortie.stderr}`);
  return sortie.stdout;
}

const decouper = (tampon) => tampon.toString('utf8').split('\0').filter(Boolean);

function lireArbre(chemin) {
  try {
    return readFileSync(join(RACINE, chemin));
  } catch {
    return null;
  }
}

const lireBlob = (reference) => (chemin) => {
  const sortie = spawnSync('git', ['cat-file', 'blob', `${reference}:${chemin}`], { cwd: RACINE, maxBuffer: 1 << 30, windowsHide: true });
  return sortie.status === 0 ? sortie.stdout : null;
};

function frontieres(tous, regles, lire) {
  const ecarts = [];
  const rust = regles.frontieres?.rust;
  if (rust && tous.includes('Cargo.toml') && tous.some((c) => c !== 'Cargo.toml' && posix.basename(c) === 'Cargo.toml')) {
    let lu = false;
    for (const options of [['--locked', '--offline'], ['--no-deps', '--offline']]) {
      const sortie = spawnSync('cargo', ['metadata', '--format-version', '1', ...options], { cwd: RACINE, maxBuffer: 1 << 30, windowsHide: true });
      if (sortie.status === 0) {
        ecarts.push(...frontieresRust(JSON.parse(sortie.stdout.toString('utf8')), rust));
        lu = true;
        break;
      }
    }
    if (!lu) ecarts.push({ regle: 'frontiere', chemin: 'Cargo.toml', message: 'cargo metadata a échoué : frontières non vérifiées' });
  }
  const node = regles.frontieres?.node;
  if (node) {
    const manifestes = {};
    for (const chemin of tous.filter((c) => posix.basename(c) === 'package.json')) {
      const contenu = lire(chemin);
      if (contenu !== null) manifestes[chemin] = contenu.toString('utf8');
    }
    ecarts.push(...frontieresNode(manifestes, node));
  }
  return ecarts;
}

function principal(argv) {
  const index = argv.includes('--index');
  const chemin = join(RACINE, 'config', 'reglement.json');
  if (!existsSync(chemin)) {
    console.error('Règlement : config/reglement.json manque. Le kit le pose : outils/poser.mjs du dépôt du plugin.');
    process.exitCode = 1;
    return;
  }
  const regles = compiler(lireJson(chemin));
  const tous = index
    ? decouper(git(['ls-files', '-z', '--cached']))
    : decouper(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
  const fichiers = index ? decouper(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])) : tous;
  const lire = index ? lireBlob('') : lireArbre;
  const presents = index ? tous : tous.filter((c) => lire(c) !== null);
  const aUnCommit = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: RACINE, windowsHide: true }).status === 0;
  const lireAvant = index && aUnCommit ? lireBlob('HEAD') : () => null;

  const avertissements = [];
  const ecarts = verifierFichiers({ fichiers: index ? fichiers : presents, tous: presents, regles, lire, lireAvant, avertir: (a) => avertissements.push(a) });
  if (!index) ecarts.push(...frontieres(presents, regles, lire));

  // Au commit, chaque fichier touché qui approche du plafond est nommé ; sur tout l'arbre, une ligne les compte.
  if (index) for (const { chemin: c, message } of avertissements) console.log(`  [avertissement] ${c} : ${message}`);
  else if (avertissements.length) {
    console.log(`${avertissements.length} fichier${avertissements.length > 1 ? 's' : ''} de plus de ${regles.lignes_avertissement} lignes : chacun se découpe quand on y touche (le commit le nomme).`);
  }

  if (ecarts.length) {
    console.error(`Règlement : ${ecarts.length} écart${ecarts.length > 1 ? 's' : ''}`);
    for (const { regle, chemin: c, message } of ecarts) console.error(`  [${regle}] ${c} : ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Règlement respecté (${presents.length} fichiers).`);
  const crochets = spawnSync('git', ['config', 'core.hooksPath'], { cwd: RACINE, windowsHide: true }).stdout?.toString().trim();
  if (!process.env.CI && crochets !== '.githooks') {
    console.log('Crochets Git inactifs : git config core.hooksPath .githooks');
  }
}

const lancement = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (lancement) principal(process.argv.slice(2));
