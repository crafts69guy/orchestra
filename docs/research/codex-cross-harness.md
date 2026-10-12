# One repo, two harnesses: Claude Code + Codex CLI (opencode later)

Research date: 2026-10-12. Local Codex CLI checked: `codex-cli 0.162.1`.
Legend: **[V]** verified (official docs / source code / local CLI) · **[U]** unverified or inferred.

Note: `developers.openai.com/codex/*` now 308-redirects to `learn.chatgpt.com/docs/*`.

---

## 1. Codex CLI extensibility today

### 1.1 Plugins

- **Manifest discovery** [V, source]: Codex looks for, in order,
  `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`
  (`DISCOVERABLE_PLUGIN_MANIFEST_PATHS`, `codex-rs/exec-server-protocol/src/protocol.rs`).
  It also accepts a portable root `plugin.json` that declares
  `$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` (the "Agent Plugins" spec:
  skills + MCP only). Source: `codex-rs/utils/plugins/src/plugin_namespace.rs`,
  `codex-rs/core-plugins/src/agent_plugin_manifest.rs`.
  → **A Claude plugin with only `.claude-plugin/plugin.json` can load in Codex.** You still want a
  `.codex-plugin/plugin.json` for `interface` metadata and a Codex-specific `hooks` path.
- **Manifest fields Codex parses** [V, `codex-rs/core-plugins/src/manifest.rs`]: `name`, `version`,
  `description`, `keywords`, `skills` (path or paths), `mcpServers` (path or inline), `apps`,
  `hooks` (path, paths, inline, inline list), `interface{displayName, shortDescription,
  longDescription, developerName, category, capabilities, websiteURL, privacyPolicyURL,
  termsOfServiceURL, defaultPrompt, brandColor, composerIcon, logo, logoDark, screenshots}`,
  `extensions`, and `commands` (read only for command migration).
  **There is no `agents` field and no `dependencies` field.**
- **Commands become skills** [V, source]: when a plugin is installed, Codex converts `commands/*.md`
  (or the `commands` manifest paths) into skills under `.codex-plugin/<migrated>/`. The command needs
  `description` frontmatter and must be at most 4,000 bytes. The conversion rewrites wording toward
  AGENTS.md. Plugins in the portable Agent Plugins format skip this step
  (`core-plugins/src/store.rs` L644, `command_migration/plugin.rs`).
- **Marketplace** [V, docs + local ponytail]: `.agents/plugins/marketplace.json` in a repo, or
  `~/.agents/plugins/marketplace.json` for a user. The legacy `.claude-plugin/marketplace.json` is
  also read. Each entry has `name`, `source` (`local` with a `./path`, `url`, `git-subdir`, or `npm`),
  `policy.installation` (`AVAILABLE`, `INSTALLED_BY_DEFAULT`, or `NOT_AVAILABLE`),
  `policy.authentication`, and `category`.
  Docs: https://developers.openai.com/codex/plugins/build
- **Install** [V, local CLI]:
  `codex plugin marketplace add owner/repo[@ref]`, then `codex plugin add <plugin>@<marketplace>`.
  Related commands: `codex plugin list|remove` and `codex plugin marketplace list|upgrade|remove`.
  Inside the TUI, use `/plugins`. Codex copies the plugin source into
  `~/.codex/plugins/cache/<mkt>/<plugin>/<ver>/`. Per-project enablement uses
  `[plugins."name@mkt"] enabled = true` in config.
- **Official directory caveat** [V, docs]: "Lifecycle hooks apply only to plugins installed manually …
  those plugins aren't eligible for the public directory." For this reason superpowers' Codex
  manifest sets `"hooks": {}`, which suppresses `hooks/hooks.json` auto-discovery.

### 1.2 Skills

