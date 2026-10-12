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
(`orch wt`), `scripts/orch-codex.mjs` (`orch codex`) and `scripts/doctor.mjs` (`orch doctor`),
and runs `orch claude` and `orch eval` itself. Each module takes its process, filesystem and
spawn dependencies as arguments. See [ADR-0005](docs/adr/0005-orch-cli.md).

## Codex launcher

`orch codex` (logic in `scripts/orch-codex.mjs`) reuses `readRules` and `buildContext` from
`hooks/session-start.mjs`, so the Codex context cannot drift from the Claude hook. Per-run `-c`
overrides are used instead of editing `~/.codex/config.toml`. Note that
`codex exec -s workspace-write` itself persists project trust in `~/.codex/config.toml`.

## Behaviour evals

`npm run eval` runs `claude plugin eval` over `evals/*/case.yaml` with `--trust-plugin --scaffold
--max-cost-usd 5 --no-publish`, granting `Bash Edit Write`. Each case scaffolds a small node:test
repo on branch `feat/x` and runs with the plugin and again without it (the baseline arm):

| Case | Expects |
|---|---|
| `inline-small` | one-line fix done inline: no Agent call, tests pass |
| `delegate-multi` | two dependent files + tests: `orch:implementer` spawned, no dispatch, no commit |
| `parallel-dispatch` | two independent features: `plan` + `dispatch`, 2+ implementers, two `orch wt merge` conventional commits, no leftover worktrees |

It costs real model usage on your Claude account (a full suite, 10 runs with Opus as the
orchestrator, cost about $1.50) and needs a logged-in `claude`, `wt` and git. Narrow it with
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
