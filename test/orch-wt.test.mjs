import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  create,
  ensureIgnored,
  exec,
  list,
  merge,
  realDeps,
  remove,
  run,
} from '../scripts/orch-wt.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'orch-wt-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const bad = (stderr = 'boom', status = 1, stdout = '') => ({ status, stdout, stderr });

/** Fake exec: `routes` maps a "cmd arg arg" prefix to a result or a function; every call is logged. */
function fake(routes) {
  const calls = [];
  const deps = {
    calls,
    exec(cmd, args, cwd) {
      const line = [cmd, ...args].join(' ');
      calls.push({ line, cwd });
      const key = Object.keys(routes).find((k) => line.startsWith(k));
      const hit = routes[key];
      return typeof hit === 'function' ? hit(line) : (hit ?? ok());
    },
    exists: () => false,
    mkdir: (p) => deps.dirs.push(p),
    rmdir: (p) => deps.removed.push(p),
    removed: [],
    append: (p, text) => deps.appended.push([p, text]),
    dirs: [],
    appended: [],
  };
  return deps;
}
const lines = (deps) => deps.calls.map((c) => c.line);

test('exec returns status/stdout and maps spawn failure to 127', () => {
  const r = exec(
    process.execPath,
    ['-e', 'console.log("hi"); console.error("e"); process.exit(3)'],
    tmp,
  );
  assert.deepEqual(r, { status: 3, stdout: 'hi\n', stderr: 'e\n' });
  const missing = exec('orch-no-such-binary', [], tmp);
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /ENOENT/);
});

test('ensureIgnored does nothing when .worktrees is already ignored', () => {
  const deps = fake({ 'git check-ignore': ok() });
  assert.equal(ensureIgnored(deps, '/r'), null);
  assert.deepEqual(deps.appended, []);
});

test('ensureIgnored appends to the common-dir info/exclude otherwise', () => {
  const deps = fake({ 'git check-ignore': bad('', 1), 'git rev-parse': ok('.git\n') });
  assert.equal(ensureIgnored(deps, '/r'), null);
  assert.deepEqual(deps.dirs, ['/r/.git/info']);
  assert.deepEqual(deps.appended, [['/r/.git/info/exclude', '.worktrees/\n.orch/\n']]);
});

test('ensureIgnored appends only the directories not yet ignored', () => {
  const deps = fake({
    'git check-ignore -q .worktrees/x': ok(),
    'git check-ignore': bad('', 1),
    'git rev-parse': ok('.git\n'),
  });
  assert.equal(ensureIgnored(deps, '/r'), null);
  assert.deepEqual(deps.appended, [['/r/.git/info/exclude', '.orch/\n']]);
});

test('ensureIgnored reports a failing rev-parse', () => {
  const deps = fake({ 'git check-ignore': bad('', 1), 'git rev-parse': bad('not a repo', 128) });
  assert.equal(ensureIgnored(deps, '/r'), 'not a repo');
});

test('create runs wt per task with the in-repo path template and prints task/branch/path', () => {
  const deps = fake({
    'wt ': (line) =>
      ok(
        JSON.stringify({
          action: 'created',
          path: `/r/.worktrees/${/switch -c (\S+)/.exec(line)[1]}`,
        }),
      ),
    'git check-ignore': ok(),
  });
  const { code, result } = create(deps, '/r', 'F', ['T1', 'T2'], true);
  assert.equal(code, 0);
  assert.deepEqual(result, [
    { task: 'T1', branch: 'F--T1', path: '/r/.worktrees/F--T1' },
    { task: 'T2', branch: 'F--T2', path: '/r/.worktrees/F--T2' },
  ]);
  assert.equal(
    lines(deps)[2],
    'wt --config-set worktree-path=".worktrees/{{ branch | sanitize }}" switch -c F--T1 --base F --no-cd --format=json --yes',
  );
});

test('create omits --yes by default, and stops at the first wt failure', () => {
  const deps = fake({
    'git check-ignore': ok(),
    'wt --config-set worktree-path=".worktrees/{{ branch | sanitize }}" switch -c F--T1':
      ok('{"path":"/p"}'),
    'wt ': bad('Cannot prompt for approval'),
  });
  const { code, result } = create(deps, '/r', 'F', ['T1', 'T2', 'T3'], false);
  assert.ok(!lines(deps)[2].includes('--yes'));
  assert.equal(code, 1);
  assert.deepEqual(result, { status: 'error', task: 'T2', stderr: 'Cannot prompt for approval' });
  assert.equal(deps.calls.length, 4);
});

