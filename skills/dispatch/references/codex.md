# Dispatch on Codex

- Agent names are bare: `implementer`, `scoper`, `reviewer`, `shipper`. They
  are loaded from the plugin's `codex/agents/*.toml` by the `orch codex`
  launcher (`-c agents.<name>.config_file=…`). An unknown name silently falls
  back to the default agent, so confirm the role in its first reply.
- Spawn each task with `spawn_agent` (`agent_type`, no forked turns), all
  before waiting, then `wait_agent` on every id.
- The sandbox must allow writing `<repo>/.git` (`--add-dir <repo>/.git`) or
  `orch wt new` and commits fail. `orch codex` adds it.
- Hooks only run when the user trusted them, so restate "do not commit or
  push" in every brief.
