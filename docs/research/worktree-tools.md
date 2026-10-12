# Worktree tooling for parallel AI agents: survey and recommendation

Date: 2026-10-12. Repo stats come from the GitHub API on that date. "Last push" is `pushed_at`.

Context: one developer using fish, tmux/herdr, Neovim, Claude Code and Codex CLI. The current setup is
`cyw` (`.config/fish/functions/cyw.fish`), which creates `../wt/<branch>` from `production`. The goal is
an orchestrator agent that starts N implementer agents, each in its own worktree, then reviews their
work and merges it back into one feature branch. The orchestrator must be callable non-interactively
through Bash.

---

## 1. Inventory

| Tool | Exists / status | License | Stars | Last push / release | Form | Agents |
|---|---|---|---|---|---|---|
| **worktrunk** (max-sixty) | Active, very fast cadence | MIT OR Apache-2.0 | 9.2k | 2026-10-11 / v0.80.0 (2026-09-27) | CLI (Rust, `wt`) | Agnostic. Claude and Codex plugins |
| **git-worktree-runner / gtr** (coderabbitai) | Active | Apache-2.0 | 1.8k | 2026-09-15 / v2.11.1 | CLI (Bash, `git gtr`) | Agnostic, with adapters for claude, codex, gemini, aider, and others |
| **claude-squad** (smtg-ai) | Maintained, slower | **AGPL-3.0** | 8.6k | 2026-08-20 / v1.0.20 | TUI (Go, `cs`) on tmux | Claude default. `-p codex` and others work |
| **crystal** (stravu) | **Deprecated Feb 2026**, renamed Nimbalyst | MIT | 3.1k | 2026-02-26 / v0.3.5 | Electron GUI | Claude and Codex |
| ↳ Nimbalyst | Active | MIT | 1.9k | 2026-10-11 | Electron GUI | Claude, Codex, OpenCode |
| **vibe-kanban** (BloopAI) | **Sunsetting**. Bloop shut down 2026-04-10; the project is now "community maintained" | Apache-2.0 | 28.3k | 2026-09-19 | Web GUI (`npx`) + MCP | 10+ agents including Codex |
| **uzi** (devflowinc) | **Abandoned** (no push since 2025-06) | MIT | 0.6k | 2025-06-04 / v0.0.2 | CLI on tmux | claude, codex |
| **ccmanager** (kbwo) | Active | MIT | 1.3k | 2026-10-10 / v4.4.6 | TUI (Node), no tmux | Claude, Codex, Gemini, Cursor, Copilot, OpenCode, and more |
| **container-use** (dagger) | Experimental, slowing (last release 2025-08) | Apache-2.0 | 4.1k | 2026-09-21 / v0.4.2 | MCP server + CLI (`cu`) | Any MCP agent |
| **gwq** (d-kuro) | Active | Apache-2.0 | 0.5k | 2026-10-02 / v0.1.2 | CLI (Go) + fzf | Agnostic (plain worktree manager) |
| **sculptor** (imbue-ai) | Active, "research preview" | MIT | 0.2k | 2026-10-11 / v0.48.0 | Desktop GUI | Claude Code, Pi, any terminal agent |
| **Conductor** (Melty Labs) | Active, **closed source**. The `meltylabs/conductor-releases` repo holds binaries only, no license | Proprietary (free app) | – | – | macOS GUI (+ cloud) | Claude, Codex, Cursor |
| **workmux** (raine) | Active | MIT | 2.8k | 2026-10-11 | CLI on tmux (also zellij, kitty, WezTerm) | claude, codex, gemini, opencode, and others |
| agent-of-empires | Active | MIT | 3.3k | 2026-10-11 | TUI + web | Claude, OpenCode, and others |
| agent-deck | Active | MIT | 1.1k | 2026-10-11 | TUI session manager | Claude, Codex, Gemini, and others |
| emdash (YC W26) | Active | Apache-2.0 | 6.0k | 2026-10-10 | Desktop GUI | Many |
| Superset | Active | "Other" (not OSI) | 15.1k | 2026-10-12 | Desktop IDE | Many |
| cmux (manaflow) | Active | "Other" | 28.1k | 2026-10-12 | Ghostty-based terminal app | Any (terminal, not worktree-centric) |
| wtp / git-wt | wtp stale since 2026-03. git-wt active | MIT | 0.6k / 0.6k | – | Minimal worktree CLIs | Agnostic |

