# ADR-0010: JSON contract for external clients

- Status: accepted
- Date: 2026-10-16

## Context

A Raycast extension, kept in its own repo, wants to show and act on orc
state: plan tasks, their worktrees, pane agents and worker reports, and
`doctor` checks. Reading `.scratch/`, `.worktrees/` and herdr directly would copy
orc's join logic into another codebase, untested and free to drift.
[docs/research/raycast.md](../research/raycast.md) has the research.

## Decision

- orc exposes its state as versioned JSON and clients call the CLI:
  - `orc status [--json]` (`scripts/status.mjs`) joins each
    `.scratch/<feature>/plan.md` (base branch; tasks from the `## Tasks` yaml
    block: `id`, `goal`, `size`, `depends_on`) with `orc wt list`, the herdr
    agent state and the worker report's Status line. `.scratch/` is read from
    the main checkout (the parent of the git common dir), also when run inside
    a task worktree. JSON:
    `{ schemaVersion, root, warnings, features: [{ feature, base, plan, note, tasks:
    [{ id, goal, size, dependsOn, branch, worktree, agent, report, merged }] }] }`.
    Paths are absolute; a missing piece is `null`. Tasks join worktrees on
    `<base branch>--<task>` (the plan's `Base branch`, else the feature name);
    those whose task is not in the plan are listed with `goal: null`. A `wt`
    failure is a `warnings` entry, not an error.
  - `orc doctor --json` prints `{ schemaVersion, checks }`. Each check has
    `status` (`pass`, `fail`, `warn`, `info`) next to `mark`, so clients never
    compare glyphs. The exit code matches text mode.
  - `orc context --json` (ADR-0008) prints `{ schemaVersion, sources,
    findings }`; findings carry the same `status`.
- Agent state is best-effort and needs no `HERDR_ENV`: clients run outside
  herdr. When `herdr` is not on `PATH` or `herdr agent get` fails, `agent` is
  `null`.
- `schemaVersion` is `1`. Adding fields does not bump it; renaming or removing
  a field, or changing its type or meaning, does. Clients check it and ignore
  unknown fields.
- The task parser is line-based, not a YAML parser: it reads task-level
  scalars and flow lists only. Plans keep that shape (the `plan` skill writes
  it).
- A GUI stays a non-goal in this repo; clients live elsewhere and depend only
  on this contract.

## Consequences

- External tools get one tested join instead of re-implementing it; agents
  can use `orc status` too.
- Field names in `status`, `doctor` and `context --json` are now public API: renames need
  a `schemaVersion` bump and a note in the client.
- `status` cannot tell a pending task from a merged one: both have no worktree
  (`worktree: null`).
- Resolved by [ADR-0011](0011-inkdrop-feature-note.md): each merge is recorded and `status`
  reports task `merged: { commit }`.
- Task `branch` values follow the plan's Base branch (`feat/x--T1`), as `orc wt new` names them;
  earlier versions reported `<feature>--<task>`, which matched no worktree when the two differ.
  Clients matching on `branch` should expect the corrected values.
- Known limitation: one plan per base branch. Two plans with the same Base branch see each
  other's worktrees, and `orc wt merge` records neither (it warns instead).
