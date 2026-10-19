import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentName } from '../scripts/orc-pane.mjs';
import {
  collect,
  formatText,
  mainRoot,
  parseBase,
  parseTasks,
  recordMerge,
  run,
} from '../scripts/status.mjs';

// Shaped like the real .scratch/p5 and ccc-integration plans: multi-line `files:` flow lists,
// block-list `decisions:` with nested `- key: value` lines, a parenthetical after the base.
const PLAN = `# p5: unified CLI

Base branch: feat/x (single checkout; files are disjoint across tasks)

## Decisions

- id: NOT-A-TASK
  goal: outside the tasks fence

## Tasks

\`\`\`yaml
- id: T1
  goal: bin/orc dispatcher with claude/codex/wt
  size: large
  files: [bin/orc, scripts/orc.mjs,
          hooks/session-start.mjs, test/orc.test.mjs,
          .codex-plugin/plugin.json]
  depends_on: []
  validate: npm test && npx biome check .
  decisions:
    - doctor wiring: \`run(deps) -> { code, lines }\`
      id: nested-not-a-key
    - size: nested
- id: T2
  goal: orc doctor prerequisite checks
  depends_on: [T1, T0 ]
\`\`\`

\`\`\`yaml
- id: LATER
\`\`\`

## Notes

\`\`\`yaml
- id: NOTES
\`\`\`
`;

test('parseBase takes the first token and drops a comment', () => {
  assert.equal(parseBase(PLAN), 'feat/x');
  assert.equal(parseBase('Base branch: main   # the branch the tasks merge into\n'), 'main');
  assert.equal(parseBase('# no base\n'), null);
});

test('parseTasks reads task-level id, goal, size and depends_on only', () => {
  assert.deepEqual(parseTasks(PLAN), [
    {
      id: 'T1',
      goal: 'bin/orc dispatcher with claude/codex/wt',
      size: 'large',
      dependsOn: [],
    },
    { id: 'T2', goal: 'orc doctor prerequisite checks', size: null, dependsOn: ['T1', 'T0'] },
  ]);
});

test('parseTasks strips comments and quotes (the plan skill template shape)', () => {
  const plan = [
    '## Tasks',
    '',
    '```yml',
    '- id: T1   # first',
    '  goal: <one sentence, observable outcome>',
    '  depends_on: []',
    '  size: small        # or substantial (rule below)',
    '- id: "T2"',
    `  goal: 'fix: the #12 case' # why`,
    '  size: # unknown',
    `  depends_on: ["T1", 'T0']  # both`,
    '```',
  ].join('\r\n');
  assert.deepEqual(parseTasks(plan), [
    { id: 'T1', goal: '<one sentence, observable outcome>', size: 'small', dependsOn: [] },
    { id: 'T2', goal: 'fix: the #12 case', size: null, dependsOn: ['T1', 'T0'] },
  ]);
  assert.equal(parseBase('Base branch: main\r\n'), 'main');
});

test('parseTasks reads the yaml fence inside the Tasks section only', () => {
  const plan = '## Tasks\n\nnone yet\n\n## Notes\n\n```yaml\n- id: NOTES\n```\n';
  assert.deepEqual(parseTasks(plan), []);
});

test('parseTasks: no Tasks section, keys before the first item, items without id', () => {
  assert.deepEqual(parseTasks('# plan\n\n## Context\n'), []);
  assert.deepEqual(
    parseTasks(
      '## Tasks\n\n```yaml\n  id: orphan\n- goal: no id\n- id: T\n  depends_on: T1\n```\n',
    ),
    [{ id: 'T', goal: null, size: null, dependsOn: [] }],
  );
});

const ROOT = '/repo';
const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
const wtList = (...branches) =>
  ok(
    JSON.stringify({
      items: [
        { branch: 'feat/x', worktree: { path: ROOT } },
        { branch: 'p5--orphan', worktree: null },
        ...branches.map((b) => ({ branch: b, worktree: { path: `${ROOT}/.worktrees/${b}` } })),
      ],
    }),
  );
