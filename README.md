# Orchestra

Orchestra (plugin name `orch`) is a cross-harness orchestration workflow for Claude Code and
Codex. A main agent scopes, delegates, reviews and ships work through four specialised subagents
(`scoper`, `implementer`, `reviewer`, `shipper`), running independent tasks in parallel git
worktrees.

The rules are always-on but opt-in: they are injected at session start only when `ORCH=1`.

## Requirements

- Node.js 22.8 or newer (hooks and the CLI are plain Node scripts, zero runtime dependencies).
- [worktrunk](https://worktrunk.dev) (`brew install worktrunk`) for parallel dispatch. The
  session hook warns when `wt` is missing.
- Claude Code and/or Codex.
- Optional: [cocoindex-code](https://github.com/cocoindex-io/cocoindex-code) (`uv tool install 'cocoindex-code[full]'`)
  for semantic code search. orch never installs it.
- Claude Code: the `ponytail` plugin is declared as a dependency. Add its marketplace first:
  `/plugin marketplace add DietrichGebert/ponytail`.

## Install

Install the `orch` CLI, then let it check everything else:

```sh
npm i -g @crafts69guy/orchestra
orch doctor
```

`orch doctor` prints one line per check with a fix hint for each failure, and exits 1 if a
required check fails. Install the plugin for your harness as it suggests:

Claude Code:

```text
/plugin marketplace add crafts69guy/orchestra
/plugin install orch@orchestra
```

Codex:

```sh
codex plugin marketplace add crafts69guy/orchestra
codex plugin add orch@orchestra
```

## Usage

| Command | Does |
|---|---|
| `orch doctor` | checks Node, git, `wt`, the harness CLIs and the installed plugins |
| `orch context [--scope user\|project\|all] [--json]` | audits what Claude Code and Codex load into context (memory, skills, agents, plugins, MCP): token estimates and findings |
| `orch claude [--yolo] [--level high] [--panes] [args...]` | starts `claude` with `ORCH=1` and `--model opus` (unless you pass `--model`) |
| `orch codex [--yolo] [args...]` | starts `codex` with `ORCH=1` and the orchestration context (below) |
| `orch update` | updates the npm CLI, then the plugin for each harness that has the `orchestra` marketplace (`claude plugin update orch@orchestra`, `codex plugin marketplace upgrade orchestra`); skips npm from a git checkout |
| `orch ccc init [--force]` | indexes this repo with `ccc` for semantic search (repos under 200 files need `--force`) |
| `orch wt new\|merge\|list ...` | worktree helper used by the `dispatch` skill; prints JSON |
| `orch pane start\|wait\|prompt\|close ...` | herdr pane workers for the `dispatch` skill (pane mode, below); prints JSON |
| `orch eval [args...]` | behaviour evals; only from a git checkout (see [AGENTS.md](AGENTS.md)) |
| `orch --help`, `orch --version` | usage and version |

`--yolo` turns off permission prompts for that run (`--dangerously-skip-permissions` on Claude,
`--dangerously-bypass-approvals-and-sandbox` on Codex). Without it the harness keeps its normal
permission model. Other arguments pass through to the harness, and so does its exit code.

`orch claude` only sets `ORCH=1`; `ORCH=1 claude` works too. Without `ORCH=1` the hooks exit
silently and the session is untouched.

The handoff brief to `implementer` includes a Docs/JSDoc acceptance criterion (new or changed exports
carry JSDoc, touched docs are updated). `ORCH_DOCS=0` turns it off; any other value keeps it on.

When `ccc` is on `PATH` and the repo's git root is indexed (`orch ccc init`), `orch claude` and
`orch codex` add the `cocoindex-code` MCP server for that run. `ORCH_CCC=0` turns it off; any other
value keeps it on. A repo indexed mid-session needs a restart.

`orch claude --level high` (or `ORCH_LEVEL=high`) raises the subagent models for that session, Claude
Code only: `implementer` runs on opus, `scoper` and `shipper` on sonnet, `reviewer` is unchanged, and
so is the orchestrator's own model. `--level default` (or no flag) keeps the agents' own models.

`orch claude --panes` (or `ORCH_PANES=1`) turns on pane mode when the session runs inside
[herdr](https://herdr.dev) (`HERDR_ENV=1`): `dispatch` runs each implementer as a real `claude` or
`codex` session in a herdr pane of an `orch:<feature>` tab, inside its worktree, so you can watch
and step into each one. Workers write their report to `<worktree>/.orch/report.md` (git-excluded).
Outside herdr the flag has no effect. See [ADR-0009](docs/adr/0009-herdr-pane-workers.md).

## Codex

Codex does not trust project agents or plugin hooks by default, so `orch codex` runs `codex`
with `ORCH=1` and prepends, per run and without touching `~/.codex`:

- `-c developer_instructions=...`: the same context the SessionStart hook injects (rules, the
  absolute path of `orch`, `wt` warning).
- `-c agents.<name>.config_file=...` and `.description=...` for each `codex/agents/*.toml`.
- `--add-dir <git common dir>` inside a git repo, because `workspace-write` blocks `.git` and
  worktrees and commits need it.

It exits 1 if the rules file is missing and 127 if `codex` is not on `PATH`.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Research notes](docs/research/)
- [Contributing and dev commands](AGENTS.md)

## License

MIT
