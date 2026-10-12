// The bench-large acceptance suite must pass against the reference implementations, laid out the
// way check.sh runs it (src/ next to .git/acceptance/), so a red hidden test means the agent. It
// must also fail every test against stubs and catch each deliberately broken reference below.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CASE = fileURLToPath(new URL('../evals/bench-large/', import.meta.url));
const MODULES = {
  cron: ['parse', 'next'],
  schema: ['validate'],
  expr: ['evaluate'],
};
const tmp = mkdtempSync(join(tmpdir(), 'orch-bench-large-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Lays out src/ (reference, optionally overridden per module) and .git/acceptance/, then runs
// the given modules' hidden suites and returns the TAP totals.
let n = 0;
function run(modules, override = {}) {
  const dir = join(tmp, String(n++));
  cpSync(join(CASE, 'reference'), join(dir, 'src'), { recursive: true });
  for (const [m, source] of Object.entries(override))
    writeFileSync(join(dir, 'src', `${m}.mjs`), source);
  mkdirSync(join(dir, '.git'));
  cpSync(join(CASE, 'hidden'), join(dir, '.git', 'acceptance'), { recursive: true });
  // Drop NODE_V8_COVERAGE (keeps the suite and reference out of this repo's coverage) and
  // NODE_TEST_CONTEXT (else the nested runner reports to this one instead of printing TAP).
  const { NODE_V8_COVERAGE, NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...modules.map((m) => `.git/acceptance/${m}.mjs`)],
    { cwd: dir, env, encoding: 'utf8' },
  );
  const count = (k) => Number(new RegExp(`^# ${k} (\\d+)$`, 'm').exec(r.stdout)?.[1] ?? Number.NaN);
  return { status: r.status, out: r.stdout + r.stderr, tests: count('tests'), pass: count('pass') };
}

test('hidden acceptance suite passes against the reference', () => {
  const r = run(Object.keys(MODULES));
  assert.equal(r.status, 0, r.out);
  assert.equal(r.pass, r.tests, r.out);
  assert.ok(r.tests >= 70, `only ${r.tests} hidden tests`);
});

test('every hidden test fails against stubs', () => {
  const stubs = Object.fromEntries(
    Object.entries(MODULES).map(([m, names]) => [
      m,
      names.map((f) => `export function ${f}() { throw new Error('todo'); }\n`).join(''),
    ]),
  );
  const r = run(Object.keys(MODULES), stubs);
  assert.ok(r.tests >= 70, r.out);
  assert.equal(r.pass, 0, r.out);
});

// [module, what it breaks, text in the reference, replacement]
const MUTANTS = [
  ['cron', 'day fields always AND', 'return either ? a || b : a && b;', 'return a && b;'],
  ['cron', 'weekday 7 kept as 7', "field.name === 'dayOfWeek' ? v % 7 : v", 'v'],
  [
    'cron',
    'next not strictly later',
    'Math.floor(from.getTime() / 60000) * 60000 + 60000',
    'Math.ceil(from.getTime() / 60000) * 60000',
  ],
  [
    'cron',
    'reversed range is SyntaxError',
    'throw new RangeError(`range',
    'throw new SyntaxError(`range',
  ],
  ['cron', 'names are case-sensitive', 'indexOf(token.toUpperCase())', 'indexOf(token)'],
  ['schema', 'length in UTF-16 units', '[...v].length', 'v.length'],
  ['schema', 'pointer keys not escaped', ".replace(/~/g, '~0').replace(/\\//g, '~1')", ''],
  [
    'schema',
    'integer accepts fractions',
    'integer: (v) => Number.isInteger(v)',
    "integer: (v) => typeof v === 'number'",
  ],
  ['schema', '$ref siblings applied', "if ('$ref' in s) return check(", "if ('$ref' in s) check("],
  [
    'schema',
    'oneOf behaves like anyOf',
    '.filter(passes).length !== 1',
    '.filter(passes).length < 1',
  ],
  [
    'schema',
    'equality depends on key order',
    'if (!TYPES.object(a) || !TYPES.object(b)) return false;',
    'return JSON.stringify(a) === JSON.stringify(b);',
  ],
  ['expr', 'no prefix operator after ^', 'const exp = unary();', 'const exp = primary();'],
  [
    'expr',
    '&& does not short-circuit',
    'bool(l(env), op) && bool(r(env), op)',
    '[bool(l(env), op), bool(r(env), op)].every(Boolean)',
  ],
  ['expr', 'round half up', '(x) => Math.sign(x) * Math.round(Math.abs(x))', 'Math.round'],
  ['expr', 'inherited variables visible', 'Object.hasOwn(vars, name)', 'name in vars'],
  [
    'expr',
    'lexer position off by one',
    "syntax('unexpected character', pos)",
    "syntax('unexpected character', pos + 1)",
  ],
  ['expr', 'end-of-input position off by one', 'pos: src.length });', 'pos: src.length - 1 });'],
  [
    'expr',
    'division by zero allowed',
    "if (x === 0) throw new RangeError('division by zero');",
    '',
  ],
];

for (const [m, what, from, to] of MUTANTS) {
  test(`hidden ${m} suite catches: ${what}`, () => {
    const source = readFileSync(join(CASE, 'reference', `${m}.mjs`), 'utf8');
    assert.ok(source.includes(from), `mutation target not found in reference/${m}.mjs: ${from}`);
    const r = run([m], { [m]: source.replace(from, to) });
    assert.ok(r.pass < r.tests, `${what}: still ${r.pass}/${r.tests}\n${r.out}`);
  });
}
