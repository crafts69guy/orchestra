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

const tmp = mkdtempSync(join(tmpdir(), 'orc-'));
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
    env: { ORC: '1', PATH: '/bin' },
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
  const cli = 'orc CLI: /p/bin/orc (use `/p/bin/orc wt new|merge|list`)\n';
  assert.equal(buildContext('# R\n', true, '/p/bin/orc'), `# R\n\n${cli}`);
  assert.equal(buildContext('# R\n\n', false, '/p/bin/orc'), `# R\n\n${cli}\n${WT_WARNING}\n`);
  assert.match(WT_WARNING, /brew install worktrunk/);
});

test('formatOutput emits the SessionStart hookSpecificOutput shape', () => {
  assert.deepEqual(JSON.parse(formatOutput('ctx')), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
  });
});

test('run is silent and exits 0 unless ORC=1', () => {
  for (const env of [{}, { ORC: '0' }, { ORC: 'true' }]) {
    const { deps, out } = harness({ env });
    assert.equal(run(deps), 0);
    assert.deepEqual(out, { stdout: '', stderr: '' });
  }
});

test('run injects the rules when ORC=1 and wt is present', () => {
  const { deps, out } = harness({
    hasCommand: (name, pathEnv) => name === 'wt' && pathEnv === '/bin',
  });
  assert.equal(run(deps), 0);
  const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  const orc = join(deps.root, 'bin', 'orc');
  assert.equal(ctx, `# RULES\n\norc CLI: ${orc} (use \`${orc} wt new|merge|list\`)\n`);
  assert.equal(out.stderr, '');
});

test('run warns about worktrunk when wt is missing', () => {
  const { deps, out } = harness({ hasCommand: () => false });
  assert.equal(run(deps), 0);
  const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  assert.ok(
    ctx.startsWith('# RULES') && ctx.includes('orc CLI: ') && ctx.endsWith(`${WT_WARNING}\n`),
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
  const ok = fakeProcess({ ORC: '1', PATH: '' });
  main(ok, pathToFileURL(join(root, 'hooks', 'session-start.mjs')).href);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.out, /# MAIN/);
  assert.match(ok.out, /worktrunk/);

  const bad = fakeProcess({ ORC: '1', PATH: '' });
  main(bad, pathToFileURL(join(tmp, 'nowhere', 'hooks', 'session-start.mjs')).href);
  assert.equal(bad.exitCode, 0);
  assert.equal(bad.out, '');
  assert.match(bad.err, /not found/);
});

test('script entrypoint exits 0 and prints nothing without ORC', () => {
  const script = fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url));
  const { ORC: _drop, ...env } = process.env;
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
    env: { ...process.env, ORC: '1' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hookSpecificOutput/);
});

test('buildContext keeps docs lines without their marker, or drops them when ORC_DOCS is off', () => {
  const rules = '# R\nkeep\nDocs line. <!-- orc:docs -->\n  Indented. <!-- orc:docs -->\nend\n';
  const cli = '\n\norc CLI: /p (use `/p wt new|merge|list`)\n';
  assert.equal(buildContext(rules, true, '/p'), `# R\nkeep\nDocs line.\n  Indented.\nend${cli}`);
  assert.equal(buildContext(rules, true, '/p', { docs: false }), `# R\nkeep\nend${cli}`);
});

