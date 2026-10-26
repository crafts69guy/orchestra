import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hasEvidence } from '../hooks/subagent-stop.mjs';
import { ensureIgnored, REPORT_DIR } from './orc-wt.mjs';

export const USAGE =
  'usage: orc pane start <feature> <task> --path <worktree> --brief <file> [--kind claude|codex] [--here] | orc pane wait <task> --path <worktree> [--timeout ms] | orc pane prompt <task> --path <worktree> (--text <t> | --file <f>) | orc pane close <task> --path <worktree>';
export const GATE_ERROR = 'orc: pane mode needs herdr (HERDR_ENV=1)';
const PROMPT_WAIT = ['--wait', '--until', 'working', '--until', 'blocked', '--timeout', '30000'];
/** Default `--timeout` (ms) of each `agent wait` in `orc pane wait`: 30 minutes. */
export const WAIT_TIMEOUT = '1800000';
const REPORT_FIELDS = '(Status, Changes, Validation, Notes, Docs)';

const fail = (stderr, extra = {}) => ({ code: 1, result: { status: 'error', ...extra, stderr } });

/**
 * herdr agent name for a task in a worktree: `orc-<first 6 hex of sha1(absPath)>-<task>`, the
 * task lowercased with other chars as `-`, at most 32 chars. Unique per worktree, so a re-run of
 * `start` on the same worktree finds the same agent and features cannot collide.
 */
export function agentName(task, absPath) {
  const hash = createHash('sha1').update(absPath).digest('hex').slice(0, 6);
  return `orc-${hash}-${task.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`.slice(0, 32);
}

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

const workerEnv = (env) => [
  '--env',
  'ORC=1',
  '--env',
  'ORC_ROLE=implementer',
  ...(env.ORC_LEVEL ? ['--env', `ORC_LEVEL=${env.ORC_LEVEL}`] : []),
];

/**
 * The pane for a new worker: the root pane of a new `orc:<feature>` tab, else a split of that
 * tab (2nd worker right of the first, 3rd/4th below pane n-2: a 2x2 grid). `{ pane }` or `{ error }`.
 */
