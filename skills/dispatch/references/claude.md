# Dispatch on Claude Code

- Agent names carry the plugin prefix: `orch:implementer`, `orch:scoper`,
  `orch:reviewer`, `orch:shipper`. The bare name is not found.
- Parallel spawn: several Agent tool calls in one assistant message.
- Do not set `isolation: "worktree"`; the worktree comes from `orch-wt new`.
- Resume an agent with SendMessage to its id or name; it keeps its context.
- Plugin hooks see `agent_type` as `orch:<role>` and enforce: implementers
  cannot commit or push; only the shipper pushes or opens PRs.
