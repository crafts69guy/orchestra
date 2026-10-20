#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { signalsPath } from '../scripts/lib/lessons.mjs';
import { ensureIgnored, exec } from '../scripts/orc-wt.mjs';
import { mainRoot } from '../scripts/status.mjs';
import { isEntry } from './session-start.mjs';

const NO_COMMIT = new Set(['implementer', 'scoper', 'reviewer']);
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const GH_VALUE_OPTS = new Set(['-R', '--repo']);
const GH_PR_WRITE = new Set(['create', 'merge', 'edit']);

/** `orc:implementer` (Claude) and `implementer` (Codex) both give `implementer`; no agent_type is the main thread. */
export function roleOf(agentType) {
  if (typeof agentType !== 'string' || agentType === '') return 'main';
  return agentType.replace(/^[^:]+:/, '');
}

// ponytail: whitespace tokenizer, quotes are not parsed, so a chain operator inside a quoted
// string splits early (can only over-deny); `bash -c '...'` wrappers are not unwrapped.
function segments(command) {
  return command.split(/&&|\|\||[;|&\n]/).map((s) => s.trim().split(/\s+/));
}

function skipEnv(tokens) {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_]\w*=/.test(tokens[i]) || tokens[i] === 'env')) i++;
  return tokens.slice(i);
}

/** Tokens after the global options of `git`/`gh`, so `git -C x push` yields ['push']. */
function afterOptions(tokens, valueOpts) {
  for (let i = 0; i < tokens.length; i++) {
    if (valueOpts.has(tokens[i])) i++;
    else if (!tokens[i].startsWith('-')) return tokens.slice(i);
  }
  return [];
}

/** Classifies one command segment as 'push', 'pr', 'commit' or null. */
export function classify(tokens) {
  const [bin, ...args] = skipEnv(tokens);
  if (bin === undefined) return null;
  const name = basename(bin);
  if (name === 'git') {
    const [sub] = afterOptions(args, GIT_VALUE_OPTS);
    return sub === 'push' || sub === 'commit' ? sub : null;
  }
  if (name === 'gh') {
    const [group, action] = afterOptions(args, GH_VALUE_OPTS);
    return group === 'pr' && GH_PR_WRITE.has(action) ? 'pr' : null;
  }
  return null;
}

/** The kind ('push', 'pr' or 'commit') of the first segment `role` may not run, or null. */
function deniedKind(role, command) {
  if (typeof command !== 'string') return null;
  for (const seg of segments(command)) {
    const kind = classify(seg);
    if ((kind === 'push' || kind === 'pr') && role !== 'shipper') return kind;
    if (kind === 'commit' && NO_COMMIT.has(role)) return kind;
  }
  return null;
}

/** Returns a deny reason, or null to allow. */
export function decide(role, command) {
  const kind = deniedKind(role, command);
  if (kind === null) return null;
  return kind === 'commit'
    ? `orc: the ${role} role must not commit; leave changes in the working tree for the orchestrator.`
    : `orc: only the shipper role may push or manage pull requests (role: ${role}).`;
}

/**
 * Appends `{ ts, kind, role, reason }` as one JSON line to `<main root>/.orc/signals.jsonl`,
 * keeping `.orc/` git-excluded. Never throws: a failed record is dropped. `deps`: `exec`,
 * `mkdir` (recursive), `append`, `cwd`, optional `now`.
 */
export function recordSignal(deps, kind, role, reason) {
  try {
    const root = mainRoot(deps, deps.cwd);
    if (root === null) return;
    deps.mkdir(join(root, '.orc'));
    ensureIgnored(deps, root);
    const ts = (deps.now?.() ?? new Date()).toISOString();
    deps.append(signalsPath(root), `${JSON.stringify({ ts, kind, role, reason })}\n`);
  } catch {
    // a hook must never fail over a signal
  }
}

/** Real fs and git for `recordSignal`, minus `cwd`. */
export const signalDeps = {
  exec,
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  append: appendFileSync,
};

export function formatDeny(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/**
 * Returns the exit code; never throws, bad stdin JSON is a silent allow. A no-commit `ORC_ROLE`
 * (herdr pane workers run with `implementer`) wins over `agent_type`, so even a subagent spawned
 * inside a pane worker (`orc:shipper` included) stays restricted. Otherwise the role comes from
 * `agent_type` via `roleOf` (`main` when empty or missing). `ORC_ROLE` can only restrict: values
 * outside the no-commit roles (e.g. `shipper`) are ignored, so an env var never grants push.
 * A deny is recorded as a `deny` signal through `signals` (`recordSignal` deps); an allow touches
 * neither git nor the filesystem.
 */
export function run({ env, input, stdout, signals }) {
  if (env.ORC !== '1') return 0;
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return 0;
  }
  const envRole = NO_COMMIT.has(env.ORC_ROLE) ? env.ORC_ROLE : null;
  const role = envRole ?? roleOf(payload?.agent_type);
  const command = payload?.tool_input?.command;
  const reason = decide(role, command);
  if (reason !== null) {
    stdout(formatDeny(reason));
    recordSignal(signals, 'deny', role, `${deniedKind(role, command)} ${command.slice(0, 80)}`);
  }
  return 0;
}

export function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function main(proc = process, read = readStdin) {
  proc.exitCode = run({
    env: proc.env,
    input: proc.env.ORC === '1' ? read() : '',
    stdout: (s) => proc.stdout.write(s),
    signals: { ...signalDeps, cwd: proc.cwd() },
  });
}

if (isEntry(process.argv[1], import.meta.url)) main();
