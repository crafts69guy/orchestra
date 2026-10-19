import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkInkdrop, checkNode, checkPlugins, realDeps, run } from '../scripts/doctor.mjs';

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
const missing = { status: 127, stdout: '', stderr: 'spawnSync x ENOENT' };
const plugin = (id, enabled = true, scope = 'user') => ({ id, version: '0.2.0', scope, enabled });
const PLUGINS = JSON.stringify([
  plugin('orc@orchestra', false, 'project'),
  plugin('orc@orchestra'),
  plugin('ponytail@ponytail'),
]);

/** Fake exec keyed by "cmd arg..."; unknown commands are missing. */
function deps(overrides = {}, nodeVersion = '22.16.0') {
  const routes = {
    'git --version': ok('git version 2.55.0\n'),
    'wt --version': ok('wt v0.80.0\n'),
    'ccc version': ok('ccc 0.4.0\n'),
    'claude --version': ok('2.1.0 (Claude Code)\n'),
    'claude plugin list --json': ok(PLUGINS),
    'codex --version': ok('codex-cli 0.162.1\n'),
    ...overrides,
  };
  return { nodeVersion, exec: (cmd, args) => routes[[cmd, ...args].join(' ')] ?? missing };
}

test('all checks pass', async () => {
  const r = await run(deps());
  assert.equal(r.checks.length, r.lines.length);
  assert.deepEqual(r.checks[0], { mark: '✓', status: 'pass', name: 'node', detail: 'v22.16.0' });
  assert.deepEqual(r.checks[4], {
    mark: '·',
    status: 'info',
    name: 'herdr',
    detail: 'not in herdr (pane mode off)',
  });
  assert.deepEqual(
    { code: r.code, lines: r.lines },
    {
      code: 0,
      lines: [
        '✓ node  v22.16.0',
        '✓ git  git version 2.55.0',
        '✓ wt  wt v0.80.0',
        '✓ ccc  ccc 0.4.0',
        '· herdr  not in herdr (pane mode off)',
        '✓ claude  2.1.0 (Claude Code)',
        '✓ orc@orchestra  enabled (0.2.0, user)',
        '✓ ponytail@ponytail  enabled (0.2.0, user)',
        '✓ codex  codex-cli 0.162.1',
        '· inkdrop  not configured (set INKDROP_LOCAL_USERNAME/PASSWORD)',
      ],
    },
  );
});

test('checkNode enforces >= 22.8', async () => {
  assert.equal(checkNode('22.8.0').mark, '✓');
  assert.equal(checkNode('v23.0.0').mark, '✓');
  assert.equal(checkNode('22.7.9').mark, '✗');
  assert.equal(checkNode('22.7.9').status, 'fail');
  assert.equal(checkNode('20.11.0').mark, '✗');
});

test('missing required tools and old node fail with fix hints', async () => {
  const r = await run(deps({ 'git --version': undefined, 'wt --version': undefined }, '20.0.0'));
  assert.equal(r.code, 1);
  assert.deepEqual(r.lines.slice(0, 3), [
    '✗ node  v20.0.0 — fix: install Node >= 22.8',
    '✗ git  spawnSync x ENOENT — fix: install git',
    '✗ wt  spawnSync x ENOENT — fix: brew install worktrunk',
  ]);
});

test('a missing harness is a warning while the other one exists', async () => {
  const noCodex = await run(deps({ 'codex --version': undefined }));
  assert.equal(noCodex.code, 0);
  assert.equal(noCodex.checks.at(-2).status, 'warn');
  assert.match(
    noCodex.lines.at(-2),
    /^! codex {2}spawnSync x ENOENT — fix: npm i -g @openai\/codex$/,
  );

  const noClaude = await run(deps({ 'claude --version': undefined }));
  assert.equal(noClaude.code, 0);
  assert.match(noClaude.lines[5], /^! claude .* — fix: install Claude Code$/);
  assert.ok(!noClaude.lines.some((l) => l.includes('orc@orchestra')), 'plugins skipped');
});

test('no harness at all fails', async () => {
  const r = await run(deps({ 'claude --version': undefined, 'codex --version': undefined }));
  assert.equal(r.code, 1);
  assert.equal(
    r.lines.at(-2),
    '✗ harness  neither claude nor codex found — fix: install Claude Code or Codex',
  );
});

test('orc missing fails, ponytail missing only warns', async () => {
  const list = JSON.stringify([plugin('orc@orchestra', false), null, plugin('other@x')]);
  const [orc, ponytail] = checkPlugins(deps({ 'claude plugin list --json': ok(list) }));
  assert.equal(orc.mark, '✗');
  assert.match(orc.fix, /claude plugin install orc@orchestra/);
  assert.equal(ponytail.mark, '!');
  assert.match(ponytail.fix, /claude plugin install ponytail@ponytail/);

  const r = await run(deps({ 'claude plugin list --json': ok('[]') }));
  assert.equal(r.code, 1);
  assert.match(
    r.lines[6],
    /^✗ orc@orchestra {2}not installed or not enabled — fix: claude plugin marketplace add crafts69guy\/orchestra/,
  );
  assert.match(r.lines[7], /^! ponytail@ponytail /);
});

