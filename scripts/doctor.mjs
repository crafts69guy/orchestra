import { fail, format, info, pass, warn } from './lib/report.mjs';
import { exec } from './orch-wt.mjs';

const MIN_NODE = [22, 8];
const ORCH_FIX =
  'claude plugin marketplace add crafts69guy/orchestra && claude plugin install orch@orchestra';
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
    return [fail('orch@orchestra', e.message, ORCH_FIX)];
  }
  const enabled = (id) => list.find((p) => p?.id === id && p.enabled === true);
  const orch = enabled('orch@orchestra');
  const ponytail = enabled('ponytail@ponytail');
  return [
    orch
      ? pass('orch@orchestra', `enabled (${orch.version}, ${orch.scope})`)
      : fail('orch@orchestra', 'not installed or not enabled', ORCH_FIX),
    ponytail
      ? pass('ponytail@ponytail', `enabled (${ponytail.version}, ${ponytail.scope})`)
      : warn('ponytail@ponytail', 'not installed or not enabled', PONYTAIL_FIX),
  ];
}

/** Returns `{ code, lines }`; code is 1 when any required check fails. Never throws. */
export function run(deps = realDeps) {
  const checks = [
    checkNode(deps.nodeVersion),
    checkTool(deps, 'git', ['--version'], 'install git'),
    checkTool(deps, 'wt', ['--version'], 'brew install worktrunk'),
    checkTool(deps, 'ccc', ['version'], "uv tool install 'cocoindex-code[full]'", warn),
    // optional: only pane mode (`orch claude --panes`) needs herdr
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
  return {
    code: checks.some((c) => c.mark === '✗') ? 1 : 0,
    lines: checks.map(format),
  };
}

export const realDeps = { exec, env: process.env, nodeVersion: process.versions.node };
