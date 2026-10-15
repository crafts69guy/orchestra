import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hasEvidence } from '../hooks/subagent-stop.mjs';
import { REPORT_DIR } from './orch-wt.mjs';

const USAGE =
  'usage: orch pane start <feature> <task> --path <worktree> [--kind claude|codex] [--brief <file>] | orch pane wait <task> --path <worktree> [--timeout ms] | orch pane prompt <task> (--text <t> | --file <f>) | orch pane close <task>';
export const GATE_ERROR = 'orch: pane mode needs herdr (HERDR_ENV=1)';
const PROMPT_WAIT = ['--wait', '--until', 'working', '--until', 'blocked', '--timeout', '30000'];

const fail = (stderr, extra = {}) => ({ code: 1, result: { status: 'error', ...extra, stderr } });

/** herdr agent name for a task: `orch-<task>` lowercased, other chars `-`, at most 32 chars. */
export const agentName = (task) =>
  `orch-${task.toLowerCase()}`.replace(/[^a-z0-9_-]/g, '-').slice(0, 32);

export const reportPath = (path) => join(path, REPORT_DIR, 'report.md');

/**
 * Runs `herdr <args>` and returns `{ result }` (the response's `.result` object) or
 * `{ error, code }`: herdr prints server errors as `{ error: { code, message } }` JSON on stderr
 * with exit 1; `code` is that error code, or null when absent or unparseable.
 */
export function herdr(deps, args) {
  const r = deps.exec('herdr', args);
  if (r.status !== 0) {
    let code = null;
    try {
      const c = JSON.parse(r.stderr)?.error?.code;
      if (typeof c === 'string') code = c;
    } catch {
      // not JSON: a syntax error or a missing binary
    }
    return { error: r.stderr || r.stdout, code };
  }
  try {
    const result = JSON.parse(r.stdout)?.result;
    if (result !== null && typeof result === 'object') return { result };
  } catch {
    // fall through
  }
  return { error: `unparseable herdr output: ${r.stdout}`, code: null };
}

const paneIdOf = (pane) =>
  typeof pane?.pane_id === 'string'
    ? { pane: pane.pane_id }
    : { error: 'herdr response has no pane_id' };

/**
 * The pane for a new worker: the root pane of a new `orch:<feature>` tab, else a split of that
 * tab (2nd worker right of the first, 3rd/4th below pane n-2: a 2x2 grid). `{ pane }` or `{ error }`.
 */
export function workerPane(deps, feature, path) {
  const { env } = deps;
  const ws = env.HERDR_WORKSPACE_ID;
  const label = `orch:${feature}`;
  const envArgs = ['--env', 'ORCH=1', '--env', 'ORCH_ROLE=implementer'];
  if (env.ORCH_LEVEL) envArgs.push('--env', `ORCH_LEVEL=${env.ORCH_LEVEL}`);
  const tabs = herdr(deps, ['tab', 'list', '--workspace', ws]);
  if (tabs.error) return tabs;
  if (!Array.isArray(tabs.result.tabs)) return { error: 'herdr tab list has no tabs array' };
  const tab = tabs.result.tabs.find((t) => t?.label === label);
  if (!tab) {
    const args = ['tab', 'create', '--workspace', ws, '--label', label, '--cwd', path];
    const created = herdr(deps, [...args, ...envArgs, '--no-focus']);
    return created.error ? created : paneIdOf(created.result.root_pane);
  }
  const listed = herdr(deps, ['pane', 'list', '--workspace', ws]);
  if (listed.error) return listed;
  if (!Array.isArray(listed.result.panes)) return { error: 'herdr pane list has no panes array' };
  const panes = listed.result.panes.filter(
    (p) => p?.tab_id === tab.tab_id && typeof p.pane_id === 'string',
  );
  if (panes.length === 0) return { error: `tab ${label} has no panes` };
  const [target, direction] =
    panes.length === 1 ? [panes[0], 'right'] : [panes[panes.length - 2], 'down'];
  const args = ['pane', 'split', target.pane_id, '--direction', direction, '--cwd', path];
  const split = herdr(deps, [...args, ...envArgs, '--no-focus']);
  return split.error ? split : paneIdOf(split.result.pane);
}

/** Submits `text` and waits until the agent works or blocks; `{ state }` or `{ error }`. */
function sendPrompt(deps, name, text) {
  const r = herdr(deps, ['agent', 'prompt', name, text, ...PROMPT_WAIT]);
  // herdr refuses to prompt an agent sitting at an approval dialog
  if (r.code === 'agent_blocked') return { state: 'blocked' };
  if (r.error) return r;
  const state = r.result.agent?.agent_status;
  return typeof state === 'string'
    ? { state }
    : { error: 'herdr agent prompt has no agent_status' };
}

/** Opens a pane and starts the agent in it: `{ pane, blocked }` or `{ error, pane? }`. */
function launch(deps, name, kind, feature, path) {
  const found = workerPane(deps, feature, path);
  if (found.error) return found;
  const model = deps.env.ORCH_LEVEL === 'high' ? 'opus' : 'sonnet';
  const native = kind === 'claude' ? ['--', '--model', model] : [];
  const args = ['agent', 'start', name, '--kind', kind, '--pane', found.pane, ...native];
  const started = herdr(deps, args);
  if (started.code === 'agent_not_ready') return { pane: found.pane, blocked: true };
  if (started.error) return { error: started.error, pane: found.pane };
  return { pane: found.pane, blocked: false };
}

/**
 * Starts the task's worker and sends it the implementer prompt. Re-runnable: when the agent
 * already exists (e.g. its start was blocked by a trust dialog the user has since cleared), it
 * skips the pane and agent start and only sends the prompt.
 */