test('create reports unparseable wt output and ignore failures', () => {
  const garbled = fake({ 'git check-ignore': ok(), 'wt ': ok('not json') });
  assert.equal(create(garbled, '/r', 'F', ['T1'], false).result.status, 'error');
  const noRepo = fake({ 'git check-ignore': bad('', 1), 'git rev-parse': bad('nope', 128) });
  assert.deepEqual(create(noRepo, '/r', 'F', ['T1'], false), {
    code: 1,
    result: { status: 'error', task: null, stderr: 'nope' },
  });
});

const LIST = JSON.stringify({
  items: [{ branch: 'F--T1', worktree: { path: '/r/.worktrees/F--T1' } }],
});

function mergeRoutes(extra = {}) {
  return {
    'wt list': ok(LIST),
    'git status': ok(''),
    'git merge-base': ok('BASE\n'),
    'git rev-list': ok('1\n'),
    'git merge-tree': ok('tree\n'),
    'wt -C': ok(),
    'git rev-parse F': ok('abc123\n'),
    ...extra,
  };
}

test('merge on a clean single-commit branch skips committing and reports the F tip', () => {
  const deps = fake(mergeRoutes());
  const { code, result } = merge(deps, '/r', 'F', 'T1', 'feat: x', true);
  assert.equal(code, 0);
  assert.deepEqual(result, { status: 'merged', task: 'T1', commit: 'abc123' });
  assert.ok(!lines(deps).some((l) => l.startsWith('git commit') || l.startsWith('git reset')));
  assert.ok(
    lines(deps).includes('wt -C /r/.worktrees/F--T1 merge F --no-commit --no-remove --yes'),
  );
  const rm = deps.calls.at(-1);
  assert.deepEqual(rm, { line: 'wt remove F--T1 --foreground -D --yes', cwd: '/r' });
  assert.deepEqual(deps.removed, [], 'nothing left on disk, nothing to rmdir');
  assert.equal(
    deps.calls.find((c) => c.line.startsWith('git merge-tree')).cwd,
    '/r/.worktrees/F--T1',
  );
});

test('merge omits --yes unless asked', () => {
  const deps = fake(mergeRoutes());
  merge(deps, '/r', 'F', 'T1', 'm', false);
  assert.ok(lines(deps).includes('wt -C /r/.worktrees/F--T1 merge F --no-commit --no-remove'));
  assert.ok(lines(deps).includes('wt remove F--T1 --foreground -D'));
});

test('merge commits a dirty tree, soft-resetting onto the merge-base first', () => {
  const deps = fake(mergeRoutes({ 'git status': ok(' M a\n'), 'git rev-list': ok('1\n') }));
  assert.equal(merge(deps, '/r', 'F', 'T1', 'feat: x', false).code, 0);
  const l = lines(deps);
  assert.deepEqual(l.slice(4, 7), ['git reset --soft BASE', 'git add -A', 'git commit -m feat: x']);
});

test('merge squashes a clean multi-commit branch, and commits a dirty tree with no commits', () => {
  const multi = fake(mergeRoutes({ 'git rev-list': ok('3\n') }));
  merge(multi, '/r', 'F', 'T1', 'm', false);
  assert.ok(lines(multi).includes('git reset --soft BASE'));
  const none = fake(mergeRoutes({ 'git status': ok('?? a\n'), 'git rev-list': ok('0\n') }));
  merge(none, '/r', 'F', 'T1', 'm', false);
  assert.ok(!lines(none).some((l) => l.startsWith('git reset')));
  assert.ok(lines(none).includes('git commit -m m'));
});

test('merge errors: missing/failed/garbled worktree lookup, merge-base, commit, merge-tree', () => {
  const cases = [
    [{ 'wt list': ok('{"items":[]}') }, /no worktree for branch F--T1/],
    [{ 'wt list': bad('list failed') }, /list failed/],
    [{ 'wt list': ok('nope') }, /unparseable wt list/],
    [{ 'git merge-base': bad('no base') }, /no base/],
    [{ 'git status': ok('x'), 'git commit': bad('', 1, 'hook rejected') }, /hook rejected/],
    [{ 'git status': ok('x'), 'git add': bad('add failed') }, /add failed/],
    [{ 'git merge-tree': bad('tree broke', 128) }, /tree broke/],
  ];
  for (const [extra, re] of cases) {
    const { code, result } = merge(fake(mergeRoutes(extra)), '/r', 'F', 'T1', 'm', false);
    assert.equal(code, 1);
    assert.equal(result.status, 'error');
    assert.match(result.stderr, re);
  }
});

test('merge deletes an empty leftover worktree directory after wt remove', () => {
  const deps = fake(mergeRoutes());
  deps.exists = (p) => p === '/r/.worktrees/F--T1';
  assert.equal(merge(deps, '/r', 'F', 'T1', 'm', false).result.status, 'merged');
  assert.deepEqual(deps.removed, ['/r/.worktrees/F--T1']);
});

