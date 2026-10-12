// Prints a per-case, per-arm table of score, wall-clock time and cost from a
// `claude plugin eval` aggregate-result.json, plus with − without deltas.
// Usage: node evals/_support/summarize.mjs [aggregate-result.json]
// Without a path it reads the newest evals/results/<timestamp>/aggregate-result.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../../hooks/session-start.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** `no-peek-*` graders are guards, not outcomes: they flag a run that read the hidden suite. */
const isGuard = (g) => g.name.startsWith('no-peek-');

/** A run is invalid when any guard failed. */
export const invalid = (run) => (run.graders ?? []).some((g) => isGuard(g) && !g.passed);

/**
 * The eval's weighted score (scored, non-with-only graders) recomputed without the guards, so
 * they never move a score. Falls back to `run.score` when the run lists no such graders.
 */
export function outcomeScore(run) {
  const graders = (run.graders ?? []).filter(
    (g) => g.scored !== false && !g.withOnly && !isGuard(g),
  );
  const total = graders.reduce((sum, g) => sum + g.weight, 0);
  if (total === 0) return run.score;
  return graders.reduce((sum, g) => sum + (g.passed ? g.weight : 0), 0) / total;
}

/**
 * Stats for one arm's runs. Invalid (peeking) runs are counted, then left out of every mean.
 * `costUsd` is the run's total_cost_usd (subagents included).
 */
export function armStats(all) {
  const runs = all.filter((r) => !invalid(r));
  const durations = runs.map((r) => r.durationSeconds).filter((d) => typeof d === 'number');
  return {
    runs: all.length,
    invalid: all.length - runs.length,
    errors: all.filter((r) => r.error).length,
    score: mean(runs.map(outcomeScore)),
    meanSeconds: mean(durations),
    p50Seconds: median(durations),
    costUsd: mean(runs.map((r) => r.costUsd)),
  };
}

const diff = (a, b) => (a === null || b === null ? null : a - b);

/** One row per case and arm; a delta row when both arms ran. */
export function summarize(result) {
  const rows = [];
  for (const c of result.cases) {
    const arms = {};
    for (const arm of ['with', 'without']) {
      const runs = c.arms?.[arm] ?? [];
      if (runs.length) {
        arms[arm] = armStats(runs);
        rows.push({ case: c.name, arm, ...arms[arm] });
      }
    }
    if (arms.with && arms.without) {
      const w = arms.with;
      const wo = arms.without;
      rows.push({
        case: c.name,
        arm: 'Δ with−without',
        delta: true,
        score: diff(w.score, wo.score),
        meanSeconds: diff(w.meanSeconds, wo.meanSeconds),
        p50Seconds: diff(w.p50Seconds, wo.p50Seconds),
        costUsd: diff(w.costUsd, wo.costUsd),
      });
    }
  }
  return rows;
}

/** Judge (LLM grader) spend across every run; the suite's costUsd excludes it. */
export const judgeCost = (result) =>
  result.cases
    .flatMap((c) => [...(c.arms?.with ?? []), ...(c.arms?.without ?? [])])
    .reduce((sum, r) => sum + (r.judgeCostUsd ?? 0), 0);

function fmt(n, digits, signed) {
  if (n === null) return '–';
  const s = n.toFixed(digits);
  return signed && n >= 0 ? `+${s}` : s;
}

export function formatTable(rows, result) {
  const head = '| case | arm | runs | invalid | errors | mean score | mean s | p50 s | mean $ |';
  const lines = [head, '|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const d = r.delta === true;
    lines.push(
      `| ${r.case} | ${r.arm} | ${d ? '' : r.runs} | ${d ? '' : r.invalid} | ${d ? '' : r.errors} | ` +
        `${fmt(r.score, 2, d)} | ` +
        `${fmt(r.meanSeconds, 0, d)} | ${fmt(r.p50Seconds, 0, d)} | ${fmt(r.costUsd, 2, d)} |`,
    );
  }
  lines.push(
    '',
    `suite: ${result.durationSeconds}s wall, agent $${result.costUsd.toFixed(2)}, judge ` +
      `$${judgeCost(result).toFixed(2)}${result.partial ? ' (partial)' : ''}`,
  );
  return `${lines.join('\n')}\n`;
}

/** Newest results dir name: they are ISO timestamps, so they sort lexically. */
export const newest = (names) => [...names].sort().at(-1) ?? null;

/** Returns the exit code. */
export function run(argv, io) {
  let path = argv[0];
  if (path === undefined) {
    const dir = join(io.root, 'evals', 'results');
    let names = [];
    try {
      names = io.readdir(dir).filter((n) => io.exists(join(dir, n, 'aggregate-result.json')));
    } catch {
      // no results dir yet
    }
    const latest = newest(names);
    if (latest === null) {
      io.stderr(`summarize: no aggregate-result.json under ${dir}\n`);
      return 1;
    }
    path = join(dir, latest, 'aggregate-result.json');
  }
  let result;
  try {
    result = JSON.parse(io.read(path, 'utf8'));
  } catch (e) {
    io.stderr(`summarize: cannot read ${path}: ${e.message}\n`);
    return 1;
  }
  io.stdout(`${path}\n\n${formatTable(summarize(result), result)}`);
  return 0;
}

export function main(proc = process) {
  proc.exitCode = run(proc.argv.slice(2), {
    root: ROOT,
    read: readFileSync,
    readdir: readdirSync,
    exists: existsSync,
    stdout: (s) => proc.stdout.write(s),
    stderr: (s) => proc.stderr.write(s),
  });
}

if (isEntry(process.argv[1], import.meta.url)) main();
