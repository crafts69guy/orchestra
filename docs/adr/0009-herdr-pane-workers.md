# ADR-0009: herdr pane workers (`orch pane`)

- Status: accepted
- Date: 2026-10-15

## Context

`dispatch` spawns implementers as in-process subagents. Inside
[herdr](https://herdr.dev), a terminal workspace manager for coding agents, they
are invisible: the user cannot watch a worker, step in when it stalls, or
answer its approval dialogs, and herdr's own agent states (`idle`, `working`,
`blocked`, `done`) never see them. herdr 0.9.4 exposes tabs, panes and agents
through a JSON CLI (`herdr tab|pane|agent ...`).

## Decision

- Opt-in pane mode: `orch claude --panes` sets `ORCH_PANES=1`; the session-start
  hook and `orch codex` set the `panes` flag only when `HERDR_ENV=1` too. The
  flag keeps the `<!-- orch:panes -->` rule line, which points `dispatch` at
  `skills/dispatch/references/herdr.md`, and adds `orch pane` to the CLI line.
- `orch pane` (`scripts/orch-pane.mjs`) wraps the herdr CLI and prints JSON:
  - `start <feature> <task> --path <worktree> [--kind claude|codex] [--brief <file>]`
    opens (or splits, up to a 2x2 grid) an `orch:<feature>` tab, starts the
    agent `orch-<task>` with `ORCH=1 ORCH_ROLE=implementer` (and `ORCH_LEVEL`),
    Claude on sonnet (opus with `ORCH_LEVEL=high`), and prompts it with the
    implementer instructions and its brief.
  - `wait <task> --path <worktree> [--timeout ms]` waits for a settled state and
    reads `<worktree>/.orch/report.md`, reporting `evidence` with the
    subagent-stop hook's `hasEvidence`.
  - `prompt <task> (--text | --file)` sends follow-ups; `close <task>` closes
    the pane only when it sits in an `orch:*` tab. Not a cwd check: after
    `orch wt merge`, worktrunk moves the worktree, and the agent's cwd with
    it, to `.git/wt/trash/`.
- Workers are main sessions, so `ORCH_ROLE` replaces `agent_type`: the guard
  hook falls back to it when `agent_type` is empty, and the session-start hook
  injects nothing when it is set. `orch wt new` adds `.orch/` to
  `.git/info/exclude`, so reports never land in a merge commit.
- Every subcommand refuses to run outside herdr (`HERDR_ENV=1`, a workspace id,
  `herdr` on `PATH`). `orch doctor` shows herdr as an optional line.

## Consequences

- No speed gain is expected: the workers do the same work as subagents. The
  gain is visibility and control.
- Not benchmarkable in the eval sandbox, which has no herdr server; covered by
  unit tests with a fake `exec` only.
- A new worktree is an untrusted directory, so Claude's trust dialog (and any
  approval dialog) surfaces as `blocked`; the orchestrator asks the user to
  look at the pane and never answers it itself.
- Codex workers have no guard hook; their sandbox blocks writes to the shared
  `.git`, so they cannot commit.
- Rejected: Claude's cross-session SendMessage as the primary channel. It is
  Claude-only and has no lifecycle wait; herdr's `agent wait` works for both
  harnesses.
