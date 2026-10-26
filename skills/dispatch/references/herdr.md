# Dispatch with herdr pane workers

Use when the session rules say pane mode is on, or the user asks for it. Each
task runs as a real `claude` or `codex` session in a herdr pane inside its
worktree, visible to the user. Only steps 3 and 4 of the wave change.

- **3. Start.** Write one brief file per task (plan path + task id, Decisions,
  `validate`). Run `start` **one at a time**, never in parallel:
  `orc pane start <F> <T> --path <path> --brief <file> [--kind claude|codex]`.
  - `status: not-sent` → a dialog kept the prompt from being delivered. Tell
    the user which pane needs them; once they clear it, re-run the same
    `start` (it reuses the live agent and only sends the prompt).
  - `status: started` with `state: blocked` → the worker got the prompt and
    then hit a dialog. Tell the user, then wait as usual.

  Then run one `orc pane wait <T> --path <path>` per task as a background
  command (Claude: Bash `run_in_background`; default timeout 30 minutes). On
  Codex (no background Bash) run each `wait` in the foreground, one per task.
- **4. Read** each wait result `{task, state, report, evidence}`:
  - `state: blocked` → tell the user which pane needs them, then wait again;
    `wait` blocks until they clear the dialog.
  - `state: timeout` → wait again, or look at the pane.
  - `evidence: false` (no report, or no Status/Validation) →
    `orc pane prompt <T> --path <path> --text "Write your full report."`.
  - Read the report file. Follow-ups go through
    `orc pane prompt <T> --path <path> --text <t>` or `--file <f>` (max 2
    rounds; same `not-sent`/`prompted` statuses as `start`), then wait again.

Never answer approval or trust dialogs yourself. Claude workers inherit trust
from a trusted repo; Codex asks once per repo root and remembers it.

Review (`git -C <path> diff`) and merge (`orc wt merge`) as before. Cleanup:
after `status: merged` → `orc pane close <T> --path <path>`. An abandoned,
failed or re-planned task → `orc pane close <T> --path <path>` and
`orc wt remove <F> <T>`. Before finishing the dispatch, no `orc:*` panes or
task worktrees may remain.

Reports live in `<path>/.orc/report.md` (git-excluded); `start` and `prompt`
delete the old one first, so a report is always fresh. Codex workers have no
guard hook; their `workspace-write` sandbox blocks writes to the shared `.git`.
Claude workers run with `ORC_ROLE=implementer`, so the guard denies commits
and pushes, for their subagents too.

## Pair mode

Use when the session rules say pair mode is on. No dispatch and no task
worktrees: each implementer task runs as a Codex session in a pane split to the
right of yours, in the session checkout, one task at a time.

- **Start.** Write the brief file, then
  `orc pane start <F> <T> --here --path <checkout root> --brief <file> --kind codex`
  (`<checkout root>`: `git rev-parse --show-toplevel`). The new pane is
  labelled `orc:<T>`. `orc: close <label> first` means another worker pane is
  still open in this tab: close it before starting the next task.
  `not-sent` and `state: blocked` mean the same as above.
- **Wait** with `orc pane wait <T> --path <checkout root>` in background Bash
  and read the result and report as in step 4.
- **Review** the worker's uncommitted diff (`git diff`) and rerun its
  validation; follow-ups go through `orc pane prompt`.
- **Close** with `orc pane close <T> --path <checkout root>` once the task is
  accepted or abandoned. There is no merge step: the changes are already in
  the checkout; commit them through `shipper` as usual.
