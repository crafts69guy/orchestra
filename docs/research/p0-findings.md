# P0 verification findings: orchestra (`orch`)

Tool versions: wt 0.80.0, codex-cli 0.162.1, Claude Code 2.1.296, node 22.16.
Workspace: `$P = .../scratchpad/p0`. Every wt run used `XDG_CONFIG_HOME=$P/xdg*`, so
`~/.config/worktrunk` was never created. Raw logs and JSONL files are in `$P/`.

## Summary

| ID | Result | Key fact |
|----|--------|----------|
| W1 | PASS | `wt switch -c F--T1 --base F --no-cd --format=json` exits 0 without needing a shell. It prints `{"action":"created","branch","path","created_branch","base_branch"}` on stdout and human-readable text on stderr. `wt list --format=json` reports the path as `.items[].worktree.path`. |
| W2 | PASS | `worktree-path` is a user-config key. Both `--config-set 'worktree-path=".worktrees/{{ branch \| sanitize }}"'` and `"../wt/{{ branch \| sanitize }}"` work. The path is relative to the primary worktree, even when wt runs from a linked worktree. `--config <file>` also works. It is **ignored in project `.config/wt.toml`** (wt prints a warning). |
| W3 | PASS (with caveats) | With no LLM configured, the squash message falls back to `Squash commits from <branch>`. There are two working ways to supply our own message (see W3). Caveats: `--stage all` sweeps untracked files into the commit. The squash happens before pre-merge hooks run. `refs/wt-backup/<branch>` refs pile up. |
| W4 | PASS | On a conflict the merge exits 1. **The rebase is left open** in the task worktree (detached HEAD, `rebase-merge/`). F is untouched and the worktree is kept. `git -C <wt> rebase --abort` restores the state cleanly. `git merge-tree --write-tree F HEAD` exits 1, so it can detect the conflict beforehand. |
| W5 | PASS | Without `--yes` and without a TTY, wt exits 1 with "Cannot prompt for approval" and creates nothing. `--yes` runs the hooks and records nothing. `wt config approvals add --yes` writes `approvals.toml` **next to the user config file**, so with `--config <plugin-owned file>` the approvals stay out of global config. |
| C1 | PASS (needs trust) | `.codex/agents/probe.toml` replies `PROBE-OK`, but only when the project is trusted. Untrusted, Codex **silently falls back to the default agent**. Trust can be given per run with `-c projects.<abs-path>.trust_level="trusted"` (**unquoted** key; the quoted form is ignored). Alternative that needs no trust: `-c agents.<name>.config_file="<abs toml>" -c agents.<name>.description=...`. |
| C2 | FAIL by default, PASS with `--add-dir` | `workspace-write` keeps `.git` read-only, so `git worktree add` and `wt switch -c` fail with `.git/refs/heads/x.lock: Operation not permitted`. With `--add-dir <repo>/.git`, creating and committing in-repo `.worktrees/x` works. `../x` also needs `--add-dir <parent>`. **Side effect:** `codex exec -s workspace-write` writes `trust_level="trusted"` for the cwd into `~/.codex/config.toml`. |
| C3 | PARTIAL | Project `.codex/hooks.json` hooks run only with **project trust plus `--dangerously-bypass-hook-trust`** (or hashes approved in `/hooks`, which is global). Inline `-c hooks.<Event>=[...]` plus `--dangerously-bypass-hook-trust` works with no trust at all. ORCH=1 reaches the hooks. `agent_type="probe"` is present on SubagentStart and SubagentStop. Plugin-sourced hooks not tested, because a plugin install touches `~/.codex`. |
| K1 | PASS | A plugin agent with `tools: ..., mcp__cocoindex-code__search` gets that MCP tool. The wildcard `mcp__cocoindex-code__*` gets every tool on the server. The tools are **deferred**, so `ToolSearch` must be in the agent's `tools`. The real `ccc mcp` **fails** in a directory that has not been through `ccc init`; the test used a stand-in server with the same name. |
| K2 | PASS | SessionStart, SubagentStart, PreToolUse(Bash) and SubagentStop all fire, and ORCH=1 reaches them. `agent_type` is **`orchprobe:probe`** (with the plugin prefix) on SubagentStart, SubagentStop and the subagent's PreToolUse. It is absent on main-thread events. SessionStart `additionalContext` reaches the main thread. |
| K3 | PASS | Returning `{"decision":"block","reason":...}` makes the subagent continue once. The second call has `stop_hook_active:true` and the final reply includes the requested line. |
| K4 | PASS | `subagent_type: "orchprobe:probe"` works. A bare `"probebash"` fails with "Agent type 'probebash' not found". |

