# ADR-0002: worktrunk manages worktrees for parallel implementers

- Status: accepted
- Date: 2026-10-12

## Context

Parallel implementers need isolated checkouts. Options surveyed
([research](../research/worktree-tools.md)): a custom script, worktrunk, gtr,
workmux, and native Claude `isolation: worktree`. Native isolation has no Codex
equivalent, an undocumented branch hand-back, and bases on the default branch.

## Decision

Use worktrunk (`wt`) as a required external tool. The orchestrator calls it via
Bash on both harnesses: `wt switch -c` to create, `wt merge <feature>` to
squash, rebase, run pre-merge checks and fast-forward, `wt list --format=json`
to inspect. Dependency bootstrap lives in each project's `.config/wt.toml`
hooks and `.worktreeinclude`.

## Consequences

- One worktree mechanism for every harness; the orchestrator always knows paths.
- Users must install worktrunk; the SessionStart hook warns when it is missing.
- `--yes` auto-approves project hooks, so it is used only on trusted repos.
- Worktrees live in `<repo>/.worktrees/` (ignored via `.git/info/exclude`);
  the path is passed with `--config-set` because worktrunk ignores it in
  project config.
- A tested helper owns the exact flags (P0 W1–W5): `bin/orch-wt` until v0.2.0,
  `orch wt` since v0.3.0 ([ADR-0005](0005-orch-cli.md)).
