import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeArgs, commands, main, run, splitYolo, USAGE } from '../scripts/orch.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'orch-cli-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const BIN = fileURLToPath(new URL('../bin/orch', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;

/** Fake io: records output and spawns; `spawnResult` is what every spawn returns. */
function fakeIo(overrides = {}) {
  const io = {
    out: '',
    err: '',
    spawned: [],
    spawnResult: { status: 0 },
    env: { PATH: '/bin' },
    cwd: '/work',
    root: '/plugin',
    stdout: (s) => {
      io.out += s;
    },
    stderr: (s) => {
      io.err += s;
    },
    spawn: (cmd, args, opts) => {
      io.spawned.push({ cmd, args, opts });
      return io.spawnResult;
    },
    exists: () => true,
    read: () => '{"version":"9.9.9"}',
    ...overrides,
  };
  return io;
}

test('splitYolo strips --yolo wherever it appears', () => {
  assert.deepEqual(splitYolo(['-p', '--yolo', 'hi']), { yolo: true, rest: ['-p', 'hi'] });
  assert.deepEqual(splitYolo(['hi']), { yolo: false, rest: ['hi'] });
});

test('claudeArgs defaults to opus, keeps a user model, maps --yolo', () => {
  assert.deepEqual(claudeArgs(['-p', 'x']), ['--model', 'opus', '-p', 'x']);
  assert.deepEqual(claudeArgs(['--model', 'sonnet']), ['--model', 'sonnet']);
  assert.deepEqual(claudeArgs(['--model=haiku']), ['--model=haiku']);
  assert.deepEqual(claudeArgs(['--yolo']), ['--model', 'opus', '--dangerously-skip-permissions']);
});

test('claude spawns with ORCH=1, never bypasses permissions by default, propagates status', () => {
  const io = fakeIo({ spawnResult: { status: 5 } });
  assert.equal(run(['claude', 'hi'], io), 5);
  const [{ cmd, args, opts }] = io.spawned;
  assert.equal(cmd, 'claude');
  assert.deepEqual(args, ['--model', 'opus', 'hi']);
  assert.deepEqual(opts.env, { PATH: '/bin', ORCH: '1' });
});

test('claude: missing binary exits 127 with a hint, a signal exits 1', () => {
  const missing = fakeIo({ spawnResult: { error: { code: 'ENOENT', message: 'x' } } });
  assert.equal(run(['claude'], missing), 127);
  assert.match(missing.err, /`claude` not found on PATH; install Claude Code/);
  assert.equal(run(['claude'], fakeIo({ spawnResult: { status: null, signal: 'SIGINT' } })), 1);
  const denied = fakeIo({ spawnResult: { error: { code: 'EACCES', message: 'denied' } } });
  assert.equal(run(['claude'], denied), 1);
  assert.match(denied.err, /failed to run claude: denied/);
});

function codexRoot() {
  const root = join(tmp, 'plugin');
  mkdirSync(join(root, 'rules'), { recursive: true });
  mkdirSync(join(root, 'codex', 'agents'), { recursive: true });
  writeFileSync(join(root, 'rules', 'orchestrator.md'), '# RULES\n');
  return root;
}

test('codex runs the launcher; --yolo becomes the bypass flag right before the user args', () => {
  const root = codexRoot();
  const io = fakeIo({
    root,
    read: readFileSync,
    readdir: () => [],
    hasCommand: () => true,
    gitDir: () => null,
    spawnResult: { status: 3 },
  });
  assert.equal(run(['codex', '--yolo', 'exec', 'hi'], io), 3);
  const [{ cmd, args, opts }] = io.spawned;
  assert.equal(cmd, 'codex');
  assert.match(args[1], /orch CLI: .*bin\/orch/);
  assert.deepEqual(args.slice(2), ['--dangerously-bypass-approvals-and-sandbox', 'exec', 'hi']);
  assert.equal(opts.env.ORCH, '1');
  run(['codex', 'exec'], io);
  assert.ok(!io.spawned[1].args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('wt prints the JSON result and returns its code', () => {
  const io = fakeIo({ wtDeps: {} });
  assert.equal(run(['wt', 'bogus'], io), 1);
  assert.match(JSON.parse(io.out).stderr, /usage: orch wt/);
});

test('doctor prints one line per check and returns its code', () => {
  const io = fakeIo({
    doctorDeps: {
      nodeVersion: '22.8.0',
      exec: () => ({ status: 1, stdout: '', stderr: 'missing' }),
    },
  });
  assert.equal(run(['doctor'], io), 1);
  assert.match(io.out, /^✓ node {2}v22\.8\.0\n/);
  assert.ok(io.out.endsWith('\n'));
});

test('update runs npm, claude and codex steps; skips npm in a checkout and missing harnesses', () => {
  const io = fakeIo({ exists: () => false, hasCommand: () => true });
  assert.equal(run(['update'], io), 0);
  assert.deepEqual(
    io.spawned.map((s) => [s.cmd, ...s.args].join(' ')),
    [
      'npm install -g @crafts69guy/orchestra@latest',
      'claude plugin marketplace update orchestra',
      'claude plugin update orch@orchestra',
      'codex plugin marketplace upgrade orchestra',
    ],
  );
  assert.match(io.out, /restart Claude Code/);

  const checkout = fakeIo({ hasCommand: (c) => c === 'codex', env: {} });
  assert.equal(run(['update'], checkout), 0);
  assert.deepEqual(
    checkout.spawned.map((s) => s.cmd),
    ['codex'],
  );
  assert.match(checkout.err, /git checkout; skipping npm/);
});

test('update keeps going after a failure and returns the first non-zero code', () => {
  const codes = [3, 0, 5];
  const io = fakeIo({ exists: () => false, hasCommand: (c) => c === 'claude' });
  io.spawn = (cmd, args) => {
    io.spawned.push({ cmd, args });
    return { status: codes.shift() };
  };
  assert.equal(run(['update'], io), 3);
  assert.equal(io.spawned.length, 3);
  assert.doesNotMatch(io.out, /updated;/);
});

test('eval runs run.sh from the plugin root, or explains it needs the git checkout', () => {
  const io = fakeIo({ spawnResult: { status: 0 } });
  assert.equal(run(['eval', '--case', 'x'], io), 0);
  assert.deepEqual(io.spawned[0].cmd, 'sh');
  assert.deepEqual(io.spawned[0].args, ['/plugin/evals/_support/run.sh', '--case', 'x']);
  assert.equal(io.spawned[0].opts.cwd, '/plugin');

  const absent = fakeIo({ exists: () => false });
  assert.equal(run(['eval'], absent), 1);
  assert.match(absent.err, /evals ship with the git checkout only/);
  assert.deepEqual(absent.spawned, []);
});

test('help and version print to stdout and exit 0', () => {
  for (const flag of ['help', '--help', '-h']) {
    const io = fakeIo();
    assert.equal(run([flag], io), 0);
    assert.equal(io.out, USAGE);
  }
  for (const flag of ['--version', '-V']) {
    const io = fakeIo();
    assert.equal(run([flag], io), 0);
    assert.equal(io.out, '9.9.9\n');
  }
});

test('unknown or missing subcommand prints usage on stderr and exits 1', () => {
  for (const argv of [[], ['bogus'], ['toString']]) {
    const io = fakeIo();
    assert.equal(run(argv, io, commands), 1);
    assert.equal(io.out, '');
    assert.ok(io.err.endsWith(USAGE));
  }
  const io = fakeIo();
  run(['bogus'], io);
  assert.match(io.err, /^orch: unknown command bogus\n/);
});

test('main wires the real io: --version reads package.json', () => {
  let out = '';
  const proc = {
    argv: ['node', 'orch', '--version'],
    env: {},
    cwd: () => tmp,
    stdout: {
      write: (s) => {
        out += s;
      },
    },
    stderr: { write: () => {} },
  };
  main(proc);
  assert.equal(proc.exitCode, 0);
  assert.equal(out, `${VERSION}\n`);
});

test('bin/orch claude runs a fake claude end to end; missing claude exits 127', () => {
  const bin = join(tmp, 'fakebin');
  const log = join(tmp, 'claude.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$ORCH" "$@" > "${log}"\nexit 4\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const r = spawnSync(process.execPath, [BIN, 'claude', '--yolo', '-p', 'hi'], {
    env: { PATH: bin },
    encoding: 'utf8',
  });
  assert.equal(r.status, 4, r.stderr);
  assert.deepEqual(readFileSync(log, 'utf8').split('\n'), [
    '1',
    '--model',
    'opus',
    '--dangerously-skip-permissions',
    '-p',
    'hi',
    '',
  ]);
  const missing = spawnSync(process.execPath, [BIN, 'claude'], {
    env: { PATH: join(tmp, 'empty') },
    encoding: 'utf8',
  });
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /`claude` not found/);
});
