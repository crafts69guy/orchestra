# Raycast integration: API survey and fit for orch

Date: 2026-10-16. Versions come from the npm registry on that date; API facts come from the Raycast
developer docs (source: `docs/` in `raycast/extensions`, main branch) and extension source code in
the same repo. Items marked ⚠ are uncertain or contradicted between sources.

Context: control and observe orch from Raycast (features and tasks, blocked workers, doctor,
context, launching sessions, Raycast AI questions). GUI stays a non-goal of this repo
([ARCHITECTURE](../ARCHITECTURE.md)); the extension lives in its own repo and consumes the JSON
contract of [ADR-0010](../adr/0010-json-contract-for-external-clients.md).

## 1. Versions and tooling

- `@raycast/api` 2.8.0 (2026-10-14): React 19.0.0, peer `@types/node` 22.19.17, `@types/react` 19.0.10, Node `>=22.22.2`.
- `@raycast/utils` 2.3.2 (peer `@raycast/api >=1.99.4`, `react >=19`). `@raycast/eslint-config` 2.2.0, flat config `defineConfig([...raycastConfig])`, ESLint 8–10, TypeScript `>=4.8.4 <6.1`.
- Raycast 2.0 (API 2.0.0, 2026-08-25) brought the extension API to macOS + Windows; added `environment.entryPointType` and `help.md`. ⚠ Windows GA date (~2026-08-21) is from third-party coverage only; 2.0 reportedly needs macOS 26.
- Manifest: `name, title, description, icon (512px), author, platforms, categories`; commands with `mode` `view | no-view | menu-bar`, `interval`, up to 3 `arguments`, `preferences` (textfield, password, checkbox, dropdown, appPicker, file, directory). ⚠ Menu-bar commands do not run on Windows.
- Scaffold with the in-app "Create Extension" command. ⚠ `create-raycast-extension` on npm is stale (0.1.0, 2022).
- CLI: `ray develop | build -e dist | lint [--fix] | publish | migrate | bundle | evals | login`.

Sources: <https://developers.raycast.com/information/manifest>,
<https://developers.raycast.com/information/developer-tools/cli>,
<https://developers.raycast.com/misc/changelog>

## 2. Running a CLI from an extension

- `useExec(file, args, opts)`: `cwd`, `env` (merged over `process.env`), `timeout` (default 10 s), `parseOutput`, `keepPreviousData`, `execute`, `onError` (default: failure toast with Retry), `failureToastOptions`. Returns `revalidate`, `mutate`. `shell: true` is discouraged.
- PATH is undocumented: an extension does not get the login shell's PATH. Patterns in the wild:
  the herdr extension takes a binary-path preference, else scans `PATH`, `~/.local/bin`,
  `/opt/homebrew/bin`, `/usr/local/bin`, then `execFile` + `--json` with a typed error envelope;
  git-worktrees uses `shell-env` + `execa`; the git extension runs `/bin/zsh -l -i -c 'env -0'` once
  and caches it.
- orch is a Node script (`#!/usr/bin/env node`), so `node` must be on the PATH it runs with, not
  only `orch`: resolve the login shell's PATH once and cache it, with an override preference.
- `showFailureToast(error, { title })` in utils.

Sources: <https://developers.raycast.com/utilities/react-hooks/useexec>,
<https://github.com/raycast/extensions/blob/main/extensions/herdr/src/lib/herdr.ts>,
<https://github.com/raycast/extensions/blob/main/extensions/git/src/utils/environment-utils.ts>

## 3. Data hooks

- `usePromise` / `useCachedPromise` (`abortable`, `execute`, `keepPreviousData`, `initialData`; cached data first, then fresh).
- `useCachedState(key, init, { cacheNamespace })`, `useLocalStorage(key, init)`, `useFrecencySorting`.
- `useStreamJSON(url)` streams large JSON arrays from `http(s)://` or `file:///`.
- `Cache` (sync, shared across commands unless namespaced, LRU capacity); `withCache(fn, { maxAge })`.
- No streaming exec hook: long jobs belong in a terminal or herdr pane, polled for status.

Source: <https://developers.raycast.com/utilities/getting-started>

## 4. UI, actions, commands

- `List` with `isShowingDetail` + `List.Item.Detail`, sections, accessories, `searchBarAccessory` dropdown; `Detail`; `Form` / `useForm`.
- Actions: `Push`, `Open`, `OpenWith`, `ShowInFinder`, `CopyToClipboard`, `Trash`, `CreateQuicklink`. ⚠ No built-in "open in terminal": extensions ship their own adapters (AppleScript, `open -na Ghostty --args ...`).
- `Keyboard.Shortcut.Common.*` maps per platform. Toasts (`Animated` → `Success`/`Failure`, primary/secondary actions), `showHUD`, `confirmAlert` with `Alert.ActionStyle.Destructive`.
- `launchCommand({ name, type, context })` (also refreshes a menu-bar command), `updateCommandMetadata({ subtitle })`, `environment.launchType`, deeplinks `raycast://extensions/<owner>/<ext>/<cmd>` (always confirm), `createDeeplink()`.

