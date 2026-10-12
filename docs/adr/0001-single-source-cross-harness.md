# ADR-0001: One repository, canonical content, thin per-harness adapters

- Status: accepted
- Date: 2026-10-12

## Context

The workflow must run on Claude Code and Codex CLI now, and opencode later.
Codex reads Claude plugin manifests, the same `SKILL.md` format and the same
hook output contract, but its plugins cannot ship agents and it has no
per-agent tool allowlist ([research](../research/codex-cross-harness.md)).

## Decision

- `agents/*.md` (Claude format), `rules/`, `skills/` and `hooks/` are canonical.
- Claude Code consumes them directly through `.claude-plugin/`.
- Codex consumes skills and hooks directly through `.codex-plugin/`; agents are
  generated into `codex/agents/*.toml`, committed, and loaded per session by
  the launcher with `-c agents.<name>.config_file=<path>` (verified in P0 C1;
  no install step, no project trust needed).
- CI fails when generated files are stale.

## Consequences

- A new harness is one manifest plus, at most, one generator.
- Role prompts cannot use harness-specific features in their body; harness
  differences live in `skills/dispatch/references/`.
- Codex sessions must be started through a launcher that passes the agent
  config files; an unknown agent name silently falls back to the default agent.
