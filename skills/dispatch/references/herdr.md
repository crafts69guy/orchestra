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