Sources: <https://developers.raycast.com/api-reference/user-interface/list>,
<https://developers.raycast.com/api-reference/user-interface/actions>,
<https://developers.raycast.com/api-reference/command>

## 5. Menu bar

- Short-lived: alive while `isLoading` is true or the menu is open. ⚠ Minimum `interval` is 1m on the manifest page, 10s on the background-refresh page; use `1m`. Timing is approximate; background refresh is off for Store installs until the user opens the command once.
- Render from cache, run one fast `--json` call, keep titles short. herdr uses `1m`, GitHub `15m`.

Sources: <https://developers.raycast.com/api-reference/menu-bar-commands>,
<https://developers.raycast.com/information/lifecycle/background-refresh>

## 6. AI extensions and MCP

- Tools: `tools[]` in the manifest, `src/tools/<name>.ts` with `export default function tool(input)`; JSDoc on the function and input fields is the AI's description. `export const confirmation: Tool.Confirmation<Input>` gates writes.
- `ai.instructions` and `ai.evals` (`{ input, mocks, expected: [callsTool | includes | matches | meetsCriteria | not] }`) in `package.json` or `ai.yaml`; `npx ray evals` runs them remotely (login needed).
- API 2.5.0 (2026-09-24): `ai.mcp` declares the extension's own MCP server (remote or local stdio), merged with its tools; `ai.skills` bundles Agent Skills.
- Raycast is an MCP client (stdio and HTTP, passes the default shell's PATH to stdio servers). Pro-only, as are `AI.ask` and `useAI`.

Sources: <https://developers.raycast.com/ai/learn-core-concepts-of-ai-extensions>,
<https://developers.raycast.com/api-reference/tool>,
<https://github.com/raycast/extensions/blob/main/docs/ai/evals.md>,
<https://manual.raycast.com/ai/model-context-protocol>

## 7. Distribution

- Store: `license: MIT`, `author` = Raycast username, npm lockfile, custom 512px icon (light and dark), README with `media/`, up to 6 screenshots 2000×1250 in `metadata/`, `CHANGELOG.md`, Title Case, US English. No opaque bundled binaries, Keychain access or analytics; calling binaries the user installed is fine. `npm run publish` opens a PR on `raycast/extensions`.
- Private (Teams): `owner` = org handle. ⚠ Free plan has an undocumented command limit.
- Local-only: an extension loaded with `ray develop` stays installed after the dev server stops. ⚠ Importing a `ray bundle` `.rayext` is undocumented.

Sources: <https://developers.raycast.com/basics/prepare-an-extension-for-store>,
<https://developers.raycast.com/teams/publish-a-private-extension>

## 8. Testing

No official harness; `@raycast/api` only exists inside Raycast. Keep logic in `src/lib/`, test it
with vitest and `vi.mock("@raycast/api", ...)` (herdr, zed-recent-projects). herdr's `check` runs
build, `tsc --noEmit`, vitest and `ray lint`, plus a test that no custom shortcut collides with a
reserved one. AI tools: `ray evals`.

## 9. Prior art (`github.com/raycast/extensions/tree/main/extensions/<name>`)

| Extension | Relevance |
|---|---|
| `herdr` | Same domain: `execFile` + JSON envelope, binary resolution, 1m menu bar, pane commands, vitest. orch's extension complements it and leaves pane control to it |
| `git-worktrees`, `worktrees` | `execa` + `shell-env`, frecency, post-create setup commands |
| `claude-code-launcher`, `claude-sessions`, `codex-manager`, `opencode-sessions` | Agent launchers with terminal adapters; codex-manager has a doctor view |
| `tmux-sessioner`, `sesh` | Multiplexer launchers |
| `github` | 12 AI tools, 15m menu bars |

## 10. Script Commands

Executable with comment metadata (`@raycast.schemaVersion 1`, `title`, `mode` `silent | compact |
fullOutput | inline`, `refreshTime` ≥10 s for inline, `argument1..3`, `needsConfirmation`). Raycast
adds only `/usr/local/bin` to PATH, so use `#!/bin/bash -l` or export PATH. Good for "run `orch
doctor`"; no lists, actions, caching, AI tools or Store distribution.
Source: <https://github.com/raycast/script-commands>

## 11. Decision

A separate `raycast-orch` repo (macOS only: menu bar and AppleScript terminals) with commands
`features`, `menu-bar` (1m), `doctor`, `context`, `launch`, and AI tools `get-status`,
`run-doctor`, `remove-task-worktree`, `launch-session` (writes behind `Tool.Confirmation`).
It reads orch only through `orch status|doctor|context --json` and `orch wt remove`, so the state
join (plan, worktrees, herdr, reports) stays in orch where it is tested. `ai.mcp` is skipped until
orch has an MCP server.
