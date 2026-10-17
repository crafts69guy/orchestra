# AGENTS.md

Contributor guide for this repo. Node >= 22.8, ESM, zero runtime dependencies.

## Commands

- `npm install` installs the dev tooling (Biome, markdownlint-cli2).
- `npm run lint` runs `biome check` and `markdownlint-cli2`.
- `npm run fmt` formats code with Biome.
- `npm test` runs `node --test` with built-in coverage.
- `npm run gen:codex` regenerates `codex/agents/*.toml` from `agents/*.md`; add `-- --check` to
  fail on drift without writing (CI does this).
- `npm run check` runs lint, the generator staleness check and tests.
- `npm run validate` runs `claude plugin validate .`.
- `npm run eval` (or `orch eval`) runs the behaviour evals (below). Not part of `check` or CI.
- `npm run eval:bench` runs the plugin-vs-baseline benchmark (below) and prints its time/cost
  table. Not part of `check` or CI.
- `bin/orch <subcommand>` runs the CLI from the checkout (`bin/orch doctor`, `bin/orch --help`);
  `npm link` puts it on `PATH` as `orch`.
- `npm pack --dry-run` lists what the npm package ships (`files` in `package.json`).

## Conventions

- Canonical sources are Markdown: `rules/orchestrator.md` and `agents/*.md`. Edit those.
- Agent descriptions start with `orch workflow:` and never say "use proactively"; activation comes
  from the injected rules. Keep agent bodies under about 25 lines.
- Hook scripts are small exported pure functions plus a thin `main`, with environment, filesystem
  and PATH lookup injected so they are testable in-process.
- Tests use `node:test` and `node:assert` only, with fixtures. They must not depend on the real
  `rules/orchestrator.md`.
- Docs under `docs/research/` relax the line-length rule (MD013); everything else is linted.

## Coverage rule

`npm test` fails below 98% lines, branches and functions. Do not exclude source files to reach it
(only `test/**` is excluded); write the test.

## Generated files

Do not edit generated Codex agent files (`codex/agents/*.toml`) by hand. Change `agents/*.md`,
run `npm run gen:codex` and commit the result.

`scripts/gen-codex-agents.mjs` maps `name`, `description`, `effort` (`max` becomes `xhigh`) and the
body (`developer_instructions`). `model` is not mapped, so Codex inherits the user's model.
`sandbox_mode = "read-only"` is set when `tools` lacks `Write` and `Edit`, unless the optional
`codex-sandbox` key overrides it: `read-only`, `workspace-write`, or `inherit` (omit `sandbox_mode`).
`agents/shipper.md` uses `inherit` because it needs to write `.git`.

## CLI

`bin/orch` is a thin shim; `scripts/orch.mjs` routes subcommands to `scripts/orch-wt.mjs`
(`orch wt`), `scripts/orch-pane.mjs` (`orch pane`, herdr pane workers; gated on `HERDR_ENV=1`,
see [ADR-0009](docs/adr/0009-herdr-pane-workers.md)), `scripts/orch-codex.mjs` (`orch codex`),
`scripts/ccc.mjs` (`orch ccc`, plus the cocoindex-code MCP gate the launchers and the session hook
share), `scripts/doctor.mjs` (`orch doctor [--json]`), `scripts/status.mjs` (`orch status [--json]`)
and `scripts/context.mjs` (`orch context`; it shares `scripts/lib/report.mjs` with doctor), and
runs `orch claude`, `orch update` and `orch eval` itself.
Each module takes its process, filesystem and spawn dependencies as arguments. See
[ADR-0005](docs/adr/0005-orch-cli.md).

`orch wt new|merge|remove|list` manages task worktrees (`remove <feature> <task>` abandons one:
worktree and branch, even unmerged). `orch pane start <feature> <task> --path <wt> --brief <file>`
and `orch pane wait|prompt|close <task> --path <wt>` drive pane workers; every pane subcommand
needs `--path`, because the herdr agent name hashes the worktree path.

`orch status --json`, `orch doctor --json` and `orch context --json` are a public contract for
external clients (the Raycast extension): additive fields keep `schemaVersion: 1`, renames and
removals bump it. See [ADR-0010](docs/adr/0010-json-contract-for-external-clients.md).

## Codex launcher