Drop for this use case: crystal (deprecated), uzi (dead), vibe-kanban (company gone; GUI/web), Conductor
(closed, GUI), Superset/emdash/Nimbalyst/sculptor (GUI apps an agent cannot drive through Bash).

---

## 2. Detailed evaluation of the relevant candidates

Criteria: (a) create/remove, (b) dependency bootstrap, (c) merge/rebase + conflicts, (d) cleanup,
(e) scriptable from a non-interactive agent, (f) tmux.

### worktrunk (`wt`), the strongest CLI
- **(a)** `wt switch -c <branch> [-x <cmd> -- args]` creates a branch and worktree from a path template
  (default `../repo.<branch>`) and can launch an agent: `wt switch -x codex -c feat-a -- '<task>'`.
  `wt remove` deletes the worktree and branch.
- **(b)** Hooks: `pre-start` (blocking) and `post-start` (background), plus pre/post for switch, commit,
  merge, and remove. Project hooks go in `.config/wt.toml` and user hooks in
  `~/.config/worktrunk/config.toml`. `wt step copy-ignored` copies gitignored files from the primary
  worktree **with reflink/copy-on-write on APFS**, Btrfs, and XFS. The docs' example: a 14 GB `target/`
  in about 20 s versus about 2 min for `cp -R`. It honours `.worktreeinclude` when present and skips
  files that already exist. `hash_port` gives each branch a stable dev-server port, and
  `wt step tether` kills the dev server when its worktree is removed.
