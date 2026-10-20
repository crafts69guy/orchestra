# ADR-0012: session worktrees and collision warnings

- Status: accepted
- Date: 2026-10-20

## Context

orc isolates subagents: each dispatched task gets its own worktree (`<F>--<T>` under
`.worktrees/`). It does not isolate sessions. In herdr, two orchestrator sessions (`orc claude`)
were started in the same checkout and edited the same working tree. Neither knew the other
existed, and the rules' "never run two writers on the same checkout" only covered subagents.

## Decision

- `orc wt session <branch> [--base <ref>] [--yes]` (`scripts/orc-wt.mjs`) gives a session its
  own worktree: `wt switch <branch>` when the branch exists (reusing its worktree; `--base` is
  ignored), else `wt switch -c <branch> [--base <ref>]`, both `--no-cd --format=json`. It prints
  `{ branch, path, action }`.
- The path comes from the user's worktrunk template (by default a sibling
  `<repo>.<branch-sanitized>`), not `.worktrees/`: a session worktree is a normal worktrunk
  worktree the user can `wt switch` to. Task worktrees stay under the main root's `.worktrees/`
  even when `orc wt new` runs from a session worktree (verified with wt v0.80.0).
- `orc claude --wt <branch> [--base <ref>]` and `orc codex --wt <branch> [--base <ref>]` create or
  reuse that worktree, print `orc: session worktree <path> (<branch>)` to stderr and launch the
  harness there (ccc, Inkdrop and `--add-dir` use the new cwd).
- Warn, don't block. The SessionStart hook (and `orc codex`, since Codex hooks may be untrusted)
  appends a warning paragraph to the context:
  - Inside herdr (`HERDR_ENV=1`): `herdr agent list`, minus this pane, keeping agents whose
    `foreground_cwd` (else `cwd`) has this checkout as its git toplevel. Task worktrees have their
    own toplevel and do not count. A herdr error means no warning.
  - Outside herdr, on `source: startup` only: `git status --porcelain` is non-empty. The changes
    may belong to another session, so the agent must not edit, stash, reset or commit them.
  The rules' **Sessions** bullet tells the orchestrator to isolate with `orc wt session` and
  EnterWorktree (Codex: ask the user to restart with `orc codex --wt`). EnterWorktree accepts
  a sibling worktree outside `.claude/worktrees/` on first entry (verified on Claude Code).
- `.scratch/` stays in the main root. In a linked worktree the context adds
  `Scratch dir: <main root>/.scratch`, and the `plan` skill writes there, so `orc status` and
  `orc inkdrop` (which already read `mainRoot`) see every plan.

## Consequences

- A second session can still start in a busy checkout; the warning only makes it stop before
  editing. Outside herdr the dirty-tree check is a heuristic: it also fires on your own
  uncommitted work and misses a second session that has not written anything yet.
- Session worktrees are ordinary worktrunk worktrees: removing one is `wt remove <branch>`.

## Skipped

- Lease files or a heartbeat per checkout: add when sessions collide outside herdr often enough
  that the dirty-tree heuristic is not enough.
- A hook that blocks edits in a shared checkout: add if warnings are ignored in practice.
- Sessions in `orc status`: add when an external client needs to list them.
