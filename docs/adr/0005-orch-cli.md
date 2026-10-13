# ADR-0005: One `orch` CLI, published to npm

- Status: accepted
- Date: 2026-10-12

## Context

Up to v0.2.0 the plugin shipped two shims, `bin/orch-wt` and `bin/orch-codex`,
and sessions were started by dotfiles wrappers (`cyl --wf`, `cdx --wf`) that set
`ORCH=1` ([ADR-0003](0003-env-gated-activation.md)). Users without those
dotfiles had no launcher, no way to check prerequisites, and two binaries to
find. The unscoped npm name `orchestra` is taken.

## Decision

- One entry point, `bin/orch` (logic in `scripts/orch.mjs`), with subcommands
  `claude`, `codex`, `wt new|merge|list`, `doctor` and `eval`, plus
  `--help` and `--version`. Unknown or missing subcommands print usage and
  exit 1.
- Published as `@crafts69guy/orchestra` (bin `orch`, public access). The plugin
  marketplaces still deliver rules, agents, skills and hooks; the npm package
  carries the same files so `orch` can find them.
- `orch claude` and `orch codex` set `ORCH=1` and replace the shell wrappers.
  `orch claude` adds `--model opus` unless the user passes `--model`.
- Permission bypass is opt-in per run with `--yolo`
  (`--dangerously-skip-permissions` on Claude,
  `--dangerously-bypass-approvals-and-sandbox` on Codex), never a default.
- `bin/orch-wt` and `bin/orch-codex` are deleted without compatibility shims.
  The SessionStart context names the absolute path of `orch` instead.
- `orch eval` only works from a git checkout; `evals/` is not published.

## Consequences

- One command to install (`npm i -g @crafts69guy/orchestra`), check
  (`orch doctor`) and launch, independent of any dotfiles.
- `ORCH=1` stays the activation contract; the CLI is just the documented way
  to set it.
- Anything that called `orch-wt` or `orch-codex` breaks; the dotfiles are
  updated in the same release.
- Package version and both plugin manifests move together (0.3.0).

## Amendment (v0.6.0): `orch update`

Updating meant three commands in three tools (npm, `claude plugin`, `codex plugin`).
`orch update` runs them in order:

1. `npm install -g @crafts69guy/orchestra@latest`, skipped when the plugin root is a
   git checkout (`npm link`); it prints a `git pull` hint instead.
2. `claude plugin marketplace update orchestra` and `claude plugin update orch@orchestra`,
   when `claude plugin marketplace list --json` names `orchestra`.
3. `codex plugin marketplace upgrade orchestra`, when `codex plugin marketplace list --json`
   names `orchestra`. Codex installs the plugin from the marketplace snapshot, so refreshing
   it is the update.

A harness is updated only when it has the `orchestra` marketplace, not merely when its
binary is on `PATH`: 0.6.0 gated on `PATH`, and `codex plugin marketplace upgrade` fails
with "not configured" for a Codex that never added the marketplace (fixed in 0.6.1).

Every step runs even after a failure; the exit code is the first non-zero one. Running
sessions keep the old version until restarted.