export function start(deps, cwd, { feature, task, path, kind, brief }) {
  const name = agentName(task);
  const abs = resolve(cwd, path);
  const existing = herdr(deps, ['agent', 'get', name]);
  let launched;
  if (existing.code === 'agent_not_found') launched = launch(deps, name, kind, feature, abs);
  else if (existing.error) return fail(existing.error, { task });
  else launched = { ...paneIdOf(existing.result.agent), blocked: false };
  const base = { task, name, pane: launched.pane, path: abs, kind };
  if (launched.error) return fail(launched.error, launched.pane ? base : { task });
  if (launched.blocked) return { code: 0, result: { status: 'blocked', ...base } };
  const briefText = brief
    ? resolve(cwd, brief)
    : `the plan task ${task} in .scratch/${feature}/plan.md`;
  const text = [
    `You are an orch implementer. Read and follow ${join(deps.root, 'agents', 'implementer.md')}.`,
    `Your brief: ${briefText}. Work only in ${abs}. Do not commit.`,
    `When finished, write your full report (Status, Changes, Validation, Notes, Docs) to ${reportPath(abs)}.`,
  ].join(' ');
  const sent = sendPrompt(deps, name, text);
  if (sent.error) return fail(sent.error, base);
  return { code: 0, result: { status: sent.state === 'blocked' ? 'blocked' : 'started', ...base } };
}

/** Text of the worker's report, or null when it is missing or unreadable. */
function readReport(deps, path) {
  try {
    return deps.readFile(reportPath(path));
  } catch {
    return null;
  }
}

export function wait(deps, cwd, { task, path, timeout }) {
  const name = agentName(task);
  const abs = resolve(cwd, path);
  const waited = herdr(deps, ['agent', 'wait', name, ...(timeout ? ['--timeout', timeout] : [])]);
  let state = 'timeout';
  if (waited.code !== 'timeout') {
    if (waited.error) return fail(waited.error, { task });
    const got = herdr(deps, ['agent', 'get', name]);
    if (got.error) return fail(got.error, { task });
    state = got.result.agent?.agent_status;
    if (typeof state !== 'string') return fail('herdr agent get has no agent_status', { task });
  }
  const text = readReport(deps, abs);
  return {
    code: 0,
    result: {
      task,
      state,
      report: text === null ? null : reportPath(abs),
      evidence: hasEvidence(text),
    },
  };
}

export function prompt(deps, cwd, { task, text, file }) {
  const name = agentName(task);
  const sent = sendPrompt(deps, name, file ? `Read and act on ${resolve(cwd, file)}` : text);
  if (sent.error) return fail(sent.error, { task });
  return {
    code: 0,
    result: { status: sent.state === 'blocked' ? 'blocked' : 'prompted', task, name },
  };
}

/**
 * Closes the task's pane, but only when it sits in an `orch:*` tab (the tab `start` creates).
 * Not a cwd check: after `orch wt merge`, worktrunk moves the worktree (and the agent's cwd) to
 * `.git/wt/trash/`.
 */
export function close(deps, { task }) {
  const name = agentName(task);
  const got = herdr(deps, ['agent', 'get', name]);
  if (got.error) return fail(got.error, { task });
  const { tab_id: tab, pane_id: pane } = got.result.agent ?? {};
  let label;
  if (typeof tab === 'string' && typeof pane === 'string') {
    const tabInfo = herdr(deps, ['tab', 'get', tab]);
    if (tabInfo.error) return fail(tabInfo.error, { task });
    label = tabInfo.result.tab?.label;
  }
  if (typeof label !== 'string' || !label.startsWith('orch:')) {
    return {
      code: 1,
      result: { status: 'refused', task, stderr: `orch: ${name} is not in an orch:* tab` },
    };
  }
  const closed = herdr(deps, ['pane', 'close', pane]);
  if (closed.error) return fail(closed.error, { task });
  return { code: 0, result: { status: 'closed', task, pane } };
}

/**
 * `orch pane start|wait|prompt|close`. `deps`: `exec` (never throws), `readFile(path)` (utf8),
 * `env`, `hasCommand(name, PATH)`, plugin `root`. Returns `{ code, result }`; `result` is the
 * JSON document to print.
 */
export function run(argv, deps, cwd) {
  const { env } = deps;
  if (env.HERDR_ENV !== '1' || !env.HERDR_WORKSPACE_ID || !deps.hasCommand('herdr', env.PATH)) {
    return fail(GATE_ERROR);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        path: { type: 'string' },
        kind: { type: 'string', default: 'claude' },
        brief: { type: 'string' },
        timeout: { type: 'string' },
        text: { type: 'string' },
        file: { type: 'string' },
      },
    });
  } catch (e) {
    return fail(`${e.message}\n${USAGE}`);
  }
  const [cmd, ...pos] = parsed.positionals;
  const v = parsed.values;
  const kindOk = v.kind === 'claude' || v.kind === 'codex';
  if (cmd === 'start' && pos.length === 2 && v.path && kindOk) {
    return start(deps, cwd, { feature: pos[0], task: pos[1], ...v });
  }
  if (cmd === 'wait' && pos.length === 1 && v.path) return wait(deps, cwd, { task: pos[0], ...v });
  if (cmd === 'prompt' && pos.length === 1 && Boolean(v.text) !== Boolean(v.file)) {
    return prompt(deps, cwd, { task: pos[0], ...v });
  }
  if (cmd === 'close' && pos.length === 1) return close(deps, { task: pos[0] });
  return fail(USAGE);
}