const agentGet = (state) =>
  ok(JSON.stringify({ result: { type: 'agent_info', agent: { agent_status: state } } }));
// herdr reports a missing agent either way: exit 0 + error JSON on stdout, or exit 1 + stderr
const NOT_FOUND = JSON.stringify({ error: { code: 'agent_not_found', message: 'x' } });
const notFound = ok(NOT_FOUND);
const notFoundExit1 = { status: 1, stdout: '', stderr: NOT_FOUND };
const T1 = `${ROOT}/.worktrees/feat/x--T1`;
const T2 = `${ROOT}/.worktrees/feat/x--T2`;
const T9 = `${ROOT}/.worktrees/feat/x--T9`;

/**
 * Fake deps: `routes` maps "cmd arg ..." to an exec result (unknown commands exit 127); `files`
 * is the fs (`readdir` lists `.scratch` entries derived from its keys).
 */
function fake({ routes = {}, files = {}, herdr = true, scratch = true } = {}) {
  const calls = [];
  return {
    calls,
    env: { PATH: '/bin' },
    hasCommand: (name, path) => herdr && name === 'herdr' && path === '/bin',
    exec(cmd, args) {
      calls.push([cmd, ...args].join(' '));
      return (
        routes[[cmd, ...args].join(' ')] ?? { status: 127, stdout: '', stderr: `${cmd}: ENOENT` }
      );
    },
    readdir(dir) {
      assert.equal(dir, `${ROOT}/.scratch`);
      if (!scratch) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return ['zeta', 'p5', 'notes'];
    },
    readFile(p) {
      if (!Object.hasOwn(files, p))
        throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return files[p];
    },
  };
}

const GIT = { 'git rev-parse --path-format=absolute --git-common-dir': ok(`${ROOT}/.git\n`) };
const FILES = {
  [`${ROOT}/.scratch/p5/plan.md`]: PLAN,
  [`${ROOT}/.scratch/zeta/plan.md`]: '# zeta\n',
};

test('collect joins plan tasks with worktrees, herdr agents and reports', () => {
  const deps = fake({
    routes: {
      ...GIT,
      'wt list --format=json': wtList(
        'feat/x--T1',
        'feat/x--T2',
        'feat/x--T9',
        'p5--T3',
        'other--T1',
      ),
      [`herdr agent get ${agentName('T1', T1)}`]: agentGet('blocked'),
      [`herdr agent get ${agentName('T2', T2)}`]: notFound,
      [`herdr agent get ${agentName('T9', T9)}`]: ok('{"result":{"agent":{}}}'),
    },
    files: {
      ...FILES,
      [`${T1}/.orc/report.md`]: '## Status: Done\n',
      [`${T2}/.orc/report.md`]: 'no status line\n',
    },
  });
  const { code, result } = collect(deps, `${ROOT}/sub`);
  assert.equal(code, 0);
  assert.equal(deps.calls.filter((c) => c.startsWith('wt')).length, 1, 'wt list runs once');
  assert.deepEqual(result, {
    schemaVersion: 1,
    root: ROOT,
    warnings: [],
    features: [
      {
        feature: 'p5',
        base: 'feat/x',
        plan: `${ROOT}/.scratch/p5/plan.md`,
        note: null,
        tasks: [
          {
            id: 'T1',
            goal: 'bin/orc dispatcher with claude/codex/wt',
            size: 'large',
            dependsOn: [],
            branch: 'feat/x--T1',
            worktree: T1,
            agent: { name: agentName('T1', T1), state: 'blocked' },
            report: { status: 'done' },
            merged: null,
          },
          {
            id: 'T2',
            goal: 'orc doctor prerequisite checks',
            size: null,
            dependsOn: ['T1', 'T0'],
            branch: 'feat/x--T2',
            worktree: T2,
            agent: null,
            report: null,
            merged: null,
          },
          {
            id: 'T9',
            goal: null,
            size: null,
            dependsOn: [],
            branch: 'feat/x--T9',
            worktree: T9,
            agent: null,
            report: null,
            merged: null,
          },
        ],
      },
      {
        feature: 'zeta',
        base: null,
        plan: `${ROOT}/.scratch/zeta/plan.md`,
        note: null,
        tasks: [],
      },
    ],
  });
});