---

## worktrunk

### W1: non-interactive create
```sh
cd $P/repo   # branches: production, F
wt switch -c F--T1 --base F </dev/null          # EXIT=0; prints "Cannot change directory — shell integration installed but not active" (harmless)
wt switch -c F--T2 --base F --no-cd --format=json </dev/null
# stdout: {"action":"created","branch":"F--T2","path":".../p0/repo.F--T2","created_branch":true,"base_branch":"F"}
wt list --format=json | jq -r '.items[] | select(.branch=="F--T1") | .worktree.path'
```
- The default path template is `../<repo>.<branch|sanitize>`. A `feat/x` branch becomes `repo.feat-x`.
- JSON goes to stdout and progress text to stderr, so `jq` can read stdout directly. The path is also in `.items[].worktree.path`, alongside `branch`, `head.sha`, `worktree.changes.*` and `default_branch.ahead/behind`.
- Branches without a worktree (for example F) don't appear in `wt list` unless `--branches` is passed.
- `wt remove` runs in the background by default. Pass `--foreground` to wait for it.

### W2: path template
```sh
wt --config-set 'worktree-path=".worktrees/{{ branch | sanitize }}"' switch -c w2a --base F --no-cd --format=json
#   path: .../repo/.worktrees/w2a     (git status stays clean because .worktrees/ is gitignored)
wt --config-set 'worktree-path="../wt/{{ branch | sanitize }}"' switch -c w2b --base F --no-cd --format=json
#   path: .../p0/wt/w2b
# Run from inside the linked worktree repo.F--T1: the result is still .../repo/.worktrees/w2c (relative to the primary worktree)
wt --config $P/wt-user.toml switch -c w2d ...   # also works
# In project .config/wt.toml:
#   ▲ Project config has key worktree-path which belongs in user config (will be ignored)
```
Template variables: `branch, commit, cwd, default_branch, primary_worktree_path, repo, repo_path, short_commit, worktree_name, worktree_path`.

### W3: merge with uncommitted changes, and controlling the message
With no generator configured, `wt merge F --yes` in T1 (one WIP commit plus a dirty tree) produced:
```
▲ Auto-staging 1 untracked path: t1.txt
◎ Squashing 1 commit & working tree changes into a single commit ... ↳ Backup created @ 84d8cc4
↳ Using fallback commit message.
  Squash commits from F--T1 / Combined commits: - wip: t1 partial
✓ Merged to F ... ◎ Removing F--T1 worktree & branch in background
```
`wt merge` has no flag for the message. Two methods worked:

**A. Squash with plain git first, then merge (recommended; no wt config needed):**
```sh
cd "$WT"                                   # task worktree
git add -A                                 # or a narrower pathspec. See the --stage note below
git reset --soft "$(git merge-base F HEAD)"
git commit -m "feat(t2): add t2 files" -m "Task: T2"
git merge-tree --write-tree --name-only F HEAD >/dev/null || { echo CONFLICT; exit 1; }   # optional pre-check
wt merge F --yes                           # rebase if needed -> pre-merge hooks -> ff -> remove
# Output: "Merging 1 commit to F @ 89a3e66 (no commit/squash needed)". The message is preserved through the rebase.
```
When there is exactly one commit and the tree is clean, wt leaves the commit alone. It also needs no backup ref. To be strict, use `wt merge F --yes --no-commit`, which requires a clean tree and still rebases. Add `--no-rebase` if F must already be an ancestor.

