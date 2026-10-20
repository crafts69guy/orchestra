import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pluginRoot, which } from '../hooks/session-start.mjs';
import { run as ccc, cccEnabled, claudeMcpArg } from './ccc.mjs';
import { run as context } from './context.mjs';
import { run as doctor } from './doctor.mjs';
import { run as inkdrop, push as inkdropPush } from './inkdrop.mjs';
import { run as codex, gitCommonDir, spawnExit } from './orc-codex.mjs';
import { run as pane } from './orc-pane.mjs';
import { exec, session, run as wt, realDeps as wtDeps } from './orc-wt.mjs';
import { mainRoot, parseBase, recordMerge, run as status } from './status.mjs';

export const USAGE = `usage: orc <command> [args]

commands:
  claude [--yolo] [--level high] [--panes] [--wt <branch> [--base <ref>]] [args]   run claude with the orc workflow (ORC=1, --model opus by default)
  codex [--yolo] [--wt <branch> [--base <ref>]] [args]   run codex with the orc workflow
  wt new|merge|remove|list|session ...   manage task and session worktrees (prints JSON)
  pane start|wait|prompt|close ...   drive herdr pane workers (prints JSON; inside herdr only)
  ccc init [--force]       index this repo for semantic search (cocoindex-code)
  status [--json]          show plan tasks with their worktrees, pane agents and reports
  inkdrop init|inbox|claim|push|pull ...   mirror a feature into an Inkdrop note (local server)
  doctor [--json]          check prerequisites
  context [--scope ...] [--json]   audit what Claude/Codex load into context
  update                   update the npm CLI and the installed Claude/Codex plugins
  eval [args]              run the behaviour evals (git checkout only)
  help, -h, --help         show this help
  -V, --version            print the version

--yolo bypasses the harness's permission prompts and sandbox; never the default.
--level high runs implementer on opus, scoper and shipper on sonnet (default: agent defaults).
--panes runs dispatch's implementers as herdr pane workers (ORC_PANES=1; needs herdr).
--wt runs the session in the worktree of <branch> (\`orc wt session\`), created from --base if new.
`;

/** Splits orc's own `--yolo` flag out of the args passed through to the harness. */
export function splitYolo(args) {
  return { yolo: args.includes('--yolo'), rest: args.filter((a) => a !== '--yolo') };
}

/** Splits orc's own `--panes` flag out of the args passed through to the harness. */
export function splitPanes(args) {
  return { panes: args.includes('--panes'), rest: args.filter((a) => a !== '--panes') };
}

/**
 * Splits orc's `--<name> <v>` / `--<name>=<v>` out of the args. `value` is undefined when absent
 * and '' when the flag has no value; the last occurrence wins.
 */
export function splitFlag(args, name) {
  let value;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) value = args[++i] ?? '';
    else if (args[i].startsWith(`--${name}=`)) value = args[i].slice(name.length + 3);
    else rest.push(args[i]);
  }
  return { value, rest };
}

/** Splits orc's `--level` out of the args (see `splitFlag`). */
export function splitLevel(args) {
  const { value, rest } = splitFlag(args, 'level');
  return { level: value, rest };
}

/**
 * Splits `--wt <branch>` and `--base <ref>` out of the args and, with `--wt`, creates or reuses that
 * session worktree. Returns `{ cwd, rest }` to launch in, or `{ code }` after printing an error.
 */
export function sessionCwd(args, io) {
  const { value: branch, rest: afterWt } = splitFlag(args, 'wt');
  const { value: base, rest } = splitFlag(afterWt, 'base');
  if (branch === undefined && base === undefined) return { cwd: io.cwd, rest };
  const err =
    (branch === undefined && '--base needs --wt <branch>') ||
    (branch === '' && '--wt needs a branch') ||
    (base === '' && '--base needs a ref');
  if (err) {
    io.stderr(`orc: ${err}\n`);
    return { code: 1 };
  }
  const { code, result } = session(io.wtDeps, io.cwd, branch, base, false);
  if (code !== 0) {
    io.stderr(`orc: session worktree failed: ${JSON.stringify(result)}\n`);
    return { code };
  }
  io.stderr(`orc: session worktree ${result.path} (${branch})\n`);
  return { cwd: result.path, rest };
}

/** Args for `claude`; `ccc` puts the cocoindex-code `--mcp-config=` first. */
export function claudeArgs(args, ccc = false) {
  const { yolo, rest } = splitYolo(args);
  const hasModel = rest.some((a) => a === '--model' || a.startsWith('--model='));
  return [
    ...(ccc ? [claudeMcpArg()] : []),
    ...(hasModel ? [] : ['--model', 'opus']),
    ...(yolo ? ['--dangerously-skip-permissions'] : []),
    ...rest,
  ];
}

/**
 * True when `cmd plugin marketplace list --json` names the `orchestra` marketplace. Claude prints
 * an array, Codex `{ marketplaces: [...] }`. A missing binary or unparsable output is false.
 */
