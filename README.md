# Orchestra

Orchestra (plugin name `orch`) is a cross-harness orchestration workflow for Claude Code and
Codex. A main agent scopes, delegates, reviews and ships work through four specialised subagents
(`scoper`, `implementer`, `reviewer`, `shipper`), running independent tasks in parallel git
worktrees.

The rules are always-on but opt-in: they are injected at session start only when `ORCH=1`.

## Requirements

- Node.js 22.8 or newer (hooks run as plain Node scripts, zero runtime dependencies).
- [worktrunk](https://worktrunk.dev) (`brew install worktrunk`) for parallel dispatch. The
  session hook warns when `wt` is missing.
- Claude Code: the `ponytail` plugin is declared as a dependency. Add its marketplace first:
  `/plugin marketplace add DietrichGebert/ponytail`.

## Install

Claude Code:

```text
/plugin marketplace add crafts69guy/orchestra
/plugin install orch@orchestra
```

Codex:

```sh
codex plugin marketplace add crafts69guy/orchestra
```

## Activate

Start the harness with `ORCH=1` to inject the orchestration rules:

```sh
ORCH=1 claude
```

Without `ORCH=1` the hook exits silently and the session is untouched.

## Codex

Codex does not trust project agents or plugin hooks by default, so launch it through the wrapper:

```sh
bin/orch-codex [codex args...]
```

It runs `codex` with `ORCH=1` and prepends, per run and without touching `~/.codex`:

- `-c developer_instructions=...`: the same context the SessionStart hook injects (rules, helper
  path, `wt` warning).
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
