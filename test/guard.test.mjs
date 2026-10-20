import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classify,
  decide,
  formatDeny,
  main,
  recordSignal,
  roleOf,
  run,
  signalDeps,
} from '../hooks/guard.mjs';

// Not a git repo: a deny/block from main or the script records no signal into this checkout.
const NO_REPO = mkdtempSync(join(tmpdir(), 'orc-signal-'));
after(() => rmSync(NO_REPO, { recursive: true, force: true }));
const script = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));

test('roleOf strips the plugin prefix and defaults to main', () => {
  assert.equal(roleOf('orc:implementer'), 'implementer');
  assert.equal(roleOf('implementer'), 'implementer');
  assert.equal(roleOf(undefined), 'main');
  assert.equal(roleOf(''), 'main');
});

test('classify sees through env assignments, git/gh global options and absolute paths', () => {
  const c = (s) => classify(s.split(/\s+/));
  assert.equal(c('git push origin main'), 'push');
  assert.equal(c('FOO=1 BAR=2 git push'), 'push');
  assert.equal(c('env X=1 git commit -m x'), 'commit');
  assert.equal(c('git -C ../x -c user.name=a commit -m x'), 'commit');
  assert.equal(c('git --no-pager --git-dir=.git push'), 'push');
  assert.equal(c('git --git-dir .git push'), 'push');
  assert.equal(c('/usr/bin/git push'), 'push');
  assert.equal(c('gh pr create --fill'), 'pr');
  assert.equal(c('gh -R a/b pr merge 3'), 'pr');
  assert.equal(c('gh pr edit 3'), 'pr');
  assert.equal(c('gh pr view 3'), null);
  assert.equal(c('gh issue create'), null);
  assert.equal(c('gh'), null);
  assert.equal(c('git status'), null);
  assert.equal(c('git -C x'), null);
  assert.equal(c('git'), null);
  assert.equal(c('echo git push'), null);
  assert.equal(c('FOO=1'), null);
  assert.equal(classify([]), null);
});

test('decide: push and PR commands are shipper-only', () => {
  for (const role of ['main', 'implementer', 'scoper', 'reviewer']) {
    assert.match(decide(role, 'git push'), /only the shipper/);
    assert.match(decide(role, 'gh pr create'), /only the shipper/);
  }
  assert.equal(decide('shipper', 'git push origin x && gh pr create --fill'), null);
});

test('decide: commit is denied for implementer, scoper, reviewer only', () => {
  for (const role of ['implementer', 'scoper', 'reviewer']) {
    assert.match(decide(role, 'git commit -m x'), new RegExp(`${role} role must not commit`));
  }
  assert.equal(decide('main', 'git commit -m x'), null);
  assert.equal(decide('shipper', 'git commit -m x'), null);
});

test('decide matches inside chains and pipes', () => {
  assert.ok(decide('implementer', 'npm test && git commit -am x'));
  assert.ok(decide('implementer', 'npm test; FOO=1 git -C sub commit -m x'));
  assert.ok(decide('implementer', 'npm test || git push'));
  assert.ok(decide('implementer', 'echo hi | git commit -F -'));
  assert.ok(decide('implementer', 'sleep 1 & git push'));
  assert.ok(decide('implementer', 'npm test\ngit push'));
  assert.equal(decide('implementer', 'git status && git diff | head && npm test'), null);
});

test('decide allows non-string commands', () => {
  assert.equal(decide('implementer', undefined), null);
  assert.equal(decide('implementer', 42), null);
});

test('formatDeny emits the PreToolUse deny shape', () => {
  assert.deepEqual(JSON.parse(formatDeny('why')), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'why',
    },
  });
});

function call(env, payload) {
  let stdout = '';
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const code = run({ env, input, stdout: (s) => (stdout += s) });
  return { code, stdout };
}
const bash = (command, agent_type) => ({ tool_name: 'Bash', tool_input: { command }, agent_type });

