import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  generate,
  isEntry,
  main,
  multiline,
  renderAgent,
  run,
  stale,
} from '../scripts/gen-codex-agents.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'orc-gen-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function fixtureRoot(agents) {
  const root = join(tmp, `r${n++}`);
  mkdirSync(join(root, 'agents'), { recursive: true });
  for (const [file, text] of Object.entries(agents))
    writeFileSync(join(root, 'agents', file), text);
  return root;
}

const WRITER =
  '---\nname: w\ndescription: "d: x"\neffort: medium\ntools: Read, Write, Edit\n---\nBody\n';
const READER = '---\nname: r\ndescription: ro\neffort: max\ntools: Read, Grep\n---\nLook.\n';

function harness(root, argv = []) {
  const out = { stdout: '', stderr: '' };
  const code = run({
    argv,
    root,
    stdout: (s) => {
      out.stdout += s;
    },
    stderr: (s) => {
      out.stderr += s;
    },
  });
  return { code, ...out };
}

test('renders a writable agent without sandbox_mode or model', () => {
  const toml = renderAgent(WRITER, 'w.md');
  assert.match(toml, /^# GENERATED .* agents\/w\.md\. Do not edit/);
  assert.match(toml, /\nname = "w"\ndescription = "d: x"\nmodel_reasoning_effort = "medium"\n/);
  assert.match(toml, /developer_instructions = '''\nBody\n'''\n$/);
  assert.doesNotMatch(toml, /sandbox_mode|\nmodel = /);
});

test('read-only tools set sandbox_mode and effort max maps to xhigh', () => {
  const toml = renderAgent(READER, 'r.md');
  assert.match(toml, /model_reasoning_effort = "xhigh"\nsandbox_mode = "read-only"\n/);
});

test('codex-sandbox overrides the tools rule; inherit omits sandbox_mode', () => {
  const src = (tools, sandbox) =>
    `---\nname: a\ndescription: b\ntools: ${tools}\ncodex-sandbox: ${sandbox}\n---\nx`;
  assert.match(
    renderAgent(src('Read, Bash', 'workspace-write'), 'a.md'),
    /sandbox_mode = "workspace-write"/,
  );
  assert.match(renderAgent(src('Read, Write', 'read-only'), 'a.md'), /sandbox_mode = "read-only"/);
  assert.doesNotMatch(renderAgent(src('Read, Bash', 'inherit'), 'a.md'), /sandbox_mode/);
  assert.throws(
    () => renderAgent(src('Read', 'bogus'), 'a.md'),
    /a\.md: codex-sandbox must be one of/,
  );
});

test('missing tools or effort is writable and omits the effort key', () => {
  const toml = renderAgent('---\nname: a\ndescription: b\n---\nx', 'a.md');
  assert.doesNotMatch(toml, /sandbox_mode|model_reasoning_effort/);
});

test('rejects missing frontmatter, name or description', () => {
  assert.throws(() => renderAgent('# no fm', 'a.md'), /a\.md: missing frontmatter/);
  assert.throws(() => renderAgent('---\ndescription: d\n---\n', 'a.md'), /missing name/);
  assert.throws(() => renderAgent('---\nname: a\n---\n', 'a.md'), /missing description/);
});

test('multiline picks a literal string, else an escaped basic string', () => {
  assert.equal(multiline('a\r\nb\n'), "'''\na\nb\n'''");
  assert.equal(multiline("it's '''x"), '"""\nit\'s \'\'\'x\n"""');
  assert.equal(multiline("ends '"), '"""\nends \'\n"""');
  assert.equal(multiline("p\\q \"r\" '''"), '"""\np\\\\q \\"r\\" \'\'\'\n"""');
});

test('generate is sorted and ignores non-md files', () => {
  const root = fixtureRoot({ 'b.md': READER, 'a.md': WRITER, 'notes.txt': 'x' });
  assert.deepEqual([...generate(root).keys()], ['a.toml', 'b.toml']);
});

test('write then check passes; write is idempotent and removes stale files', () => {
  const root = fixtureRoot({ 'a.md': WRITER, 'b.md': READER });
  const first = harness(root);
  assert.equal(first.code, 0);
  assert.match(first.stdout, /wrote 2 agent files/);
  writeFileSync(join(root, 'codex', 'agents', 'old.toml'), 'x');
  writeFileSync(join(root, 'codex', 'agents', 'README.txt'), 'keep');
  assert.equal(harness(root).code, 0);
  assert.deepEqual(stale(root), []);
  assert.equal(readFileSync(join(root, 'codex', 'agents', 'README.txt'), 'utf8'), 'keep');
  assert.equal(harness(root, ['--check']).code, 0);
});

test('--check lists missing, differing and extra files and exits 1', () => {
  const root = fixtureRoot({ 'a.md': WRITER, 'b.md': READER });
  mkdirSync(join(root, 'codex', 'agents'), { recursive: true });
  writeFileSync(join(root, 'codex', 'agents', 'a.toml'), 'hand edited');
  writeFileSync(join(root, 'codex', 'agents', 'z.toml'), 'extra');
  const { code, stderr } = harness(root, ['--check']);
  assert.equal(code, 1);
  assert.deepEqual(stderr.split('\n').slice(0, 3), [
    'differs: codex/agents/a.toml',
    'missing: codex/agents/b.toml',
    'extra: codex/agents/z.toml',
  ]);
});

test('--check on a root without codex/agents reports everything missing', () => {
  const root = fixtureRoot({ 'a.md': WRITER });
  const { code, stderr } = harness(root, ['--check']);
  assert.equal(code, 1);
  assert.match(stderr, /missing: codex\/agents\/a\.toml/);
});

test('invalid agent source exits 1 with a message', () => {
  const { code, stderr } = harness(fixtureRoot({ 'bad.md': '# no fm' }));
  assert.equal(code, 1);
  assert.match(stderr, /gen-codex-agents: bad\.md: missing frontmatter/);
});

test('main derives the root from metaUrl and wires stdout and stderr', () => {
  const root = fixtureRoot({ 'a.md': WRITER });
  const metaUrl = pathToFileURL(join(root, 'scripts', 'gen-codex-agents.mjs')).href;
  const out = { stdout: '', stderr: '' };
  const proc = {
    argv: ['node', 'x'],
    exitCode: undefined,
    stdout: { write: (s) => (out.stdout += s) },
    stderr: { write: (s) => (out.stderr += s) },
  };
  main(proc, metaUrl);
  assert.equal(proc.exitCode, 0);
  assert.match(out.stdout, /wrote 1 agent files/);
  writeFileSync(join(root, 'codex', 'agents', 'a.toml'), 'edited');
  proc.argv = ['node', 'x', '--check'];
  main(proc, metaUrl);
  assert.equal(proc.exitCode, 1);
  assert.match(out.stderr, /differs: codex\/agents\/a\.toml/);
});

test('isEntry resolves symlinks and tolerates missing paths', () => {
  const real = fileURLToPath(new URL('../scripts/gen-codex-agents.mjs', import.meta.url));
  const link = join(tmp, 'link.mjs');
  symlinkSync(real, link);
  assert.equal(isEntry(link, pathToFileURL(real).href), true);
  assert.equal(isEntry(join(tmp, 'nope'), pathToFileURL(real).href), false);
});

test('CLI entry runs as a script and the committed codex/agents are current', () => {
  const script = fileURLToPath(new URL('../scripts/gen-codex-agents.mjs', import.meta.url));
  const res = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
});
