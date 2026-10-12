# Benchmarks: does parallel dispatch pay off?

Date: 2026-10-12. Claude Code 2.1.296, `claude plugin eval`, judge model Sonnet. Decision taken from it: [ADR-0006](../adr/0006-dispatch-threshold.md).

## Method

- `npm run eval:bench` (`evals/_support/bench.sh`, details in [AGENTS.md](../../AGENTS.md#benchmark)): each case runs once with the plugin (`with`) and once without it (`without`, the baseline), sequentially (concurrency 1), 2 runs per arm.
- Orchestrator: Opus in both arms. In the `with` arm the implementers are the plugin's `orch:implementer` (Sonnet). The `with` arm ran under the rule then in force: dispatch every set of independent tasks in parallel, whatever their size.
- The prompt only says "implement the modules in SPEC.md, one commit per module"; it never mentions subagents or parallelism.
- Graders are outcomes only, so the baseline is not penalised for working serially: a hidden acceptance suite per module (≥80% and 100% tiers), the agent's own tests green, one commit per module, a clean tree, and one LLM quality rubric (weight 2).
- Score below is the outcome score `summarize.mjs` computes (no-peek guards excluded). Cost is the run's `total_cost_usd`, subagents included; judge cost is separate. Time is the run's wall clock.

Cases:

| Case | Modules | Size |
|---|---|---|
| `bench-modules` | `duration`, `semver`, `csv`, `lru` | tiny: ~140 reference lines in total, ~25 s of coding each |
| `bench-large` | `cron`, `schema` (JSON Schema subset), `expr` (expression evaluator) | ~100–200 reference lines each (~390 total), 73 hidden tests |

## Results

Means over 2 runs per arm. Hidden acceptance suites were at 100% for every module in every run of both cases and both arms.

| Case | Arm | Score | Time (s) | Agent cost ($) |
|---|---|---|---|---|
| `bench-modules` | with | 0.92 | 115 | 0.81 |
| `bench-modules` | without | 1.00 | 118 | 0.56 |
| `bench-modules` | Δ | −0.08 | −3 (≈0%) | +0.25 (+45%) |
| `bench-large` | with | 0.82 | 164 | 1.18 |
| `bench-large` | without | 0.91 | 208 | 0.97 |
| `bench-large` | Δ | −0.09 | −44 (−21%) | +0.21 (+22%) |

The score gaps come entirely from the LLM rubric (see caveats); every regex outcome passed in every run. In the `bench-large` `with` runs the orchestrator went `plan` → `dispatch` → 3 parallel `orch:implementer`s.

### Per run

Raw numbers from `evals/results/<timestamp>/aggregate-result.json` (gitignored). Turns are the orchestrator's only.

| Results dir | Case | Arm | Time (s) | Agent $ | Judge $ | Turns | Score | Failed graders |
|---|---|---|---|---|---|---|---|---|
| `2026-10-12T04-30-54-653Z` | `bench-modules` | with | 128 | 0.858 | 0.108 | 6 | 0.85 | `quality-rubric` |
| `2026-10-12T04-30-54-653Z` | `bench-modules` | with | 101 | 0.766 | 0.064 | 8 | 1.00 | – |
| `2026-10-12T04-30-54-653Z` | `bench-modules` | without | 131 | 0.588 | 0.090 | 21 | 1.00 | – |
| `2026-10-12T04-30-54-653Z` | `bench-modules` | without | 104 | 0.540 | 0.068 | 19 | 1.00 | – |
| `2026-10-12T05-21-13-191Z` | `bench-large` | with | 176 | 1.169 | 0.160 | 10 | 0.82 | `quality-rubric`, `no-peek-bash`* |
| `2026-10-12T05-21-13-191Z` | `bench-large` | without | 179 | 0.902 | 0.122 | 20 | 0.82 | `quality-rubric`, `no-peek-bash`* |
| `2026-10-12T05-27-55-631Z` | `bench-large` | with | 151 | 1.195 | 0.158 | 9 | 0.82 | `quality-rubric`, `no-peek-bash`* |
| `2026-10-12T05-27-55-631Z` | `bench-large` | without | 237 | 1.031 | 0.159 | 21 | 1.00 | `no-peek-bash`* |

\* False positive, see caveats. Suite totals: `bench-modules` 465 s, agent $2.75, judge $0.33; `bench-large` 356 s + 389 s, agent $2.07 + $2.23, judge $0.28 + $0.32.

## Reading

- Tiny independent modules: dispatch saves nothing (−3 s on ~118 s, within the 27 s spread between baseline runs) and costs 45% more. At ~25 s of work per task, the fixed overhead (plan, worktrees, briefs, review, serial merges) is likely what eats the parallel gain.
- Substantial modules (~100–200 lines each, several edit-and-test cycles): dispatch is 21% faster for 22% more cost. The wall-clock gain is real but well short of the 3× an ideal 3-way split would give, because planning, review and merging stay serial on the orchestrator.
- Hence the threshold in `rules/orchestrator.md`: dispatch only when 2+ independent tasks are each substantial; batch small independent tasks into one implementer.

## Caveats

- **n = 2 per arm.** Two runs is a small sample; with two runs the median equals the mean. The `bench-large` baseline alone spread 179–237 s, so the −21% is suggestive, not significant.
- **The LLM rubric is noisy on long inputs.** Its input is SPEC + the whole diff: 20–26k characters for `bench-modules`, 42–54k for `bench-large`, and the eval itself warns that judges are noisy on long files. It failed 3 of the 4 `bench-large` runs (both `with` runs, one `without` run) and 1 of 4 `bench-modules` runs, while the hidden suites passed 100% everywhere. The score deltas are most likely rubric noise, not a quality difference between arms.
- **Peek-guard incident.** Both `bench-large` runs were first flagged invalid in both arms, so `summarize.mjs` printed only dashes for them. The `no-peek-bash` guard then also matched reading `check.sh`, and the agents only ran `cat check.sh` while orienting; none touched `acceptance.tgz` or `.git/acceptance`. The guard has since been relaxed to the tarball and unpacked directory only, and these runs are treated as valid here: their score is recomputed without the guards.
- **Model mix.** Opus orchestrator in both arms; the `with` arm adds Sonnet implementers, so its cost mixes two price tiers. A different implementer model would move both the time and the cost delta.
- Durations include the harness's own overhead; runs were sequential so a shared rate limit affects both arms alike.