test('merge reports a failed removal or a non-empty leftover as an error naming the commit', () => {
  const failed = merge(
    fake(mergeRoutes({ 'wt remove': bad('locked') })),
    '/r',
    'F',
    'T1',
    'm',
    false,
  );
  assert.deepEqual(failed, {
    code: 1,
    result: {
      status: 'error',
      task: 'T1',
      stderr: 'merged as abc123, but /r/.worktrees/F--T1 is left: locked',
    },
  });
  const deps = fake(mergeRoutes());
  deps.exists = () => true;
  deps.rmdir = () => {
    throw new Error('ENOTEMPTY');
  };
  const { code, result } = merge(deps, '/r', 'F', 'T1', 'm', false);
  assert.equal(code, 1);
  assert.match(result.stderr, /^merged as abc123, but \/r\/.worktrees\/F--T1 is left: ENOTEMPTY$/);
});

test('merge reports a pre-detected conflict without invoking wt merge', () => {
  const deps = fake(
    mergeRoutes({
      'git merge-tree': bad('', 1, 'tree\na.txt\nb.txt\n\nAuto-merging a.txt\nCONFLICT\n'),
    }),
  );
  const { code, result } = merge(deps, '/r', 'F', 'T1', 'm', false);
  assert.equal(code, 2);
  assert.deepEqual(result, { status: 'conflict', task: 'T1', files: ['a.txt', 'b.txt'] });
  assert.ok(!lines(deps).some((l) => l.startsWith('wt -C')));
});

test('merge aborts an open rebase when wt merge fails and reports conflict files', () => {
  const deps = fake(
    mergeRoutes({
      'wt -C': bad('rebase incomplete'),
      'git rev-parse --git-path': ok('.git/worktrees/x/rebase-merge\n'),
      'git diff': ok('a.txt\n'),
    }),
  );
  deps.exists = (p) => p === '/r/.worktrees/F--T1/.git/worktrees/x/rebase-merge';
  const { code, result } = merge(deps, '/r', 'F', 'T1', 'm', false);
  assert.equal(code, 2);
  assert.deepEqual(result, { status: 'conflict', task: 'T1', files: ['a.txt'] });
  assert.ok(lines(deps).includes('git rebase --abort'));
});

test('merge reports wt failure without a rebase as an error and leaves the worktree alone', () => {
  const deps = fake(
    mergeRoutes({
      'wt -C': bad('pre-merge command failed'),
      'git rev-parse --git-path': ok('rb\n'),
    }),
  );
  const { code, result } = merge(deps, '/r', 'F', 'T1', 'm', false);
  assert.equal(code, 1);
  assert.deepEqual(result, { status: 'error', task: 'T1', stderr: 'pre-merge command failed' });
  assert.ok(!lines(deps).includes('git rebase --abort'));
});

test('run dispatches subcommands and rejects bad usage', () => {
  const deps = fake(
    mergeRoutes({ 'git check-ignore': ok(), 'wt --config-set': ok('{"path":"/p"}') }),
  );
  assert.equal(run(['new', 'F', 'T1', '--yes'], deps, '/r').code, 0);
  assert.equal(
    run(['merge', 'F', 'T1', '--message', 'feat: x'], deps, '/r').result.status,
    'merged',
  );
  for (const argv of [
    [],
    ['new', 'F'],
    ['merge', 'F', 'T1'],
    ['merge', 'F', 'T1', 'T2', '--message', 'm'],
    ['bogus'],
    ['--nope'],
  ]) {
    const { code, result } = run(argv, deps, '/r');
    assert.equal(code, 1);
    assert.match(result.stderr, /usage: orch wt/);
  }
});

test('list returns the feature task worktrees only', () => {
  const items = [
    { branch: 'F', worktree: { path: '/r' } },
    { branch: 'F--T1', worktree: { path: '/r/.worktrees/F--T1' } },
    { branch: 'F--T2' },
    { branch: 'FF--T3', worktree: { path: '/x' } },
    { branch: 'F--', worktree: { path: '/y' } },
    { branch: null, worktree: { path: '/detached' } },
  ];
  const deps = fake({ 'wt list': ok(JSON.stringify({ items })) });
  assert.deepEqual(list(deps, '/r', 'F'), {
    code: 0,
    result: [{ task: 'T1', branch: 'F--T1', path: '/r/.worktrees/F--T1' }],
  });
  assert.deepEqual(run(['list', 'F'], deps, '/r').result.length, 1);
  assert.deepEqual(list(fake({ 'wt list': bad('no wt') }), '/r', 'F'), {
    code: 1,
    result: { status: 'error', task: null, stderr: 'no wt' },
  });
  for (const argv of [['list'], ['list', 'F', 'T1']]) assert.equal(run(argv, deps, '/r').code, 1);
});

