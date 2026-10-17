import { dirname, join, resolve } from 'node:path';
import { STATUS } from '../hooks/subagent-stop.mjs';
import { agentName, agentState, readReport } from './orch-pane.mjs';
import { featureTasks, taskBranch, worktrees } from './orch-wt.mjs';

const USAGE = 'usage: orch status [--json]\n';

/** `Base branch: <F>   # comment` (or `(comment)`): the first token, null when absent. */
export function parseBase(plan) {
  return plan.replace(/\r\n/g, '\n').match(/^Base branch:[ \t]*([^\s#]+)/m)?.[1] ?? null;
}

/** A YAML scalar: one pair of surrounding quotes, else the text before a ` # comment`. */
function scalar(value) {
  const quoted = value.match(/^(["'])(.*)\1(?:\s+#.*)?\s*$/);
  return quoted ? quoted[2] : value.replace(/(^|\s+)#.*$/, '').trim();
}

/**
 * Tasks of a plan: `{ id, goal, size, dependsOn }` from the first ```yaml (or ```yml) fence in the
 * `## Tasks` section (up to the next `## ` heading). Only task-level keys count (`- key:` or
 * two-space `  key:`); deeper lines are ignored.
 */
export function parseTasks(plan) {
  // ponytail: line-regex, not a YAML parser; upgrade if plans grow nested keys
  const sections = plan.replace(/\r\n/g, '\n').split(/^(?=## )/m);
  const section = sections.find((s) => /^## Tasks\b/.test(s)) ?? '';
  const block = section.match(/^```ya?ml[ \t]*\n([\s\S]*?)^```/m)?.[1] ?? '';
  const tasks = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^(- | {2})(\w+):[ \t]*(.*)$/);
    if (!m) continue;
    if (m[1] === '- ') tasks.push({ id: null, goal: null, size: null, dependsOn: [] });
    const task = tasks.at(-1);
    if (!task) continue;
    const [, , key, value] = m;
    if (key === 'depends_on') {
      task.dependsOn = (value.match(/^\[(.*?)\]/)?.[1] ?? '')
        .split(',')
        .map((s) => scalar(s.trim()))
        .filter(Boolean);
    } else if (key === 'id' || key === 'goal' || key === 'size') task[key] = scalar(value) || null;
  }
  return tasks.filter((t) => t.id !== null);
}

/** `{ status }` from the worker's report, or null when it is missing or has no Status line. */
function reportStatus(deps, path) {
  const status = readReport(deps, path)?.match(STATUS)?.[1];
  return status ? { status: status.toLowerCase() } : null;
}

/**
 * Collects the state of every `<root>/.scratch/<feature>/plan.md`, `root` being the main checkout
 * (the parent of the git common dir, also from inside a task worktree): tasks joined with their `wt`
 * worktrees, herdr agents and worker reports. Live worktrees not in the plan are kept as tasks
 * with `goal: null`. A `wt` failure is a warning, not an error. Returns `{ code, result }` or
 * `{ code: 1, error }` outside a git repo. `deps`: `exec` (never throws), `readdir`,
 * `readFile` (utf8), `env`, `hasCommand(name, PATH)`.
 */
export function collect(deps, cwd) {
  // The main checkout, even from a task worktree: plans live in its .scratch/, not the worktree's.
  const common = deps.exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (common.status !== 0 || !common.stdout.trim()) {
    return { code: 1, error: `orch status: not a git repository: ${cwd}` };
  }
  const root = dirname(common.stdout.trim());
  const warnings = [];
  const herdrOn = deps.hasCommand('herdr', deps.env.PATH);
  let names = [];
  try {
    names = deps.readdir(join(root, '.scratch')).sort();
  } catch {
    // no .scratch: no features
  }
  let found = null; // `wt list` runs once, on the first feature with a plan
  const features = [];
  for (const feature of names) {
    const plan = join(root, '.scratch', feature, 'plan.md');
    let text;
    try {
      text = deps.readFile(plan);
    } catch {
      continue; // a scratch dir without a plan is not a feature
    }
    if (found === null) {
      found = worktrees(deps, root);
      // `error` can be '' (wt failed silently), so test for `items`
      if (!found.items) warnings.push(`wt list failed; worktrees unknown: ${found.error.trim()}`);
    }
    const trees = found.items ? featureTasks(found.items, feature) : [];
    const planned = parseTasks(text);
    const extra = trees
      .filter((w) => !planned.some((t) => t.id === w.task))
      .map((w) => ({ id: w.task, goal: null, size: null, dependsOn: [] }));
    const tasks = [...planned, ...extra].map((t) => {
      const tree = trees.find((w) => w.task === t.id);
      const worktree = tree ? resolve(root, tree.path) : null;
      let agent = null;
      if (worktree && herdrOn) {
        const name = agentName(t.id, worktree);
        const got = agentState(deps, name);
        if (!got.error) agent = { name, state: got.state };
      }
      const report = worktree ? reportStatus(deps, worktree) : null;
      return { ...t, branch: taskBranch(feature, t.id), worktree, agent, report };
    });
    features.push({ feature, base: parseBase(text), plan, tasks });
  }
  return { code: 0, result: { schemaVersion: 1, root, warnings, features } };
}

/**
 * One line per task: `feature/id  <state>  <worktree or ->`; `no features` without plans,
 * `no tasks` when the plans list none.
 */
export function formatText(result) {
  const lines = result.features.flatMap(({ feature, tasks }) =>
    tasks.map((t) => {
      const state = t.agent?.state ?? t.report?.status ?? (t.worktree ? 'worktree' : '-');
      return `${feature}/${t.id}  ${state}  ${t.worktree ?? '-'}`;
    }),
  );
  if (lines.length) return `${lines.join('\n')}\n`;
  return result.features.length ? 'no tasks\n' : 'no features\n';
}

/** `orch status [--json]`. Returns `{ code, out, err }`; warnings go to `err`. Never throws. */
export function run(args, deps, cwd) {
  const json = args.includes('--json');
  if (args.some((a) => a !== '--json')) return { code: 1, out: '', err: USAGE };
  const r = collect(deps, cwd);
  if (r.error) return { code: 1, out: '', err: `${r.error}\n` };
  const out = json ? `${JSON.stringify(r.result, null, 2)}\n` : formatText(r.result);
  const err = json ? '' : r.result.warnings.map((w) => `orch status: ${w}\n`).join('');
  return { code: 0, out, err };
}
