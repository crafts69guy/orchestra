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

## Codex launcher

`bin/orch-codex` (logic in `scripts/orch-codex.mjs`) is a thin shim like `bin/orch-wt`. It reuses
`readRules` and `buildContext` from `hooks/session-start.mjs`, so the Codex context cannot drift
from the Claude hook. Per-run `-c` overrides are used instead of editing `~/.codex/config.toml`.
Note that `codex exec -s workspace-write` itself persists project trust in `~/.codex/config.toml`.
