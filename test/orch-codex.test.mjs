import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { agentArgs, buildArgs, gitCommonDir, run, spawnExit } from '../scripts/orch-codex.mjs';

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
    exec: () => ({ status: 1, stdout: '' }),
    exists: () => false,
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
  assert.deepEqual(buildArgs({ context: 'c', agents: [], commonDir: null, mcp: ['-c', 'm'] }), [
    '-c',
    'developer_instructions="c"',
    '-c',
    'm',
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
  assert.ok(instructions.includes(`orch CLI: ${join(deps.root, 'bin', 'orch')}`));
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
  const { deps, out } = harness({
    spawn: () => ({ error: { code: 'ENOENT', message: 'nope' } }),
  });
  assert.equal(run(deps), 127);
  assert.match(out.stderr, /`codex` not found on PATH; install Codex CLI first/);
});

test('spawnExit passes the status through', () => {
  assert.equal(
    spawnExit({ status: 4 }, 'x', () => {}, 'h'),
    4,
  );
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

test('run injects the cocoindex-code server only when ccc is enabled', () => {
  const indexed = { exec: () => ({ status: 0, stdout: '/repo\n' }), exists: () => true };
  const on = harness(indexed);
  run(on.deps);
  assert.ok(on.out.spawned.args.includes('mcp_servers.cocoindex-code.command="ccc"'));
  const off = harness({ ...indexed, env: { PATH: '/bin', ORCH_CCC: '0' } });
  run(off.deps);
  assert.ok(!off.out.spawned.args.some((a) => a.startsWith('mcp_servers.')));
});
