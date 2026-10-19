import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  claudeArgs,
  commands,
  hasOrchestra,
  main,
  realIo,
  run,
  splitLevel,
  splitPanes,
  splitYolo,
  USAGE,
} from '../scripts/orc.mjs';
import { agentName } from '../scripts/orc-pane.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'orc-cli-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const BIN = fileURLToPath(new URL('../bin/orc', import.meta.url));
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
  assert.match(io.err, /usage: orc ccc init/);
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

test('claude spawns with ORC=1, never bypasses permissions by default, propagates status', () => {
  const io = fakeIo({ spawnResult: { status: 5 } });
  assert.equal(run(['claude', 'hi'], io), 5);
  const [{ cmd, args, opts }] = io.spawned;
  assert.equal(cmd, 'claude');
  assert.deepEqual(args, ['--model', 'opus', 'hi']);
  assert.deepEqual(opts.env, { PATH: '/bin', ORC: '1', ORC_ROLE: '' });
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

test('claude --level sets ORC_LEVEL and stays out of argv; no flag leaves env alone', () => {
  const io = fakeIo();
  assert.equal(run(['claude', '--level', 'high', 'hi'], io), 0);
  assert.deepEqual(io.spawned[0].args, ['--model', 'opus', 'hi']);
  assert.equal(io.spawned[0].opts.env.ORC_LEVEL, 'high');
  const plain = fakeIo();
  run(['claude'], plain);
  assert.equal('ORC_LEVEL' in plain.spawned[0].opts.env, false);
});

test('claude --level rejects unknown or missing values without spawning', () => {
  for (const a of [['--level', 'max'], ['--level=x'], ['--level']]) {
    const io = fakeIo();
    assert.equal(run(['claude', ...a], io), 1);
    assert.match(io.err, /orc: unknown level \S* \(default\|high\)/);
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
  assert.match(args[1], /orc CLI: .*bin\/orc/);
  assert.deepEqual(args.slice(2), ['--dangerously-bypass-approvals-and-sandbox', 'exec', 'hi']);
  assert.equal(opts.env.ORC, '1');
  run(['codex', 'exec'], io);
  assert.ok(!io.spawned[1].args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('wt prints the JSON result and returns its code', async () => {
  const io = fakeIo({ wtDeps: {} });
  assert.equal(await run(['wt', 'bogus'], io), 1);
  assert.match(JSON.parse(io.out).stderr, /usage: orc wt/);
});

test('doctor prints one line per check and returns its code', async () => {
  const io = fakeIo({
    doctorDeps: {
      nodeVersion: '22.8.0',
      exec: () => ({ status: 1, stdout: '', stderr: 'missing' }),
    },
  });
  assert.equal(await run(['doctor'], io), 1);
  assert.match(io.out, /^✓ node {2}v22\.8\.0\n/);
  assert.ok(io.out.endsWith('\n'));
});

test('doctor --json prints schemaVersion and checks with the same code; bad args are usage', async () => {
  const doctorDeps = {
    nodeVersion: '22.8.0',
    exec: () => ({ status: 1, stdout: '', stderr: 'x' }),
  };
  const io = fakeIo({ doctorDeps });
  assert.equal(await run(['doctor', '--json'], io), 1);
  const doc = JSON.parse(io.out);
  assert.equal(doc.schemaVersion, 1);
  assert.deepEqual(doc.checks[0], { mark: '✓', status: 'pass', name: 'node', detail: 'v22.8.0' });
  assert.ok(doc.checks.some((c) => c.status === 'fail'));
  const bad = fakeIo({ doctorDeps });
  assert.equal(await run(['doctor', '--bogus'], bad), 1);
  assert.equal(bad.out, '');
  assert.equal(bad.err, 'usage: orc doctor [--json]\n');
});

test('status wires io into the collector; warnings and errors go to stderr', () => {
  const io = fakeIo({
    exec: (cmd) =>
      cmd === 'git'
        ? { status: 0, stdout: '/work/.git\n', stderr: '' }
        : { status: 1, stdout: '', stderr: 'no wt' },
    readdir: () => ['f'],
    read: (p, enc) => {
      assert.equal(enc, 'utf8');
      assert.equal(p, '/work/.scratch/f/plan.md');
      return '## Tasks\n\n```yaml\n- id: T1\n```\n';
    },
  });
  assert.equal(run(['status'], io), 0);
  assert.equal(io.out, 'f/T1  -  -\n');
  assert.equal(io.err, 'orc status: wt list failed; worktrees unknown: no wt\n');
  const json = fakeIo({ exec: () => ({ status: 128, stdout: '', stderr: '' }) });
  assert.equal(run(['status', '--json'], json), 1);
  assert.equal(json.out, '');
  assert.match(json.err, /not a git repository: \/work/);
});

test('USAGE lists status, doctor --json and wt remove', () => {
  assert.match(USAGE, /status \[--json\]/);
  assert.match(USAGE, /doctor \[--json\]/);
  assert.match(USAGE, /wt new\|merge\|remove\|list/);
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
      'claude plugin update orc@orchestra',
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
  assert.match(io.err, /^orc: unknown command bogus\n/);
});

test('main wires the real io: --version reads package.json', async () => {
  let out = '';
  let onError;
  const exits = [];
  const proc = {
    argv: ['node', 'orc', '--version'],
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
  await main(proc);
  assert.equal(proc.exitCode, 0);
  assert.equal(out, `${VERSION}\n`);
  // A closed pipe exits quietly with the command's code; other stdout errors still surface.
  onError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.deepEqual(exits, [0]);
  assert.throws(() => onError(Object.assign(new Error('boom'), { code: 'EIO' })), /boom/);
});

test('bin/orc claude runs a fake claude end to end; missing claude exits 127', () => {
  const bin = join(tmp, 'fakebin');
  const log = join(tmp, 'claude.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$ORC" "$@" > "${log}"\nexit 4\n`);
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
  assert.deepEqual(JSON.parse(ok.out), { schemaVersion: 1, sources: [], findings: [] });
  const bad = fakeIo();
  assert.equal(run(['context', '--bogus'], bad), 1);
  assert.match(bad.err, /usage: orc context/);
});

test('splitPanes strips --panes; claude --panes sets ORC_PANES and stays out of argv', () => {
  assert.deepEqual(splitPanes(['-p', '--panes', 'hi']), { panes: true, rest: ['-p', 'hi'] });
  assert.deepEqual(splitPanes(['hi']), { panes: false, rest: ['hi'] });
  const io = fakeIo();
  assert.equal(run(['claude', '--panes', '--level', 'high', 'hi'], io), 0);
  assert.deepEqual(io.spawned[0].args, ['--model', 'opus', 'hi']);
  assert.equal(io.spawned[0].opts.env.ORC_PANES, '1');
  assert.equal(io.spawned[0].opts.env.ORC_ROLE, '', 'a pane worker role never leaks');
  const plain = fakeIo();
  run(['claude'], plain);
  assert.equal('ORC_PANES' in plain.spawned[0].opts.env, false);
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
    report: '/work/wt/.orc/report.md',
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
  assert.deepEqual(unlinked, ['/work/wt/.orc/report.md']);
});

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const MERGED = '{"status":"merged","task":"T1","commit":"abc123"}\n';
const NOTE = { _id: 'note:n', _rev: '1-a', title: 't', body: 'spec', bookId: 'book:B' };

/**
 * io for `orc wt merge feat/x T1 -m msg` that merges (fake `wtDeps`), over an in-memory `.scratch`
 * (`files`), git config mapping a notebook, and `fetch` for the inkdrop push.
 */
function mergeIo({
  files = {},
  fetch = async () => new Response('{}'),
  append,
  branch = 'feat/x',
} = {}) {
  const routes = {
    'wt list': ok(
      JSON.stringify({ items: [{ branch: `${branch}--T1`, worktree: { path: '/work/.wt/T1' } }] }),
    ),
    'git merge-base': ok('BASE\n'),
    'git rev-list': ok('1\n'),
    'git merge-tree': ok('tree\n'),
    [`git rev-parse ${branch}`]: ok('abc123\n'),
  };
  const wtDeps = {
    exec: (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      return routes[Object.keys(routes).find((k) => line.startsWith(k))] ?? ok();
    },
    exists: () => false,
  };
  const appended = [];
  const io = fakeIo({
    wtDeps,
    appended,
    env: { PATH: '/bin', INKDROP_LOCAL_USERNAME: 'u', INKDROP_LOCAL_PASSWORD: 'p' },
    exec: (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      if (line === 'git rev-parse --path-format=absolute --git-common-dir')
        return ok('/work/.git\n');
      if (line.startsWith('git config --get-regexp')) {
        return ok('orc.inkdropbook book:B\norc.inkdropbookname B\norc.inkdroptag tag:T\n');
      }
      return { status: 1, stdout: '', stderr: 'no' };
    },
    readdir: (d) => {
      const names = Object.keys(files)
        .filter((f) => f.startsWith(`${d}/`))
        .map((f) => f.slice(d.length + 1).split('/')[0]);
      if (!names.length) throw new Error('ENOENT');
      return [...new Set(names)];
    },
    read: (p) => {
      if (!Object.hasOwn(files, p)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    exists: (p) => Object.hasOwn(files, p),
    write: (p, text) => {
      files[p] = text;
    },
    append: append ?? ((p, text) => appended.push([p, text])),
    mkdir: () => {},
    fetch,
    now: () => new Date(2026, 0, 1),
  });
  return io;
}
const MERGE = ['wt', 'merge', '--message', 'feat: x', 'feat/x', 'T1'];
const PLAN_X = 'Base branch: feat/x\n';

test('wt merge records the merge for the feature whose plan merges into the branch', async () => {
  const io = mergeIo({
    files: { '/work/.scratch/x/plan.md': PLAN_X, '/work/.scratch/y/plan.md': 'Base branch: y\n' },
  });
  assert.equal(await run(MERGE, io), 0);
  assert.equal(io.out, MERGED);
  assert.equal(io.err, '');
  assert.deepEqual(io.appended, [['/work/.scratch/x/merged', 'T1 abc123\n']]);
});

test('wt merge skips recording without exactly one matching feature', async () => {
  for (const files of [
    {},
    { '/work/.scratch/x/plan.md': PLAN_X, '/work/.scratch/x2/plan.md': PLAN_X },
    { '/work/.scratch/notes/a.md': '' },
  ]) {
    const io = mergeIo({ files });
    assert.equal(await run(MERGE, io), 0);
    assert.equal(io.out, MERGED);
    assert.deepEqual(io.appended, []);
    const several = files['/work/.scratch/x2/plan.md'] !== undefined;
    assert.equal(
      io.err,
      several ? 'orc: merge not recorded: several plans use base feat/x (x, x2)\n' : '',
    );
  }
  const named = mergeIo({
    branch: 'solo',
    files: { '/work/.scratch/solo/plan.md': '# no base\n' },
  });
  assert.equal(await run(['wt', 'merge', 'solo', 'T1', '--message', 'm'], named), 0);
  assert.deepEqual(named.appended, [['/work/.scratch/solo/merged', 'T1 abc123\n']]);
});

test('wt merge pushes a linked feature; a push or record failure never changes the result', async () => {
  const linked = () => ({
    '/work/.scratch/x/plan.md': PLAN_X,
    '/work/.scratch/x/inkdrop.json': '{"noteId":"note:n","specHash":"h"}',
  });
  const posts = [];
  const fetch = async (_url, init) => {
    if (init.method === 'POST') posts.push(JSON.parse(init.body));
    return new Response(JSON.stringify(init.method === 'GET' ? NOTE : { ok: true }));
  };
  const io = mergeIo({ files: linked(), fetch });
  assert.equal(await run(MERGE, io), 0);
  assert.equal(io.out, MERGED);
  assert.equal(io.err, '');
  assert.match(posts[0].body, /^spec\n\n<!-- orc:begin -->/);

  const down = mergeIo({
    files: linked(),
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
    append: () => {
      throw new Error('EACCES merged');
    },
  });
  assert.equal(await run(MERGE, down), 0);
  assert.equal(down.out, MERGED);
  assert.equal(
    down.err,
    'orc: recording the merge failed: EACCES merged\n' +
      'orc: inkdrop push failed: Inkdrop is not running or its local server is off (Preferences → Local Server)\n',
  );

  const off = mergeIo({ files: linked(), fetch: async () => assert.fail('no push') });
  off.env = { ...off.env, ORC_INKDROP: '0' };
  assert.equal(await run(MERGE, off), 0);
  assert.equal(off.err, '');
  assert.deepEqual(off.appended, [['/work/.scratch/x/merged', 'T1 abc123\n']], 'still recorded');

  const outside = mergeIo({ files: linked() });
  outside.exec = () => ({ status: 128, stdout: '', stderr: '' });
  assert.equal(await run(MERGE, outside), 0);
  assert.deepEqual(outside.appended, []);
});

test('inkdrop routes to inkdrop.mjs with io-wired deps; stdout and stderr pass through', async () => {
  const io = mergeIo({
    files: { '/work/.scratch/x/inkdrop.json': '{"noteId":"note:n","specHash":"h"}' },
    fetch: async () => new Response(JSON.stringify(NOTE)),
  });
  assert.equal(await run(['inkdrop', 'pull', 'x'], io), 0);
  assert.equal(io.out, 'changed: yes\n\nspec\n');
  const bad = fakeIo();
  assert.equal(await run(['inkdrop'], bad), 1);
  assert.match(bad.err, /^usage: orc inkdrop init/);
  assert.match(USAGE, /inkdrop init\|inbox\|claim\|push\|pull/);
});

test('realIo wires recursive mkdir, a Date clock and the global fetch', () => {
  const io = realIo({ env: {}, cwd: () => tmp }, import.meta.url);
  const dir = join(tmp, 'deep', 'er');
  io.mkdir(dir);
  io.mkdir(dir);
  assert.ok(existsSync(dir));
  assert.ok(io.now() instanceof Date);
  assert.equal(io.fetch, globalThis.fetch);
});
