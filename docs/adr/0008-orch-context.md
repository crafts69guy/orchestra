# ADR-0008: `orch context`, a static audit of agent context

- Status: accepted
- Date: 2026-10-15

## Context

Every enabled skill, agent, command, memory file (CLAUDE.md / AGENTS.md) and
SessionStart hook adds to what a Claude Code or Codex session loads. With many
plugins and user skills the context grows, overlaps and drifts: duplicated
skills across scopes, over-broad descriptions that trigger everywhere, broken
`@imports`, project docs that Codex silently truncates. Claude Code's `/context`
and `/skill-doctor` only see a live Claude session. Nothing covers Codex,
compares scopes, or runs without starting a session.

## Decision

- A separate subcommand, `orch context [--scope user|project|all] [--json]`
  (logic in `scripts/context.mjs`), not a `doctor` flag: `doctor` checks
  prerequisites and fails hard, this is an audit that is mostly warnings.
- Static only: it reads files and configs for Claude and Codex at user scope,
  the current project (git root up to cwd) and enabled plugins. It never runs
  hook commands or MCP servers, so hook output and MCP tool lists are listed,
  not measured.
- Context is split into three tiers: always loaded (memory files and their
  imports), listing (name + description of skills, agents, commands) and
  on demand (skill bodies). Tokens are estimated as characters / 4. Manual-only
  skills (Claude `disable-model-invocation: true`, Codex `agents/openai.yaml`
  `allow_implicit_invocation: false`) are never listed to the model, so they are
  counted apart and skip the description checks.
- Findings use `doctor`'s `✓ / ! / ✗ … — fix:` lines plus `·` for info.
  Exit 1 only on `✗` (a broken import, Codex project docs over
  `project_doc_max_bytes`), else 0. It never throws and never edits config.
- Deferred: usage analysis from transcripts (dead skills), LLM-judged quality,
  exact token counts, `--fix`.

## Consequences

- Numbers are estimates of harness internals that change between versions;
  output says `~` and the thresholds are heuristics.
- Plugin layouts are read from `installed_plugins.json` (Claude) and
  `config.toml` + `plugins/cache` (Codex); a format change there shows as
  missing plugins, not a crash.
