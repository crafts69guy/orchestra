import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const WORKTREE_DIR = '.worktrees';
const PATH_TEMPLATE = `worktree-path="${WORKTREE_DIR}/{{ branch | sanitize }}"`;
export const USAGE =
  'usage: orc wt new <feature> <task>... [--yes] | orc wt merge <feature> <task> --message <msg> [--yes] | orc wt remove <feature> <task> [--yes] | orc wt list <feature> | orc wt session <branch> [--base <ref>] [--yes]';

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

/** Pane workers write `<worktree>/.orc/report.md`; ignored so it never lands in a merge commit. */
export const REPORT_DIR = '.orc';

/** Keep `.worktrees/` and `.orc/` out of `git status` without touching tracked files. */
export function ensureIgnored(deps, cwd) {
  const missing = [WORKTREE_DIR, REPORT_DIR].filter(
    (dir) => git(deps, cwd, 'check-ignore', '-q', `${dir}/x`).status !== 0,
  );
  if (missing.length === 0) return null;
  const common = git(deps, cwd, 'rev-parse', '--git-common-dir');
  if (common.status !== 0) return common.stderr;
  const info = resolve(cwd, common.stdout.trim(), 'info');
  deps.mkdir(info);
  deps.append(resolve(info, 'exclude'), missing.map((dir) => `${dir}/\n`).join(''));
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

/** `wt list` items that have a worktree, as `{ branch, path }`, or `{ error }`. */
export function worktrees(deps, cwd) {
  const r = deps.exec('wt', ['list', '--format=json'], cwd);
  if (r.status !== 0) return { error: r.stderr || `wt list exited ${r.status}` };
  try {
    const items = JSON.parse(r.stdout).items.filter((i) => i.worktree?.path);
    return { items: items.map((i) => ({ branch: i.branch, path: i.worktree.path })) };
  } catch {
    return { error: `unparseable wt list output: ${r.stdout}` };
  }
}

function findWorktree(deps, cwd, branch) {
  const found = worktrees(deps, cwd);
  if (found.error) return found;
  const item = found.items.find((i) => i.branch === branch);
  return item ? { path: item.path } : { error: `no worktree for branch ${branch}` };
}

/** The `worktrees()` items of `feature` (branches `<feature>--<task>`) as `{ task, branch, path }`. */
export function featureTasks(items, feature) {
  const prefix = taskBranch(feature, '');
  return items
    .filter((i) => i.branch?.startsWith(prefix) && i.branch.length > prefix.length)
    .map(({ branch, path }) => ({ task: branch.slice(prefix.length), branch, path }));
}

/** Task worktrees of `feature`: branches named `<feature>--<task>`. */
export function list(deps, cwd, feature) {
  const found = worktrees(deps, cwd);
  if (found.error) return fail(null, found.error);
  return { code: 0, result: featureTasks(found.items, feature) };
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

  const yesArg = yes ? ['--yes'] : [];
  // --no-remove: wt's own cleanup runs in the background and returns before the directory is
  // gone (or never finishes when the caller's sandbox kills it), so remove in the foreground below.
  const r = deps.exec(
    'wt',
    ['-C', path, 'merge', feature, '--no-commit', '--no-remove', ...yesArg],
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
  const left = `merged as ${commit}, but ${path} is left`;
  // -D: wt judges "merged" against the default branch, but the branch is now in `feature`.
  const rm = deps.exec('wt', ['remove', branch, '--foreground', '-D', ...yesArg], cwd);
  if (rm.status !== 0) return fail(task, `${left}: ${rm.stderr}`);
  if (deps.exists(path)) {
    try {
      deps.rmdir(path); // only an empty leftover: rmdir refuses a non-empty directory
    } catch (e) {
      return fail(task, `${left}: ${e.message}`);
    }
  }
  return { code: 0, result: { status: 'merged', task, commit } };
}

/**
 * Abandons a task: removes its worktree (even dirty) and deletes its branch (even unmerged).
 * Returns `{ status: 'removed', task, branch }`.
 */
export function remove(deps, cwd, feature, task, yes) {
  const branch = taskBranch(feature, task);
  const args = ['remove', branch, '--foreground', '-D', '-f', ...(yes ? ['--yes'] : [])];
  const r = deps.exec('wt', args, cwd);
  if (r.status !== 0) return fail(task, r.stderr);
  return { code: 0, result: { status: 'removed', task, branch } };
}

/**
 * A session worktree for `branch`: reuses its worktree, or creates one (a new branch from `base`
 * when the branch does not exist yet; `base` is ignored for an existing branch). The path comes
 * from the user's worktrunk template, not `.worktrees/`. Returns `{ branch, path, action }`.
 */
export function session(deps, cwd, branch, base, yes) {
  const exists = git(deps, cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  const args =
    exists.status === 0
      ? ['switch', branch]
      : ['switch', '-c', branch, ...(base ? ['--base', base] : [])];
  args.push('--no-cd', '--format=json', ...(yes ? ['--yes'] : []));
  const r = deps.exec('wt', args, cwd);
  if (r.status !== 0) return fail(null, r.stderr);
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    out = null;
  }
  if (typeof out?.path !== 'string') return fail(null, `unparseable wt output: ${r.stdout}`);
  return { code: 0, result: { branch, path: out.path, action: out.action } };
}

/** Returns `{ code, result }`; `result` is the JSON document to print. */
export function run(argv, deps, cwd) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { yes: { type: 'boolean' }, message: { type: 'string' }, base: { type: 'string' } },
    });
  } catch (e) {
    return fail(null, `${e.message}\n${USAGE}`);
  }
  const [cmd, feature, ...tasks] = parsed.positionals;
  const { yes = false, message, base } = parsed.values;
  if (cmd === 'new' && feature && tasks.length > 0) return create(deps, cwd, feature, tasks, yes);
  if (cmd === 'merge' && feature && tasks.length === 1 && message) {
    return merge(deps, cwd, feature, tasks[0], message, yes);
  }
  if (cmd === 'remove' && feature && tasks.length === 1) {
    return remove(deps, cwd, feature, tasks[0], yes);
  }
  if (cmd === 'list' && feature && tasks.length === 0) return list(deps, cwd, feature);
  if (cmd === 'session' && feature && tasks.length === 0) {
    return session(deps, cwd, feature, base, yes);
  }
  return fail(null, USAGE);
}

export const realDeps = {
  exec,
  exists: existsSync,
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  rmdir: rmdirSync,
  append: appendFileSync,
};