- [V] https://learn.chatgpt.com/docs/build-skills
  - Format: `SKILL.md` with `name` and `description` frontmatter. A skill folder can also hold
    `scripts/`, `references/`, `assets/`, and an optional `agents/openai.yaml` with
    `interface{display_name,…}`, `policy.allow_implicit_invocation` (default true), and
    `dependencies.tools` (MCP).
  - Locations: `$CWD/.agents/skills`, `$REPO_ROOT/.agents/skills`, `~/.agents/skills`,
    `/etc/codex/skills`, bundled skills, and plugin `skills/`. Symlinked skill folders are followed.
    This machine also has a legacy `~/.codex/skills` directory.
  - Invocation: `$skill-name`, the `/skills` picker, or implicit matching on the description.
  - Disable a skill with `[[skills.config]] path=… enabled=false`.
- Custom prompts (`~/.codex/prompts/*.md`, run as `/prompts:name`) are **deprecated** in favor of
  skills, and they cannot be scoped to a project [V]: https://learn.chatgpt.com/docs/custom-prompts
  → **Codex has no plugin-provided slash commands.** Skills (invoked with `$name`) replace them.

### 1.3 Custom subagents / agent roles

- [V] https://learn.chatgpt.com/docs/agent-configuration/subagents
  - Files: one TOML per agent, in `~/.codex/agents/*.toml` (personal) or `.codex/agents/*.toml`
    (project).
  - Required keys: `name`, `description`, `developer_instructions`.
  - Optional keys: any config.toml key, such as `model`, `model_reasoning_effort`, `sandbox_mode`,
    `mcp_servers`, `skills.config`.
  - Built-in agents: `default`, `worker`, `explorer`. A custom agent with the same name overrides
    the built-in.
  - Global `[agents]` keys: `enabled`, `max_concurrent_threads_per_session` (legacy alias
    `max_threads`), `default_subagent_model`, `default_subagent_reasoning_effort`,
    `interrupt_message`.
  - Legacy format still seen in the wild (ECC): `[agents.<role>] description=…`,
    `config_file="agents/x.toml"`, plus `max_depth` [U: support status].
- **Plugins cannot ship agents** [V]. Codex's manifest has no `agents` key, and the loader never
  reads one. The Vercel Codex plugin carries `agents/*.md` (a Claude leftover) that Codex appears to
  ignore [U].
  → Agents must be installed into `~/.codex/agents/` or `.codex/agents/` by an installer script,
  a skill, or the user.
- **Built-in Claude-to-Codex agent converter** [V, source; trigger UX U]:
  `codex-rs/external-agent-migration/src/subagents.rs` turns `.claude/agents/*.md` into TOML:
  - `name` and `description` are copied.
  - `effort` becomes `model_reasoning_effort` (`max` maps to `xhigh`).
  - `permissionMode` becomes `sandbox_mode` (`acceptEdits` maps to `workspace-write`, `readOnly`
    maps to `read-only`).
  - The body becomes `developer_instructions`.
  - `model` and `tools` are dropped.
  This is exactly the mapping our generator should use.
- **Spawning** [V, from strings in the local 0.162.1 binary]:
  - Tools: `spawn_agent` (`agent_type`, `fork_turns` none|all, `model`, `reasoning_effort`),
    `wait_agent`, `send_input` / `followup_task`, `list_agents`, `resume_agent`, and `close_agent`
    (V1 only).
  - Feature flag `multi_agent` is stable and on. `multi_agent_v2` is stable but off by default.
  - The system prompt says: *"Do not spawn sub-agents unless the user or applicable AGENTS.md/skill
    instructions explicitly ask for sub-agents, delegation, or parallel agent work."*
    → **Orchestration rules must explicitly authorize spawning.**
  - A spawned agent has *"the same tools as you and the ability to spawn its own subagents."*
  - Subagents run in parallel and in the background, capped by
    `max_concurrent_threads_per_session`. Use `/agent` to switch between threads.
- **Per-subagent model**: set `model` and `model_reasoning_effort` in the agent TOML, or pass them
  at spawn time. Resolution order: agent file > spawn arg > `[agents]` default > parent.
  Superpowers warns that setting `model` without effort resets effort to the model's default.
  Source: https://github.com/obra/superpowers/blob/main/skills/using-superpowers/references/codex-tools.md
