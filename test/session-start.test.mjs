import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyMarkers,
  buildContext,
  formatOutput,
  isEntry,
  main,
  pluginRoot,
  readRules,
  run,
  WT_WARNING,
  which,
} from '../hooks/session-start.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'orch-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function fixtureRoot(name, rules) {
  const root = join(tmp, name);
  mkdirSync(join(root, 'rules'), { recursive: true });
  if (rules !== undefined) writeFileSync(join(root, 'rules', 'orchestrator.md'), rules);
  return root;
}

function harness(overrides = {}) {
  const out = { stdout: '', stderr: '' };
  const deps = {
    env: { ORCH: '1', PATH: '/bin' },
    root: fixtureRoot('default', '# RULES\n'),
    read: undefined,
    cwd: '/work',
    hasCommand: () => true,
    exec: () => ({ status: 1, stdout: '' }),
    exists: () => false,
    stdout: (s) => {
      out.stdout += s;
    },
    stderr: (s) => {
      out.stderr += s;
    },
    ...overrides,
  };
  return { deps, out };
}

test('pluginRoot resolves one level above hooks/', () => {
  const url = pathToFileURL(join(tmp, 'hooks', 'session-start.mjs')).href;
  assert.equal(pluginRoot(url), tmp);
});

test('readRules returns file contents, or null when missing/unreadable', () => {
  assert.equal(readRules(fixtureRoot('has', '# HAS\n')), '# HAS\n');
  assert.equal(readRules(fixtureRoot('none')), null);
  assert.equal(
    readRules(tmp, () => {
      throw new Error('boom');
    }),
    null,
  );
});

test('which finds executables on PATH only', () => {
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tool'), '#!/bin/sh\n');
  chmodSync(join(bin, 'tool'), 0o755);
  writeFileSync(join(bin, 'plain'), 'x');
  chmodSync(join(bin, 'plain'), 0o644);
  const pathEnv = ['/nonexistent', bin].join(delimiter);
  assert.equal(which('tool', pathEnv), true);
  assert.equal(which('plain', pathEnv), false);
  assert.equal(which('tool', undefined), false);
});

test('buildContext appends the worktrunk warning only when wt is missing', () => {
  const cli = 'orch CLI: /p/bin/orch (use `/p/bin/orch wt new|merge|list`)\n';
  assert.equal(buildContext('# R\n', true, '/p/bin/orch'), `# R\n\n${cli}`);
  assert.equal(buildContext('# R\n\n', false, '/p/bin/orch'), `# R\n\n${cli}\n${WT_WARNING}\n`);
  assert.match(WT_WARNING, /brew install worktrunk/);
});

test('formatOutput emits the SessionStart hookSpecificOutput shape', () => {
  assert.deepEqual(JSON.parse(formatOutput('ctx')), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
  });
});

test('run is silent and exits 0 unless ORCH=1', () => {
  for (const env of [{}, { ORCH: '0' }, { ORCH: 'true' }]) {
    const { deps, out } = harness({ env });
    assert.equal(run(deps), 0);
    assert.deepEqual(out, { stdout: '', stderr: '' });
  }
});

test('run injects the rules when ORCH=1 and wt is present', () => {
  const { deps, out } = harness({
    hasCommand: (name, pathEnv) => name === 'wt' && pathEnv === '/bin',
  });
  assert.equal(run(deps), 0);
  const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  const orch = join(deps.root, 'bin', 'orch');
  assert.equal(ctx, `# RULES\n\norch CLI: ${orch} (use \`${orch} wt new|merge|list\`)\n`);
  assert.equal(out.stderr, '');
});

test('run warns about worktrunk when wt is missing', () => {
  const { deps, out } = harness({ hasCommand: () => false });
  assert.equal(run(deps), 0);
  const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  assert.ok(
    ctx.startsWith('# RULES') && ctx.includes('orch CLI: ') && ctx.endsWith(`${WT_WARNING}\n`),
  );
});

test('run exits 0 with a stderr note when the rules file is missing', () => {
  const { deps, out } = harness({ root: fixtureRoot('missing') });
  assert.equal(run(deps), 0);
  assert.equal(out.stdout, '');
  assert.match(out.stderr, /rules\/orchestrator\.md not found/);
});

