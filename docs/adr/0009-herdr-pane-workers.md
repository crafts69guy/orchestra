# ADR-0009: herdr pane workers (`orc pane`)

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

- Opt-in pane mode: `orc claude --panes` sets `ORC_PANES=1`; the session-start
  hook and `orc codex` set the `panes` flag only when `HERDR_ENV=1` too. The
  flag keeps the `<!-- orc:panes -->` rule line, which points `dispatch` at
  `skills/dispatch/references/herdr.md`, and adds `orc pane` to the CLI line.
- `orc pane` (`scripts/orc-pane.mjs`) wraps the herdr CLI and prints JSON:
  - Every subcommand takes `--path <worktree>`. The agent is named
    `orc-<first 6 hex of sha1(worktree path)>-<task>` (at most 32 chars), so
    names are unique per worktree and a re-run finds the same agent.
  - `start <feature> <task> --path <worktree> --brief <file> [--kind claude|codex]`
    opens (or splits, up to a 2x2 grid) an `orc:<feature>` tab, starts the
    agent with `ORC=1 ORC_ROLE=implementer` (and `ORC_LEVEL`), Claude on
    sonnet (opus with `ORC_LEVEL=high`), Codex with
    `--sandbox workspace-write`, and prompts it with the implementer
    instructions and its brief. A failed agent start closes the new pane. When
    the agent already exists, `start` only sends the prompt.
  - `start` reports `started` or `not-sent`, `prompt` reports `prompted` or
    `not-sent`. `not-sent` means a dialog kept the prompt from being delivered
    (`agent_not_ready`, `agent_blocked`). Both carry `state`, the agent status
    after submission. Both delete the old report first.
  - `wait <task> --path <worktree> [--timeout ms]` (30 minutes by default)
    first waits out a dialog the agent is already blocked on, then waits for a
    settled state and reads `<worktree>/.orc/report.md`, reporting `evidence`
    with the subagent-stop hook's `hasEvidence`.
  - `prompt` sends follow-ups prefixed `Follow-up:`; `close` closes the pane
    only when it sits in an `orc:*` tab. Not a cwd check: after
    `orc wt merge`, worktrunk moves the worktree, and the agent's cwd with
    it, to `.git/wt/trash/`. `orc wt remove <feature> <task>` drops an
    abandoned task's worktree and branch.
- Workers are main sessions, so they carry `ORC_ROLE=implementer`. A no-commit
  `ORC_ROLE` overrides `agent_type` in the guard hook, so a subagent spawned
  inside a worker (`orc:shipper` included) stays restricted; other values are
  ignored. `orc claude` and `orc codex` clear `ORC_ROLE` for a new
  orchestrator. The session-start hook injects nothing when it is set. `orc wt new` adds `.orc/` to
  `.git/info/exclude`, so reports never land in a merge commit.
- Every subcommand refuses to run outside herdr (`HERDR_ENV=1`, a workspace id,
  `herdr` on `PATH`). `orc doctor` shows herdr as an optional line.

## Consequences

- No speed gain is expected: the workers do the same work as subagents. The
  gain is visibility and control.
- Not benchmarkable in the eval sandbox, which has no herdr server; covered by
  unit tests with a fake `exec` only.
- Dialogs surface as `not-sent` or `state: blocked`; the orchestrator asks the
  user to look at the pane and never answers them itself. Verified live:
  Claude workers inherit trust from a trusted repo, while Codex asks once per
  repo root and remembers it.
- Codex workers have no guard hook; their `workspace-write` sandbox blocks
  writes to the shared `.git`, so they cannot commit.
- Rejected: Claude's cross-session SendMessage as the primary channel. It is
  Claude-only and has no lifecycle wait; herdr's `agent wait` works for both
  harnesses.