export function hasOrchestra(io, cmd) {
  const r = io.exec(cmd, ['plugin', 'marketplace', 'list', '--json']);
  if (r.status !== 0) return false;
  try {
    const out = JSON.parse(r.stdout);
    const list = Array.isArray(out) ? out : (out?.marketplaces ?? []);
    return list.some((m) => m?.name === 'orchestra');
  } catch {
    return false;
  }
}

/** True when `uv tool list` shows cocoindex-code. */
function hasCcc(io) {
  const r = io.exec('uv', ['tool', 'list']);
  return r.status === 0 && /^cocoindex-code /m.test(r.stdout);
}

/**
 * Steps of `orc update` as `[cmd, args]`. The npm step is skipped in a git checkout (update it
 * with `git pull`); a harness step is skipped unless that harness has the `orchestra` marketplace.
 */
export function updateSteps(io) {
  return [
    ...(io.exists(join(io.root, '.git'))
      ? []
      : [['npm', ['install', '-g', '--prefer-online', '@crafts69guy/orchestra@latest']]]),
    ...(hasOrchestra(io, 'claude')
      ? [
          ['claude', ['plugin', 'marketplace', 'update', 'orchestra']],
          ['claude', ['plugin', 'update', 'orc@orchestra']],
        ]
      : []),
    ...(hasOrchestra(io, 'codex')
      ? [['codex', ['plugin', 'marketplace', 'upgrade', 'orchestra']]]
      : []),
    ...(hasCcc(io) ? [['uv', ['tool', 'upgrade', 'cocoindex-code']]] : []),
  ];
}

/** Deps for `inkdrop.mjs` (and the `status.mjs` collector it reuses) from io. */
function inkdropDeps(io) {
  return {
    exec: io.exec,
    readFile: (p) => io.read(p, 'utf8'),
    writeFile: io.write,
    appendFile: io.append,
    readdir: io.readdir,
    mkdir: io.mkdir,
    env: io.env,
    hasCommand: io.hasCommand,
    fetch: io.fetch,
    now: io.now,
  };
}

/**
 * The `.scratch/<feature>` names whose plan merges into `branch` (`Base branch:`), or the dir named
 * exactly `branch`. `wt merge <F>` takes the branch, `.scratch/` the feature name.
 */
function featuresOf(deps, root, branch) {
  let names = [];
  try {
    names = deps.readdir(join(root, '.scratch'));
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (name === branch) return true;
    try {
      return parseBase(deps.readFile(join(root, '.scratch', name, 'plan.md'))) === branch;
    } catch {
      return false;
    }
  });
}

/**
 * After `wt merge` succeeds: records the merge for `orc status`, then pushes a linked feature
 * (`inkdrop.json`) to Inkdrop unless `ORC_INKDROP=0`. Best effort: failures are a stderr line,
 * never the exit code.
 */
async function afterMerge(args, io, { task, commit }) {
  const options = { yes: { type: 'boolean' }, message: { type: 'string' } };
  const branch = parseArgs({ args, allowPositionals: true, options }).positionals[1];
  const deps = inkdropDeps(io);
  const root = mainRoot(deps, io.cwd);
  const found = root === null ? [] : featuresOf(deps, root, branch);
  // Two plans on one branch can share task ids, so neither is guessed.
  if (found.length > 1) {
    io.stderr(`orc: merge not recorded: several plans use base ${branch} (${found.join(', ')})\n`);
  }
  if (found.length !== 1) return;
  const [feature] = found;
  try {
    recordMerge(deps, root, feature, task, commit);
  } catch (e) {
    io.stderr(`orc: recording the merge failed: ${e.message}\n`);
  }
  if (io.env.ORC_INKDROP === '0' || !io.exists(join(root, '.scratch', feature, 'inkdrop.json'))) {
    return;
  }
  const r = await inkdropPush(deps, io.cwd, feature);
  if (r.code !== 0)
    io.stderr(`orc: inkdrop push failed: ${r.error.replace(/^orc inkdrop: /, '')}\n`);
}