- **(c)** `wt merge [target]` runs commit → squash (on by default, LLM commit message) → rebase onto the
  target → `pre-merge` hooks (tests) → fast-forward → remove. **The target can be any local branch**, for
  example `wt merge feature-x`. It does not fetch. `--no-squash`, `--no-remove`, `--no-ff`, and
  `--branch <name>` (merge another worktree's branch without leaving the current one) are available.
  **On a rebase conflict it stops and leaves the rebase open in the worktree**, so you resolve or abort
  it yourself.
- **(d)** `wt remove`. `wt step prune` removes worktrees already merged into the default branch.
  Removal after a merge runs in the background.
- **(e)** Good. `--yes` skips approval prompts and `--no-hooks` skips hooks. `wt list --format=json` gives
  machine-readable status. The `cd` behaviour needs shell integration, but an agent passes paths and
  `-x`, so it does not need it. Caveat: project hooks need approval, so a non-interactive call either
  pre-approves them (`wt config approvals add`) or passes `--yes`. `--yes` auto-approves repository code.
- **(f)** No built-in tmux mode. The docs give recipes: a `pre-start` hook that builds a tmux session, a
  `pre-remove` hook that kills it, and `tmux new-session -d -s X "wt switch -c X -x claude -- '<task>'"`.
- **Claude/Codex extras:** `wt config plugins claude install` provides a skill, 🤖/💬 activity markers in
  `wt list`, a statusline, and **`WorktreeCreate`/`WorktreeRemove` hooks that route Claude's native
  worktrees (including `isolation: worktree` subagents) through `wt`**. The Codex plugin provides
  activity markers only.

### git-worktree-runner (`git gtr`), the best agent contract, but no merge
- **(a)** `git gtr new <branch> [--from <ref> | --from-current]` and `git gtr rm <branch> [--delete-branch]`.
- **(b)** `gtr.copy.include` globs for env files and `gtr.copy.includeDirs` (for example `node_modules`),
  copied with plain `cp -r`, so no CoW. `gtr.hook.postCreate`, `preRemove`, and `postRemove` hooks. A
  team-shared `.gtrconfig` needs `git gtr trust` before its hooks run.
- **(c)** **No merge command.** It is PR-oriented: `git gtr clean --merged --closed` uses `gh`/`glab`.
- **(d)** `rm`, plus `clean`, which also unlocks and prunes stale locked entries left by crashed agents.
- **(e)** **Best in class.** `git gtr new <b> --porcelain` prints exactly `path`, `branch`, and
  `hook_status` records (tab-separated) on stdout, logs go to stderr, and a hook failure exits non-zero.
  `list --porcelain`, `run <branch> <cmd>`, and `--yes`. It ships `docs/agent-usage.md` with an AGENTS.md
  policy: agents must not run `trust`, `rm --force`, or `clean`.
- **(f)** None. Bash 3.2-compatible, with fish completions and fish shell-integration snippet.

### workmux, the best tmux-native option
- **(a)** `workmux add <branch> [-p "<prompt>"]` creates a worktree **plus a tmux window** with a
  configured pane layout (agent, nvim, dev server). `workmux remove`, `open`, `close`, and `resurrect`.
- **(b)** `files.copy` / `files.symlink` (for example symlink `node_modules`, `.pnpm-store`) and
  `post_create` hooks.
- **(c)** `workmux merge [branch] --into <feature-branch>` with `merge`, `--rebase`, or `--squash`.
  `--into` exists for "merging subtasks into a parent feature branch". Rebase conflicts are left for
  manual `git rebase --continue`.
- **(d)** `merge` cleans up the worktree, window, and branch (`--keep` to skip). `reap-agents`.
- **(e)** Medium. It is scriptable (`add -p`, `--wait`, `path`, `merge`), but every `add` creates tmux UI
  and expects a running multiplexer. It does not support herdr, and is a herdr competitor.
- **(f)** First-class: window per worktree, agent status icons in window names, sidebar, dashboard.

### claude-squad (`cs`)
TUI on tmux and git worktrees. Keys: `n` new, `c` checkout (commit + pause), `s` commit + push, `D` kill.
No dependency bootstrap or hooks, no merge (you push and PR, or check out). **Not scriptable**: the CLI
only has `cs`, `reset`, `debug`, and `version`, and everything else is interactive. AGPL. It is for a
human dashboard, not for an orchestrator.

### ccmanager
Node TUI with its own PTYs, no tmux. Creates, merges, and deletes worktrees from menus. Supports
`.worktreeinclude` (it explicitly matches Claude Code, Codex, and Conductor semantics), post-create
worktree hooks, status-change hooks, copying Claude session data between worktrees, devcontainers, and
session restore. **Interactive only**, so an agent cannot call it.

### container-use (dagger)
An MCP server (`claude mcp add container-use -- container-use stdio`). Each agent environment is a
container plus a git branch, and you review with `git checkout <branch>`. Strong isolation (processes,
ports, deps), but it needs Docker/Dagger, uses MCP rather than a CLI, is experimental, and had no
release since 2025-08. Overkill for one developer on macOS unless sandboxing is the goal.

### gwq
A ghq-style worktree manager: `gwq add/exec/remove/prune`, `gwq status --json --watch`, and
`gwq tmux run/attach/kill` for long-running processes. Per-repo `copy_files` and `setup_commands`
(templated, trust-gated). No merge. Scriptable (JSON output) but adds little over git plus a function.

### Native: Claude Code (verified against code.claude.com docs)
- `claude -w/--worktree <name>` creates `.claude/worktrees/<name>/` on branch `worktree-<name>`.
  `--worktree "#1234"` or a PR/MR URL starts from a PR. Reusing a name reopens that worktree.
- **Non-interactive:** `claude -p --worktree <name>` skips the workspace-trust check, but **does no
  cleanup and leaves a `git worktree lock`** until a later session's stale-lock sweep releases it. An
  orchestrator must `git worktree unlock` and then `git worktree remove` itself.
- **Subagents:** `isolation: worktree` in agent frontmatter. The worktree is removed automatically if the
  subagent made no changes. If it has changes it stays until the periodic sweep (`cleanupPeriodDays`)
  can remove it without losing work. Claude Code holds a `git worktree lock` while the agent runs.
- **Isolation enforcement:** inside a worktree session, Edit/Write to the main checkout is blocked, and
  so is Bash whose cwd resolves to the main checkout or that redirects git (`git -C`, `GIT_DIR`, or `cd`
  into the main checkout). These checks cannot be turned off. **This matters for an orchestrator that
  runs inside a worktree and tries to merge into the main checkout.**
- **Settings (`worktree.*`):**
  - `baseRef`: `"fresh"` (default, `origin/<default>`) or `"head"` (current HEAD; inside a worktree,
    that worktree's HEAD). It **cannot be a branch name**. Use `"head"` so implementer subagents branch
    from your feature branch.
  - `symlinkDirectories`: for example `["node_modules", ".cache"]`, symlinked from the main checkout.
  - `sparsePaths`: sparse-checkout for monorepos.
  - `bgIsolation`: `"worktree"` (default) or `"none"` for background sessions.
  - `location`: Desktop SSH sessions only. The CLI ignores it.
- **`.worktreeinclude`** (gitignore syntax) at the repo root: copies files that are both matched and
  gitignored into every git-created worktree (`--worktree`, subagents, desktop).
- **`WorktreeCreate` hook (exists):** it *replaces* git worktree creation for `--worktree`,
  `EnterWorktree`, `isolation: worktree`, workflows, background sessions, and remote-control. stdin
  JSON has `name`. The hook prints the absolute path as the last stdout line (HTTP hooks return
  `hookSpecificOutput.worktreePath`), and a non-zero exit fails creation. With the hook,
  `.worktreeinclude` is **not processed**, so the hook copies files itself. The path must be normalized,
  must not pass through a symlink inside the repo, and must sit outside any repository unless it is a
  real git worktree. **`WorktreeRemove` does not run for subagent or workflow worktrees**, so you must
  clean those yourself. Claude Code never deletes a branch a hook created.
- Hooks: `${CLAUDE_PROJECT_DIR}` stays at the launch root. Read `cwd` from the hook input to get the
  worktree path.

### Native: Codex
- **CLI:** experimental `--worktree` and `/worktree` shipped in **0.154.0** (managed worktrees for
  interactive sessions, forks, and **`codex exec`**). They were **enabled by default in 0.156.0**, and
  0.162.0 added TUI tools to create and list managed worktrees. This comes from the openai/codex
  release notes. The flag is boolean: it starts from HEAD and has no branch selector.
- **App (ChatGPT desktop):** managed worktrees in `$CODEX_HOME/worktrees` start in **detached HEAD**. The
  app keeps 15 managed worktrees by default and snapshots before deleting. "Hand off" moves work between
  Local and a worktree. `.worktreeinclude` is copied **only for app-managed local worktrees, "not … Git
  worktrees you create yourself from the command line"**. Setup scripts ("local environments" in
  `.codex/`) are **desktop app only**.
- Result: for scripted Codex implementers, creating the worktree yourself and running
  `codex exec -C <path>` (or cd into it) gives deterministic branch names and bootstrap.

---

## 3. Summary matrix

| | Create/remove | Dep bootstrap | Merge back + conflicts | Cleanup | Agent-callable (Bash) | tmux |
|---|---|---|---|---|---|---|
| worktrunk | ✅ | ✅ hooks + CoW copy + `.worktreeinclude` | ✅ `wt merge <any-branch>`, stops on conflict | ✅ | ✅ `--yes`, JSON list | recipes |
| gtr | ✅ | ✅ hooks + `cp -r` | ❌ (PR only) | ✅ incl. stale locks | ✅✅ `--porcelain` contract | ❌ |
| workmux | ✅ | ✅ copy/symlink + hooks | ✅ `--into`, rebase/squash, stops on conflict | ✅ | ⚠️ creates tmux UI | ✅✅ |
| claude-squad | ✅ | ❌ | ❌ (push/checkout) | ✅ | ❌ TUI | ✅ (required) |
| ccmanager | ✅ | ✅ `.worktreeinclude` + hook | ✅ (menu) | ✅ | ❌ TUI | ❌ |
| container-use | ✅ (containers) | ✅ container image | git branches | ✅ | via MCP only | ❌ |
| gwq | ✅ | ✅ copy + setup cmds | ❌ | ✅ prune | ✅ JSON | ✅ process runner |
| Claude native | ✅ | `.worktreeinclude`, symlinkDirectories, WorktreeCreate hook | ❌ (your git) | auto for clean, sweep for dirty; `-p` leaves locks | ✅ `-p --worktree`, subagents | ❌ |
| Codex native | ✅ (CLI: HEAD, detached) | app only | ❌ / app Handoff | app: keep 15 | ✅ `codex exec` (0.154+) | ❌ |

---

## 4. Bootstrapping dependencies in a fresh worktree: best practice

1. **Secrets and env files: use `.worktreeinclude`.** It is now a de-facto shared convention read by
   Claude Code, the Codex app, ccmanager, Conductor, and worktrunk (`wt step copy-ignored`). One file
   serves every tool. Only files that are both matched and gitignored are copied.
2. **Node with pnpm: don't copy `node_modules`, reinstall from the shared store.** pnpm's
   content-addressable store plus `packageImportMethod: auto` (macOS order: **clone → hardlink → copy**)
   means `pnpm install --frozen-lockfile --prefer-offline` in a new worktree reflinks on APFS and takes
   seconds. It gives correct per-branch deps with no shared mutable state. Keep the store on the same
   volume as the worktrees.
3. **Big build caches (`target/`, `.next/cache`, `.venv`, npm/yarn `node_modules`): copy-on-write
   clone.** On macOS, use `cp -c -R src dst` (clonefile(2)) or `wt step copy-ignored`. Avoid plain
   `cp -r` (gtr's `includeDirs`), which duplicates disk.
4. **Symlinked `node_modules` (Claude `worktree.symlinkDirectories`, workmux `files.symlink`) is the
   fastest but riskiest.** All agents share one mutable tree, so an agent that adds a dependency
   mutates main's tree. Bundlers and test runners that realpath symlinks (Jest, Vite, Next/Turbopack,
   TS) can resolve outside the worktree. Use it only when no agent changes dependencies.
5. **Run the install blocking, before the agent starts.** Use a `pre-start` hook, not `post-start`, or
   make it step 2 of the orchestrator script, so the agent never races a half-installed tree and
   failures surface as a non-zero exit (gtr's model).
6. **Per-worktree ports and DBs:** hash the branch to a port (worktrunk `hash_port`, Conductor
   `CONDUCTOR_PORT`, uzi `portRange`) and store derived values per branch.
7. **Claude-specific:** set `worktree.baseRef: "head"` so subagent worktrees start from the feature
   branch, not `origin/production`. Add `.claude/worktrees/` to `.gitignore`. If you want worktrees in
   `../wt/<name>` (matching `cyw`), a `WorktreeCreate` hook can do it, but you then own the
   `.worktreeinclude` copy, the bootstrap, and **subagent cleanup** (no WorktreeRemove for subagents).

---

## 5. Recommendation

**Borrow ideas, and lean on native features plus plain git. Don't take a dependency now. If one is
ever adopted, make it worktrunk.**

Why not adopt a tool as a hard dependency for the orchestrator:
- The orchestrator needs about five primitives: create a worktree on a named branch from the feature
  branch, bootstrap, launch an agent non-interactively, merge or rebase back with a conflict policy,
  and remove. Each is one or two git commands. `cyw` already does the first.
- The GUI and TUI tools (claude-squad, ccmanager, crystal/Nimbalyst, vibe-kanban, Conductor, sculptor,
  Superset, emdash) are **not agent-callable**, and two are dead or deprecated.
- worktrunk is excellent, but it adds an approval/trust layer (`--yes` auto-approves repo hooks), a
  squash-by-default merge with LLM commit messages, and a fast-moving 0.x CLI surface that an agent
  prompt would pin against.
- workmux couples every worktree to a tmux window, and herdr is your multiplexer.

What to borrow:
1. **gtr's output contract:** have the wrapper print `path\t…`, `branch\t…`, and `status\t…` on stdout,
   send logs to stderr, and exit non-zero on bootstrap failure. That interface is what an agent needs.
2. **worktrunk/workmux merge semantics:** `rebase onto <feature> → run checks → ff-only merge`. On
   conflict, **`git rebase --abort` and report**, never leave a half-rebased tree for a non-interactive
   agent (both tools leave it open, which only suits a human). Add `--into <feature-branch>` as the
   target.
3. **`.worktreeinclude` + CoW:** copy the include list, run `cp -c -R` for caches, and run
   `pnpm install --prefer-offline` blocking.
4. **Lock awareness:** clean with `git worktree unlock` + `remove` + `prune` (gtr `clean` and the Claude
   docs both show `-p` runs leave locks).

Native split:
- **Claude implementers:** subagents with `isolation: worktree` plus `worktree.baseRef: "head"` and a
  committed `.worktreeinclude`. The main session (on the feature branch) reviews and merges. Claude
  auto-removes clean worktrees. For dirty ones, the orchestrator merges the branch and then removes it.
  Don't run the merging orchestrator *inside* a worktree, because the isolation checks will block git
  aimed at the main checkout.
- **Codex implementers:** create the worktree with your wrapper (named branch, bootstrap), then
  `codex exec` in it. Codex CLI `--worktree` is new (0.154/0.156), uses detached HEAD, and its
  `.worktreeinclude` and setup scripts are app-only.
- **Separate terminals (herdr/tmux panes):** the wrapper plus `claude`/`codex` in the pane. Skip
  `claude -p --worktree` unless you also own its unlock and remove.

Escalation trigger: if the wrapper grows past about 100 lines (hooks per repo, port hashing, listing
with status, PR checkout), switch the primitives to **worktrunk** (`wt switch -c … -x …`,
`wt merge <feature> --no-squash --yes`, `wt list --format=json`, plus its Claude plugin to unify native
worktrees). It is the only candidate that is permissive-licensed, very active, CLI-first, fish-aware,
agent-agnostic, and has a real merge command.

---

## Sources
- Claude Code worktrees: https://code.claude.com/docs/en/worktrees.md
- Claude Code settings reference (`worktree.*`): https://code.claude.com/docs/en/settings-reference.md
- Claude Code hooks (`WorktreeCreate`/`WorktreeRemove`): https://code.claude.com/docs/en/hooks.md
- Codex worktrees (app): https://developers.openai.com/codex/app/worktrees.md
- Codex local environments: https://learn.chatgpt.com/docs/environments/local-environment.md
- Codex CLI release notes 0.154.0 / 0.156.0 / 0.162.0: https://github.com/openai/codex/releases
- worktrunk: https://github.com/max-sixty/worktrunk, https://worktrunk.dev/hook/, https://worktrunk.dev/merge/, https://worktrunk.dev/step/, https://worktrunk.dev/claude-code/, https://worktrunk.dev/tips-patterns/
- gtr: https://github.com/coderabbitai/git-worktree-runner (README, docs/agent-usage.md, docs/configuration.md)
- workmux: https://github.com/raine/workmux
- claude-squad: https://github.com/smtg-ai/claude-squad
- crystal → Nimbalyst: https://github.com/stravu/crystal
- vibe-kanban + shutdown post: https://github.com/BloopAI/vibe-kanban, https://www.vibekanban.com/blog/shutdown
- uzi: https://github.com/devflowinc/uzi
- ccmanager: https://github.com/kbwo/ccmanager
- container-use: https://github.com/dagger/container-use
- gwq: https://github.com/d-kuro/gwq
- sculptor: https://github.com/imbue-ai/sculptor
- Conductor: https://www.conductor.build/workflows, https://github.com/meltylabs (releases-only repos)
- pnpm `packageImportMethod`: https://pnpm.io/settings/node-modules
