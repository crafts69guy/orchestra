#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cccEnabled } from '../scripts/ccc.mjs';
import { exec } from '../scripts/orch-wt.mjs';

export const WT_WARNING =
  'orch: `wt` (worktrunk) not found on PATH; parallel dispatch needs it (`brew install worktrunk`).';

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

/** A line ending in `<!-- orch:NAME -->` is dropped when `flags[NAME]` is falsy, else the marker is stripped. */
export function applyMarkers(rules, flags) {
  const marker = / *<!-- orch:(\w+) -->$/;
  return rules
    .split('\n')
    .filter((l) => {
      const name = marker.exec(l)?.[1];
      return name === undefined || Boolean(flags[name]);
    })
    .map((l) => l.replace(marker, ''))
    .join('\n');
}

/** `orchPath` is the absolute `bin/orch`; plugin bin/ is not on PATH under Codex, so name it. */
export function buildContext(
  rules,
  hasWt,
  orchPath,
  flags = { docs: true, ccc: false, high: false },
) {
  const withCli = `${applyMarkers(rules, flags).trimEnd()}\n\norch CLI: ${orchPath} (use \`${orchPath} wt new|merge|list\`)\n`;
  return hasWt ? withCli : `${withCli}\n${WT_WARNING}\n`;
}

export function formatOutput(additionalContext) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  });
}

/** Returns the process exit code; never throws for a missing rules file. */
export function run({ env, root, cwd, read, hasCommand, exec, exists, stdout, stderr }) {
  if (env.ORCH !== '1') return 0;
  const rules = readRules(root, read);
  if (rules === null) {
    stderr(`orch: rules/orchestrator.md not found under ${root}; skipping injection\n`);
    return 0;
  }
  stdout(
    formatOutput(
      buildContext(rules, hasCommand('wt', env.PATH), join(root, 'bin', 'orch'), {
        docs: env.ORCH_DOCS !== '0',
        high: env.ORCH_LEVEL === 'high',
        ccc: cccEnabled(env, cwd, { exec, exists, hasCommand }),
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
