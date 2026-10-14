# ADR-0007: cocoindex-code through the launchers

- Status: accepted
- Date: 2026-10-14

## Context

`ccc` (cocoindex-code, a Python CLI) gives `scoper` semantic search, but it was
set up by hand: install it, register a global MCP server, run `ccc init` in each
repo. A global `cocoindex-code` MCP server fails with `CONNECTION_CLOSED` in any
repo without `ccc init`, and repos indexed with an old config lack
`max_file_size`, so large files bloat the index. See the P0 findings
(`docs/research/p0-findings.md`, "cocoindex-code via the launchers").

## Decision

- Optional and default-on, never installed by orch (`uv tool install 'cocoindex-code[full]'`).
- `orch claude` and `orch codex` inject the `cocoindex-code` MCP server per run
  (`--mcp-config=<json>` on Claude, `-c mcp_servers.cocoindex-code.*` on Codex) only
  when `ORCH_CCC` is not `0`, `ccc` is on `PATH` and the git root holds
  `.cocoindex_code/settings.yml`. Only the git root counts; a stray parent index is
  never used. The Claude flag uses the `=` form because `--mcp-config` is variadic and
  would swallow the prompt.
- The same condition (`scripts/ccc.mjs`) gates the `Search` line of the injected rules.
- `orch ccc init [--force]` indexes the git root: `ccc init` (repos under 200 tracked
  files are refused without `--force`; use `rg`), adds `max_file_size: 256KB` when
  missing, then `ccc index`. Re-running on an initialised repo only fixes the size
  and re-indexes.
- `orch doctor` warns when `ccc` is missing; `orch update` runs
  `uv tool upgrade cocoindex-code` when `uv tool list` shows it.
- No plugin `.mcp.json`: plugin MCP servers would start in non-ORCH sessions and
  rename the tool.

## Consequences

- Plain `claude` sessions no longer get the MCP unless the user configures it.
- A repo indexed mid-session needs a restart to get the server.
- Users should remove their global `cocoindex-code` entries. In an indexed repo the
  injected server wins over them (P0 M4), but in a repo without an index they still
  start and fail with `CONNECTION_CLOSED`.
- `ORCH_CCC=0` turns the integration off for a run.
