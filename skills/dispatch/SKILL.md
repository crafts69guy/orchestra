---
name: dispatch
description: "orch workflow: run independent substantial tasks from .scratch/<feature>/plan.md in parallel, one implementer per git worktree (worktrunk), then merge them into the feature branch one at a time."
---

# Dispatch

Run the plan in waves. Harness-specific spawn syntax:
[Claude Code](references/claude.md) · [Codex](references/codex.md).

`orch` is the CLI shipped with this plugin; the session context names its
absolute path. Use that path where the plugin's `bin/` is not on `PATH` (Codex).
`orch wt` wraps worktrunk (`wt`) and prints JSON.

## Preconditions

- You are on the feature branch `F` named in the plan, with a clean tree.
- `wt` is installed. If the repo has worktrunk project hooks
  (`.config/wt.toml`) and the user has not said the repo is trusted, ask once
  before passing `--yes`: it runs the repo's hook commands.

## Each wave

1. **Pick** the ready `substantial` tasks: all `depends_on` merged, `files`
   disjoint. At most 4 per wave; queue the rest. `small` tasks are never
   dispatched: run them as one batched implementer task on `F`, before any wave
   that depends on them.
2. **Create** worktrees: `orch wt new <F> <T1> <T2> …` → JSON list of
   `{task, branch, path}`.
3. **Spawn** one implementer per task, all in the **same message** so they run
   in parallel. Brief each with: plan path + task id, its worktree `path`
   (work only there), the plan's Decisions, `validate`, and "do not commit".
4. **Wait** for all reports. `partial`/`blocked` → answer and resume that agent
   (max 2 rounds), or re-plan.
5. **Review** each diff (`git -C <path> diff`). Send defects back to the same
   agent.
6. **Merge one task at a time:**
   `orch wt merge <F> <T> --message "<conventional commit message>"`.
   The message is the full commit message: include any trailers your
   instructions require (e.g. `Co-Authored-By`). Never rewrite merged commits
   afterwards.
   - `status: merged` → next task.
   - `status: conflict` → the rebase was aborted and the worktree kept. Resolve
     it yourself in the worktree, or resume the task's implementer with the
     conflicting files, then merge again.
7. **Verify** the full test suite on `F` before the next wave.

## After the last wave

Report per task: merged commit, validation evidence, anything skipped. Shipping
(push, PR) is still the shipper's job and needs the user's go-ahead.

## Don't

- Run two implementers in the same checkout.
- Merge in parallel, or merge a task whose validation you have not seen.
- Let implementers commit, push, or touch files outside their `files`.
