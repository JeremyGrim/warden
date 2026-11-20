// Les contrôles du règlement sur une liste de fichiers. Rien ici ne lit le disque ni Git : `lire` donne le contenu d'un
// chemin (ou null), `lireAvant` celui du commit précédent. Chaque contrôle ne joue que si sa section est dans
// config/reglement.json.

import { extname, posix } from 'node:path';

const echapper = (texte) => texte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compiler(regles) {
  const docs = regles.docs;
  return {
    ...regles,
    racine: regles.racine ?? null,
    obligatoires: regles.obligatoires ?? [],
    lignes_exemptes: regles.lignes_exemptes ?? [],
    taille_exceptions: regles.taille_exceptions ?? {},
    segments_interdits: regles.segments_interdits ?? [],
    extensions_interdites: (regles.extensions_interdites ?? []).map((e) => e.toLowerCase()),
    gestionnaires_interdits: regles.gestionnaires_interdits ?? [],
    secrets: (regles.secrets ?? []).map(({ nom, motif }) => ({ nom, motif: new RegExp(motif) })),
    secrets_exceptions: regles.secrets_exceptions ?? {},
    code_etranger: regles.code_etranger ?? {},
    docs: docs
      ? {
          dossier: docs.dossier ?? 'docs/',
          fichiers_max: docs.fichiers_max ?? null,
          noms_interdits: (docs.noms_interdits ?? []).map((motif) => new RegExp(motif, 'i')),
          statuts_interdits: docs.statuts_interdits ? new RegExp(docs.statuts_interdits, 'i') : null,
        }
      : null,
    passages: (regles.passages ?? []).map((p) => ({ ...p, motif: new RegExp(p.motif), zones: p.zones ?? [''], exceptions: p.exceptions ?? {} })),
    dettes: (regles.dettes ?? []).map((d) => ({ ...d, motif: new RegExp(d.motif, 'i') })),
  };
}

export function estTexte(contenu) {
  return !contenu.subarray(0, 8000).includes(0);
}

export function compterLignes(contenu) {
  if (contenu.length === 0) return 0;
  let lignes = 0;
  for (const octet of contenu) if (octet === 10) lignes += 1;
  return contenu.at(-1) === 10 ? lignes : lignes + 1;
}

