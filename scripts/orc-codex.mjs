import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import {
  buildContext,
  collisionWarning,
  readRules,
  scratchDir,
  withWarning,
} from '../hooks/session-start.mjs';
import { cccEnabled, codexMcpArgs } from './ccc.mjs';
import { inkdropFlag } from './inkdrop.mjs';

const DESCRIPTION = /^description = ("(?:[^"\\]|\\.)*")$/m;

/** Exit code for a spawnSync result: missing binary 127, other spawn error or a signal 1. */
export function spawnExit(r, name, stderr, hint) {
  if (!r.error) return r.status ?? 1;
  const missing = r.error.code === 'ENOENT';
  stderr(
    missing
      ? `orc: \`${name}\` not found on PATH; ${hint}\n`
      : `orc: failed to run ${name}: ${r.error.message}\n`,
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

/** Args prepended to the user's codex args (`mcp` are extra `-c` pairs); `commonDir` null skips `--add-dir` (P0 C2). */
export function buildArgs({ context, agents, commonDir, mcp = [] }) {
  return [
    '-c',
    `developer_instructions=${JSON.stringify(context)}`,
    ...agents,
    ...mcp,
    ...(commonDir ? ['--add-dir', commonDir] : []),
  ];
}

/** Returns the process exit code; never throws. */
export function run({
  argv,
  env,
  root,
  cwd,
  read,
  readdir,
  hasCommand,
  gitDir,
  exec,
  exists,
  spawn,
  stderr,
}) {
  const rules = readRules(root, read);
  if (rules === null) {
    stderr(`orc codex: rules/orchestrator.md not found under ${root}\n`);
    return 1;
  }
  const ccc = cccEnabled(env, cwd, { exec, exists, hasCommand });
  const context = buildContext(rules, hasCommand('wt', env.PATH), join(root, 'bin', 'orc'), {
    docs: env.ORC_DOCS !== '0',
    ccc,
    panes: env.ORC_PANES === '1' && env.HERDR_ENV === '1',
    inkdrop: inkdropFlag(env, cwd, { exec }),
    scratch: scratchDir(exec, cwd),
  });
  // Codex hooks may be untrusted, so the launcher warns itself; a launch is always a startup.
  const warning = collisionWarning({ env, cwd, exec, source: 'startup' });
  const prefix = buildArgs({
    context: withWarning(context, warning),
    agents: agentArgs(root, { read, readdir }),
    commonDir: gitDir(cwd),
    mcp: ccc ? codexMcpArgs() : [],
  });
  const r = spawn([...prefix, ...argv], { ...env, ORC: '1', ORC_ROLE: '' });
  return spawnExit(r, 'codex', stderr, 'install Codex CLI first.');
}