**B. Generator override per call:**
```sh
ORCH_MSG_FILE=/path/msg.txt wt --config-set 'commit.generation.command="cat \"$ORCH_MSG_FILE\""' merge F --yes
# ◎ Generating squash commit message... feat(t3): add t3 / Task: T3  ✓
```
- Pre-merge failure (`[pre-merge] check="test ! -f FAILME"`): exit 1, `✗ pre-merge command failed`, F unchanged, worktree kept. The task branch **has already been squashed** by then.
- `--stage all` (the default) auto-stages untracked files, including any stray artifacts that aren't gitignored. Method A gives the orchestrator control over what gets staged.
- F checked out in the main worktree: the fast-forward also updates that working tree. It succeeded even when the main worktree had an unrelated dirty file.
- `refs/wt-backup/<branch>` is left behind after each auto-squash. Clean it up with `git update-ref -d`.

### W4: conflict
```sh
# CA and CB both edit line2 of a.txt. Merge CA (exit 0), then from the CB worktree:
wt merge F --yes   ->  ✗ Rebase onto F incomplete ... CONFLICT (content): Merge conflict in a.txt   EXIT=1
git status  ->  "interactive rebase in progress; onto 2fb5b3c"; worktree list shows "(detached HEAD)"; .git/worktrees/repo.F--CB/rebase-merge exists
git -C "$WT" rebase --abort   # EXIT=0; branch F--CB back at 4f15dc2, clean
```
`--format=json` prints nothing to stdout on failure, so callers must rely on the exit code. Detect conflicts before merging with `git merge-tree --write-tree F HEAD` (exit 1 means conflict; no state changes).

### W5: project hooks and approvals
```sh
# .config/wt.toml: [pre-start] boot="echo boot > booted"; [pre-merge] check=...
wt switch -c a --base F --no-cd </dev/null       # EXIT=1 "Cannot prompt for approval in non-interactive environment"; no branch, no worktree
wt switch -c b --base F --no-cd --yes            # runs boot; booted exists; nothing recorded
wt config approvals add --yes                    # writes $XDG_CONFIG_HOME/worktrunk/approvals.toml: [projects."<repo path>"] approved-commands=[...]
wt config approvals list --format=json | jq .state   # "approval_required" -> "approved"
wt switch -c c --base F --no-cd                  # runs hook without --yes
wt switch ... --no-hooks                         # skips hooks
XDG_CONFIG_HOME=$P/xdg6 wt --config $P/cfg6/config.toml config approvals add --yes   # writes $P/cfg6/approvals.toml (next to --config)
```
Approvals are keyed by command template and project path. They need re-approval when either one changes.

---

## Codex

### C1: custom agent
```sh
# .codex/agents/probe.toml: name="probe", description=..., developer_instructions="...always reply with exactly: PROBE-OK"
R=$(pwd -P)
codex exec --ephemeral --json -m gpt-5.6-luna -c model_reasoning_effort=low -s read-only \
  -c "projects.$R.trust_level=\"trusted\"" 'Use spawn_agent with agent_type "probe" ...' </dev/null
# collab_tool_call wait -> {"status":"completed","message":"PROBE-OK"}
```
- `-c 'projects."<path>".trust_level=...'` (quoted key) has **no effect**. The unquoted dotted key works. I confirmed this with a project `.codex/config.toml` containing `developer_instructions`: the marker appeared only with the unquoted form.
- Untrusted: spawn_agent still succeeds but runs the default agent. The reply was a Vietnamese greeting from the user's AGENTS.md, and **no error was raised**.
- Works without trust: `-c 'agents.probe2.description="..."' -c "agents.probe2.config_file=\"$P/cagents/probe2.toml\""` gave `PROBE2-OK`.
- `codex exec` needs `</dev/null`. Otherwise it waits on stdin ("Reading additional input from stdin...").

