#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { isEntry } from './session-start.mjs';

const NO_COMMIT = new Set(['implementer', 'scoper', 'reviewer']);
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const GH_VALUE_OPTS = new Set(['-R', '--repo']);
const GH_PR_WRITE = new Set(['create', 'merge', 'edit']);

/** `orch:implementer` (Claude) and `implementer` (Codex) both give `implementer`; no agent_type is the main thread. */
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

/** Returns a deny reason, or null to allow. */
export function decide(role, command) {
  if (typeof command !== 'string') return null;
  for (const seg of segments(command)) {
    const kind = classify(seg);
    if ((kind === 'push' || kind === 'pr') && role !== 'shipper') {
      return `orch: only the shipper role may push or manage pull requests (role: ${role}).`;
    }
    if (kind === 'commit' && NO_COMMIT.has(role)) {
      return `orch: the ${role} role must not commit; leave changes in the working tree for the orchestrator.`;
    }
  }
  return null;
}

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
 * Returns the exit code; never throws, bad stdin JSON is a silent allow. The role comes from a
 * non-empty `agent_type` (a subagent, via `roleOf`); otherwise from `ORCH_ROLE`, which herdr pane
 * workers run with (`implementer`), else `main`. `ORCH_ROLE` can only restrict: values outside
 * the no-commit roles (e.g. `shipper`) are ignored, so an env var never grants push.
 */
export function run({ env, input, stdout }) {
  if (env.ORCH !== '1') return 0;
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return 0;
  }
  const type = payload?.agent_type;
  const fallback = NO_COMMIT.has(env.ORCH_ROLE) ? env.ORCH_ROLE : 'main';
  const role = typeof type === 'string' && type !== '' ? roleOf(type) : fallback;
  const reason = decide(role, payload?.tool_input?.command);
  if (reason !== null) stdout(formatDeny(reason));
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
    input: proc.env.ORCH === '1' ? read() : '',
    stdout: (s) => proc.stdout.write(s),
  });
}

if (isEntry(process.argv[1], import.meta.url)) main();
