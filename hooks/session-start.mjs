#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cccEnabled } from '../scripts/ccc.mjs';
import { inkdropFlag } from '../scripts/inkdrop.mjs';
import { lessonsPath, parseLessons, selectLessons } from '../scripts/lib/lessons.mjs';
import { herdr } from '../scripts/orc-pane.mjs';
import { exec } from '../scripts/orc-wt.mjs';
import { mainRoot } from '../scripts/status.mjs';
import { readStdin } from './guard.mjs';

export const WT_WARNING =
  'orc: `wt` (worktrunk) not found on PATH; parallel dispatch needs it (`brew install worktrunk`).';

export function pluginRoot(metaUrl) {
  return join(dirname(fileURLToPath(metaUrl)), '..');
}

export function readRules(root, read = readFileSync) {
  try {
    return read(join(root, 'rules', 'orchestrator.md'), 'utf8');
  } catch {
    return null;
  }
}

// ponytail: POSIX-only executable lookup; add PATHEXT handling if Windows matters.
export function which(name, pathEnv = '') {
  return pathEnv.split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** A line ending in `<!-- orc:NAME -->` is dropped when `flags[NAME]` is falsy, else the marker is stripped. */
export function applyMarkers(rules, flags) {
  const marker = / *<!-- orc:(\w+) -->$/;
  return rules
    .split('\n')
    .filter((l) => {
      const name = marker.exec(l)?.[1];
      return name === undefined || Boolean(flags[name]);
    })
    .map((l) => l.replace(marker, ''))
    .join('\n');
}

const LESSONS_HEADER =
  'Lessons (approved, from past work in this repo; apply when relevant and pass relevant ones into briefs):';

/**
 * `orcPath` is the absolute `bin/orc`; plugin bin/ is not on PATH under Codex, so name it.
 * `flags.panes` adds `orc pane` to the CLI line (and keeps the `orc:panes` rule line).
 * `flags.inkdrop` (`{ name, id }` or false) adds `orc inkdrop` and an `Inkdrop notebook:` line.
 * `flags.scratch` (a path or null) adds a `Scratch dir:` line.
 * `flags.lessons` (`{ kept, hidden }` from `readLessons`, or null) adds a `Lessons` block of the
 * kept raw lines, plus a consolidation note when `hidden > 0`.
 */
export function buildContext(
  rules,
  hasWt,
  orcPath,
  flags = { docs: true, ccc: false, high: false, panes: false, inkdrop: false },
) {
  const pane = flags.panes ? ` and \`${orcPath} pane start|wait|prompt|close\`` : '';
  const ink = flags.inkdrop ? ` and \`${orcPath} inkdrop inbox|claim|push|pull|lessons\`` : '';
  const book = flags.inkdrop
    ? `Inkdrop notebook: ${flags.inkdrop.name} (${flags.inkdrop.id})\n`
    : '';
  const scratch = flags.scratch
    ? `Scratch dir: ${flags.scratch} (plans and briefs go here, not in this worktree)\n`
    : '';
  const more = flags.lessons?.hidden
    ? `orc: ${flags.lessons.hidden} more lessons not shown; run the reflect skill to consolidate .orc/lessons.md.\n`
    : '';
  const lessons = flags.lessons?.kept.length
    ? `${LESSONS_HEADER}\n${flags.lessons.kept.map((l) => `${l.line}\n`).join('')}${more}`
    : '';
  const withCli = `${applyMarkers(rules, flags).trimEnd()}\n\norc CLI: ${orcPath} (use \`${orcPath} wt new|merge|list\`${pane}${ink})\n${book}${scratch}${lessons}`;
  return hasWt ? withCli : `${withCli}\n${WT_WARNING}\n`;
}

const toplevel = (exec, cwd) => {
  const r = exec('git', ['rev-parse', '--show-toplevel'], cwd);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
};

/** `<main root>/.scratch` when `cwd` is in a linked worktree (a session worktree), else null. */
export function scratchDir(exec, cwd) {
  const top = toplevel(exec, cwd);
  const root = mainRoot({ exec }, cwd);
  return top !== null && root !== null && root !== top ? join(root, '.scratch') : null;
}

/**
 * `{ kept, hidden }` from `<main root>/.orc/lessons.md` (shared by every worktree), or null with
 * no git root, a missing or unreadable file, or no active lesson.
 */
export function readLessons(exec, cwd, read = readFileSync) {
  const root = mainRoot({ exec }, cwd);
  if (root === null) return null;
  let text;
  try {
    text = String(read(lessonsPath(root), 'utf8'));
  } catch {
    return null;
  }
  const selected = selectLessons(parseLessons(text).lessons);
  return selected.kept.length > 0 ? selected : null;
}

const ISOLATE =
  'Do not edit here: run `orc wt session <branch>` and switch into its path (Claude Code: EnterWorktree with that path; Codex: ask the user to restart with `orc codex --wt <branch>`). Never edit, stash, reset or commit their changes.';

/**
 * A warning when another session may be writing to this checkout, or null. Inside herdr: other
 * agents whose cwd has this checkout as its git toplevel (task worktrees under `.worktrees/` have
 * their own). Outside herdr, at `startup` only: uncommitted changes already present.
 */
export function collisionWarning({ env, cwd, exec, source }) {
  const top = toplevel(exec, cwd);
  if (top === null) return null;
  if (env.HERDR_ENV === '1') {
    const agents = herdr({ exec }, ['agent', 'list']).result?.agents;
    if (!Array.isArray(agents)) return null;
    const others = agents.filter((a) => {
      if (a?.pane_id === env.HERDR_PANE_ID) return false;
      const dir = a?.foreground_cwd ?? a?.cwd;
      if (typeof dir !== 'string' || (dir !== top && !dir.startsWith(`${top}/`))) return false;
      return toplevel(exec, dir) === top;
    });
    if (others.length === 0) return null;
    const names = others
      .map((a) => `${a.pane_id} ${a.agent} "${a.terminal_title_stripped ?? ''}"`)
      .join(', ');
    return `orc: other agents are working in this checkout: ${names}. ${ISOLATE}`;
  }
  if (source !== 'startup') return null;
  const st = exec('git', ['status', '--porcelain'], cwd);
  const n = st.status === 0 ? st.stdout.split('\n').filter(Boolean).length : 0;
  if (n === 0) return null;
  return `orc: this checkout already has uncommitted changes (${n} paths). They may belong to another session: do not edit, stash, reset or commit them unless the user says they are part of this task; otherwise isolate with \`orc wt session <branch>\` and switch into its path.`;
}

/** Appends `warning` as its own paragraph. */
export const withWarning = (context, warning) =>
  warning === null ? context : `${context}\n${warning}\n`;

/** SessionStart `source` (startup|resume|clear|compact) from the hook input, or undefined. */
export function sourceOf(input) {
  try {
    const source = JSON.parse(input)?.source;
    return typeof source === 'string' ? source : undefined;
  } catch {
    return undefined;
  }
}

export function formatOutput(additionalContext) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  });
}