### C2: worktrees under the sandbox
`$P/c2c.sh` runs `git worktree add` and `wt switch -c` for each path layout. All runs used `-s workspace-write -c sandbox_workspace_write.exclude_slash_tmp=true -c sandbox_workspace_write.exclude_tmpdir_env_var=true`, because the scratch dir is under /tmp and would otherwise be writable by default.

| extra flags | in-repo `.worktrees/x` | `../x` | wt in-repo | wt `../` | commit in worktree |
|---|---|---|---|---|---|
| none | FAIL (`.git/refs/heads/x.lock: Operation not permitted`) | FAIL | FAIL | FAIL | FAIL (`index.lock`) |
| `--add-dir <repo>/.git` | ok | FAIL | ok | FAIL | ok |
| `--add-dir <repo>/.git --add-dir <parent>` | ok | ok | ok | ok | ok |

**Global side effect (found and reverted):** `codex exec -s workspace-write` in an untrusted cwd **persists** `[projects."<cwd>"] trust_level="trusted"` to `~/.codex/config.toml`. I reproduced this in an isolated test (`crepo2`): it happens with workspace-write and does not happen with `-c projects...` or `--dangerously-bypass-hook-trust` under read-only. I removed both entries I caused, and the file now matches its prior content (`$P/codex-config.backup.toml`).

### C3: hooks
The logger is `$P/hooklib/log.js`. It appends `{label, ORCH, stdin}` and emits SessionStart `additionalContext` ("secret word MANGOSTEEN").

