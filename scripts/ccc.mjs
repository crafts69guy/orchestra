import { join } from 'node:path';

const SETTINGS = ['.cocoindex_code', 'settings.yml'];
const MIN_FILES = 200;
const SERVER = 'cocoindex-code';
const TRACKING = { COCOINDEX_DISABLE_USAGE_TRACKING: '1' };
const INSTALL_HINT = "install it: uv tool install 'cocoindex-code[full]'";

/** Git toplevel of `cwd` when it holds a ccc index (`.cocoindex_code/settings.yml`), else null. A parent index never counts. */
export function cccRoot(cwd, { exec, exists }) {
  const r = exec('git', ['rev-parse', '--show-toplevel'], cwd);
  if (r.status !== 0) return null;
  const top = r.stdout.trim();
  return top && exists(join(top, ...SETTINGS)) ? top : null;
}

/** True when ccc should be injected: not `ORCH_CCC=0`, `ccc` on PATH and the git root indexed. */
export function cccEnabled(env, cwd, { exec, exists, hasCommand }) {
  return (
    env.ORCH_CCC !== '0' && hasCommand('ccc', env.PATH) && cccRoot(cwd, { exec, exists }) !== null
  );
}

/** Single `--mcp-config=<json>` arg; the `=` form is required because the flag is variadic and would swallow the prompt. */
export function claudeMcpArg() {
  const cfg = {
    mcpServers: { [SERVER]: { type: 'stdio', command: 'ccc', args: ['mcp'], env: TRACKING } },
  };
  return `--mcp-config=${JSON.stringify(cfg)}`;
}

/** Codex per run `-c` pairs defining the cocoindex-code server (search tool only, auto-approved). */
export function codexMcpArgs() {
  const p = `mcp_servers.${SERVER}`;
  return [
    `${p}.command="ccc"`,
    `${p}.args=["mcp"]`,
    `${p}.env.COCOINDEX_DISABLE_USAGE_TRACKING="1"`,
    `${p}.enabled_tools=["search"]`,
    `${p}.default_tools_approval_mode="auto"`,
    `${p}.startup_timeout_sec=30`,
    `${p}.tool_timeout_sec=120`,
  ].flatMap((v) => ['-c', v]);
}

/** Appends `max_file_size: 256KB` unless settings text already sets it. */
export function ensureMaxFileSize(text) {
  if (/^max_file_size:/m.test(text)) return text;
  return `${text}${text.endsWith('\n') ? '' : '\n'}max_file_size: 256KB\n`;
}

/**
 * `orch ccc init [--force]`: index the git root with a standard config. Returns the exit code.
 * `io.spawnExit` is injected (orch-codex imports session-start, which imports this module).
 */
export function run(args, io) {
  const [sub, ...flags] = args;
  if (sub !== 'init') {
    io.stderr('usage: orch ccc init [--force]\n');
    return 1;
  }
  const top = io.exec('git', ['rev-parse', '--show-toplevel'], io.cwd);
  if (top.status !== 0) {
    io.stderr('orch ccc: not inside a git repository\n');
    return 1;
  }
  const root = top.stdout.trim();
  const settings = join(root, ...SETTINGS);
  const spawn = (cmd, a) =>
    io.spawnExit(io.spawn(cmd, a, { cwd: root, env: io.env }), cmd, io.stderr, INSTALL_HINT);
  if (!io.exists(settings)) {
    const files = io.exec('git', ['ls-files'], root).stdout.split('\n').filter(Boolean).length;
    // ponytail: fixed threshold, make it configurable if it bites
    if (files < MIN_FILES && !flags.includes('--force')) {
      io.stderr(`orch ccc: small repo (${files} files): use rg; pass --force to index anyway\n`);
      return 1;
    }
    const code = spawn('ccc', ['init']);
    if (code !== 0) return code;
  }
  const text = io.read(settings, 'utf8');
  const next = ensureMaxFileSize(text);
  if (next !== text) {
    io.write(settings, next);
    io.stdout('orch ccc: added max_file_size: 256KB to settings.yml\n');
  }
  return spawn('ccc', ['index']);
}