/**
 * Returns the process exit code; never throws for a missing rules file. A herdr pane worker
 * (`ORC_ROLE` set) gets no orchestrator rules: it follows its implementer prompt.
 */
export function run({
  env,
  root,
  cwd,
  read,
  hasCommand,
  exec,
  exists,
  stdout,
  stderr,
  input = '',
}) {
  if (env.ORC !== '1' || env.ORC_ROLE) return 0;
  const rules = readRules(root, read);
  if (rules === null) {
    stderr(`orc: rules/orchestrator.md not found under ${root}; skipping injection\n`);
    return 0;
  }
  const context = buildContext(rules, hasCommand('wt', env.PATH), join(root, 'bin', 'orc'), {
    docs: env.ORC_DOCS !== '0',
    high: env.ORC_LEVEL === 'high',
    panes: env.ORC_PANES === '1' && env.HERDR_ENV === '1',
    ccc: cccEnabled(env, cwd, { exec, exists, hasCommand }),
    inkdrop: inkdropFlag(env, cwd, { exec }),
    scratch: scratchDir(exec, cwd),
    lessons: readLessons(exec, cwd, read),
  });
  const warning = collisionWarning({ env, cwd, exec, source: sourceOf(input) });
  stdout(formatOutput(withWarning(context, warning)));
  return 0;
}

export function main(proc = process, metaUrl = import.meta.url, readInput = readStdin) {
  proc.exitCode = run({
    input: proc.env.ORC === '1' ? readInput() : '',
    env: proc.env,
    root: pluginRoot(metaUrl),
    cwd: proc.cwd(),
    read: readFileSync,
    hasCommand: which,
    exec,
    exists: existsSync,
    stdout: (s) => proc.stdout.write(s),
    stderr: (s) => proc.stderr.write(s),
  });
}

// realpath both sides: a symlinked plugin dir (stow, --plugin-dir) must still run main.
export function isEntry(argv1, metaUrl, real = realpathSync) {
  try {
    return real(argv1) === real(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isEntry(process.argv[1], import.meta.url)) main();