- **Per-subagent tool restriction: none.** Only `sandbox_mode` (read-only or workspace-write),
  `mcp_servers`, and `skills.config` can differ per agent [V]. Subagents inherit the parent's
  sandbox and live overrides such as `--yolo`.

### 1.4 Hooks

- [V] https://learn.chatgpt.com/docs/hooks
  - Events: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`,
    `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `Stop`,
    `Interrupt`.
  - Where hooks are configured:
    - `hooks.json` or `[hooks]` in `~/.codex/` or `<repo>/.codex/` (the project layer must be
      trusted).
    - In a plugin: `hooks/hooks.json` by default, or the manifest `hooks` field.
  - Output and context injection:
    - `hookSpecificOutput.additionalContext` works on SessionStart, UserPromptSubmit,
      SubagentStart, PreToolUse, and PostToolUse. Plain stdout also counts as context for
      SessionStart, UserPromptSubmit, and SubagentStart.
    - **`SubagentStart` context reaches the subagent**, and the matcher filters on agent type.
    - Avoid `systemMessage`, which renders as a yellow warning (ponytail #605).
  - Trust: every non-managed hook needs review in `/hooks` and is pinned by hash. A changed hook is
    skipped until trusted again. `--dangerously-bypass-hook-trust` skips the check.
  - Plugin hook env: `PLUGIN_ROOT` and `PLUGIN_DATA`, **plus `CLAUDE_PLUGIN_ROOT` and
    `CLAUDE_PLUGIN_DATA`** for compatibility.
    → **One `hooks.json` that uses `${CLAUDE_PLUGIN_ROOT}` can serve both harnesses.**

### 1.5 AGENTS.md

- [V] https://learn.chatgpt.com/docs/agent-configuration/agents-md
  - Global file: `~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md`.
  - Project files: from the git root down to the cwd, one file per directory (`AGENTS.override.md`
    > `AGENTS.md` > `project_doc_fallback_filenames`). Files are concatenated root-first and capped
    at `project_doc_max_bytes` (default 32 KiB).
  - **Plugins cannot contribute AGENTS.md** (not documented) [U → treat as no].
- Claude Code now reads `AGENTS.md` when no `CLAUDE.md` exists [V]: https://code.claude.com/docs/en/memory

### 1.6 MCP, flags, worktrees

- MCP: `[mcp_servers.<name>]` in config.toml, or `codex mcp add`. In a plugin: `.mcp.json` at the
  root, or the manifest `mcpServers` field [V].
- Flags [V, `codex --help`]:
  - `-c key=value` (the value is parsed as TOML).
  - `--enable` / `--disable <feature>`.
  - `-p/--profile <name>`, which now layers `$CODEX_HOME/<name>.config.toml` (profile v2).
  - `-m`, `-s`, `-C`, `--add-dir`, `--worktree`.
  - `codex exec --json --output-schema`.
- **Worktrees** [V, local CLI]: `--worktree` ("Run the session in a new managed Git worktree") is
  session-level. Feature `worktrees` is stable.
  - **No per-subagent worktree isolation** like Claude's `isolation: worktree` [V: absent from the
    docs and spawn params].
  - Dispatch must run `git worktree add` itself and tell each child to work in its path.
  - Keep worktrees inside a writable root (for example a gitignored `<repo>/.worktrees/`) or pass
    `--add-dir`.
  - [U] It is not verified whether workspace-write lets the sandbox write `.git/worktrees`.
    Test before relying on it.

---

## 2. Parity matrix