/** Each command takes `(args, io)` and returns the exit code (or a Promise of it). */
export const commands = {
  claude(args, io) {
    const { level, rest: afterLevel } = splitLevel(args);
    const { panes, rest: afterPanes } = splitPanes(afterLevel);
    if (level !== undefined && level !== 'default' && level !== 'high') {
      io.stderr(`orc: unknown level ${level} (default|high)\n`);
      return 1;
    }
    const { code, cwd, rest } = sessionCwd(afterPanes, io);
    if (code !== undefined) return code;
    return spawnExit(
      io.spawn('claude', claudeArgs(rest, cccEnabled(io.env, cwd, io)), {
        cwd,
        env: {
          ...io.env,
          ORC: '1',
          ORC_ROLE: '', // a pane worker's role must not leak into a new orchestrator
          ...(level === undefined ? {} : { ORC_LEVEL: level }),
          ...(panes ? { ORC_PANES: '1' } : {}),
        },
      }),
      'claude',
      io.stderr,
      'install Claude Code first.',
    );
  },
  codex(args, io) {
    const { yolo, rest: afterYolo } = splitYolo(args);
    const { code, cwd, rest } = sessionCwd(afterYolo, io);
    if (code !== undefined) return code;
    return codex({
      ...io,
      cwd,
      argv: yolo ? ['--dangerously-bypass-approvals-and-sandbox', ...rest] : rest,
      spawn: (a, env) => io.spawn('codex', a, { env, cwd }),
    });
  },
  ccc: (args, io) => ccc(args, { ...io, spawnExit }),
  async wt(args, io) {
    const { code, result } = wt(args, io.wtDeps, io.cwd);
    io.stdout(`${JSON.stringify(result)}\n`);
    if (result.status === 'merged') await afterMerge(args, io, result);
    return code;
  },
  pane(args, io) {
    const deps = {
      exec: io.exec,
      readFile: (p) => io.read(p, 'utf8'),
      unlink: io.unlink,
      env: io.env,
      hasCommand: io.hasCommand,
      root: io.root,
    };
    const { code, result } = pane(args, deps, io.cwd);
    io.stdout(`${JSON.stringify(result)}\n`);
    return code;
  },
  /** `--json` prints `{ schemaVersion: 1, checks }` (see ADR-0010); same exit code as text. */
  async doctor(args, io) {
    const json = args.includes('--json');
    if (args.some((a) => a !== '--json')) {
      io.stderr('usage: orc doctor [--json]\n');
      return 1;
    }
    const { code, lines, checks } = await doctor(io.doctorDeps);
    io.stdout(
      json ? `${JSON.stringify({ schemaVersion: 1, checks }, null, 2)}\n` : `${lines.join('\n')}\n`,
    );
    return code;
  },
  status(args, io) {
    const deps = {
      exec: io.exec,
      readdir: io.readdir,
      readFile: (p) => io.read(p, 'utf8'),
      env: io.env,
      hasCommand: io.hasCommand,
    };
    const { code, out, err } = status(args, deps, io.cwd);
    if (out) io.stdout(out);
    if (err) io.stderr(err);
    return code;
  },
  async inkdrop(args, io) {
    const { code, out, err } = await inkdrop(args, inkdropDeps(io), io.cwd);
    if (out) io.stdout(out);
    if (err) io.stderr(err);
    return code;
  },
  context(args, io) {
    const { code, out, err } = context(args, io);
    if (out) io.stdout(out);
    if (err) io.stderr(err);
    return code;
  },
  /** Runs every step even after a failure; returns the first non-zero code. */
  update(_args, io) {
    if (io.exists(join(io.root, '.git'))) {
      io.stderr(`orc: ${io.root} is a git checkout; skipping npm (run git pull there)\n`);
    }
    let code = 0;
    for (const [cmd, args] of updateSteps(io)) {
      io.stdout(`$ ${cmd} ${args.join(' ')}\n`);
      const c = spawnExit(io.spawn(cmd, args, { env: io.env }), cmd, io.stderr, 'skipping.');
      if (c !== 0 && code === 0) code = c;
    }
    if (code === 0) io.stdout('orc: updated; restart Claude Code / Codex sessions to apply\n');
    return code;
  },
  eval(args, io) {
    const script = join(io.root, 'evals', '_support', 'run.sh');
    if (!io.exists(script)) {
      io.stderr('orc: evals ship with the git checkout only\n');
      return 1;
    }
    const r = io.spawn('sh', [script, ...args], { cwd: io.root, env: io.env });
    return spawnExit(r, 'sh', io.stderr, 'a POSIX shell is required.');
  },
};

/** Returns the process exit code, or a Promise of it for async commands. */
export function run(argv, io, table = commands) {
  const [cmd, ...args] = argv;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    io.stdout(USAGE);
    return 0;
  }
  if (cmd === '--version' || cmd === '-V') {
    io.stdout(`${JSON.parse(io.read(join(io.root, 'package.json'), 'utf8')).version}\n`);
    return 0;
  }
  if (!Object.hasOwn(table, cmd)) {
    io.stderr(`${cmd === undefined ? '' : `orc: unknown command ${cmd}\n`}${USAGE}`);
    return 1;
  }
  return table[cmd](args, io);
}

export function realIo(proc, metaUrl) {
  return {
    env: proc.env,
    cwd: proc.cwd(),
    root: pluginRoot(metaUrl),
    stdout: (s) => proc.stdout.write(s),
    stderr: (s) => proc.stderr.write(s),
    spawn: (cmd, args, opts) => spawnSync(cmd, args, { stdio: 'inherit', ...opts }),
    exists: existsSync,
    read: readFileSync,
    write: writeFileSync,
    append: appendFileSync,
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    fetch: globalThis.fetch,
    now: () => new Date(),
    unlink: unlinkSync,
    readdir: readdirSync,
    hasCommand: which,
    exec,
    gitDir: gitCommonDir,
    wtDeps,
  };
}

export async function main(proc = process, metaUrl = import.meta.url) {
  // A reader that closed early (`orc context --json | head`) ends the output, not the process.
  proc.stdout.on('error', (e) => {
    if (e.code !== 'EPIPE') throw e;
    proc.exit(proc.exitCode);
  });
  proc.exitCode = await run(proc.argv.slice(2), realIo(proc, metaUrl));
}
