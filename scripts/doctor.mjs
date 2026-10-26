import { inkdropConfig, probe as probeInkdrop } from './inkdrop.mjs';
import { fail, format, info, pass, warn } from './lib/report.mjs';
import { exec } from './orc-wt.mjs';

const MIN_NODE = [22, 8];
const ORC_FIX =
  'claude plugin marketplace add crafts69guy/orchestra && claude plugin install orc@orchestra';
const PONYTAIL_FIX =
  'claude plugin marketplace add DietrichGebert/ponytail && claude plugin install ponytail@ponytail';

/** exec that never throws; the first output line is the detail. */
function probe(deps, cmd, args) {
  try {
    const r = deps.exec(cmd, args);
    const out = (r.status === 0 ? r.stdout : r.stderr || r.stdout).trim();
    return { ok: r.status === 0, out, first: out.split('\n')[0] };
  } catch (e) {
    return { ok: false, out: '', first: e.message };
  }
}

export function checkNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return ok ? pass('node', `v${version}`) : fail('node', `v${version}`, 'install Node >= 22.8');
}

function checkTool(deps, name, args, fix, onMissing = fail) {
  const r = probe(deps, name, args);
  return r.ok ? pass(name, r.first) : onMissing(name, r.first || 'not found', fix);
}

/** `claude plugin list --json`: one entry per id and scope; enabled in any scope counts. */
export function checkPlugins(deps) {
  const r = probe(deps, 'claude', ['plugin', 'list', '--json']);
  let list;
  try {
    if (!r.ok) throw new Error(r.first || 'claude plugin list failed');
    list = JSON.parse(r.out);
    if (!Array.isArray(list)) throw new Error('claude plugin list --json is not an array');
  } catch (e) {
    return [fail('orc@orchestra', e.message, ORC_FIX)];
  }
  const enabled = (id) => list.find((p) => p?.id === id && p.enabled === true);
  const orc = enabled('orc@orchestra');
  const ponytail = enabled('ponytail@ponytail');
  return [
    orc
      ? pass('orc@orchestra', `enabled (${orc.version}, ${orc.scope})`)
      : fail('orc@orchestra', 'not installed or not enabled', ORC_FIX),
    ponytail
      ? pass('ponytail@ponytail', `enabled (${ponytail.version}, ${ponytail.scope})`)
      : warn('ponytail@ponytail', 'not installed or not enabled', PONYTAIL_FIX),
  ];
}

/**
 * Optional Inkdrop link: info without credentials, warn when the local server does not answer
 * `GET /`, else the version and the notebook this repo maps to (`deps.cwd`).
 */
export async function checkInkdrop(deps) {
  const env = deps.env ?? {};
  if (!env.INKDROP_LOCAL_USERNAME || !env.INKDROP_LOCAL_PASSWORD) {
    return info('inkdrop', 'not configured (set INKDROP_LOCAL_USERNAME/PASSWORD)');
  }
  const r = await probeInkdrop(env, deps.fetch);
  if (r.error) return warn('inkdrop', r.error, 'enable Preferences → Local Server');
  const { book, bookName } = inkdropConfig(deps.cwd, deps);
  return pass(
    'inkdrop',
    `v${r.version}${book ? `, book ${bookName ?? book}` : ', run orc inkdrop init'}`,
  );
}

/**
 * Resolves to `{ code, lines, checks }`: `checks` are the report objects (see `lib/report.mjs`),
 * `lines` their text form. code is 1 when any required check fails. Never throws.
 */
export async function run(deps = realDeps) {
  const checks = [
    checkNode(deps.nodeVersion),
    checkTool(deps, 'git', ['--version'], 'install git'),
    checkTool(deps, 'wt', ['--version'], 'brew install worktrunk'),
    checkTool(deps, 'ccc', ['version'], "uv tool install 'cocoindex-code[full]'", warn),
    // optional: only pane and pair mode (`orc claude --panes|--pair`) need herdr
    deps.env?.HERDR_ENV === '1'
      ? checkTool(deps, 'herdr', ['--version'], 'see https://herdr.dev', warn)
      : info('herdr', 'not in herdr (pane mode off)'),
  ];
  const claude = checkTool(deps, 'claude', ['--version'], 'install Claude Code', warn);
  checks.push(claude);
  if (claude.mark === '✓') checks.push(...checkPlugins(deps));
  const codex = checkTool(deps, 'codex', ['--version'], 'npm i -g @openai/codex', warn);
  checks.push(codex);
  if (claude.mark !== '✓' && codex.mark !== '✓') {
    checks.push(fail('harness', 'neither claude nor codex found', 'install Claude Code or Codex'));
  }
  checks.push(await checkInkdrop(deps));
  return {
    code: checks.some((c) => c.mark === '✗') ? 1 : 0,
    lines: checks.map(format),
    checks,
  };
}

export const realDeps = {
  exec,
  env: process.env,
  nodeVersion: process.versions.node,
  cwd: process.cwd(),
  fetch: globalThis.fetch,
};
