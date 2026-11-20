// Les empreintes du kit. Le kit se copie tel quel dans un projet : `kit.json` dit sa version et l'empreinte de chacun de
// ses fichiers, et la garde `kit.test.mjs` prouve à chaque poussée qu'aucun n'a été retouché. Ce qui est propre au
// projet va dans config/, jamais dans un script du kit.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFESTE = 'kit.json';

// Une fin de ligne Windows ne change pas l'empreinte : Git peut la convertir à l'extraction.
export function empreinte(contenu) {
  return createHash('sha256').update(contenu.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
}

// L'empreinte de chaque fichier du dossier du kit, le manifeste excepté.
export function empreintesDuDossier(dossier) {
  const fichiers = {};
  for (const nom of readdirSync(dossier, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()) {
    if (nom !== MANIFESTE) fichiers[nom] = empreinte(readFileSync(join(dossier, nom)));
  }
  return fichiers;
}

// Ce qui sépare un dossier de son manifeste : les fichiers changés, en trop et manquants.
export function ecartsAuManifeste(dossier, manifeste) {
  const presents = empreintesDuDossier(dossier);
  const attendus = manifeste.fichiers ?? {};
  return {
    changes: Object.keys(presents).filter((nom) => nom in attendus && attendus[nom] !== presents[nom]),
    enTrop: Object.keys(presents).filter((nom) => !(nom in attendus)),
    manquants: Object.keys(attendus).filter((nom) => !(nom in presents)),
  };
}