export function workerPane(deps, feature, path) {
  const { env } = deps;
  const ws = env.HERDR_WORKSPACE_ID;
  const label = `orc:${feature}`;
  const envArgs = workerEnv(env);
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

/**
 * The pane for a pair-mode worker (`start --here`): a split right of the caller's pane
 * (`HERDR_PANE_ID`), renamed `orc:<task>`. Refuses while the caller's tab (`HERDR_TAB_ID`) already
 * has an `orc:`-labelled pane: one worker at a time. `{ pane }` or `{ error }`.
 */
export function herePane(deps, task, path) {
  const { env } = deps;
  const listed = herdr(deps, ['pane', 'list', '--workspace', env.HERDR_WORKSPACE_ID]);
  if (listed.error) return listed;
  if (!Array.isArray(listed.result.panes)) return { error: 'herdr pane list has no panes array' };
  const busy = listed.result.panes.find(
    (p) => p?.tab_id === env.HERDR_TAB_ID && String(p.label).startsWith('orc:'),
  );
  if (busy) return { error: `orc: close ${busy.label} first` };
  const args = ['pane', 'split', env.HERDR_PANE_ID, '--direction', 'right', '--cwd', path];
  const split = herdr(deps, [...args, ...workerEnv(env), '--no-focus']);
  if (split.error) return split;
  const found = paneIdOf(split.result.pane);
  if (found.error) return found;
  const renamed = herdr(deps, ['pane', 'rename', found.pane, `orc:${task}`]);
  if (renamed.error) {
    herdr(deps, ['pane', 'close', found.pane]); // unlabelled, `close` would refuse it later
    return renamed;
  }
  return found;
}

/**
 * Submits `text` and waits until the agent works or blocks: `{ sent, state }` or `{ error }`.
 * `sent` is false when herdr refused because the agent sits at an approval dialog.
 */
function sendPrompt(deps, name, text) {
  const r = herdr(deps, ['agent', 'prompt', name, text, ...PROMPT_WAIT]);
  if (r.code === 'agent_blocked') return { sent: false, state: 'blocked' };
  if (r.error) return r;
  const state = r.result.agent?.agent_status;
  return typeof state === 'string'
    ? { sent: true, state }
    : { error: 'herdr agent prompt has no agent_status' };
}

/** Deletes a stale report so the next one is fresh; a missing file is fine. Error text or null. */
function clearReport(deps, path) {
  try {
    deps.unlink(reportPath(path));
  } catch (e) {
    if (e.code !== 'ENOENT') return `orc: cannot delete ${reportPath(path)}: ${e.message}`;
  }
  return null;
}

/**
 * Opens a pane and starts the agent in it: `{ pane, blocked }` or `{ error }`. A failed start
 * closes the pane it just opened.
 */
function launch(deps, name, kind, { feature, task, here }, path) {
  const found = here ? herePane(deps, task, path) : workerPane(deps, feature, path);
  if (found.error) return found;
  const model = deps.env.ORC_LEVEL === 'high' ? 'opus' : 'sonnet';
  const native =
    kind === 'claude' ? ['--', '--model', model] : ['--', '--sandbox', 'workspace-write'];
  const args = ['agent', 'start', name, '--kind', kind, '--pane', found.pane, ...native];
  const started = herdr(deps, args);
  if (started.code === 'agent_not_ready') return { pane: found.pane, blocked: true };
  if (started.error) {
    herdr(deps, ['pane', 'close', found.pane]); // best effort: the start error is what matters
    return { error: started.error };
  }
  return { pane: found.pane, blocked: false };
}

/**
 * Starts the task's worker and sends it the implementer prompt. Status `started`, or `not-sent`
 * when a dialog (`agent_not_ready` / `agent_blocked`) kept the prompt from being delivered; `state`
 * is the agent status after submission. Re-runnable: when the worktree's agent already exists
 * (the user has since cleared the dialog), it skips the pane and agent start and only sends the
 * prompt. `here` (pair mode) opens the pane with `herePane` and first git-ignores `<path>/.orc/`,
 * since `path` is then the session checkout, not a task worktree.
 */
export function start(deps, cwd, { feature, task, path, kind, brief, here }) {
  const abs = resolve(cwd, path);
  const name = agentName(task, abs);
  if (here) {
    if (!deps.env.HERDR_PANE_ID) return fail('orc: --here needs HERDR_PANE_ID', { task });
    const ignoreErr = ensureIgnored(deps, abs);
    if (ignoreErr !== null) return fail(ignoreErr, { task });
  }
  const existing = herdr(deps, ['agent', 'get', name]);
  let launched;
  if (existing.code === 'agent_not_found') {
    launched = launch(deps, name, kind, { feature, task, here }, abs);
  } else if (existing.error) {
    return fail(existing.error, { task });
  } else {
    launched = { ...paneIdOf(existing.result.agent), blocked: false };
  }
  if (launched.error) return fail(launched.error, { task });
  const base = { task, name, pane: launched.pane, path: abs, kind };
  if (launched.blocked) {
    return { code: 0, result: { status: 'not-sent', state: 'blocked', ...base } };
  }
  const clearErr = clearReport(deps, abs);
  if (clearErr !== null) return fail(clearErr, base);
  const text = [
    `You are an orc implementer. Read and follow ${join(deps.root, 'agents', 'implementer.md')}.`,
    `Your brief: ${resolve(cwd, brief)}. Work only in ${abs}. Do not commit.`,
    `When finished, write your full report ${REPORT_FIELDS} to ${reportPath(abs)}.`,
  ].join(' ');
  const sent = sendPrompt(deps, name, text);
  if (sent.error) return fail(sent.error, base);
  const status = sent.sent ? 'started' : 'not-sent';
  return { code: 0, result: { status, state: sent.state, ...base } };
}

/** Text of the worker's report, or null when it is missing or unreadable. */
export function readReport(deps, path) {
  try {
    return deps.readFile(reportPath(path));
  } catch {
    return null;
  }
}

/** The agent's `agent_status`: `{ state }` or `{ error }`. */
export function agentState(deps, name) {
  const got = herdr(deps, ['agent', 'get', name]);
  if (got.error) return got;
  const state = got.result.agent?.agent_status;
  return typeof state === 'string' ? { state } : { error: 'herdr agent get has no agent_status' };
}

/**
 * Waits for the worker to settle and reads its report. An agent already at a dialog (`blocked`)
 * is first waited on until the user clears it; a timeout at either step gives state `timeout`.
 */
export function wait(deps, cwd, { task, path, timeout = WAIT_TIMEOUT }) {
  const abs = resolve(cwd, path);
  const name = agentName(task, abs);
  const before = agentState(deps, name);
  if (before.error) return fail(before.error, { task });
  const steps = [['--timeout', timeout]];
  if (before.state === 'blocked') {
    steps.unshift([
      '--until',
      'working',
      '--until',
      'idle',
      '--until',
      'done',
      '--timeout',
      timeout,
    ]);
  }
  let state;
  for (const step of steps) {
    const waited = herdr(deps, ['agent', 'wait', name, ...step]);
    if (waited.code === 'timeout') {
      state = 'timeout';
      break;
    }
    if (waited.error) return fail(waited.error, { task });
  }
  if (state === undefined) {
    const after = agentState(deps, name);
    if (after.error) return fail(after.error, { task });
    state = after.state;
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

/**
 * Sends a follow-up (`Follow-up: ...`, so text starting with `-` is safe) after deleting the old
 * report. Status `prompted`, or `not-sent` when the agent sits at a dialog.
 */
export function prompt(deps, cwd, { task, path, text, file }) {
  const abs = resolve(cwd, path);
  const name = agentName(task, abs);
  const clearErr = clearReport(deps, abs);
  if (clearErr !== null) return fail(clearErr, { task });
  const body = file ? `read and act on ${resolve(cwd, file)}.` : text;
  const full = `Follow-up: ${body} When done, rewrite your full report ${REPORT_FIELDS} to ${reportPath(abs)}.`;
  const sent = sendPrompt(deps, name, full);
  if (sent.error) return fail(sent.error, { task });
  const status = sent.sent ? 'prompted' : 'not-sent';
  return { code: 0, result: { status, state: sent.state, task, name } };
}

/**
 * Closes the task's pane, but only when it sits in an `orc:*` tab (the tab `start` creates) or is
 * itself labelled `orc:*` (the pane `start --here` splits off). Not a cwd check: after
 * `orc wt merge`, worktrunk moves the worktree (and the agent's cwd) to `.git/wt/trash/`.
 */
export function close(deps, cwd, { task, path }) {
  const name = agentName(task, resolve(cwd, path));
  const got = herdr(deps, ['agent', 'get', name]);
  if (got.error) return fail(got.error, { task });
  const { tab_id: tab, pane_id: pane } = got.result.agent ?? {};
  let label;
  if (typeof tab === 'string' && typeof pane === 'string') {
    const tabInfo = herdr(deps, ['tab', 'get', tab]);
    if (tabInfo.error) return fail(tabInfo.error, { task });
    label = tabInfo.result.tab?.label;
    if (!String(label).startsWith('orc:')) {
      const paneInfo = herdr(deps, ['pane', 'get', pane]);
      if (paneInfo.error) return fail(paneInfo.error, { task });
      label = paneInfo.result.pane?.label;
    }
  }
  if (typeof label !== 'string' || !label.startsWith('orc:')) {
    return {
      code: 1,
      result: { status: 'refused', task, stderr: `orc: ${name} is not in an orc:* tab or pane` },
    };
  }
  const closed = herdr(deps, ['pane', 'close', pane]);
  if (closed.error) return fail(closed.error, { task });
  return { code: 0, result: { status: 'closed', task, pane } };
}

/**
 * `orc pane start|wait|prompt|close`. `deps`: `exec` (never throws), `readFile(path)` (utf8),
 * `unlink(path)`, `mkdir(path)` (recursive), `append(path, text)`, `env`, `hasCommand(name, PATH)`,
 * plugin `root`. Returns `{ code, result }`; `result` is the
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
        here: { type: 'boolean' },
      },
    });
  } catch (e) {
    return fail(`${e.message}\n${USAGE}`);
  }
  const [cmd, ...pos] = parsed.positionals;
  const v = parsed.values;
  const kindOk = v.kind === 'claude' || v.kind === 'codex';
  if (!v.path) return fail(USAGE);
  if (cmd === 'start' && pos.length === 2 && v.brief && kindOk) {
    return start(deps, cwd, { feature: pos[0], task: pos[1], ...v });
  }
  if (pos.length !== 1) return fail(USAGE);
  const task = pos[0];
  if (cmd === 'wait') return wait(deps, cwd, { task, ...v });
  if (cmd === 'prompt' && Boolean(v.text) !== Boolean(v.file)) {
    return prompt(deps, cwd, { task, ...v });
  }
  if (cmd === 'close') return close(deps, cwd, { task, ...v });
  return fail(USAGE);
}
