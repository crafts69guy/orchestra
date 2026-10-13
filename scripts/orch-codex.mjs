import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { buildContext, readRules } from '../hooks/session-start.mjs';

const DESCRIPTION = /^description = ("(?:[^"\\]|\\.)*")$/m;

/** Exit code for a spawnSync result: missing binary 127, other spawn error or a signal 1. */
export function spawnExit(r, name, stderr, hint) {
  if (!r.error) return r.status ?? 1;
  const missing = r.error.code === 'ENOENT';
  stderr(
    missing
      ? `orch: \`${name}\` not found on PATH; ${hint}\n`
      : `orch: failed to run ${name}: ${r.error.message}\n`,
  );
  return missing ? 127 : 1;
}

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
    stderr(`orch codex: rules/orchestrator.md not found under ${root}\n`);
    return 1;
  }
  const context = buildContext(
    rules,
    hasCommand('wt', env.PATH),
    join(root, 'bin', 'orch'),
    env.ORCH_DOCS !== '0',
  );
  const prefix = buildArgs({
    context,
    agents: agentArgs(root, { read, readdir }),
    commonDir: gitDir(cwd),
  });
  const r = spawn([...prefix, ...argv], { ...env, ORCH: '1' });
  return spawnExit(r, 'codex', stderr, 'install Codex CLI first.');
}