test('unusable plugin list output becomes a failed orc check', async () => {
  const cases = [
    [{ status: 1, stdout: '', stderr: 'not logged in\nmore' }, 'not logged in'],
    [{ status: 1, stdout: '', stderr: '' }, 'claude plugin list failed'],
    [ok('not json'), /JSON/],
    [ok('{"id":"orc@orchestra"}'), 'claude plugin list --json is not an array'],
  ];
  for (const [result, detail] of cases) {
    const checks = checkPlugins(deps({ 'claude plugin list --json': result }));
    assert.equal(checks.length, 1);
    assert.equal(checks[0].mark, '✗');
    if (typeof detail === 'string') assert.equal(checks[0].detail, detail);
    else assert.match(checks[0].detail, detail);
  }
});

test('a throwing exec never escapes run', async () => {
  const r = await run({
    nodeVersion: '22.16.0',
    exec: () => {
      throw new Error('spawn exploded');
    },
  });
  assert.equal(r.code, 1);
  assert.equal(r.lines[1], '✗ git  spawn exploded — fix: install git');
});

test('a tool failing with empty output reads as not found', async () => {
  const r = await run(deps({ 'wt --version': { status: 1, stdout: '', stderr: '' } }));
  assert.equal(r.lines[2], '✗ wt  not found — fix: brew install worktrunk');
});

test('realDeps uses the running node and the real exec', async () => {
  assert.equal(realDeps.nodeVersion, process.versions.node);
  assert.equal(realDeps.exec('git', ['--version']).status, 0);
});

test('a missing ccc only warns', async () => {
  const r = await run(deps({ 'ccc version': undefined }));
  assert.equal(r.code, 0);
  assert.ok(
    r.lines.some(
      (l) => l.startsWith('! ccc') && l.includes("uv tool install 'cocoindex-code[full]'"),
    ),
  );
});

test('herdr is optional: checked inside herdr, never fails doctor', async () => {
  const inside = { ...deps({ 'herdr --version': ok('herdr 0.9.4\n') }), env: { HERDR_ENV: '1' } };
  assert.equal((await run(inside)).lines[4], '✓ herdr  herdr 0.9.4');
  const broken = await run({ ...deps(), env: { HERDR_ENV: '1' } });
  assert.equal(broken.code, 0);
  assert.match(broken.lines[4], /^! herdr {2}spawnSync x ENOENT — fix: see https:\/\/herdr\.dev$/);
  assert.equal(
    (await run({ ...deps(), env: {} })).lines[4],
    '· herdr  not in herdr (pane mode off)',
  );
});

test('inkdrop: info without credentials, warn when GET / fails, pass with version and book', async () => {
  const creds = { INKDROP_LOCAL_USERNAME: 'u', INKDROP_LOCAL_PASSWORD: 'p' };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('{"version":"6.1.0","ok":true}');
  };
  const config = (stdout) => (cmd, args, cwd) => {
    assert.equal(cwd, '/repo');
    assert.deepEqual([cmd, ...args], ['git', 'config', '--get-regexp', '^orc\\.inkdrop']);
    return { status: stdout ? 0 : 1, stdout, stderr: '' };
  };
  const check = (env, exec = config(''), f = fetch) =>
    checkInkdrop({ env, exec, fetch: f, cwd: '/repo' });

  assert.equal((await check({ INKDROP_LOCAL_USERNAME: 'u' })).status, 'info');
  assert.deepEqual(await check(creds), {
    mark: '✓',
    status: 'pass',
    name: 'inkdrop',
    detail: 'v6.1.0, run orc inkdrop init',
  });
  assert.equal(calls[0].url, 'http://localhost:19840/');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${btoa('u:p')}`);
  const mapped = config('orc.inkdropbook book:1\norc.inkdropbookname Orchestra\n');
  assert.equal((await check(creds, mapped)).detail, 'v6.1.0, book Orchestra');
  assert.equal(
    (await check(creds, config('orc.inkdropbook book:1\n'))).detail,
    'v6.1.0, book book:1',
  );

  const down = await check(creds, config(''), async () => {
    throw new TypeError('fetch failed');
  });
  assert.deepEqual(down, {
    mark: '!',
    status: 'warn',
    name: 'inkdrop',
    detail: 'Inkdrop is not running or its local server is off (Preferences → Local Server)',
    fix: 'enable Preferences → Local Server',
  });
  const remote = await check({ ...creds, INKDROP_LOCAL_SERVER_URL: 'http://10.0.0.1:19840' });
  assert.equal(remote.status, 'warn');
  assert.match(remote.detail, /refusing non-loopback/);
});