test('realDeps wraps fs: mkdir is recursive, append writes, rmdir only takes empty dirs', () => {
  const dir = join(tmp, 'a', 'b');
  realDeps.mkdir(dir);
  realDeps.append(join(dir, 'f'), 'x\n');
  assert.equal(readFileSync(join(dir, 'f'), 'utf8'), 'x\n');
  assert.equal(realDeps.exists(dir), true);
  assert.throws(() => realDeps.rmdir(dir), { code: 'ENOTEMPTY' });
  rmSync(join(dir, 'f'));
  realDeps.rmdir(dir);
  assert.equal(realDeps.exists(dir), false);
});

const hasWt = spawnSync('wt', ['--version']).status === 0;

test('integration: new then merge against real git + wt', {
  skip: !hasWt && 'wt not installed',
}, () => {
  const repo = realpathSync(mkdtempSync(join(tmp, 'repo-')));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    XDG_CONFIG_HOME: join(tmp, 'xdg'),
    HOME: join(tmp, 'home'),
  };
  mkdirSync(env.HOME);
  const sh = (cwd, cmd, ...args) => {
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const git = (cwd, ...args) => sh(cwd, 'git', ...args);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'switch', '-qc', 'feat');

  const bin = fileURLToPath(new URL('../bin/orch', import.meta.url));
  const orch = (...args) =>
    spawnSync(process.execPath, [bin, 'wt', ...args], { cwd: repo, env, encoding: 'utf8' });

  const made = orch('new', 'feat', 'T1', 'T2');
  assert.equal(made.status, 0, made.stderr);
  const [t1, t2] = JSON.parse(made.stdout);
  assert.equal(t1.path, join(repo, '.worktrees', 'feat--T1'));
  assert.equal(git(repo, 'status', '--porcelain'), '', '.worktrees must stay out of git status');

  writeFileSync(join(t1.path, 'b.txt'), 'b\n');
  writeFileSync(join(t2.path, 'a.txt'), 'two\n');
  const m1 = orch('merge', 'feat', 'T1', '--message', 'feat(t1): add b');
  assert.equal(m1.status, 0, m1.stderr);
  const merged = JSON.parse(m1.stdout);
  assert.equal(merged.status, 'merged');
  assert.equal(merged.commit, git(repo, 'rev-parse', 'feat'));
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'feat(t1): add b');
  // removal is synchronous: no (empty) directory and no branch left once `merged` is printed
  assert.equal(existsSync(t1.path), false, 'merged worktree directory must be gone');
  assert.equal(git(repo, 'branch', '--list', 'feat--T1'), '');

  // T2 edits a.txt, which nothing else touched: merges cleanly; now force a conflict on a new task.
  assert.equal(orch('merge', 'feat', 'T2', '--message', 'feat(t2): edit a').status, 0);
  assert.equal(existsSync(t2.path), false);
  const [t3] = JSON.parse(orch('new', 'feat', 'T3').stdout);
  const [t4] = JSON.parse(orch('new', 'feat', 'T4').stdout);
  writeFileSync(join(t3.path, 'a.txt'), 'three\n');
  writeFileSync(join(t4.path, 'a.txt'), 'four\n');
  assert.equal(orch('merge', 'feat', 'T3', '--message', 'feat(t3): a').status, 0);
  const before = git(repo, 'rev-parse', 'feat');
  const c = orch('merge', 'feat', 'T4', '--message', 'feat(t4): a');
  assert.equal(c.status, 2, c.stderr);
  assert.deepEqual(JSON.parse(c.stdout), { status: 'conflict', task: 'T4', files: ['a.txt'] });
  assert.equal(git(repo, 'rev-parse', 'feat'), before);
  assert.equal(existsSync(t4.path), true);

  // merged worktrees are removed; only the conflicted T4 is left
  assert.deepEqual(JSON.parse(orch('list', 'feat').stdout), [
    { task: 'T4', branch: 'feat--T4', path: t4.path },
  ]);
});

test('remove force-removes the task worktree and its unmerged branch', () => {
  const deps = fake({ 'wt remove': ok() });
  assert.deepEqual(remove(deps, '/r', 'F', 'T1', false), {
    code: 0,
    result: { status: 'removed', task: 'T1', branch: 'F--T1' },
  });
  assert.deepEqual(lines(deps), ['wt remove F--T1 --foreground -D -f']);
  assert.equal(run(['remove', 'F', 'T1', '--yes'], deps, '/r').code, 0);
  assert.equal(lines(deps)[1], 'wt remove F--T1 --foreground -D -f --yes');
  const failed = fake({ 'wt remove': bad('no such branch') });
  assert.deepEqual(remove(failed, '/r', 'F', 'T1', false), {
    code: 1,
    result: { status: 'error', task: 'T1', stderr: 'no such branch' },
  });
  assert.equal(run(['remove', 'F'], deps, '/r').code, 1);
});