test('collect reads merged commits and the linked note; bad inkdrop.json is null', () => {
  const files = {
    ...FILES,
    [`${ROOT}/.scratch/p5/merged`]: 'T1 aaa\n\nT1 bbb\nbroken\n',
    [`${ROOT}/.scratch/p5/inkdrop.json`]: '{"noteId":"note:abc","specHash":"x"}',
    [`${ROOT}/.scratch/zeta/inkdrop.json`]: '{not json',
  };
  const { result } = collect(fake({ routes: GIT, files }), ROOT);
  const [p5, zeta] = result.features;
  assert.equal(p5.note, 'note:abc');
  assert.deepEqual(p5.tasks[0].merged, { commit: 'bbb' }, 'the last line per task wins');
  assert.equal(p5.tasks[1].merged, null);
  assert.equal(zeta.note, null);
  for (const bad of ['{"noteId":42}', '{"noteId":"book:x"}', 'null']) {
    const f = { ...FILES, [`${ROOT}/.scratch/p5/inkdrop.json`]: bad };
    assert.equal(collect(fake({ routes: GIT, files: f }), ROOT).result.features[0].note, null);
  }
});

test('mainRoot is the parent of the common dir, null outside git', () => {
  assert.equal(mainRoot(fake({ routes: GIT }), T1), ROOT);
  assert.equal(mainRoot(fake(), '/tmp/x'), null);
});

test('recordMerge appends "<task> <commit>" to the feature merged file', () => {
  const writes = [];
  recordMerge({ appendFile: (p, s) => writes.push([p, s]) }, ROOT, 'p5', 'T1', 'abc123');
  assert.deepEqual(writes, [[`${ROOT}/.scratch/p5/merged`, 'T1 abc123\n']]);
});

test('tasks join worktrees on <base branch>--<task>, else <feature>--<task>', () => {
  const files = {
    [`${ROOT}/.scratch/x/plan.md`]: 'Base branch: feat/x\n\n## Tasks\n\n```yaml\n- id: T1\n```\n',
    [`${ROOT}/.scratch/zeta/plan.md`]: '## Tasks\n\n```yaml\n- id: T1\n```\n',
  };
  const deps = fake({
    herdr: false,
    routes: { ...GIT, 'wt list --format=json': wtList('feat/x--T1', 'x--T1', 'zeta--T1') },
    files,
  });
  deps.readdir = () => ['x', 'zeta'];
  const [x, zeta] = collect(deps, ROOT).result.features;
  assert.equal(x.tasks.length, 1, 'x--T1 is not x: its plan merges into feat/x');
  assert.equal(x.tasks[0].branch, 'feat/x--T1');
  assert.equal(x.tasks[0].worktree, `${ROOT}/.worktrees/feat/x--T1`);
  assert.equal(zeta.tasks[0].branch, 'zeta--T1');
  assert.equal(zeta.tasks[0].worktree, `${ROOT}/.worktrees/zeta--T1`);
});

test('from inside a task worktree the root is the main checkout', () => {
  const deps = fake({
    routes: { ...GIT, 'wt list --format=json': wtList('feat/x--T1') },
    files: FILES,
  });
  const { result } = collect(deps, T1);
  assert.equal(result.root, ROOT);
  assert.equal(result.features[0].plan, `${ROOT}/.scratch/p5/plan.md`);
  assert.equal(result.features[0].tasks[0].worktree, T1);
});

test('a missing herdr agent is null whether herdr exits 0 or 1', () => {
  for (const missing of [notFound, notFoundExit1]) {
    const deps = fake({
      routes: {
        ...GIT,
        'wt list --format=json': wtList('feat/x--T1'),
        [`herdr agent get ${agentName('T1', T1)}`]: missing,
      },
      files: FILES,
    });
    assert.equal(collect(deps, ROOT).result.features[0].tasks[0].agent, null);
  }
});

