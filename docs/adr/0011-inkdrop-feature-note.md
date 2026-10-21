# ADR-0011: Inkdrop feature note

- Status: accepted
- Date: 2026-10-18

## Context

orc's state is ephemeral and lives only in the terminal. `.scratch/<feature>/plan.md` is
gitignored, so its decisions and learnings are gone after the merge, and the user can steer a run
only from the chat. The user keeps their knowledge in Inkdrop, which syncs across devices and has
a local HTTP server and an official MCP server.
[docs/research/inkdrop.md](../research/inkdrop.md) has the API survey.

## Decision

- **One Inkdrop note per feature**, in the repo's notebook, tagged `orc`. The user's text is the
  spec. orc owns only a managed block between the lines `<!-- orc:begin -->` and
  `<!-- orc:end -->`: feature, base branch, the plan's Decisions, one checkbox per task (checked
  once merged) and the log. Inkdrop derives a task progress bar from the checkboxes.
- **Four flows:**
  - Inbox: the user writes a note tagged `orc` with status `active`. `orc inkdrop inbox` lists
    unclaimed ones, and `orc inkdrop claim <note-id> <feature>` links one and prints its spec as
    the request.
  - Mirror: `orc inkdrop push <feature>` after the plan is written, and automatically after every
    `orc wt merge` of a linked feature. `orc inkdrop pull <feature>` before each wave reports
    whether the spec changed (sha256 of the spec, stored in `.scratch/<feature>/inkdrop.json`).
  - Capture: the orchestrator writes `.scratch/<feature>/log.md`, and `push --done` puts it in the
    block and sets the status to `completed`.
  - Recall: before scoping, the orchestrator and `scoper` search the notebook through the
    Inkdrop MCP (`search-notes`, `read-note`).
- **Hybrid I/O:** every write goes through `scripts/inkdrop.mjs` over HTTP. It is deterministic
  and tested, and it spends no tokens on note bodies. Only recall reads use MCP, because
  choosing what to read takes judgment.
- **Safety:** credentials come from the MCP's own `INKDROP_LOCAL_*` env vars, are never printed,
  and are sent only to a loopback host. A body write is GET, splice, then `POST /notes` with
  `_rev`; a conflict re-reads and retries once, then fails. Text outside the block is never
  changed. orc never deletes, and it writes only notes it created or claimed, the `orc` tag, and
  (with `--create`) the notebook and its parent. `init --move` changes only the `bookId` of this
  repo's notes in the old notebook: its own lesson notes, its linked feature notes and unclaimed
  `orc` specs.
- **Repo mapping** lives in local git config (`orc.inkdropBook`, `orc.inkdropBookName`,
  `orc.inkdropTag`), written by `orc inkdrop init`. It stores ids, and searches use the
  `bookId:<id>` qualifier, so renames are safe (a `book:"<name>"` keyword broke after one).
  Nothing is tracked. `--parent <name>` (or `orc.inkdropParent`, local or global) maps the repo to
  a sub-notebook of that root notebook; `--move` carries the old notebook's orc notes over on a
  remap. Inkdrop's notebook search does not include sub-notebooks, so cross-repo lesson recall
  searches by tag.
- **Gate**, the same shape as ccc (ADR-0007): the rule lines marked `orc:inkdrop` and the context
  line naming the notebook are injected when `ORC_INKDROP` is not `0`, both credential vars are
  set and the repo is mapped. The check is offline: SessionStart makes no HTTP call.
- `orc status --json` gains feature `note` and task `merged: { commit }`. These are additive, so
  `schemaVersion` stays 1 (ADR-0010). The new `.scratch/<feature>/merged` record, written on each
  merge, also resolves ADR-0010's "pending vs merged" gap.

## Consequences

- Specs, progress and the log outlive `.scratch/`, and they work from any device that has
  Inkdrop.
- Each feature costs a few extra CLI calls (claim, push, pull per wave, done). The data cost
  stays small because bodies never go through the model.
- Inkdrop must be running for the inbox and pushes. An auto-push failure after a merge is a
  warning and never fails the merge.
- Edits the user makes inside the managed block are overwritten by the next push.
- Recall on Codex needs the Inkdrop MCP configured for Codex (`codex mcp add`); `orc codex` does
  not inject it.
- Deferred: a `/_changes` watcher and an Inkdrop plugin command ("send to orc"). Promoting log
  learnings into atomic notes is now `orc inkdrop lessons` (ADR-0013).
