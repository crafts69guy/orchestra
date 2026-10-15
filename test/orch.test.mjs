import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  claudeArgs,
  commands,
  hasOrchestra,
  main,
  run,
  splitLevel,
  splitPanes,
  splitYolo,
  USAGE,
} from '../scripts/orch.mjs';
import { agentName } from '../scripts/orch-pane.mjs';

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
    hasCommand: () => false,
    read: () => '{"version":"9.9.9"}',
    ...overrides,
  };
  return io;
}

test('splitYolo strips --yolo wherever it appears', () => {
  assert.deepEqual(splitYolo(['-p', '--yolo', 'hi']), { yolo: true, rest: ['-p', 'hi'] });
  assert.deepEqual(splitYolo(['hi']), { yolo: false, rest: ['hi'] });
});

test('claudeArgs puts the ccc --mcp-config= arg first', () => {
  const args = claudeArgs(['hi'], true);
  assert.match(args[0], /^--mcp-config=\{"mcpServers":\{"cocoindex-code"/);
  assert.deepEqual(args.slice(1), ['--model', 'opus', 'hi']);
});

test('claude injects ccc when enabled', () => {
  const io = fakeIo({
    env: { PATH: '/bin' },
    hasCommand: () => true,
    exec: () => ({ status: 0, stdout: '/work\n' }),
  });
  run(['claude', 'hi'], io);
  assert.match(io.spawned[0].args[0], /^--mcp-config=/);
});

test('ccc subcommand dispatches to ccc init', () => {
  const io = fakeIo();
  assert.equal(run(['ccc'], io), 1);
  assert.match(io.err, /usage: orch ccc init/);
});

test('update upgrades cocoindex-code only when uv lists it', () => {
  const uv =
    (stdout, status = 0) =>
    (cmd) =>
      cmd === 'uv' ? { status, stdout } : { status: 127, stdout: '' };
  const listed = fakeIo({ exists: () => true, exec: uv('cocoindex-code v0.4\n- ccc\n') });
  run(['update'], listed);
  assert.deepEqual(
    listed.spawned.map((s) => [s.cmd, ...s.args].join(' ')),
    ['uv tool upgrade cocoindex-code'],
  );
  for (const exec of [uv('ruff v1\n'), uv('cocoindex-code v0.4\n', 1)]) {
    const io = fakeIo({ exists: () => true, exec });
    run(['update'], io);
    assert.equal(io.spawned.length, 0);
  }
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
  assert.deepEqual(opts.env, { PATH: '/bin', ORCH: '1', ORCH_ROLE: '' });
});

test('splitLevel strips --level in both forms', () => {
  assert.deepEqual(splitLevel(['-p', '--level', 'high', 'hi']), {
    level: 'high',
    rest: ['-p', 'hi'],
  });
  assert.deepEqual(splitLevel(['--level=default', 'hi']), { level: 'default', rest: ['hi'] });
  assert.deepEqual(splitLevel(['hi']), { level: undefined, rest: ['hi'] });
  assert.deepEqual(splitLevel(['--level']), { level: '', rest: [] });
});

test('claude --level sets ORCH_LEVEL and stays out of argv; no flag leaves env alone', () => {
  const io = fakeIo();
  assert.equal(run(['claude', '--level', 'high', 'hi'], io), 0);
  assert.deepEqual(io.spawned[0].args, ['--model', 'opus', 'hi']);
  assert.equal(io.spawned[0].opts.env.ORCH_LEVEL, 'high');
  const plain = fakeIo();
  run(['claude'], plain);
  assert.equal('ORCH_LEVEL' in plain.spawned[0].opts.env, false);
});

test('claude --level rejects unknown or missing values without spawning', () => {
  for (const a of [['--level', 'max'], ['--level=x'], ['--level']]) {
    const io = fakeIo();
    assert.equal(run(['claude', ...a], io), 1);
    assert.match(io.err, /orch: unknown level \S* \(default\|high\)/);
    assert.equal(io.spawned.length, 0);
  }
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
    exec: () => ({ status: 1, stdout: '' }),
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

/** Fake `exec` for `<cmd> plugin marketplace list --json`: `lists[cmd]` is the result. */
const marketplaces = (lists) => (cmd) => lists[cmd] ?? { status: 127, stdout: '' };
const ORCHESTRA = { status: 0, stdout: '[{"name":"orchestra"}]' };

test('update runs npm, claude and codex steps; skips npm in a checkout and harnesses without orchestra', () => {
  const io = fakeIo({
    exists: () => false,
    exec: marketplaces({
      claude: ORCHESTRA,
      codex: { status: 0, stdout: '{"marketplaces":[{"name":"orchestra"}]}' },
    }),
  });
  assert.equal(run(['update'], io), 0);
  assert.deepEqual(
    io.spawned.map((s) => [s.cmd, ...s.args].join(' ')),
    [
      'npm install -g --prefer-online @crafts69guy/orchestra@latest',
      'claude plugin marketplace update orchestra',
      'claude plugin update orch@orchestra',
      'codex plugin marketplace upgrade orchestra',
    ],
  );
  assert.match(io.out, /restart Claude Code/);

  const checkout = fakeIo({
    exec: marketplaces({
      claude: { status: 0, stdout: '[{"name":"other"}]' },
      codex: { status: 0, stdout: '{"marketplaces":[{"name":"orchestra"}]}' },
    }),
  });
  assert.equal(run(['update'], checkout), 0);
  assert.deepEqual(
    checkout.spawned.map((s) => s.cmd),
    ['codex'],
  );
  assert.match(checkout.err, /git checkout; skipping npm/);
});

test('hasOrchestra is false for a missing binary, a failed list or garbled output', () => {
  const io = (r) => ({ exec: () => r });
  assert.equal(hasOrchestra(io({ status: 127, stdout: '' }), 'codex'), false);
  assert.equal(hasOrchestra(io({ status: 0, stdout: 'not json' }), 'codex'), false);
  assert.equal(hasOrchestra(io({ status: 0, stdout: 'null' }), 'codex'), false);
  assert.equal(hasOrchestra(io({ status: 0, stdout: '[null]' }), 'claude'), false);
});

test('update keeps going after a failure and returns the first non-zero code', () => {
  const codes = [3, 0, 5];
  const io = fakeIo({ exists: () => false, exec: marketplaces({ claude: ORCHESTRA }) });
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
  let onError;
  const exits = [];
  const proc = {
    argv: ['node', 'orch', '--version'],
    env: {},
    cwd: () => tmp,
    exit: (code) => exits.push(code),
    stdout: {
      on: (event, fn) => {
        if (event === 'error') onError = fn;
      },
      write: (s) => {
        out += s;
      },
    },
    stderr: { write: () => {} },
  };
  main(proc);
  assert.equal(proc.exitCode, 0);
  assert.equal(out, `${VERSION}\n`);
  // A closed pipe exits quietly with the command's code; other stdout errors still surface.
  onError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.deepEqual(exits, [0]);
  assert.throws(() => onError(Object.assign(new Error('boom'), { code: 'EIO' })), /boom/);
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

test('context prints the audit and returns its code; usage goes to stderr', () => {
  const ok = fakeIo({
    cwd: '/work',
    env: { HOME: '/nohome' },
    exists: () => false,
    readdir: () => [],
    exec: () => ({ status: 1, stdout: '' }),
  });
  assert.equal(run(['context', '--json'], ok), 0);
  assert.deepEqual(JSON.parse(ok.out), { sources: [], findings: [] });
  const bad = fakeIo();
  assert.equal(run(['context', '--bogus'], bad), 1);
  assert.match(bad.err, /usage: orch context/);
});

test('splitPanes strips --panes; claude --panes sets ORCH_PANES and stays out of argv', () => {
  assert.deepEqual(splitPanes(['-p', '--panes', 'hi']), { panes: true, rest: ['-p', 'hi'] });
  assert.deepEqual(splitPanes(['hi']), { panes: false, rest: ['hi'] });
  const io = fakeIo();
  assert.equal(run(['claude', '--panes', '--level', 'high', 'hi'], io), 0);
  assert.deepEqual(io.spawned[0].args, ['--model', 'opus', 'hi']);
  assert.equal(io.spawned[0].opts.env.ORCH_PANES, '1');
  assert.equal(io.spawned[0].opts.env.ORCH_ROLE, '', 'a pane worker role never leaks');
  const plain = fakeIo();
  run(['claude'], plain);
  assert.equal('ORCH_PANES' in plain.spawned[0].opts.env, false);
});

test('pane prints the JSON result and returns its code', () => {
  const gated = fakeIo();
  assert.equal(run(['pane', 'close', 'T', '--path', 'wt'], gated), 1);
  assert.match(JSON.parse(gated.out).stderr, /pane mode needs herdr/);

  const calls = [];
  const unlinked = [];
  const io = fakeIo({
    unlink: (p) => unlinked.push(p),
    env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', PATH: '/bin' },
    hasCommand: (name) => name === 'herdr',
    exec: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return {
        status: 0,
        stdout: '{"result":{"type":"agent_info","agent":{"agent_status":"idle"}}}',
        stderr: '',
      };
    },
    read: (p, enc) => {
      assert.equal(enc, 'utf8');
      return `Status: done\nValidation\n- ok (${p})`;
    },
  });
  assert.equal(run(['pane', 'wait', 'T', '--path', 'wt'], io), 0);
  assert.deepEqual(JSON.parse(io.out), {
    task: 'T',
    state: 'idle',
    report: '/work/wt/.orch/report.md',
    evidence: true,
  });
  const name = agentName('T', '/work/wt');
  assert.deepEqual(calls, [
    `herdr agent get ${name}`,
    `herdr agent wait ${name} --timeout 1800000`,
    `herdr agent get ${name}`,
  ]);
  io.out = '';
  run(['pane', 'prompt', 'T', '--path', 'wt', '--text', 'x'], io);
  assert.deepEqual(unlinked, ['/work/wt/.orch/report.md']);
});