test('without herdr on PATH no agent is queried', () => {
  const deps = fake({
    herdr: false,
    routes: { ...GIT, 'wt list --format=json': wtList('feat/x--T1') },
    files: FILES,
  });
  const { result } = collect(deps, ROOT);
  assert.equal(result.features[0].tasks[0].agent, null);
  assert.ok(!deps.calls.some((c) => c.startsWith('herdr')));
});

test('a wt failure is one warning; worktrees are all null and wt is not retried', () => {
  const deps = fake({ routes: GIT, files: FILES });
  const { code, result } = collect(deps, ROOT);
  assert.equal(code, 0);
  assert.deepEqual(result.warnings, ['wt list failed; worktrees unknown: wt: ENOENT']);
  assert.ok(result.features.every((f) => f.tasks.every((t) => t.worktree === null)));
  assert.equal(deps.calls.filter((c) => c.startsWith('wt')).length, 1);
  const silent = { ...GIT, 'wt list --format=json': { status: 1, stdout: '', stderr: '' } };
  assert.deepEqual(collect(fake({ routes: silent, files: FILES }), ROOT).result.warnings, [
    'wt list failed; worktrees unknown: wt list exited 1',
  ]);
});

test('no .scratch gives no features; outside git is an error', () => {
  assert.deepEqual(collect(fake({ routes: GIT, scratch: false }), ROOT).result.features, []);
  const blank = { 'git rev-parse --path-format=absolute --git-common-dir': ok('\n') };
  assert.equal(collect(fake({ routes: blank }), '/tmp/x').code, 1);
  assert.deepEqual(collect(fake(), '/tmp/x'), {
    code: 1,
    error: 'orc status: not a git repository: /tmp/x',
  });
});

test('formatText shows merged, else agent state, else report, else worktree, else -', () => {
  const task = (id, extra) => ({ id, worktree: null, agent: null, report: null, ...extra });
  const text = formatText({
    features: [
      {
        feature: 'f',
        tasks: [
          task('A', { worktree: '/w/a', agent: { state: 'working' }, report: { status: 'done' } }),
          task('B', { worktree: '/w/b', report: { status: 'partial' } }),
          task('C', { worktree: '/w/c' }),
          task('D'),
          task('E', { worktree: '/w/e', agent: { state: 'idle' }, merged: { commit: 'abc' } }),
        ],
      },
    ],
  });
  assert.equal(
    text,
    [
      'f/A  working  /w/a',
      'f/B  partial  /w/b',
      'f/C  worktree  /w/c',
      'f/D  -  -',
      'f/E  merged  /w/e\n',
    ].join('\n'),
  );
  assert.equal(formatText({ features: [] }), 'no features\n');
  assert.equal(formatText({ features: [{ feature: 'f', tasks: [] }] }), 'no tasks\n');
});

test('run prints JSON or text, warnings to stderr in text mode, usage on bad args', () => {
  const deps = () => fake({ routes: GIT, files: FILES });
  const json = run(['--json'], deps(), ROOT);
  assert.equal(json.code, 0);
  assert.equal(json.err, '');
  assert.equal(JSON.parse(json.out).schemaVersion, 1);

  const text = run([], deps(), ROOT);
  assert.equal(text.code, 0);
  assert.match(text.out, /^p5\/T1 {2}- {2}-\n/);
  assert.equal(text.err, 'orc status: wt list failed; worktrees unknown: wt: ENOENT\n');

  assert.deepEqual(run(['--bogus'], deps(), ROOT), {
    code: 1,
    out: '',
    err: 'usage: orc status [--json]\n',
  });
  assert.deepEqual(run([], fake(), '/x'), {
    code: 1,
    out: '',
    err: 'orc status: not a git repository: /x\n',
  });
});
