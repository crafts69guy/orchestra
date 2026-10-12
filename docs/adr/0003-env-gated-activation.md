# ADR-0003: Activation through the ORCH=1 environment variable

- Status: accepted
- Date: 2026-10-12

## Context

The workflow is opt-in per session. Per-session plugin enabling differs by
harness (`--settings` on Claude, an unverified `-c` override on Codex).

## Decision

The plugin stays enabled globally. Hooks do nothing unless `ORCH=1` is set in
the environment that launched the harness. Shell wrappers (`cyl --wf`,
`cdx --wf`) set it.

## Consequences

- One mechanism for every harness, testable as a pure function.
- Agent definitions are visible in every session, so their descriptions start
  with `orch workflow:` and never say "use proactively".
