# Dispatch with herdr pane workers

Use when the session rules say pane mode is on, or the user asks for it. Each
task runs as a real `claude` or `codex` session in a herdr pane inside its
worktree, visible to the user. Only steps 3 and 4 of the wave change.

- **3. Start** one worker per task:
  `orch pane start <F> <T> --path <path> [--kind claude|codex] [--brief <file>]`.
  Without `--brief` the worker reads task `<T>` of `.scratch/<F>/plan.md`; put
  anything else it needs (Decisions, `validate`) in a brief file. Then run one
  `orch pane wait <T> --path <path>` per task as a background command
  (Claude: Bash `run_in_background`) and continue when each one finishes.
- **4. Read** each wait result `{task, state, report, evidence}`:
  - `start` says `blocked` → tell the user which pane needs them; after they
    clear it, run the same `orch pane start …` again (it reuses the live agent
    and sends the prompt), then wait. `wait` says `blocked` → tell the user,
    then wait again. Never answer approval or trust dialogs yourself.
  - `state: timeout` → wait again, or look at the pane.
  - `evidence: false` (no report, or no Status/Validation) →
    `orch pane prompt <T> --text "Write your full report to <path>/.orch/report.md"`.
  - Read the report file. Follow-up fixes go through
    `orch pane prompt <T> --text <t>` or `--file <f>` (max 2 rounds), then
    wait again.

Review (`git -C <path> diff`) and merge (`orch wt merge`) as before. After
`status: merged`, run `orch pane close <T>`; it only closes panes in an
`orch:*` tab.

Reports live in `<path>/.orch/`, which `orch wt new` adds to
`.git/info/exclude`, so they never land in a commit.

Codex workers have no guard hook; their sandbox blocks writes to the shared
`.git`, so they cannot commit. Claude workers run with `ORCH_ROLE=implementer`,
so the guard hook denies commits and pushes as for a subagent.
