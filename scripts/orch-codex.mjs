import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildContext, pluginRoot, readRules, which } from '../hooks/session-start.mjs';

const DESCRIPTION = /^description = ("(?:[^"\\]|\\.)*")$/m;

/** Real spawn: inherits stdio, never throws; the caller inspects `error`, `status` and `signal`. */
export const spawnCodex = (args, env) => spawnSync('codex', args, { stdio: 'inherit', env });

/** Absolute git common dir of `cwd` (shared by worktrees), or null outside a repo. */
export function gitCommonDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Per run `-c` overrides: P0 C1 proved `config_file` + `description` work without project trust
 * (project `.codex/agents` silently falls back to the default agent when untrusted).
 */
export function agentArgs(root, { read, readdir }) {
  const dir = join(root, 'codex', 'agents');
  return readdir(dir)
    .filter((f) => f.endsWith('.toml'))
    .sort()
    .flatMap((f) => {
      const name = basename(f, '.toml');
      const file = join(dir, f);
      const description = DESCRIPTION.exec(read(file, 'utf8'))?.[1];
      return [
        '-c',
        `agents.${name}.config_file=${JSON.stringify(file)}`,
        ...(description ? ['-c', `agents.${name}.description=${description}`] : []),
      ];
    });
}

/** Args prepended to the user's codex args; `commonDir` null skips `--add-dir` (P0 C2). */
export function buildArgs({ context, agents, commonDir }) {
  return [
    '-c',
    `developer_instructions=${JSON.stringify(context)}`,
    ...agents,
    ...(commonDir ? ['--add-dir', commonDir] : []),
  ];
}

/** Returns the process exit code; never throws. */
export function run({ argv, env, root, cwd, read, readdir, hasCommand, gitDir, spawn, stderr }) {
  const rules = readRules(root, read);
  if (rules === null) {
    stderr(`orch-codex: rules/orchestrator.md not found under ${root}\n`);
    return 1;
  }
  const context = buildContext(rules, hasCommand('wt', env.PATH), join(root, 'bin', 'orch-wt'));
  const prefix = buildArgs({
    context,
    agents: agentArgs(root, { read, readdir }),
    commonDir: gitDir(cwd),
  });
  const r = spawn([...prefix, ...argv], { ...env, ORCH: '1' });
  if (r.error) {
    const missing = r.error.code === 'ENOENT';
    stderr(
      missing
        ? 'orch-codex: `codex` not found on PATH; install Codex CLI first.\n'
        : `orch-codex: failed to run codex: ${r.error.message}\n`,
    );
    return missing ? 127 : 1;
  }
  return r.status ?? 1;
}

export function main(proc = process, metaUrl = import.meta.url) {
  proc.exitCode = run({
    argv: proc.argv.slice(2),
    env: proc.env,
    root: pluginRoot(metaUrl),
    cwd: proc.cwd(),
    read: readFileSync,
    readdir: readdirSync,
    hasCommand: which,
    gitDir: gitCommonDir,
    spawn: spawnCodex,
    stderr: (s) => proc.stderr.write(s),
  });
}
