import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cccEnabled,
  cccRoot,
  claudeMcpArg,
  codexMcpArgs,
  ensureMaxFileSize,
  run,
} from '../scripts/ccc.mjs';

const SETTINGS = '/repo/.cocoindex_code/settings.yml';
const gitOk = { status: 0, stdout: '/repo\n' };

test('cccRoot needs a git toplevel holding settings.yml', () => {
  const exists = (p) => p === SETTINGS;
  assert.equal(cccRoot('/repo/sub', { exec: () => gitOk, exists }), '/repo');
  assert.equal(cccRoot('/repo', { exec: () => gitOk, exists: () => false }), null);
  assert.equal(cccRoot('/x', { exec: () => ({ status: 128, stdout: '' }), exists }), null);
  assert.equal(cccRoot('/x', { exec: () => ({ status: 0, stdout: '\n' }), exists }), null);
});

test('cccEnabled short-circuits on ORC_CCC, then ccc on PATH, then the index', () => {
  const calls = [];
  const deps = {
    exec: () => {
      calls.push('exec');
      return gitOk;
    },
    exists: () => true,
    hasCommand: () => {
      calls.push('has');
      return true;
    },
  };
  assert.equal(cccEnabled({ ORC_CCC: '0' }, '/repo', deps), false);
  assert.deepEqual(calls, []);
  assert.equal(cccEnabled({ PATH: '/bin' }, '/repo', deps), true);
  assert.deepEqual(calls, ['has', 'exec']);
  assert.equal(cccEnabled({}, '/repo', { ...deps, hasCommand: () => false }), false);
});

test('claudeMcpArg is one --mcp-config= string with the stdio server', () => {
  const arg = claudeMcpArg();
  assert.ok(arg.startsWith('--mcp-config='));
  assert.deepEqual(JSON.parse(arg.slice('--mcp-config='.length)), {
    mcpServers: {
      'cocoindex-code': {
        type: 'stdio',
        command: 'ccc',
        args: ['mcp'],
        env: { COCOINDEX_DISABLE_USAGE_TRACKING: '1' },
      },
    },
  });
});

test('codexMcpArgs is -c pairs for the cocoindex-code server', () => {
  const args = codexMcpArgs();
  assert.equal(args.length, 14);
  assert.ok(args.filter((_, i) => i % 2 === 0).every((a) => a === '-c'));
  assert.ok(args.includes('mcp_servers.cocoindex-code.enabled_tools=["search"]'));
  assert.ok(args.includes('mcp_servers.cocoindex-code.args=["mcp"]'));
  assert.ok(args.includes('mcp_servers.cocoindex-code.default_tools_approval_mode="auto"'));
  assert.ok(args.includes('mcp_servers.cocoindex-code.tool_timeout_sec=120'));
});

test('ensureMaxFileSize appends only when missing', () => {
  assert.equal(ensureMaxFileSize('a: 1\n'), 'a: 1\nmax_file_size: 256KB\n');
  assert.equal(ensureMaxFileSize('a: 1'), 'a: 1\nmax_file_size: 256KB\n');
  assert.equal(ensureMaxFileSize(''), '\nmax_file_size: 256KB\n');
  const set = 'x: 1\nmax_file_size: 1MB\n';
  assert.equal(ensureMaxFileSize(set), set);
});

/** Fake io for `run`; `files` counts `git ls-files` lines, `spawnCodes` the successive spawn statuses. */
function fakeIo({
  files = 500,
  initialised = false,
  text = 'a: 1\n',
  spawnCodes = [0, 0],
  git = gitOk,
} = {}) {
  const io = { out: '', err: '', spawned: [], written: [], codes: [...spawnCodes] };
  Object.assign(io, {
    env: { K: 'v' },
    cwd: '/repo/sub',
    exec: (_cmd, args) =>
      args[0] === 'ls-files' ? { status: 0, stdout: 'f\n'.repeat(files) } : git,
    exists: () => initialised,
    read: () => text,
    write: (p, t) => io.written.push([p, t]),
    stdout: (s) => {
      io.out += s;
    },
    stderr: (s) => {
      io.err += s;
    },
    spawn: (cmd, args, opts) => {
      io.spawned.push([cmd, ...args, opts.cwd]);
      return { status: io.codes.shift() };
    },
    spawnExit: (r) => r.status,
  });
  return io;
}

test('run rejects anything but init', () => {
  const io = fakeIo();
  assert.equal(run([], io), 1);
  assert.equal(run(['index'], io), 1);
  assert.match(io.err, /usage: orc ccc init/);
});

test('run fails outside a git repo', () => {
  const io = fakeIo({ git: { status: 128, stdout: '' } });
  assert.equal(run(['init'], io), 1);
  assert.match(io.err, /not inside a git repository/);
});

test('run refuses small repos unless --force', () => {
  const io = fakeIo({ files: 199 });
  assert.equal(run(['init'], io), 1);
  assert.match(io.err, /small repo \(199 files\): use rg; pass --force to index anyway/);
  assert.equal(io.spawned.length, 0);
  const forced = fakeIo({ files: 3 });
  assert.equal(run(['init', '--force'], forced), 0);
  assert.equal(forced.spawned[0][1], 'init');
});

test('run inits, adds max_file_size, then indexes in the git root', () => {
  const io = fakeIo();
  assert.equal(run(['init'], io), 0);
  assert.deepEqual(io.spawned, [
    ['ccc', 'init', '/repo'],
    ['ccc', 'index', '/repo'],
  ]);
  assert.deepEqual(io.written, [[SETTINGS, 'a: 1\nmax_file_size: 256KB\n']]);
  assert.match(io.out, /added max_file_size/);
});

test('run on an initialised repo skips the size check and init, and leaves a set size alone', () => {
  const io = fakeIo({ files: 1, initialised: true, text: 'max_file_size: 1MB\n', spawnCodes: [4] });
  assert.equal(run(['init'], io), 4);
  assert.deepEqual(io.spawned, [['ccc', 'index', '/repo']]);
  assert.deepEqual(io.written, []);
});

test('run returns the ccc init exit code without indexing', () => {
  const io = fakeIo({ spawnCodes: [127] });
  assert.equal(run(['init'], io), 127);
  assert.equal(io.spawned.length, 1);
});