`orch codex` (logic in `scripts/orch-codex.mjs`) reuses `readRules` and `buildContext` from
`hooks/session-start.mjs`, so the Codex context cannot drift from the Claude hook. Per-run `-c`
overrides are used instead of editing `~/.codex/config.toml`. Note that
`codex exec -s workspace-write` itself persists project trust in `~/.codex/config.toml`.

## Behaviour evals

`npm run eval` runs `claude plugin eval` over the `evals/*/case.yaml` cases tagged `orch` with
`--trust-plugin --scaffold --max-cost-usd "${ORCH_EVAL_MAX_COST:-5}" --no-publish`, granting
`Bash Edit Write` (`run.sh` adds `--tag orch` unless you pass a `--tag`). Set the cost cap with
`ORCH_EVAL_MAX_COST`, not a second `--max-cost-usd` flag. Each case scaffolds a small node:test
repo on branch `feat/x` and runs with the plugin and again without it (the baseline arm):

| Case | Expects |
|---|---|
| `inline-small` | one-line fix done inline: no Agent call, tests pass |
| `delegate-multi` | two dependent files + tests: `orch:implementer` spawned, no dispatch, no commit |
| `batch-small` | two independent but tiny features: no `dispatch`, exactly one `orch:implementer`, two conventional commits, no leftover worktrees |
| `parallel-dispatch` | two independent substantial modules (bench-large's cron and expr spec, copied by the fixture): `plan` + `dispatch`, 2+ implementers, two `orch wt merge` conventional commits, no leftover worktrees |

It costs real model usage on your Claude account (a full suite, 12 runs with Opus as the
orchestrator, took about 9 minutes and $3; `parallel-dispatch` alone is about $1.45) and needs a
logged-in `claude`, `wt` and git. Narrow it with
`npm run eval -- --case <name> --runs 1 --ablation none`. Results go to `evals/results/`
(gitignored).

`evals/_support/run.sh` first builds `.eval-plugin/` (gitignored), a copy of the plugin, because
eval runs differ from a real session:

- Only `EVAL_*` variables reach a run, so the copy's hook commands are prefixed with `ORCH=1`.
  The hooks' own gate is unchanged.
- The `ponytail` dependency cannot be installed in the run's isolated home, so the copy's
  manifest drops it.
- Sandboxed Bash cannot read most of `$HOME` (including this repo) or `/tmp`, only the plugin
  root. So the copy carries `bin/`, `scripts/` and `package.json`, PATH entries under `$HOME` are
  dropped (Node's spawn fails with EPERM on them), and a `git` wrapper in the copy avoids the
  macOS `/usr/bin/git` shim, which prints everything twice in the sandbox and breaks `wt`.

## Benchmark

`npm run eval:bench` (`evals/_support/bench.sh`) asks whether the workflow pays off on a task big
enough to parallelise. It runs the `bench`-tagged cases (`bench-modules`, `bench-large`) through
`run.sh` with
`ORCH_EVAL_MAX_COST=20` (unless already set) and `--threshold 0 --judge-model sonnet`, then prints
`evals/_support/summarize.mjs` for the newest results. Extra args pass through
(`npm run eval:bench -- --runs 1`); `node evals/_support/summarize.mjs <aggregate-result.json>`
re-prints any older run. `ORCH_EVAL_MAX_COST=20 orch eval --tag bench` also runs the case (`orch
eval` passes args as-is), but with the behaviour defaults and no table.

It costs real model usage: the first full run (2 runs per arm, Opus orchestrator, Sonnet
implementers) took about 8 minutes and cost $2.75 agent plus $0.33 judge. The $20 cap is a
placeholder until a run with the current graders is measured.

Two sizes find the break-even point. `bench-modules` has ~25 s of coding per module (about $3
for the full case); `bench-large` (three modules: cron, JSON Schema subset, expression
evaluator; ~390 reference lines, 73 hidden tests, `three-commits` instead of `four-commits`, so
outcome weights total 11) has a few minutes per module. Measured: $0.9–1.2 and 2.5–4 minutes per
run, so about $2.5 with one run per arm or $5 for the full case. Run it alone with its own cap:
`ORCH_EVAL_MAX_COST=8 npm run eval:bench -- --case bench-large`. Both use the
same harness, graders and peek guards below.

The fixture is a repo on `feat/x` with `evals/bench-modules/SPEC.md`: four independent modules
(`duration`, `semver`, `csv`, `lru`). The prompt says implement them with tests, one commit per
module, and never mentions parallelism or subagents. Every grader is an outcome, so the baseline is
not penalised for working serially (outcome weights total 13; the no-peek guards are not
outcomes):

| Grader | Weight | Passes when |
|---|---|---|
| `no-peek-bash` / `-read` / `-grep` | guard | no tool call read `check.sh` or the hidden suite (below) |
| `acceptance-<module>-80` / `-all` | 1 + 1 per module | hidden suite at ≥80% / 100% |
| `quality-rubric` (llm) | 2 | judge scores SPEC + final diff ≥8/10 on correctness, edge cases, readability, tests, no over-engineering |
| `own-tests-pass` | 1 | the agent's own `node --test` has ≥4 passing and 0 failing |
| `four-commits` | 1 | exactly 4 commits on `main..feat/x` |
| `clean-tree` | 1 | nothing uncommitted (`.scratch/` excluded) |

`check.out` in a kept run (`--keep-temp`) shows exact hidden counts per module
(`acceptance csv: 17/18 94%`).

**Hidden tests.** The acceptance suite is `evals/bench-modules/hidden/`, validated against
`reference/` by `test/bench-hidden.test.mjs`. The run's sandbox cannot read this repo, so the
fixture (which runs as you, outside the sandbox) packs the suite into the workspace's
`.git/acceptance.tgz`: no tracked file, no git object, not matched by Glob or Grep. Only `check.sh`
unpacks it into `.git/acceptance/`, runs it and deletes it. The sandbox cannot stop an agent from
reading `check.sh` and extracting the tarball, so the `no-peek-*` graders detect it instead: any
Bash, Read or Grep call (subagents' included) that touches `acceptance.tgz` / `.git/acceptance`
fails one. Reading `check.sh` itself is allowed: agents routinely `cat` it while orienting (both
arms did in the first bench-large run), and it holds no test content.
The guards don't affect the score: `summarize.mjs` recomputes each run's score without them
and drops a run that failed one as invalid (counted in the `invalid` column, left out of score,
time and cost means). The eval's own per-run score and pass rate still include them at weight 1,
so a peeking run never shows as a pass there. Still undetected: running `check.sh` early and reading
the pass counts in `check.out`, and readers outside the regex's list (`node -e` and the like). To
audit a run, grep its kept `trace.jsonl` for `acceptance`.

Another case with a hidden suite copies this block (adjust paths if its checker differs);
`max: 0` needs `min: 0`, and `tool` takes one exact tool name, hence three graders:

```yaml
  - name: no-peek-bash
    type: tool_used
    tool: Bash
    input_match: '"command"\s*:\s*"(?:[^"\\]|\\.)*?(?:acceptance\.tgz|\.git/acceptance)'
    min: 0
    max: 0
    weight: 1
    arm: both
  - name: no-peek-read
    type: tool_used
    tool: Read
    input_match: '"file_path"\s*:\s*"[^"]*acceptance'
    min: 0
    max: 0
    weight: 1
    arm: both
  - name: no-peek-grep
    type: tool_used
    tool: Grep
    input_match: '"(?:path|glob)"\s*:\s*"[^"]*acceptance'
    min: 0
    max: 0
    weight: 1
    arm: both
```

Keep the `no-peek-` name prefix: that is how `summarize.mjs` recognises a guard. `input_match`
is a flagless JS RegExp tested against `JSON.stringify` of each tool input.

**Reading the numbers.** Per case and arm, the table shows runs, invalid (peeking) runs, errored
runs, then over the valid runs the mean score, mean and median (p50) wall-clock seconds per run,
and mean agent cost, then a `Δ with−without` row. Cost is the run's `total_cost_usd`, which
includes subagent spend (checked: its `modelUsage` lists the Sonnet implementers next to the Opus
orchestrator). LLM-judge spend is only in the suite line;
the eval's own per-run `$` adds it in. Runs are sequential (concurrency 1), so a shared rate limit
does not skew durations. With two runs per arm p50 equals the mean, and two is a small sample:
treat a delta smaller than the spread between runs as noise. Slower or dearer with no score gain is
a valid result, not a reason to tune the case.
