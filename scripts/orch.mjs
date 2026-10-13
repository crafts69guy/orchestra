import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginRoot, which } from '../hooks/session-start.mjs';
import { run as doctor } from './doctor.mjs';
import { run as codex, gitCommonDir, spawnExit } from './orch-codex.mjs';
import { exec, run as wt, realDeps as wtDeps } from './orch-wt.mjs';

export const USAGE = `usage: orch <command> [args]

commands:
  claude [--yolo] [args]   run claude with the orch workflow (ORCH=1, --model opus by default)
  codex [--yolo] [args]    run codex with the orch workflow
  wt new|merge|list ...    manage task worktrees (prints JSON)
  doctor                   check prerequisites
  update                   update the npm CLI and the installed Claude/Codex plugins
  eval [args]              run the behaviour evals (git checkout only)
  help, -h, --help         show this help
  -V, --version            print the version

--yolo bypasses the harness's permission prompts and sandbox; never the default.
`;

/** Splits orch's own `--yolo` flag out of the args passed through to the harness. */
export function splitYolo(args) {
  return { yolo: args.includes('--yolo'), rest: args.filter((a) => a !== '--yolo') };
}

export function claudeArgs(args) {
  const { yolo, rest } = splitYolo(args);
  const hasModel = rest.some((a) => a === '--model' || a.startsWith('--model='));
  return [
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

/**
 * Steps of `orch update` as `[cmd, args]`. The npm step is skipped in a git checkout (update it
 * with `git pull`); a harness step is skipped unless that harness has the `orchestra` marketplace.
 */
export function updateSteps(io) {
  return [
    ...(io.exists(join(io.root, '.git'))
      ? []
      : [['npm', ['install', '-g', '@crafts69guy/orchestra@latest']]]),
    ...(hasOrchestra(io, 'claude')
      ? [
          ['claude', ['plugin', 'marketplace', 'update', 'orchestra']],
          ['claude', ['plugin', 'update', 'orch@orchestra']],
        ]
      : []),
    ...(hasOrchestra(io, 'codex')
      ? [['codex', ['plugin', 'marketplace', 'upgrade', 'orchestra']]]
      : []),
  ];
}

/** Each command takes `(args, io)` and returns the exit code. */
export const commands = {
  claude: (args, io) =>
    spawnExit(
      io.spawn('claude', claudeArgs(args), { env: { ...io.env, ORCH: '1' } }),
      'claude',
      io.stderr,
      'install Claude Code first.',
    ),
  codex(args, io) {
    const { yolo, rest } = splitYolo(args);
    return codex({
      ...io,
      argv: yolo ? ['--dangerously-bypass-approvals-and-sandbox', ...rest] : rest,
      spawn: (a, env) => io.spawn('codex', a, { env }),
    });
  },
  wt(args, io) {
    const { code, result } = wt(args, io.wtDeps, io.cwd);
    io.stdout(`${JSON.stringify(result)}\n`);
    return code;
  },
  doctor(_args, io) {
    const { code, lines } = doctor(io.doctorDeps);
    io.stdout(`${lines.join('\n')}\n`);
    return code;
  },
  /** Runs every step even after a failure; returns the first non-zero code. */
  update(_args, io) {
    if (io.exists(join(io.root, '.git'))) {
      io.stderr(`orch: ${io.root} is a git checkout; skipping npm (run git pull there)\n`);
    }
    let code = 0;
    for (const [cmd, args] of updateSteps(io)) {
      io.stdout(`$ ${cmd} ${args.join(' ')}\n`);
      const c = spawnExit(io.spawn(cmd, args, { env: io.env }), cmd, io.stderr, 'skipping.');
      if (c !== 0 && code === 0) code = c;
    }
    if (code === 0) io.stdout('orch: updated; restart Claude Code / Codex sessions to apply\n');
    return code;
  },
  eval(args, io) {
    const script = join(io.root, 'evals', '_support', 'run.sh');
    if (!io.exists(script)) {
      io.stderr('orch: evals ship with the git checkout only\n');
      return 1;
    }
    const r = io.spawn('sh', [script, ...args], { cwd: io.root, env: io.env });
    return spawnExit(r, 'sh', io.stderr, 'a POSIX shell is required.');
  },
};

/** Returns the process exit code. */
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
    io.stderr(`${cmd === undefined ? '' : `orch: unknown command ${cmd}\n`}${USAGE}`);
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
    readdir: readdirSync,
    hasCommand: which,
    exec,
    gitDir: gitCommonDir,
    wtDeps,
  };
}

export function main(proc = process, metaUrl = import.meta.url) {
  proc.exitCode = run(proc.argv.slice(2), realIo(proc, metaUrl));
}
