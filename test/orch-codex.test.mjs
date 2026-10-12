import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  agentArgs,
  buildArgs,
  gitCommonDir,
  main,
  run,
  spawnCodex,
} from '../scripts/orch-codex.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'orch-codex-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const AGENTS = {
  'b.toml': 'name = "b"\ndescription = "orch workflow: say \\"hi\\"."\nx = 1\n',
  'a.toml': 'name = "a"\ndescription = "orch workflow: a."\n',
  'c.toml': 'name = "c"\n',
  'notes.md': 'ignored',
};

function fixtureRoot(name, rules = '# RULES\n') {
  const root = join(tmp, name);
  mkdirSync(join(root, 'rules'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'codex', 'agents'), { recursive: true });
  if (rules !== null) writeFileSync(join(root, 'rules', 'orchestrator.md'), rules);
  for (const [f, text] of Object.entries(AGENTS)) {
    writeFileSync(join(root, 'codex', 'agents', f), text);
  }
  return root;
}

function harness(overrides = {}) {
  const out = { stderr: '', spawned: null };
  const deps = {
    argv: ['exec', 'hello'],
    env: { PATH: '/bin', KEEP: 'y' },
    root: fixtureRoot('default'),
    cwd: '/work',
    read: (p, enc) => readFileSync(p, enc),
    readdir: (d) => Object.keys(AGENTS).filter(() => d.endsWith('agents')),
    hasCommand: () => true,
    gitDir: () => '/repo/.git',
    spawn: (args, env) => {
      out.spawned = { args, env };
      return { status: 0 };
    },
    stderr: (s) => {
      out.stderr += s;
    },
    ...overrides,
  };
  return { deps, out };
}

test('agentArgs emits config_file and description per toml, sorted, skipping non-toml', () => {
  const { deps } = harness();
  const args = agentArgs(deps.root, deps);
  const dir = join(deps.root, 'codex', 'agents');
  assert.deepEqual(args, [
    '-c',
    `agents.a.config_file=${JSON.stringify(join(dir, 'a.toml'))}`,
    '-c',
    'agents.a.description="orch workflow: a."',
    '-c',
    `agents.b.config_file=${JSON.stringify(join(dir, 'b.toml'))}`,
    '-c',
    'agents.b.description="orch workflow: say \\"hi\\"."',
    '-c',
    `agents.c.config_file=${JSON.stringify(join(dir, 'c.toml'))}`,
  ]);
});

test('buildArgs JSON-encodes developer_instructions and adds --add-dir only with a git dir', () => {
  const context = 'line1\n"quoted" \\ back';
  const withGit = buildArgs({ context, agents: ['-c', 'x'], commonDir: '/r/.git' });
  assert.deepEqual(withGit, [
    '-c',
    `developer_instructions=${JSON.stringify(context)}`,
    '-c',
    'x',
    '--add-dir',
    '/r/.git',
  ]);
  assert.deepEqual(buildArgs({ context: 'c', agents: [], commonDir: null }), [
    '-c',
    'developer_instructions="c"',
  ]);
});

test('run prepends context, agents and --add-dir, adds ORCH=1 and propagates the exit code', () => {
  const { deps, out } = harness({
    spawn: (args, env) => {
      out.spawned = { args, env };
      return { status: 7 };
    },
  });
  assert.equal(run(deps), 7);
  const { args, env } = out.spawned;
  assert.equal(args[0], '-c');
  const instructions = JSON.parse(args[1].slice('developer_instructions='.length));
  assert.ok(instructions.startsWith('# RULES'));
  assert.ok(instructions.includes(`orch helper: ${join(deps.root, 'bin', 'orch-wt')}`));
  assert.ok(!instructions.includes('worktrunk'));
  assert.deepEqual(args.slice(-4), ['--add-dir', '/repo/.git', 'exec', 'hello']);
  assert.equal(args.filter((a) => a.startsWith('agents.')).length, 5);
  assert.deepEqual(env, { PATH: '/bin', KEEP: 'y', ORCH: '1' });
});

test('run includes the wt warning when wt is missing and skips --add-dir outside git', () => {
  const { deps, out } = harness({ hasCommand: () => false, gitDir: () => null });
  assert.equal(run(deps), 0);
  assert.ok(out.spawned.args[1].includes('worktrunk'));
  assert.ok(!out.spawned.args.includes('--add-dir'));
});

test('run maps a signal-killed codex (null status) to 1', () => {
  const { deps } = harness({ spawn: () => ({ status: null, signal: 'SIGTERM' }) });
  assert.equal(run(deps), 1);
});

test('run exits 1 without spawning when the rules file is missing', () => {
  const { deps, out } = harness({ root: fixtureRoot('norules', null) });
  assert.equal(run(deps), 1);
  assert.equal(out.spawned, null);
  assert.match(out.stderr, /rules\/orchestrator\.md not found/);
});

test('run exits 127 with a clear message when codex is missing', () => {
  const { deps } = harness({ spawn: () => ({ error: { code: 'ENOENT', message: 'nope' } }) });
  assert.equal(run(deps), 127);
});

test('run exits 1 on other spawn errors', () => {
  const { deps, out } = harness({
    spawn: () => ({ error: { code: 'EACCES', message: 'denied' } }),
  });
  assert.equal(run(deps), 1);
  assert.match(out.stderr, /failed to run codex: denied/);
});

test('gitCommonDir returns the absolute common dir in a repo and null outside', () => {
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const dir = gitCommonDir(repo);
  assert.ok(dir?.endsWith('/.git'));
  assert.equal(gitCommonDir(join(tmp, 'nogit-does-not-exist')), null);
});

test('spawnCodex reports ENOENT when codex is not on PATH', () => {
  assert.equal(spawnCodex([], { PATH: join(tmp, 'empty') }).error?.code, 'ENOENT');
});

test('main runs a fake codex on PATH end to end and sets exitCode', () => {
  const root = fixtureRoot('main');
  const bin = join(tmp, 'fakebin');
  const log = join(tmp, 'fake.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nprintf '%s\\n' "$ORCH" "$@" > "${log}"\nexit 3\n`);
  chmodSync(join(bin, 'codex'), 0o755);
  const proc = {
    argv: ['node', 'orch-codex', 'exec', 'hi'],
    env: { PATH: `${bin}:${process.env.PATH}` },
    cwd: () => tmp,
    stderr: { write: () => {} },
  };
  main(proc, pathToFileURL(join(root, 'scripts', 'orch-codex.mjs')).href);
  assert.equal(proc.exitCode, 3);
  const logged = readFileSync(log, 'utf8').split('\n');
  assert.equal(logged[0], '1');
  assert.deepEqual(logged.slice(-3, -1), ['exec', 'hi']);
});

test('main reports a missing codex on stderr with exit 127', () => {
  const root = fixtureRoot('main-missing');
  let err = '';
  const proc = {
    argv: ['node', 'orch-codex'],
    env: { PATH: join(tmp, 'empty') },
    cwd: () => tmp,
    stderr: {
      write: (s) => {
        err += s;
      },
    },
  };
  main(proc, pathToFileURL(join(root, 'scripts', 'orch-codex.mjs')).href);
  assert.equal(proc.exitCode, 127);
  assert.match(err, /`codex` not found/);
});

test('bin/orch-codex shim runs main (codex absent from PATH gives 127)', () => {
  const shim = fileURLToPath(new URL('../bin/orch-codex', import.meta.url));
  const r = spawnSync(process.execPath, [shim], {
    cwd: tmp,
    env: { PATH: join(tmp, 'empty') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /`codex` not found/);
});