| Capability | Claude Code | Codex CLI 0.162 | Design note |
|---|---|---|---|
| Subagent definition | `agents/*.md` with frontmatter; plugins can ship them | `.codex/agents/*.toml` (`name`, `description`, `developer_instructions`); **plugins can't ship them** | Generate TOML from the md source and install it with a script or skill |
| Parallel spawn | `Agent` tool, background, cap 20 (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), nesting depth 3 | `spawn_agent` + `wait_agent`, parallel, `max_concurrent_threads_per_session`; spawns only when instructions ask | Rules must say "spawn subagents" explicitly |
| Worktree isolation | `isolation: worktree` frontmatter (temp worktree, auto-cleanup) | Session-level `--worktree` only | Dispatch skill creates worktrees itself on both harnesses |
| Session-start context | `SessionStart` → `hookSpecificOutput.additionalContext`; `SubagentStart` likewise | Same events and shape; hooks need `/hooks` trust; none in official-directory plugins | Shared hook script; AGENTS.md or a skill as fallback |
| Skills | `skills/<n>/SKILL.md` in plugins, `.claude/skills` | Plugin `skills/`, `.agents/skills`, `~/.agents/skills` | Same files verbatim |
| Slash commands | `commands/*.md` or skills (`/plugin:name`) | None for plugins; commands auto-migrate to skills (`$name`); custom prompts deprecated | Write skills, not commands |
| Per-subagent model | `model`, `effort` | `model`, `model_reasoning_effort` in TOML or spawn args | Map model aliases per harness |
| Per-subagent tools | `tools`, `disallowedTools` (plugin agents can't set `hooks`, `mcpServers`, `permissionMode`) | No tool allowlist; only `sandbox_mode`, `mcp_servers`, `skills.config` | Reviewer/scoper read-only = `sandbox_mode="read-only"` |
| Plugin dependencies | `dependencies: ["name@mkt"]` | None | Document as a manual install step |
| Always-on rules | Hooks (plugins can't ship CLAUDE.md; root CLAUDE.md is ignored) | Hooks, or the user's or repo's AGENTS.md | Hook-inject the same `rules.md` |

Claude references: https://code.claude.com/docs/en/plugins-reference ·
https://code.claude.com/docs/en/sub-agents

---

## 3. Real cross-harness repos

### 3.1 ponytail (local: `~/.claude/plugins/marketplaces/ponytail`, v4.13.0; Codex cache has 5.1.0)

- **Manifests**: `.claude-plugin/{plugin,marketplace}.json`, `.codex-plugin/plugin.json`, and
  `.agents/plugins/marketplace.json` (`source: url` pointing at the git repo). It also ships:
  - manifests for other hosts: `gemini-extension.json` (`contextFileName: AGENTS.md`),
    `opencode.json`, `plugin.yaml` (Hermes), `.qoder-plugin`, `.kimi-plugin`, and others;
  - rule files for rule-only hosts: `.cursor/`, `.windsurf/`, `.clinerules/`, `.kiro/`.
- **Single source of truth = `skills/ponytail/SKILL.md`.**
  `hooks/ponytail-instructions.js` reads that SKILL.md at runtime, strips the frontmatter, and
  filters it by mode. Every adapter calls this one builder:
  - the Claude and Codex hooks;
  - the opencode plugin (`.opencode/plugins/ponytail.mjs` requires `../../hooks/...`);
  - the pi extension.
- **One hooks file for Claude and Codex**: `hooks/claude-codex-hooks.json` covers SessionStart,
  SubagentStart, and UserPromptSubmit, and both manifests point `hooks` at it. The command is
  `node -e "require(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'hooks/…'))"`, which works because
  Codex exports `CLAUDE_PLUGIN_ROOT`.
- **Host detection inside the script** (`hooks/ponytail-runtime.js`): Codex is detected when
  `PLUGIN_DATA` is set. The output is shaped per host; on Codex that means `hookSpecificOutput`
  with no `systemMessage`.
- Separate hooks files exist only for hosts whose schema differs (`cursor-hooks.json`,
  `copilot-hooks.json`, `qoder-hooks.json`).
- Commands are duplicated per host format (`commands/*.toml`, `.opencode/command/*.md`), and a
  test suite (`tests/*-plugin.test.js`) checks the copies stay consistent. There is no build step.

### 3.2 openai-codex (local: `~/.claude/plugins/marketplaces/openai-codex`, v1.0.6)

- A Claude-only plugin that *drives* Codex. It does not target both harnesses.
- Layout: `plugins/codex/{agents/codex-rescue.md, commands/*.md, skills/*, hooks/hooks.json,
  scripts/codex-companion.mjs}`.
- The agent is a thin forwarder: `model: sonnet`, `tools: Bash`, and it preloads skills through the
  `skills:` frontmatter.
- The runtime spawns `codex app-server` (JSON-RPC over stdio, `scripts/lib/app-server.mjs`) behind
  a broker.
- Useful pattern: a **cross-model reviewer**, where the Claude orchestrator delegates to Codex
  through `codex exec`/app-server. It is not a portability pattern.

### 3.3 obra/superpowers (v7.0.0, pushed 2026-10-10)

https://github.com/obra/superpowers

- **Skills are the only canonical content.** There is **no `agents/` directory**. Implementer and
  reviewer "agents" are *prompt templates inside skills*, such as
  `skills/subagent-driven-development/{implementer-prompt.md, task-reviewer-prompt.md}`.
  The orchestrator spawns a generic subagent with that prompt, which avoids per-harness agent
  formats entirely.
- **Skills name actions, not tools.** Per-harness tool mapping lives in
  `skills/using-superpowers/references/<harness>-tools.md`. `codex-tools.md` maps:
  - *dispatch* → `spawn_agent{fork_turns:"none", agent_type, model, reasoning_effort}`;
  - waiting → `wait_agent`, with 5–10 minute timeouts;
  - follow-ups → `followup_task`;
  - worktrees → detect `GIT_DIR != GIT_COMMON`.
- **Bootstrap = the whole integration.** On Claude, the SessionStart hook injects
  `using-superpowers`. On Codex, the manifest sets `"hooks": {}` (no hook) and relies on native
  skill discovery, because it ships through the official `openai/plugins` directory, which allows
  no hooks.
- Codex distribution is a fork sync: `scripts/sync-to-codex-plugin.sh` rsyncs the repo into
  `prime-radiant-inc/openai-codex-plugins`.
- Porting guide: `docs/porting-to-a-new-harness.md`. For opencode, `.opencode/plugins/superpowers.js`
  injects the bootstrap into the system prompt.

### 3.4 affaan-m/everything-claude-code (ECC)

https://github.com/affaan-m/everything-claude-code

- Claude side: `agents/*.md` (many agents) and `skills/`.
- Codex side:
  - `.codex-plugin/plugin.json` with `skills`, `mcpServers: ./.mcp.json`, and
    `hooks: ./hooks/codex-hooks.json`.
  - A **separate Codex hooks projection**, kept apart because some Claude hooks block tools, run
    async, or use events Codex lacks.
  - **Hand-written `.codex/agents/*.toml`** for only three roles. They are wired through legacy
    `[agents.<role>] config_file=` entries in `.codex/config.toml` and copied by the installer,
    since plugins can't ship agents.
- It also ships `.agents/skills/*/agents/openai.yaml` and a TypeScript opencode package under
  `.opencode/`.

---

## 4. Recommended layout

```
repo/
├── .claude-plugin/plugin.json        # name, version, hooks: ./hooks/hooks.json, dependencies (Claude only)
├── .claude-plugin/marketplace.json   # Claude marketplace (Codex also reads this as legacy)
├── .codex-plugin/plugin.json         # interface{} + skills: ./skills/ + hooks: ./hooks/hooks.json
├── .agents/plugins/marketplace.json  # Codex marketplace (source: local "./" or url)
├── rules/orchestrator.md             # CANONICAL always-on orchestration rules (harness-neutral prose)
├── agents/                           # CANONICAL + Claude-native: implementer|scoper|reviewer|shipper.md
├── skills/
│   ├── dispatch/SKILL.md             # harness-neutral; names actions, not tools
│   │   └── references/{claude-code,codex}.md   # tool mapping (Agent vs spawn_agent/wait_agent)
│   └── install-codex-agents/SKILL.md # optional: copies dist/codex/agents/*.toml → ~/.codex/agents
├── hooks/
│   ├── hooks.json                    # SessionStart + SubagentStart, uses ${CLAUDE_PLUGIN_ROOT}
│   └── inject.mjs                    # reads rules/orchestrator.md; emits hookSpecificOutput.additionalContext
├── dist/codex/agents/*.toml          # GENERATED from agents/*.md (committed; CI checks no diff)
├── scripts/gen-codex-agents.mjs      # ~50 LOC md-frontmatter → TOML
└── AGENTS.md                         # thin: points at rules/orchestrator.md for repo contributors
```

### Rules

- **The canonical source is Markdown.** `agents/*.md` (Claude format) and `rules/orchestrator.md`.
  Claude consumes `agents/` directly.
- **Generate only Codex agent TOML.** It is the one place the formats really diverge, and
  symlinks can't convert md to TOML. Mapping (same as Codex's own migrator):
  - `name` → `name`; `description` → `description`; body → `developer_instructions`;
  - `effort` → `model_reasoning_effort`;
  - read-only `tools` (no Write/Edit) → `sandbox_mode = "read-only"`, otherwise
    `"workspace-write"`;
  - `model`: a per-harness alias table in frontmatter, e.g. `codex-model: gpt-6-luna`, or omit it
    and inherit.
  - Commit the output, and have CI run `gen --check`.
- **Everything else is shared verbatim, with no build step.**
  - `skills/` is read by both harnesses, and opencode reads `.agents/skills` or `.claude/skills`
    too.
  - `hooks/hooks.json` is shared because Codex exports `CLAUDE_PLUGIN_ROOT` and uses the same
    event and JSON shapes. Detect Codex by `PLUGIN_DATA` (or the absence of `CLAUDE_PROJECT_DIR`)
    only if output must differ, e.g. to drop `systemMessage`.
- **No commands.** Ship skills only: `/plugin:dispatch` on Claude, `$dispatch` on Codex.
- **Write the dispatch skill harness-neutrally** (superpowers style):
  - "Create a worktree per task with `git worktree add .worktrees/<task> -b <branch>`; spawn one
    implementer subagent per task in parallel, instructing it to work only in that path; wait for
    all; then review."
  - On Claude you *may* set `isolation: worktree` on implementer, but explicit worktrees behave the
    same on both and keep branch names predictable.
- **Always-on rules.**
  - SessionStart injects `rules/orchestrator.md` on both harnesses, and SubagentStart (matcher on
    agent type) injects role reminders.
  - Fallback when Codex hooks are untrusted or the plugin sits in the official directory: the
    dispatch skill body restates the core rules, and the README tells users to add one line to
    `AGENTS.md`.
  - The rules **must explicitly authorize spawning**, or Codex won't delegate.
- **opencode later.** Add `.opencode/agents/*.md`, generated with `mode: subagent` and a
  `permission:` block, and a small `.opencode/plugins/x.mjs` that injects `rules/orchestrator.md`
  into the system prompt (the ponytail and superpowers pattern). Skills work unchanged.

### Codex gaps to design around

1. Plugins can't ship agents. They need an install step (a script or skill writing to
   `~/.codex/agents` or `.codex/agents`), or use superpowers' trick: no named agents, generic
   `spawn_agent` + prompt templates in the skill + `model`/`reasoning_effort` at spawn time.
   **Simplest path: the prompt-template approach for Codex, named agents for Claude.**
2. No per-subagent tool allowlist. Only `sandbox_mode`. The shipper's "git only" limit must be
   prose, or a `PreToolUse` deny hook.
3. No per-subagent worktree isolation. The skill must manage worktrees itself; check sandbox write
   access to `.git` [U].
4. No plugin dependencies.
5. No plugin slash commands (commands are auto-converted to skills, ≤4 KB).
6. Hooks need manual `/hooks` trust and are excluded from the official directory, so never make
   hooks the only carrier of critical rules.
7. Subagents don't spawn unless instructions explicitly say so.
8. Plugins can't contribute AGENTS.md.
9. There is no `CLAUDE_PROJECT_DIR` equivalent in Codex hooks [U]; use the `cwd` field from stdin.
