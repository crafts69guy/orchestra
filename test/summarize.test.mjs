import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  armStats,
  formatTable,
  invalid,
  judgeCost,
  main,
  mean,
  median,
  newest,
  outcomeScore,
  run,
  summarize,
} from '../evals/_support/summarize.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'orc-summarize-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const r = (score, durationSeconds, costUsd, extra = {}) => ({
  score,
  durationSeconds,
  costUsd,
  judgeCostUsd: 0.01,
  error: null,
  ...extra,
});

const RESULT = {
  durationSeconds: 900,
  costUsd: 10,
  partial: false,
  cases: [
    {
      name: 'bench',
      arms: {
        with: [r(1, 100, 3), r(0.5, 300, 5)],
        without: [r(0.75, 200, 1), r(0.75, 200, 2, { judgeCostUsd: undefined, error: 'boom' })],
      },
    },
    { name: 'solo', arms: { with: [r(1, undefined, 1)] } },
    { name: 'empty' },
  ],
};

test('mean and median', () => {
  assert.equal(mean([]), null);
  assert.equal(mean([1, 2, 6]), 3);
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('armStats counts errors and skips missing durations', () => {
  assert.deepEqual(armStats([r(1, 10, 1), r(0, undefined, 3, { error: 'timeout' })]), {
    runs: 2,
    invalid: 0,
    errors: 1,
    score: 0.5,
    meanSeconds: 10,
    p50Seconds: 10,
    costUsd: 2,
  });
});

const g = (name, passed, weight = 1, extra = {}) => ({
  name,
  passed,
  weight,
  scored: true,
  ...extra,
});

test('outcomeScore re-weights without the no-peek guards, skipping unscored and with-only', () => {
  const graders = [
    g('acceptance', true, 3),
    g('commits', false),
    g('no-peek-read', false, 13),
    g('skill', false, 1, { withOnly: true }),
    g('judge', false, 2, { scored: false }),
  ];
  assert.equal(outcomeScore({ score: 0.1, graders }), 0.75);
  assert.equal(outcomeScore({ score: 0.4 }), 0.4, 'no graders: the eval score');
  assert.equal(outcomeScore({ score: 0.4, graders: [g('no-peek-bash', true)] }), 0.4);
});

test('invalid flags a run whose no-peek guard failed', () => {
  assert.equal(invalid({ graders: [g('no-peek-bash', true), g('acceptance', false)] }), false);
  assert.equal(invalid({ graders: [g('no-peek-grep', false)] }), true);
  assert.equal(invalid({}), false);
});

test('armStats counts invalid runs and leaves them out of score, time and cost', () => {
  const peek = r(1, 999, 99, { graders: [g('acceptance', true), g('no-peek-read', false)] });
  const honest = r(0, 10, 1, { graders: [g('acceptance', false, 2), g('no-peek-read', true)] });
  assert.deepEqual(armStats([peek, honest]), {
    runs: 2,
    invalid: 1,
    errors: 0,
    score: 0,
    meanSeconds: 10,
    p50Seconds: 10,
    costUsd: 1,
  });
  assert.equal(armStats([peek]).score, null);
});

test('summarize adds a delta row only when both arms ran', () => {
  const rows = summarize(RESULT);
  assert.deepEqual(
    rows.map((x) => [x.case, x.arm]),
    [
      ['bench', 'with'],
      ['bench', 'without'],
      ['bench', 'Δ with−without'],
      ['solo', 'with'],
    ],
  );
  const delta = rows[2];
  assert.equal(delta.score, 0);
  assert.equal(delta.meanSeconds, 0);
  assert.equal(delta.p50Seconds, 0);
  assert.equal(delta.costUsd, 2.5);
  assert.equal(rows[3].meanSeconds, null);
});

test('delta is null when one arm has no durations', () => {
  const [, , delta] = summarize({
    cases: [{ name: 'x', arms: { with: [r(1, undefined, 1)], without: [r(1, 5, 1)] } }],
  });
  assert.equal(delta.meanSeconds, null);
});

test('judgeCost sums judge spend, treating missing as zero', () => {
  assert.equal(judgeCost(RESULT).toFixed(2), '0.04');
});

test('formatTable renders signed deltas, dashes and the suite line', () => {
  const out = formatTable(summarize(RESULT), RESULT);
  assert.match(out, /^\| case \| arm \| runs \| invalid \| errors \|/);
  assert.match(out, /\| bench \| with \| 2 \| 0 \| 0 \| 0\.75 \| 200 \| 200 \| 4\.00 \|/);
  assert.match(out, /\| bench \| without \| 2 \| 0 \| 1 \|/);
  assert.match(
    out,
    /\| bench \| Δ with−without \| {2}\| {2}\| {2}\| \+0\.00 \| \+0 \| \+0 \| \+2\.50 \|/,
  );
  assert.match(out, /\| solo \| with \| 1 \| 0 \| 0 \| 1\.00 \| – \| – \| 1\.00 \|/);
  assert.match(out, /suite: 900s wall, agent \$10\.00, judge \$0\.04\n$/);
  const neg = summarize({
    cases: [{ name: 'n', arms: { with: [r(0, 1, 1)], without: [r(1, 2, 2)] } }],
  });
  const partial = formatTable(neg, { ...RESULT, cases: [], partial: true });
  assert.match(partial, /\| -1\.00 \| -1 \| -1 \| -1\.00 \|/);
  assert.match(partial, /\(partial\)\n$/);
});

test('newest picks the latest timestamp', () => {
  assert.equal(newest([]), null);
  assert.equal(
    newest(['2026-10-12T04-06', '2026-10-12T03-40', '2026-10-13T00-00']),
    '2026-10-13T00-00',
  );
});

function fakeIo(overrides = {}) {
  const io = {
    out: '',
    err: '',
    root: '/repo',
    read: () => JSON.stringify(RESULT),
    readdir: () => ['2026-01-01', '2026-02-01', 'stray'],
    exists: (p) => !p.includes('stray'),
    stdout: (s) => {
      io.out += s;
    },
    stderr: (s) => {
      io.err += s;
    },
    ...overrides,
  };
  return io;
}

test('run reads the newest results dir by default', () => {
  const reads = [];
  const io = fakeIo({
    read: (p) => {
      reads.push(p);
      return JSON.stringify(RESULT);
    },
  });
  assert.equal(run([], io), 0);
  assert.deepEqual(reads, [
    join('/repo', 'evals', 'results', '2026-02-01', 'aggregate-result.json'),
  ]);
  assert.match(io.out, /\| bench \| with \|/);
});

test('run reads an explicit path', () => {
  const io = fakeIo({ read: (p) => (p === 'a.json' ? JSON.stringify(RESULT) : '') });
  assert.equal(run(['a.json'], io), 0);
  assert.match(io.out, /^a\.json\n/);
});

test('run fails without results', () => {
  const missing = fakeIo({
    readdir: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(run([], missing), 1);
  assert.match(missing.err, /no aggregate-result\.json under/);
  const empty = fakeIo({ readdir: () => ['stray'] });
  assert.equal(run([], empty), 1);
});

test('run fails on unreadable or invalid JSON', () => {
  const io = fakeIo({ read: () => '{' });
  assert.equal(run(['bad.json'], io), 1);
  assert.match(io.err, /cannot read bad\.json/);
});

test('main wires the real filesystem', () => {
  const file = join(tmp, 'aggregate-result.json');
  writeFileSync(file, JSON.stringify(RESULT));
  let out = '';
  const proc = { argv: ['node', 'summarize.mjs', file], stdout: { write: (s) => (out += s) } };
  main(proc);
  assert.equal(proc.exitCode, 0);
  assert.match(out, /suite: 900s wall/);
});

test('main reports errors on stderr', () => {
  let err = '';
  const proc = {
    argv: ['node', 'summarize.mjs', join(tmp, 'missing.json')],
    stderr: { write: (s) => (err += s) },
  };
  main(proc);
  assert.equal(proc.exitCode, 1);
  assert.match(err, /cannot read/);
});
