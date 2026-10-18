import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNode, checkPlugins, realDeps, run } from '../scripts/doctor.mjs';

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

test('all checks pass', () => {
  const r = run(deps());
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
      ],
    },
  );
});

test('checkNode enforces >= 22.8', () => {
  assert.equal(checkNode('22.8.0').mark, '✓');
  assert.equal(checkNode('v23.0.0').mark, '✓');
  assert.equal(checkNode('22.7.9').mark, '✗');
  assert.equal(checkNode('22.7.9').status, 'fail');
  assert.equal(checkNode('20.11.0').mark, '✗');
});

test('missing required tools and old node fail with fix hints', () => {
  const r = run(deps({ 'git --version': undefined, 'wt --version': undefined }, '20.0.0'));
  assert.equal(r.code, 1);
  assert.deepEqual(r.lines.slice(0, 3), [
    '✗ node  v20.0.0 — fix: install Node >= 22.8',
    '✗ git  spawnSync x ENOENT — fix: install git',
    '✗ wt  spawnSync x ENOENT — fix: brew install worktrunk',
  ]);
});

test('a missing harness is a warning while the other one exists', () => {
  const noCodex = run(deps({ 'codex --version': undefined }));
  assert.equal(noCodex.code, 0);
  assert.equal(noCodex.checks.at(-1).status, 'warn');
  assert.match(
    noCodex.lines.at(-1),
    /^! codex {2}spawnSync x ENOENT — fix: npm i -g @openai\/codex$/,
  );

  const noClaude = run(deps({ 'claude --version': undefined }));
  assert.equal(noClaude.code, 0);
  assert.match(noClaude.lines[5], /^! claude .* — fix: install Claude Code$/);
  assert.ok(!noClaude.lines.some((l) => l.includes('orc@orchestra')), 'plugins skipped');
});

test('no harness at all fails', () => {
  const r = run(deps({ 'claude --version': undefined, 'codex --version': undefined }));
  assert.equal(r.code, 1);
  assert.equal(
    r.lines.at(-1),
    '✗ harness  neither claude nor codex found — fix: install Claude Code or Codex',
  );
});

test('orc missing fails, ponytail missing only warns', () => {
  const list = JSON.stringify([plugin('orc@orchestra', false), null, plugin('other@x')]);
  const [orc, ponytail] = checkPlugins(deps({ 'claude plugin list --json': ok(list) }));
  assert.equal(orc.mark, '✗');
  assert.match(orc.fix, /claude plugin install orc@orchestra/);
  assert.equal(ponytail.mark, '!');
  assert.match(ponytail.fix, /claude plugin install ponytail@ponytail/);

  const r = run(deps({ 'claude plugin list --json': ok('[]') }));
  assert.equal(r.code, 1);
  assert.match(
    r.lines[6],
    /^✗ orc@orchestra {2}not installed or not enabled — fix: claude plugin marketplace add crafts69guy\/orchestra/,
  );
  assert.match(r.lines[7], /^! ponytail@ponytail /);
});

test('unusable plugin list output becomes a failed orc check', () => {
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

test('a throwing exec never escapes run', () => {
  const r = run({
    nodeVersion: '22.16.0',
    exec: () => {
      throw new Error('spawn exploded');
    },
  });
  assert.equal(r.code, 1);
  assert.equal(r.lines[1], '✗ git  spawn exploded — fix: install git');
});

test('a tool failing with empty output reads as not found', () => {
  const r = run(deps({ 'wt --version': { status: 1, stdout: '', stderr: '' } }));
  assert.equal(r.lines[2], '✗ wt  not found — fix: brew install worktrunk');
});

test('realDeps uses the running node and the real exec', () => {
  assert.equal(realDeps.nodeVersion, process.versions.node);
  assert.equal(realDeps.exec('git', ['--version']).status, 0);
});

test('a missing ccc only warns', () => {
  const r = run(deps({ 'ccc version': undefined }));
  assert.equal(r.code, 0);
  assert.ok(
    r.lines.some(
      (l) => l.startsWith('! ccc') && l.includes("uv tool install 'cocoindex-code[full]'"),
    ),
  );
});

test('herdr is optional: checked inside herdr, never fails doctor', () => {
  const inside = { ...deps({ 'herdr --version': ok('herdr 0.9.4\n') }), env: { HERDR_ENV: '1' } };
  assert.equal(run(inside).lines[4], '✓ herdr  herdr 0.9.4');
  const broken = run({ ...deps(), env: { HERDR_ENV: '1' } });
  assert.equal(broken.code, 0);
  assert.match(broken.lines[4], /^! herdr {2}spawnSync x ENOENT — fix: see https:\/\/herdr\.dev$/);
  assert.equal(run({ ...deps(), env: {} }).lines[4], '· herdr  not in herdr (pane mode off)');
});
