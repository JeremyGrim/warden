#!/usr/bin/env node
// The `warden` command, for whoever installs Warden without the Claude Code plugin: through npx, straight from the
// repository, with nothing published anywhere else.
//
//   npx github:JeremyGrim/warden setup [<project>] [--dry-run] [--locale en|fr]     install or update the kit
//   npx github:JeremyGrim/warden install ...                                       the same
//   npx github:JeremyGrim/warden ui [<project>] [--port <n>] [--no-open]          open the interface of a project
//   npx github:JeremyGrim/warden --version
//
// `setup` is tools/install.mjs. `ui` runs the interface of the project's own kit (scripts/warden/ui.mjs): a project is
// always read by the kit it carries.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLocale } from '../kit/scripts/warden/messages.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MESSAGES = {
  en: {
    usage: [
      'Warden {version}',
      '',
      '  warden setup [<project>] [--dry-run] [--locale en|fr]   install or update the kit in a project (install: the same)',
      '  warden ui [<project>] [--port <n>] [--no-open]          open the interface, served by the project\'s own kit',
      '  warden --version',
    ].join('\n'),
    no_kit: '{path} carries no Warden kit, or one older than the interface (0.4.3): run warden setup there first.',
    unknown: 'Unknown command: {command}.',
  },
  fr: {
    usage: [
      'Warden {version}',
      '',
      '  warden setup [<projet>] [--dry-run] [--locale en|fr]   pose ou met à jour le kit dans un projet (install : la même)',
      '  warden ui [<projet>] [--port <n>] [--no-open]          ouvre l’interface, servie par le kit du projet',
      '  warden --version',
    ].join('\n'),
    no_kit: '{path} ne porte pas de kit Warden, ou un kit plus ancien que l’interface (0.4.3) : y lancer warden setup d’abord.',
    unknown: 'Commande inconnue : {command}.',
  },
};

export const version = () => JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'plugin.json'), 'utf8')).version;

function say(key, vars = {}) {
  const locale = MESSAGES[resolveLocale()] ? resolveLocale() : 'en';
  return MESSAGES[locale][key].replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

// The project a command names: the first argument that is not an option nor an option's value.
function projectArg(args, withValue) {
  const path = args.find((a, i) => !a.startsWith('--') && !withValue.includes(args[i - 1]));
  return resolve(path ?? process.cwd());
}

const run = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit', windowsHide: true }).status ?? 1;

export function main(argv) {
  const [command, ...args] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(say('usage', { version: version() }));
    return 0;
  }
  if (['--version', '-v', 'version'].includes(command)) {
    console.log(version());
    return 0;
  }
  if (command === 'setup' || command === 'install') return run(join(REPO, 'tools', 'install.mjs'), args, process.cwd());
  if (command === 'ui') {
    const project = projectArg(args, ['--port']);
    const ui = join(project, 'scripts', 'warden', 'ui.mjs');
    if (!existsSync(ui)) {
      console.error(say('no_kit', { path: project }));
      return 1;
    }
    return run(ui, args.filter((a) => resolve(a) !== project), project);
  }
  console.error(say('unknown', { command }));
  console.error(say('usage', { version: version() }));
  return 2;
}

// npm links the command to this file (a symbolic link outside Windows): the real path decides.
const launched = process.argv[1] && realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
if (launched) process.exitCode = main(process.argv.slice(2));
