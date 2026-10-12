#!/usr/bin/env node
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** `orchPath` is the absolute `bin/orch`; plugin bin/ is not on PATH under Codex, so name it. */
export function buildContext(rules, hasWt, orchPath) {
  const withCli = `${rules.trimEnd()}\n\norch CLI: ${orchPath} (use \`${orchPath} wt new|merge|list\`)\n`;
  return hasWt ? withCli : `${withCli}\n${WT_WARNING}\n`;
}

export function formatOutput(additionalContext) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  });
}

/** Returns the process exit code; never throws for a missing rules file. */
export function run({ env, root, read, hasCommand, stdout, stderr }) {
  if (env.ORCH !== '1') return 0;
  const rules = readRules(root, read);
  if (rules === null) {
    stderr(`orch: rules/orchestrator.md not found under ${root}; skipping injection\n`);
    return 0;
  }
  stdout(formatOutput(buildContext(rules, hasCommand('wt', env.PATH), join(root, 'bin', 'orch'))));
  return 0;
}

export function main(proc = process, metaUrl = import.meta.url) {
  proc.exitCode = run({
    env: proc.env,
    root: pluginRoot(metaUrl),
    read: readFileSync,
    hasCommand: which,
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