// La version qu'un fichier déclare, selon sa lecture : `json:<clé.clé>` ou `toml:<table.clé>` (`toml:version` pour une
// clé hors de toute table).
export function lireVersion(texte, lecture) {
  const [format, chemin = ''] = lecture.split(':');
  const cles = chemin.split('.').filter(Boolean);
  if (format === 'json') {
    let valeur = JSON.parse(texte);
    for (const cle of cles) valeur = valeur?.[cle];
    return typeof valeur === 'string' ? valeur : null;
  }
  if (format === 'toml') {
    const cle = cles.pop();
    let bloc = texte;
    if (cles.length) {
      const entete = new RegExp(`^\\[${echapper(cles.join('.'))}\\][ \\t]*\\r?$`, 'm').exec(texte);
      if (!entete) return null;
      bloc = texte.slice(entete.index + entete[0].length);
    }
    const fin = /^\[/m.exec(bloc);
    if (fin) bloc = bloc.slice(0, fin.index);
    return new RegExp(`^${echapper(cle)}\\s*=\\s*"([^"]+)"`, 'm').exec(bloc)?.[1] ?? null;
  }
  throw new Error(`lecture de version inconnue : ${lecture} (json:<clé> ou toml:<table.clé>)`);
}

const etranger = (chemin, regles) => Object.keys(regles.code_etranger).some((dossier) => chemin.startsWith(dossier));

function verifierUnFichier(chemin, regles, lire, noter, avertir) {
  const segments = chemin.split('/');
  const nom = segments.at(-1);

  if (regles.racine) {
    if (segments.length === 1) {
      if (!regles.racine.fichiers.includes(nom)) noter('racine', chemin, 'fichier non admis à la racine ; la liste est dans config/reglement.json');
    } else if (!regles.racine.dossiers.includes(segments[0])) {
      noter('racine', chemin, `dossier « ${segments[0]} » non admis à la racine ; la liste est dans config/reglement.json`);
    }
  }

  const segment = segments.find((s) => regles.segments_interdits.includes(s));
  if (segment) noter('artefact', chemin, `« ${segment} » ne se versionne pas`);
  const extension = extname(nom).toLowerCase();
  if (regles.extensions_interdites.includes(extension)) noter('artefact', chemin, `un fichier ${extension} ne se versionne pas`);
  if (regles.gestionnaires_interdits.includes(nom)) noter('gestionnaire', chemin, `un seul gestionnaire de paquets : pas de ${nom}`);

  const contenu = lire(chemin);
  if (contenu === null) return;

  const venu = etranger(chemin, regles);
  const kio = contenu.length / 1024;
  const plafond = regles.taille_exceptions[chemin] ?? regles.taille_max_kio;
  if (plafond && kio > plafond && !venu) noter('taille', chemin, `${Math.ceil(kio)} Kio pour ${plafond} Kio au plus`);
  if (!estTexte(contenu)) return;

  if (regles.lignes_max && !venu && !regles.lignes_exemptes.includes(nom) && !regles.lignes_exemptes.includes(chemin)) {
    const lignes = compterLignes(contenu);
    if (lignes > regles.lignes_max) {
      noter('lignes', chemin, `${lignes} lignes pour ${regles.lignes_max} au plus ; découper par responsabilité`);
    } else if (regles.lignes_avertissement && lignes > regles.lignes_avertissement) {
      // Pas un écart : le fichier se découpe à la prochaine touche, avant de buter sur le plafond.
      avertir('lignes', chemin, `${lignes} lignes, le plafond est à ${regles.lignes_max} : le découper par responsabilité tant qu'on y touche`);
    }
  }

  const texte = contenu.toString('utf8');
  const admis = regles.secrets_exceptions[chemin] ?? {};
  for (const { nom: type, motif } of regles.secrets) {
    if (motif.test(texte) && !admis[type]) noter('secret', chemin, `${type} détecté`);
  }
  if (regles.docs?.statuts_interdits && chemin.startsWith(regles.docs.dossier) && regles.docs.statuts_interdits.test(texte.slice(0, 600))) {
    noter('present', chemin, 'un document ne se déclare pas historique : le corriger ou le supprimer');
  }
  // Un passage obligé : ce qui doit passer par sa source (un texte d'interface, une couleur) n'est pas écrit en dur.
  for (const p of regles.passages) {
    const dansLaZone = p.zones.some((zone) => chemin.startsWith(zone));
    const bonneExtension = !p.extensions || p.extensions.includes(extension);
    if (dansLaZone && bonneExtension && !venu && !p.exceptions[chemin] && p.motif.test(texte)) {
      noter('passage', chemin, `${p.nom} : ${p.message ?? 'passe par sa source, pas écrit en dur'}`);
    }
  }
}

function verifierDocs(tous, regles, noter) {
  const docs = regles.docs;
  if (!docs) return;
  const fichiers = tous.filter((c) => c.startsWith(docs.dossier));
  if (docs.fichiers_max && fichiers.length > docs.fichiers_max) {
    noter('present', docs.dossier, `${fichiers.length} fichiers pour ${docs.fichiers_max} au plus`);
  }
  for (const chemin of fichiers) {
    if (docs.noms_interdits.some((motif) => motif.test(posix.basename(chemin)))) {
      noter('present', chemin, `pas de date, de compte rendu, de brief, d'audit ni de plan dans ${docs.dossier} : ils vont dans .input/ ou .travail/`);
    }
  }
}

// Une seule source des règles : le fichier des agents d'un outil ne fait qu'y renvoyer.
function verifierSourceUnique(tous, regles, lire, noter) {
  const source = regles.source_unique;
  if (!source || !tous.includes(source.fichier)) return;
  const contenu = lire(source.fichier);
  if (contenu === null) return;
  const lignes = contenu.toString('utf8').split('\n').filter((l) => l.trim());
  if (lignes.length > (source.lignes_max ?? 3) || !contenu.includes(source.renvoi)) {
    noter('source-unique', source.fichier, `${source.fichier} renvoie à ${source.renvoi} et ne porte aucune règle`);
  }
}

function verifierVersions(tous, regles, lire, noter) {
  const lues = [];
  for (const { fichier, lire: lecture } of regles.versions ?? []) {
    if (!tous.includes(fichier)) continue;
    const contenu = lire(fichier);
    if (contenu !== null) lues.push({ fichier, version: lireVersion(contenu.toString('utf8'), lecture) });
  }
  if (lues.length > 1 && lues.some((l) => l.version !== lues[0].version)) {
    noter('version', lues[1].fichier, `une seule version : ${lues.map((l) => `${l.fichier} dit ${l.version}`).join(', ')}`);
  }
}

// Les éléments d'une liste de zones : `zone/nom`, pour chaque dossier de premier niveau qui contient quelque chose.
export function elementsDe(tous, zones) {
  const elements = new Set();
  for (const chemin of tous) {
    const [zone, nom, ...reste] = chemin.split('/');
    if (zones.includes(zone) && nom && reste.length) elements.add(`${zone}/${nom}`);
  }
  return elements;
}

function verifierProvenance(tous, regles, lire, noter) {
  const section = regles.provenance;
  if (!section) return;
  const presents = elementsDe(tous, section.zones);
  const contenu = tous.includes(section.fichier) ? lire(section.fichier) : null;
  const provenance = contenu ? JSON.parse(contenu.toString('utf8')) : { elements: {}, sources: {} };
  for (const element of presents) {
    const fiche = provenance.elements[element];
    if (!fiche) {
      noter('provenance', element, `à déclarer dans ${section.fichier}`);
    } else if (fiche.origine !== 'neuf' && !(provenance.sources[fiche.origine] && fiche.revision && fiche.chemin)) {
      noter('provenance', element, 'origine incomplète : source connue, révision et chemin, ou origine « neuf »');
    }
  }
  for (const element of Object.keys(provenance.elements)) {
    if (!presents.has(element)) noter('provenance', element, `déclaré dans ${section.fichier} mais absent du dépôt`);
  }
}

// Chaque fichier de tests/ fait un binaire de test, et chaque binaire relie tout le crate : un seul par crate.
function verifierBinairesDeTest(tous, regles, noter) {
  const zones = regles.binaire_de_test_unique?.zones;
  if (!zones?.length) return;
  const motif = new RegExp(`^((?:${zones.map(echapper).join('|')})/[^/]+)/tests/(?:[^/]+\\.rs|[^/]+/main\\.rs)$`);
  const parCrate = new Map();
  for (const chemin of tous) {
    const trouve = motif.exec(chemin);
    if (trouve) parCrate.set(trouve[1], (parCrate.get(trouve[1]) ?? 0) + 1);
  }
  for (const [element, nombre] of parCrate) {
    if (nombre > 1) noter('disque', `${element}/tests/`, `${nombre} binaires de test ; un seul par crate, les autres en sous-modules`);
  }
}

// Tout composant a sa place déclarée, et la déclaration ne nomme que ce qui est dans le dépôt.
function verifierRegistre(tous, regles, lire, noter) {
  const section = regles.registre;
  if (!section) return;
  const presents = elementsDe(tous, section.zones);
  const contenu = tous.includes(section.fichier) ? lire(section.fichier) : null;
  const categories = contenu ? JSON.parse(contenu.toString('utf8')).categories ?? {} : {};
  const ranges = new Set(Object.values(categories).flat());
  for (const element of presents) {
    if (!ranges.has(element)) noter('registre', element, `à ranger dans ${section.fichier} : ${Object.keys(categories).join(', ') || 'une catégorie'}`);
  }
  for (const element of ranges) {
    if (!presents.has(element)) noter('registre', element, `nommé dans ${section.fichier}, absent du dépôt : le retirer`);
  }
}

// Une dette se regarde diminuer à un seul endroit : rien de son nom ailleurs, et son fichier ne grandit pas.
function verifierDettes(fichiers, tous, regles, lire, lireAvant, noter) {
  for (const dette of regles.dettes) {
    for (const chemin of tous) {
      if (chemin.startsWith(dette.racine) && chemin !== dette.fichier && dette.motif.test(posix.basename(chemin))) {
        noter('dette', chemin, `${dette.nom} : ne vit que dans ${dette.fichier}`);
      }
    }
    if (!dette.ne_grandit_pas || !fichiers.includes(dette.fichier)) continue;
    const avant = lireAvant(dette.fichier);
    const maintenant = lire(dette.fichier);
    if (avant && maintenant && compterLignes(maintenant) > compterLignes(avant)) {
      noter('dette', dette.fichier, `${dette.nom} : ${compterLignes(maintenant)} lignes pour ${compterLignes(avant)} au commit précédent ; une dette se vide, elle ne grandit pas`);
    }
  }
}

/** Les écarts refusent ; `avertir` reçoit ce qui ne refuse pas encore (un fichier qui approche du plafond). */
export function verifierFichiers({ fichiers, tous = fichiers, regles, lire, lireAvant = () => null, avertir = () => {} }) {
  const ecarts = [];
  const noter = (regle, chemin, message) => ecarts.push({ regle, chemin, message });
  const prevenir = (regle, chemin, message) => avertir({ regle, chemin, message });

  for (const chemin of fichiers) verifierUnFichier(chemin, regles, lire, noter, prevenir);
  for (const chemin of regles.obligatoires) {
    if (!tous.includes(chemin)) noter('racine', chemin, 'fichier obligatoire absent');
  }
  verifierDocs(tous, regles, noter);
  verifierSourceUnique(tous, regles, lire, noter);
  verifierVersions(tous, regles, lire, noter);
  verifierProvenance(tous, regles, lire, noter);
  verifierBinairesDeTest(tous, regles, noter);
  verifierRegistre(tous, regles, lire, noter);
  verifierDettes(fichiers, tous, regles, lire, lireAvant, noter);
  return ecarts;
}
