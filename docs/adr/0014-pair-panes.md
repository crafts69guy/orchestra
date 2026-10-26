# ADR-0014: pair mode (`orc claude --pair`)

- Status: accepted
- Date: 2026-10-26

## Context

Pane mode ([ADR-0009](0009-herdr-pane-workers.md)) runs `dispatch`'s implementers in an
`orc:<feature>` tab, one worktree per task. Most work is not dispatched: a single task goes to the
`orc:implementer` subagent in the session checkout, invisible to the user. A common herdr layout is
two panes side by side: the orchestrator on the left, a worker on the right, both on screen.

## Decision

- `orc claude --pair` sets `ORC_PAIR=1`; the session-start hook sets the `pair` flag only with
  `HERDR_ENV=1` too, like `panes`. `--pair` with `--panes` is a usage error (exit 2, nothing
  launched). Pair mode is Claude-main only: `orc codex` ignores `ORC_PAIR`.
- The flag keeps the `<!-- orc:pair -->` rule line (and drops the `orc:panes` one): each
  implementer task goes to a Codex pane beside the orchestrator instead of `orc:implementer`, one
  at a time, without `dispatch`. It adds `orc pane` to the CLI line.
- `orc pane start <F> <T> --here --path <checkout root> --brief <file> --kind codex` splits the
  caller's pane (`HERDR_PANE_ID`) to the right with the usual worker env and renames the new pane
  `orc:<T>`. A caller tab (`HERDR_TAB_ID`) that already has an `orc:`-labelled pane is refused with
  `orc: close <label> first`, unless the task's agent is already live (then `start` only prompts).
  `--path` is the session checkout, not a task worktree, so `start --here` git-ignores `.orc/`
  there (`ensureIgnored`). herdr 0.9.5 keeps a renamed label across terminal-title changes.
- `close` also accepts a pane whose own label starts with `orc:`. The brief, report, `wait` and
  `prompt` protocol is unchanged.
- With `ORC_PAIR=1`, the collision warning skips agents in the caller's tab: a `/clear` or compact
  must not tell the orchestrator to isolate from its own worker.

## Consequences

- Probe (2026-10-26, `codex sandbox -c sandbox_mode=workspace-write` in a temp repo): writing
  `.git` fails, `git commit` fails on `index.lock`, and network is blocked. The Codex worker cannot
  commit, push or install packages, so it needs no guard hook. A dependency install must happen in
  the main pane.
- Reviewer, scoper and shipper stay Claude subagents in the main pane. The reviewer needs a fresh
  context (diff, brief, criteria), which a subagent gives for free; the shipper commits, which the
  Codex sandbox forbids, and the guard hook only covers Claude. No Codex shipper.
- One worker at a time: no speed gain over `orc:implementer`; the gain is that the user sees and
  can steer the worker. Parallel work still goes through `dispatch` (pane mode or subagents).
- Not benchmarkable in the eval sandbox (no herdr server); covered by unit tests with a fake `exec`.