| setup | project hooks fire? |
|---|---|
| project trusted via `-c`, no bypass | no (hooks unreviewed; only the user's global hooks ran) |
| project trusted via `-c` + `--dangerously-bypass-hook-trust` | yes: SessionStart, PreToolUse×3, SubagentStart, SubagentStop, Stop; the model answered MANGOSTEEN |
| untrusted + bypass | no (0 log lines) |
| untrusted + inline `-c "hooks.SessionStart=[{hooks=[{type=\"command\",command=\"...\"}]}]"` + bypass | **yes** (SessionStart, PreToolUse) |
| inline, no bypass | no |

Payloads:
- SessionStart fields: `cwd, hook_event_name, model, permission_mode, session_id, source:"startup", transcript_path`.
- PreToolUse: `tool_name` is `Bash`, `spawn_agent` or `multi_agent_v1wait_agent`.
- SubagentStart: `agent_id, agent_type:"probe"` (no plugin prefix), ...
- SubagentStop: adds `agent_transcript_path, last_assistant_message, stop_hook_active`.
- `ORCH:"1"` appears everywhere.
- Main-thread events carry no `agent_type`.

Plugin-sourced hooks were not tested, because installing a Codex plugin writes to `~/.codex`. Requirement without global changes: `--dangerously-bypass-hook-trust`, plus either inline `-c hooks.*` or a trusted project. The persistent alternative is `/hooks` review, which stores `trusted_hash` under `[hooks.state]` in `~/.codex/config.toml`.

---

## Claude Code
The probe plugin is at `$P/kplug` (`name: orchprobe`), with agents `probe`, `probewild` and `probebash` and the hooks in `hooks/hooks.json`. Base command:
```sh
ORCH=1 ORCH_PROBE_LOG=$P/k-runN.log claude -p --model haiku --dangerously-skip-permissions --no-session-persistence \
  --plugin-dir $P/kplug [--mcp-config $P/fakemcp/mcp.json] --strict-mcp-config --output-format stream-json --verbose '<prompt>'
```

### K1: MCP tool in plugin agent
- Run 1 used the user's real servers. `cocoindex-code` reported `status:"failed"`, because `ccc mcp` exits with "Not in an initialized project directory" in a dir without `ccc init`. The subagent's `ToolSearch select:mcp__cocoindex-code__search` returned "No matching deferred tools found".
- Run 2 used a stand-in stdio server registered as `cocoindex-code`, with tools `search` and `status`:
  - probe (exact name): `TOOLS: Read, Bash, ToolSearch, mcp__cocoindex-code__search`, `MCP_CALL: OK`.
  - probewild (`mcp__cocoindex-code__*`): `... mcp__cocoindex-code__search, mcp__cocoindex-code__status`, `MCP_CALL: OK`.
  - In both subagents, the stream shows `ToolSearch {"query":"select:mcp__cocoindex-code__search"}` followed by the `mcp__cocoindex-code__search` call.

### K2: hooks
From `$P/k-run2.log` and `$P/k-run3.log`:
```
SessionStart  ORCH=1  (no agent_type)
PreToolUse    ORCH=1  tool=Bash (main thread: no agent_type)
SubagentStart ORCH=1  agent_type="orchprobe:probe"  agent_id=afdf97c57e...
SubagentStop  ORCH=1  agent_type="orchprobe:probe"  stop_hook_active=false  (+agent_transcript_path, last_assistant_message, background_tasks)
PreToolUse    agent_type="orchprobe:probebash" agent_id=acf7610272...  tool=Bash   (inside the subagent)
```
SessionStart `additionalContext` reached the main thread (the final answer included "Secret word: MANGOSTEEN").

### K3: SubagentStop block
With `ORCH_BLOCK=1`, the hook blocks when `!stop_hook_active`:
```
SubagentStop sha=false last="PROBEBASH-DONE"
SubagentStop sha=true  last="PROBEBASH-DONE\nBLOCKED-ONCE-ACK"
```

### K4: namespaced subagent_type
`"orchprobe:probe"` works. A bare `"probebash"` gives `Agent type 'probebash' not found. Available agents: ..., orchprobe:probe, orchprobe:probebash, ...`.

Side effect: even with `--no-session-persistence`, Claude created `~/.claude/projects/-private-tmp-...-p0-kwork/` (subagent `.meta.json` files and an empty `memory/`). I deleted it.

---

## Design implications
1. **Worktree lifecycle:** have the orchestrator call `wt --config <plugin-owned toml> switch -c <F>--<T> --base <F> --no-cd --format=json`, read `.path`, and pass `--yes` or pre-approve hooks with `wt --config <same> config approvals add --yes` so global config stays untouched. Path layout cannot come from project config, so it must go through `--config` or `--config-set`. Prefer the in-repo `.worktrees/` layout (gitignored): Codex then needs only `--add-dir <repo>/.git`, and it's simpler.
2. **Commit and merge:** use method A. The orchestrator writes the message, makes one squash commit with git, runs `git merge-tree` as a pre-check, then `wt merge F --yes [--no-commit]`. Don't rely on auto-squash: the fallback message is not conventional, it stages untracked files, and it leaves backup refs.
3. **Conflicts:** treat exit 1 as "check for `rebase-merge`". Policy can be either abort (`git -C wt rebase --abort`) and mark the task blocked, or hand the open rebase to a resolver subagent. Serialize merges into F.
4. **Codex agents:** don't depend on project trust. Pass `-c agents.<name>.config_file=<plugin>/dist/codex/agents/<name>.toml -c agents.<name>.description=...` per run, or install the agents with a script. Unknown agents fall back silently, so verify through SubagentStart `agent_type` or a sentinel in the reply.
5. **Codex sandbox:** implementers need `--add-dir <repo>/.git`. Avoid `-s workspace-write` in a repo the user hasn't trusted unless persisting trust is acceptable, and document that it is persisted.
6. **Codex hooks** are opt-in and dangerous-flagged. They must not be the only carrier of rules: use AGENTS.md or skill text, plus `developer_instructions` in the agent TOML.
7. **Claude hooks:** match `agent_type` as `<plugin>:<agent>` (`orch:implementer`). Codex reports the bare name, so match both, for example by stripping the `^[^:]+:` prefix. PreToolUse inside subagents carries `agent_type`, which enables per-role guards. A SubagentStop block plus `stop_hook_active` gives one retry of a definition-of-done gate.
8. **MCP in agents:** list `ToolSearch` together with `mcp__cocoindex-code__*`. In a fresh worktree without `ccc init`, the real ccc server fails, so search must degrade gracefully (fall back to rg). Whether ccc resolves a parent project from inside `.worktrees/` is untested.