test('run drops docs lines only when ORC_DOCS=0', () => {
  const rules = 'a\nb <!-- orc:docs -->\n';
  const ctx = (envDocs) => {
    const root = fixtureRoot(`docs-${envDocs}`, rules);
    let out = '';
    run({
      env: { ORC: '1', PATH: '', ORC_DOCS: envDocs },
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

test('run keeps high lines only when ORC_LEVEL=high', () => {
  const ctx = (level) => {
    const { deps, out } = harness({
      root: fixtureRoot(`high-${level}`, 'a\nb <!-- orc:high -->\n'),
      read: readFileSync,
    });
    deps.env.ORC_LEVEL = level;
    run(deps);
    return JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  };
  assert.match(ctx('high'), /\nb\n/);
  assert.doesNotMatch(ctx(undefined), /\nb\b/);
  assert.doesNotMatch(ctx('default'), /\nb\b/);
});

test('applyMarkers drops a line when its flag is falsy and strips the marker otherwise', () => {
  const rules = 'a\nb <!-- orc:ccc -->\nc <!-- orc:docs -->\n';
  assert.equal(applyMarkers(rules, { ccc: true, docs: false }), 'a\nb\n');
  assert.equal(applyMarkers(rules, {}), 'a\n');
  assert.equal(buildContext(rules, true, '/p').includes('b'), false);
});

test('run keeps ccc lines only when ccc is enabled for the git root', () => {
  const rules = 'a\nb <!-- orc:ccc -->\n';
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

test('run is silent for a herdr pane worker (ORC_ROLE set)', () => {
  const { deps, out } = harness({ env: { ORC: '1', ORC_ROLE: 'implementer', PATH: '/bin' } });
  assert.equal(run(deps), 0);
  assert.deepEqual(out, { stdout: '', stderr: '' });
});

test('run keeps panes lines and names orc pane only with ORC_PANES=1 inside herdr', () => {
  const ctx = (env) => {
    const { deps, out } = harness({
      root: fixtureRoot('panes', 'a\nb <!-- orc:panes -->\n'),
      read: readFileSync,
    });
    Object.assign(deps.env, env);
    run(deps);
    return JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  };
  const on = ctx({ ORC_PANES: '1', HERDR_ENV: '1' });
  assert.match(on, /\nb\n/);
  assert.match(
    on,
    /bin\/orc wt new\|merge\|list` and `\S+bin\/orc pane start\|wait\|prompt\|close`\)/,
  );
  for (const env of [{ ORC_PANES: '1' }, { HERDR_ENV: '1' }]) {
    const off = ctx(env);
    assert.doesNotMatch(off, /\nb\b/);
    assert.doesNotMatch(off, /orc pane/);
  }
});

const INKDROP_ENV = { INKDROP_LOCAL_USERNAME: 'u', INKDROP_LOCAL_PASSWORD: 'p' };
const inkdropExec = (_cmd, args) =>
  args[0] === 'config'
    ? { status: 0, stdout: 'orc.inkdropbook book:B\norc.inkdropbookname Orchestra\n' }
    : { status: 1, stdout: '' };

test('buildContext names orc inkdrop and the notebook only when the inkdrop flag is set', () => {
  const rules = 'a\nb <!-- orc:inkdrop -->\n';
  const on = buildContext(rules, true, '/p/bin/orc', {
    inkdrop: { name: 'Orchestra', id: 'book:B' },
  });
  assert.equal(
    on,
    'a\nb\n\norc CLI: /p/bin/orc (use `/p/bin/orc wt new|merge|list` and `/p/bin/orc inkdrop inbox|claim|push|pull`)\nInkdrop notebook: Orchestra (book:B)\n',
  );
  const off = buildContext(rules, true, '/p/bin/orc');
  assert.equal(off, 'a\n\norc CLI: /p/bin/orc (use `/p/bin/orc wt new|merge|list`)\n');
});

test('run turns inkdrop on with credentials and a mapped notebook, off with ORC_INKDROP=0', () => {
  const ctx = (env) => {
    const { deps, out } = harness({
      root: fixtureRoot('inkdrop', 'a\nb <!-- orc:inkdrop -->\n'),
      read: readFileSync,
      exec: inkdropExec,
    });
    Object.assign(deps.env, env);
    run(deps);
    return JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  };
  const on = ctx(INKDROP_ENV);
  assert.match(on, /\nb\n/);
  assert.match(on, /\nInkdrop notebook: Orchestra \(book:B\)\n/);
  for (const env of [{}, { ...INKDROP_ENV, ORC_INKDROP: '0' }]) {
    const off = ctx(env);
    assert.doesNotMatch(off, /\nb\b|orc inkdrop|Inkdrop notebook/);
  }
});
