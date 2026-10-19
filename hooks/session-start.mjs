#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cccEnabled } from '../scripts/ccc.mjs';
import { inkdropFlag } from '../scripts/inkdrop.mjs';
import { exec } from '../scripts/orc-wt.mjs';

export const WT_WARNING =
  'orc: `wt` (worktrunk) not found on PATH; parallel dispatch needs it (`brew install worktrunk`).';

export function pluginRoot(metaUrl) {
  return join(dirname(fileURLToPath(metaUrl)), '..');
}

export function readRules(root, read = readFileSync) {
  try {
    return read(join(root, 'rules', 'orchestrator.md'), 'utf8');
  } catch {
    return null;
  }
}

// ponytail: POSIX-only executable lookup; add PATHEXT handling if Windows matters.
export function which(name, pathEnv = '') {
  return pathEnv.split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** A line ending in `<!-- orc:NAME -->` is dropped when `flags[NAME]` is falsy, else the marker is stripped. */
export function applyMarkers(rules, flags) {
  const marker = / *<!-- orc:(\w+) -->$/;
  return rules
    .split('\n')
    .filter((l) => {
      const name = marker.exec(l)?.[1];
      return name === undefined || Boolean(flags[name]);
    })
    .map((l) => l.replace(marker, ''))
    .join('\n');
}

/**
 * `orcPath` is the absolute `bin/orc`; plugin bin/ is not on PATH under Codex, so name it.
 * `flags.panes` adds `orc pane` to the CLI line (and keeps the `orc:panes` rule line).
 * `flags.inkdrop` (`{ name, id }` or false) adds `orc inkdrop` and an `Inkdrop notebook:` line.
 */
export function buildContext(
  rules,
  hasWt,
  orcPath,
  flags = { docs: true, ccc: false, high: false, panes: false, inkdrop: false },
) {
  const pane = flags.panes ? ` and \`${orcPath} pane start|wait|prompt|close\`` : '';
  const ink = flags.inkdrop ? ` and \`${orcPath} inkdrop inbox|claim|push|pull\`` : '';
  const book = flags.inkdrop
    ? `Inkdrop notebook: ${flags.inkdrop.name} (${flags.inkdrop.id})\n`
    : '';
  const withCli = `${applyMarkers(rules, flags).trimEnd()}\n\norc CLI: ${orcPath} (use \`${orcPath} wt new|merge|list\`${pane}${ink})\n${book}`;
  return hasWt ? withCli : `${withCli}\n${WT_WARNING}\n`;
}

export function formatOutput(additionalContext) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  });
}

/**
 * Returns the process exit code; never throws for a missing rules file. A herdr pane worker
 * (`ORC_ROLE` set) gets no orchestrator rules: it follows its implementer prompt.
 */
export function run({ env, root, cwd, read, hasCommand, exec, exists, stdout, stderr }) {
  if (env.ORC !== '1' || env.ORC_ROLE) return 0;
  const rules = readRules(root, read);
  if (rules === null) {
    stderr(`orc: rules/orchestrator.md not found under ${root}; skipping injection\n`);
    return 0;
  }
  stdout(
    formatOutput(
      buildContext(rules, hasCommand('wt', env.PATH), join(root, 'bin', 'orc'), {
        docs: env.ORC_DOCS !== '0',
        high: env.ORC_LEVEL === 'high',
        panes: env.ORC_PANES === '1' && env.HERDR_ENV === '1',
        ccc: cccEnabled(env, cwd, { exec, exists, hasCommand }),
        inkdrop: inkdropFlag(env, cwd, { exec }),
      }),
    ),
  );
  return 0;
}

export function main(proc = process, metaUrl = import.meta.url) {
  proc.exitCode = run({
    env: proc.env,
    root: pluginRoot(metaUrl),
    cwd: proc.cwd(),
    read: readFileSync,
    hasCommand: which,
    exec,
    exists: existsSync,
    stdout: (s) => proc.stdout.write(s),
    stderr: (s) => proc.stderr.write(s),
  });
}

// realpath both sides: a symlinked plugin dir (stow, --plugin-dir) must still run main.
export function isEntry(argv1, metaUrl, real = realpathSync) {
  try {
    return real(argv1) === real(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isEntry(process.argv[1], import.meta.url)) main();