function fakeProcess(env) {
  const proc = { env, out: '', err: '', cwd: () => tmp };
  proc.stdout = {
    write(s) {
      proc.out += s;
      return true;
    },
  };
  proc.stderr = {
    write(s) {
      proc.err += s;
      return true;
    },
  };
  return proc;
}

test('main wires real fs and process streams against a plugin root', () => {
  const root = fixtureRoot('main-ok', '# MAIN\n');
  const ok = fakeProcess({ ORCH: '1', PATH: '' });
  main(ok, pathToFileURL(join(root, 'hooks', 'session-start.mjs')).href);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.out, /# MAIN/);
  assert.match(ok.out, /worktrunk/);

  const bad = fakeProcess({ ORCH: '1', PATH: '' });
  main(bad, pathToFileURL(join(tmp, 'nowhere', 'hooks', 'session-start.mjs')).href);
  assert.equal(bad.exitCode, 0);
  assert.equal(bad.out, '');
  assert.match(bad.err, /not found/);
});

test('script entrypoint exits 0 and prints nothing without ORCH', () => {
  const script = fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url));
  const { ORCH: _drop, ...env } = process.env;
  const res = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('isEntry matches through a symlinked plugin dir, false on missing paths', () => {
  const real = join(tmp, 'entry-real');
  mkdirSync(real);
  writeFileSync(join(real, 'h.mjs'), '');
  const link = join(tmp, 'entry-link');
  symlinkSync(real, link);
  const metaUrl = pathToFileURL(join(real, 'h.mjs')).href;
  assert.equal(isEntry(join(link, 'h.mjs'), metaUrl), true);
  assert.equal(isEntry(join(tmp, 'other.mjs'), metaUrl), false);
});

test('hook runs when invoked through a symlinked plugin dir', () => {
  const link = join(tmp, 'plugin-link');
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), link);
  const r = spawnSync(process.execPath, [join(link, 'hooks', 'session-start.mjs')], {
    env: { ...process.env, ORCH: '1' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hookSpecificOutput/);
});

test('buildContext keeps docs lines without their marker, or drops them when ORCH_DOCS is off', () => {
  const rules = '# R\nkeep\nDocs line. <!-- orch:docs -->\n  Indented. <!-- orch:docs -->\nend\n';
  const cli = '\n\norch CLI: /p (use `/p wt new|merge|list`)\n';
  assert.equal(buildContext(rules, true, '/p'), `# R\nkeep\nDocs line.\n  Indented.\nend${cli}`);
  assert.equal(buildContext(rules, true, '/p', { docs: false }), `# R\nkeep\nend${cli}`);
});

test('run drops docs lines only when ORCH_DOCS=0', () => {
  const rules = 'a\nb <!-- orch:docs -->\n';
  const ctx = (envDocs) => {
    const root = fixtureRoot(`docs-${envDocs}`, rules);
    let out = '';
    run({
      env: { ORCH: '1', PATH: '', ORCH_DOCS: envDocs },
      root,
      read: readFileSync,
      cwd: '/work',
      hasCommand: () => true,
      exec: () => ({ status: 1, stdout: '' }),
      exists: () => false,
      stdout: (s) => (out += s),
      stderr: () => {},
    });
    return JSON.parse(out).hookSpecificOutput.additionalContext;
  };
  assert.match(ctx('1'), /\nb\n/);
  assert.doesNotMatch(ctx('0'), /\nb\b/);
});

test('applyMarkers drops a line when its flag is falsy and strips the marker otherwise', () => {
  const rules = 'a\nb <!-- orch:ccc -->\nc <!-- orch:docs -->\n';
  assert.equal(applyMarkers(rules, { ccc: true, docs: false }), 'a\nb\n');
  assert.equal(applyMarkers(rules, {}), 'a\n');
  assert.equal(buildContext(rules, true, '/p').includes('b'), false);
});

test('run keeps ccc lines only when ccc is enabled for the git root', () => {
  const rules = 'a\nb <!-- orch:ccc -->\n';
  const ctx = (exists) => {
    const { deps, out } = harness({
      root: fixtureRoot(`ccc-${exists}`, rules),
      read: readFileSync,
      exec: () => ({ status: 0, stdout: '/repo\n' }),
      exists: () => exists,
    });
    run(deps);
    return JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  };
  assert.match(ctx(true), /\nb\n/);
  assert.doesNotMatch(ctx(false), /\nb\b/);
});
