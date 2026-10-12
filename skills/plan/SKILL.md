---
name: plan
description: "orch workflow: write .scratch/<feature>/plan.md, a task list with file ownership and dependencies that the dispatch skill can run in parallel waves. Use when work has 2+ separable parts."
---

# Plan

Write `.scratch/<feature>/plan.md` in the repo root. Keep `.scratch/` out of git
(`.git/info/exclude`) unless the repo already tracks it.

## Before writing

1. Read the scoper brief if there is one; do not rescope.
2. Decide every cross-cutting choice now (interfaces, names, libraries, error
   handling). Workers run in parallel and cannot ask each other.

## Format

````markdown
# <feature>

Base branch: <F>   # the branch the tasks merge into

## Decisions

- <decision that every task must follow>

## Tasks

```yaml
- id: T1
  goal: <one sentence, observable outcome>
  files: [<paths this task owns>]
  depends_on: []
  validate: <command that proves this task works>
  decisions: [<task-specific choices>]
```
````

## Rules

- `files` is ownership. Two tasks with no dependency path between them must not
  share a file. If they must, add a `depends_on` edge or merge the tasks.
- Shared files that everyone touches (lockfiles, barrel exports, registries) go
  to one task that the others depend on.
- Each task is 1 implementer-sized unit: one edit-and-test loop, not a project.
- `validate` runs inside the task's own worktree and must not need other
  unmerged tasks.
- Prefer fewer, larger tasks over many tiny ones; parallelism costs tokens.

## After writing

Show the user the task table (id, goal, depends_on) in a few lines. If 2+ tasks
are independent, continue with the `dispatch` skill; otherwise run implementers
one at a time.
