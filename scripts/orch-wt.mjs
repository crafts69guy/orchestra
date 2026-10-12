import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const WORKTREE_DIR = '.worktrees';
const PATH_TEMPLATE = `worktree-path="${WORKTREE_DIR}/{{ branch | sanitize }}"`;
const USAGE =
  'usage: orch-wt new <feature> <task>... [--yes] | orch-wt merge <feature> <task> --message <msg> [--yes]';

/** Real exec: never throws; a spawn failure (e.g. ENOENT) becomes status 127. */
export function exec(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return {
    status: r.status ?? 127,
    stdout: r.stdout ?? '',
    stderr: r.error ? r.error.message : (r.stderr ?? ''),
  };
}

export const taskBranch = (feature, task) => `${feature}--${task}`;

const git = (deps, cwd, ...args) => deps.exec('git', args, cwd);
const fail = (task, stderr) => ({ code: 1, result: { status: 'error', task, stderr } });
const lines = (s) => s.split('\n').filter(Boolean);

/** Keep `.worktrees/` out of `git status` without touching tracked files. */
export function ensureIgnored(deps, cwd) {
  if (git(deps, cwd, 'check-ignore', '-q', `${WORKTREE_DIR}/x`).status === 0) return null;
  const common = git(deps, cwd, 'rev-parse', '--git-common-dir');
  if (common.status !== 0) return common.stderr;
  const info = resolve(cwd, common.stdout.trim(), 'info');
  deps.mkdir(info);
  deps.append(resolve(info, 'exclude'), `${WORKTREE_DIR}/\n`);
  return null;
}

export function create(deps, cwd, feature, tasks, yes) {
  const ignoreErr = ensureIgnored(deps, cwd);
  if (ignoreErr !== null) return fail(null, ignoreErr);
  const created = [];
  for (const task of tasks) {
    const branch = taskBranch(feature, task);
    const args = ['--config-set', PATH_TEMPLATE, 'switch', '-c', branch, '--base', feature];
    args.push('--no-cd', '--format=json', ...(yes ? ['--yes'] : []));
    const r = deps.exec('wt', args, cwd);
    if (r.status !== 0) return fail(task, r.stderr);
    try {
      created.push({ task, branch, path: JSON.parse(r.stdout).path });
    } catch {
      return fail(task, `unparseable wt output: ${r.stdout}`);
    }
  }
  return { code: 0, result: created };
}

function findWorktree(deps, cwd, branch) {
  const r = deps.exec('wt', ['list', '--format=json'], cwd);
  if (r.status !== 0) return { error: r.stderr };
  try {
    const item = JSON.parse(r.stdout).items.find((i) => i.branch === branch);
    if (item?.worktree?.path) return { path: item.worktree.path };
  } catch {
    return { error: `unparseable wt list output: ${r.stdout}` };
  }
  return { error: `no worktree for branch ${branch}` };
}

/** Commit pending work as ONE commit with our message; wt's own fallback message is not conventional. */
function commitTask(deps, path, feature, message) {
  const dirty = git(deps, path, 'status', '--porcelain').stdout.trim() !== '';
  const base = git(deps, path, 'merge-base', feature, 'HEAD');
  if (base.status !== 0) return base.stderr;
  const count = Number(
    git(deps, path, 'rev-list', '--count', `${base.stdout.trim()}..HEAD`).stdout,
  );
  if (!dirty && count <= 1) return null;
  const steps = [
    ...(count > 0 ? [['reset', '--soft', base.stdout.trim()]] : []),
    ['add', '-A'],
    ['commit', '-m', message],
  ];
  for (const step of steps) {
    const r = git(deps, path, ...step);
    if (r.status !== 0) return r.stderr || r.stdout;
  }
  return null;
}

export function merge(deps, cwd, feature, task, message, yes) {
  const branch = taskBranch(feature, task);
  const found = findWorktree(deps, cwd, branch);
  if (found.error) return fail(task, found.error);
  const { path } = found;

  const commitErr = commitTask(deps, path, feature, message);
  if (commitErr !== null) return fail(task, commitErr);

  const tree = git(deps, path, 'merge-tree', '--write-tree', '--name-only', feature, 'HEAD');
  if (tree.status === 1) {
    // output: <tree oid>, conflicted file names, blank line, informational messages
    const files = lines(tree.stdout.split('\n\n')[0]).slice(1);
    return { code: 2, result: { status: 'conflict', task, files } };
  }
  if (tree.status !== 0) return fail(task, tree.stderr);

  const r = deps.exec(
    'wt',
    ['-C', path, 'merge', feature, '--no-commit', ...(yes ? ['--yes'] : [])],
    cwd,
  );
  if (r.status !== 0) {
    const rebaseDir = git(deps, path, 'rev-parse', '--git-path', 'rebase-merge').stdout.trim();
    if (!deps.exists(resolve(path, rebaseDir))) return fail(task, r.stderr);
    const files = lines(git(deps, path, 'diff', '--name-only', '--diff-filter=U').stdout);
    git(deps, path, 'rebase', '--abort');
    return { code: 2, result: { status: 'conflict', task, files } };
  }
  const commit = git(deps, cwd, 'rev-parse', feature).stdout.trim();
  return { code: 0, result: { status: 'merged', task, commit } };
}

/** Returns `{ code, result }`; `result` is the JSON document to print. */
export function run(argv, deps, cwd) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { yes: { type: 'boolean' }, message: { type: 'string' } },
    });
  } catch (e) {
    return fail(null, `${e.message}\n${USAGE}`);
  }
  const [cmd, feature, ...tasks] = parsed.positionals;
  const { yes = false, message } = parsed.values;
  if (cmd === 'new' && feature && tasks.length > 0) return create(deps, cwd, feature, tasks, yes);
  if (cmd === 'merge' && feature && tasks.length === 1 && message) {
    return merge(deps, cwd, feature, tasks[0], message, yes);
  }
  return fail(null, USAGE);
}

export const realDeps = {
  exec,
  exists: existsSync,
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  append: appendFileSync,
};

export function main(proc = process, deps = realDeps) {
  const { code, result } = run(proc.argv.slice(2), deps, proc.cwd());
  proc.stdout.write(`${JSON.stringify(result)}\n`);
  proc.exitCode = code;
}