test('run is silent unless ORC=1', () => {
  assert.deepEqual(call({}, bash('git push')), { code: 0, stdout: '' });
  assert.deepEqual(call({ ORC: '0' }, bash('git push')), { code: 0, stdout: '' });
});

test('run denies per role and allows silently otherwise', () => {
  const env = { ORC: '1' };
  const denied = call(env, bash('git commit -m x', 'orc:implementer'));
  assert.equal(denied.code, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(call(env, bash('git push')).stdout.includes('deny'), true);
  assert.deepEqual(call(env, bash('git commit -m x')), { code: 0, stdout: '' });
  assert.deepEqual(call(env, bash('git push', 'orc:shipper')), { code: 0, stdout: '' });
  assert.deepEqual(call(env, bash('ls', 'orc:implementer')), { code: 0, stdout: '' });
});

test('run exits 0 silently on bad or oddly shaped input', () => {
  const env = { ORC: '1' };
  for (const input of ['', '{not json', 'null', '{}', '{"tool_input":null}']) {
    assert.deepEqual(call(env, input), { code: 0, stdout: '' });
  }
});

test('main wires env, stdin reader and stdout; skips reading without ORC', () => {
  const proc = (env) => ({
    env,
    out: '',
    cwd: () => NO_REPO,
    stdout: { write: (s) => (proc.out += s) },
  });
  const on = proc({ ORC: '1' });
  main(on, () => JSON.stringify(bash('git push')));
  assert.equal(on.exitCode, 0);
  assert.match(proc.out, /deny/);

  const off = proc({});
  main(off, () => assert.fail('must not read stdin'));
  assert.equal(off.exitCode, 0);
});

test('script entrypoint reads stdin end to end', () => {
  const opts = (env, input) => ({
    env: { ...process.env, ...env },
    input,
    cwd: NO_REPO,
    encoding: 'utf8',
  });
  const deny = spawnSync(
    process.execPath,
    [script],
    opts({ ORC: '1' }, JSON.stringify(bash('git push', 'orc:reviewer'))),
  );
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const garbage = spawnSync(process.execPath, [script], opts({ ORC: '1' }, 'nope'));
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');

  const off = spawnSync(
    process.execPath,
    [script],
    opts({ ORC: '' }, JSON.stringify(bash('git push'))),
  );
  assert.equal(off.status, 0);
  assert.equal(off.stdout, '');
});

test('run: a no-commit ORC_ROLE (herdr pane workers) overrides agent_type', () => {
  const pane = { ORC: '1', ORC_ROLE: 'implementer' };
  assert.match(call(pane, bash('git commit -m x')).stdout, /implementer role must not commit/);
  assert.match(call(pane, bash('git commit -m x', '')).stdout, /implementer role must not commit/);
  assert.match(
    call(pane, bash('git push', 'orc:shipper')).stdout,
    /only the shipper role may push.*role: implementer/,
  );
  assert.match(call(pane, bash('git commit -m x', 'orc:shipper')).stdout, /must not commit/);
  assert.deepEqual(call({ ORC: '1', ORC_ROLE: '' }, bash('git commit -m x')), {
    code: 0,
    stdout: '',
  });
});

test('run ignores an ORC_ROLE that would widen permissions', () => {
  const shipper = { ORC: '1', ORC_ROLE: 'shipper' };
  assert.match(
    call(shipper, bash('git push')).stdout,
    /only the shipper role may push.*role: main/,
  );
});

/** Fake `recordSignal` deps over a repo at /repo; `ignored` says whether `.orc/` is excluded. */
function signalHarness({ common = '/repo/.git', ignored = true } = {}) {
  const calls = [];
  const deps = {
    cwd: '/repo/sub',
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    exec: (cmd, args, cwd) => {
      calls.push(['exec', [cmd, ...args].join(' '), cwd]);
      if (args.includes('--git-common-dir')) {
        return common ? { status: 0, stdout: `${common}\n` } : { status: 128, stdout: '' };
      }
      if (args[0] === 'check-ignore') return { status: ignored ? 0 : 1, stdout: '' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: '.git\n' };
      return { status: 1, stdout: '' };
    },
    mkdir: (p) => calls.push(['mkdir', p]),
    append: (p, text) => calls.push(['append', p, text]),
  };
  return { deps, calls };
}

test('recordSignal appends one JSON line under the main root .orc and keeps it excluded', () => {
  const { deps, calls } = signalHarness({ ignored: false });
  recordSignal(deps, 'deny', 'implementer', 'commit git commit -m x');
  assert.deepEqual(
    calls.filter((c) => c[0] !== 'exec'),
    [
      ['mkdir', '/repo/.orc'],
      ['mkdir', '/repo/.git/info'],
      ['append', '/repo/.git/info/exclude', '.worktrees/\n.orc/\n'],
      [
        'append',
        '/repo/.orc/signals.jsonl',
        '{"ts":"2026-01-02T03:04:05.000Z","kind":"deny","role":"implementer","reason":"commit git commit -m x"}\n',
      ],
    ],
  );
});

test('recordSignal is a no-op outside a repo and swallows every failure', () => {
  const none = signalHarness({ common: null });
  recordSignal(none.deps, 'deny', 'main', 'x');
  assert.deepEqual(
    none.calls.filter((c) => c[0] !== 'exec'),
    [],
  );
  const { deps } = signalHarness();
  deps.append = () => {
    throw new Error('EACCES');
  };
  assert.doesNotThrow(() => recordSignal(deps, 'deny', 'main', 'x'));
  assert.doesNotThrow(() => recordSignal(undefined, 'deny', 'main', 'x'));
  const real = signalHarness();
  delete real.deps.now;
  recordSignal(real.deps, 'deny', 'main', 'x');
  const line = real.calls.find((c) => c[0] === 'append')[2];
  assert.match(JSON.parse(line).ts, /^\d{4}-\d\d-\d\dT/);
});

test('run records a deny signal with kind and command prefix; an allow touches nothing', () => {
  const { deps, calls } = signalHarness();
  let stdout = '';
  const long = `git push ${'x'.repeat(100)}`;
  const input = JSON.stringify(bash(long, 'orc:reviewer'));
  run({ env: { ORC: '1' }, input, stdout: (s) => (stdout += s), signals: deps });
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, 'deny');
  const signal = JSON.parse(calls.find((c) => c[0] === 'append')[2]);
  assert.deepEqual(signal, {
    ts: '2026-01-02T03:04:05.000Z',
    kind: 'deny',
    role: 'reviewer',
    reason: `push ${long.slice(0, 80)}`,
  });

  const touch = () => assert.fail('the allow path must not touch git or fs');
  const strict = { cwd: '/repo', exec: touch, mkdir: touch, append: touch };
  for (const command of ['ls', 'git status']) {
    let out = '';
    run({
      env: { ORC: '1' },
      input: JSON.stringify(bash(command, 'orc:implementer')),
      stdout: (s) => (out += s),
      signals: strict,
    });
    assert.equal(out, '');
  }
});

test('run output is unchanged when recording the signal fails', () => {
  const { deps } = signalHarness();
  deps.mkdir = () => {
    throw new Error('EROFS');
  };
  let stdout = '';
  const input = JSON.stringify(bash('git commit -m x', 'orc:implementer'));
  assert.equal(run({ env: { ORC: '1' }, input, stdout: (s) => (stdout += s), signals: deps }), 0);
  assert.equal(stdout, formatDeny(decide('implementer', 'git commit -m x')));
});

test('signalDeps.mkdir creates nested directories', () => {
  const dir = join(NO_REPO, 'a', 'b');
  signalDeps.mkdir(dir);
  assert.equal(existsSync(dir), true);
});
