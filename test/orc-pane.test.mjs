import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { agentName, GATE_ERROR, herdr, run, WAIT_TIMEOUT } from '../scripts/orc-pane.mjs';

const ENV = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', PATH: '/bin' };
const ok = (result) => ({ status: 0, stdout: JSON.stringify({ id: 'x', result }), stderr: '' });
const err = (code, message = code) => ({
  status: 1,
  stdout: '',
  stderr: JSON.stringify({ id: 'x', error: { code, message } }),
});
const agent = (fields) => ok({ type: 'agent_info', agent: fields });
const prompted = (status = 'working') =>
  ok({ type: 'agent_prompted', agent: { agent_status: status } });
const REPORT = 'Status: done\n\nValidation\n- npm test: pass\n';
const PROMPT_WAIT = ['--wait', '--until', 'working', '--until', 'blocked', '--timeout', '30000'];
const enoent = (p) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });

/** The agent name for task T in worktree /a, used by most tests. */
const NAME = agentName('T', '/a');

/**
 * Fake deps: `routes` maps a "herdr arg ..." prefix (longest first wins) to a result; `files`
 * is the report fs (`unlink` removes from it); `unlinkError` makes unlink throw it.
 */
function fake(routes = {}, { env = {}, files = {}, unlinkError } = {}) {
  const calls = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const fs = { ...files };
  return {
    calls,
    fs,
    unlinked: [],
    env: { ...ENV, ...env },
    root: '/plugin',
    hasCommand: (name) => name === 'herdr',
    exec(cmd, args) {
      calls.push([cmd, ...args]);
      const line = [cmd, ...args].join(' ');
      const key = keys.find((k) => line.startsWith(k));
      return key === undefined
        ? { status: 1, stdout: '', stderr: `unrouted: ${line}` }
        : routes[key];
    },
    readFile(p) {
      if (Object.hasOwn(fs, p)) return fs[p];
      throw enoent(p);
    },
    unlink(p) {
      if (unlinkError) throw unlinkError;
      if (!Object.hasOwn(fs, p)) throw enoent(p);
      delete fs[p];
      this.unlinked.push(p);
    },
  };
}
const call = (deps, prefix) => deps.calls.find((c) => c.join(' ').startsWith(prefix));

const NEW = { 'herdr agent get': err('agent_not_found') };
const NO_TAB = {
  ...NEW,
  'herdr tab list': ok({ type: 'tab_list', tabs: [{ label: 'other', tab_id: 't0' }] }),
};
const TAB = {
  ...NEW,
  'herdr tab list': ok({ type: 'tab_list', tabs: [{ label: 'orc:F', tab_id: 't1' }] }),
};
const CREATE = {
  'herdr tab create': ok({ type: 'tab_created', root_pane: { pane_id: 'p1' } }),
};
const panes = (...ids) =>
  ok({
    type: 'pane_list',
    panes: [{ tab_id: 't0', pane_id: 'x' }, ...ids.map((pane_id) => ({ tab_id: 't1', pane_id }))],
  });
const START = ['start', 'F', 'T', '--path', '/a', '--brief', 'b.md'];

test('gate: needs HERDR_ENV=1, a workspace id and herdr on PATH', () => {
  const cases = [
    { env: { HERDR_ENV: '0' } },
    { env: { HERDR_WORKSPACE_ID: '' } },
    { hasCommand: () => false },
  ];
  for (const { env = {}, hasCommand } of cases) {
    const deps = fake({}, { env });
    if (hasCommand) deps.hasCommand = hasCommand;
    assert.deepEqual(run(['close', 'T', '--path', '/a'], deps, '/r'), {
      code: 1,
      result: { status: 'error', stderr: GATE_ERROR },
    });
    assert.equal(deps.calls.length, 0);
  }
});

test('usage errors: bad flags, unknown command, missing args, bad kind, text and file', () => {
  const argvs = [
    ['start', 'F', 'T', '--bogus'],
    ['nope', '--path', 'p'],
    [],
    ['start', 'F', 'T', '--brief', 'b'],
    ['start', 'F', 'T', '--path', 'p'],
    ['start', 'F', 'T', '--path', 'p', '--brief', 'b', '--kind', 'gemini'],
    ['nope', 'T', '--path', 'p'],
    ['wait', 'T'],
    ['wait', '--path', 'p'],
    ['prompt', 'T', '--text', 'a'],
    ['prompt', 'T', '--path', 'p'],
    ['prompt', 'T', '--path', 'p', '--text', 'a', '--file', 'b'],
    ['close', 'T'],
    ['close', '--path', 'p'],
  ];
  for (const argv of argvs) {
    const { code, result } = run(argv, fake(), '/r');
    assert.equal(code, 1, argv.join(' '));
    assert.match(result.stderr, /usage: orc pane start/);
  }
});

test('agentName: sha1 prefix of the worktree path, sanitized task, at most 32 chars', () => {
  const hash = createHash('sha1').update('/r/wt').digest('hex').slice(0, 6);
  assert.equal(agentName('Parse_CSV v2', '/r/wt'), `orc-${hash}-parse_csv-v2`);
  assert.equal(agentName('x'.repeat(40), '/r/wt').length, 32);
  assert.match(agentName('Ünï', '/r/wt'), /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(agentName('T', '/r/a'), agentName('T', '/r/b'));
  assert.equal(agentName('T', '/r/a'), agentName('T', '/r/a'));
});

test('start in a new tab: tab create with env, claude on sonnet, then the prompt', () => {
  const name = agentName('Csv', '/r/wt/csv');
  const deps = fake(
    {
      ...NO_TAB,
      ...CREATE,
      'herdr agent start': agent({ agent_status: 'idle' }),
      'herdr agent prompt': prompted(),
    },
    { files: { '/r/wt/csv/.orc/report.md': 'old' } },
  );
  const argv = ['start', 'F', 'Csv', '--path', 'wt/csv', '--brief', 'b.md'];
  const { code, result } = run(argv, deps, '/r');
  assert.equal(code, 0);
  assert.deepEqual(result, {
    status: 'started',
    state: 'working',
    task: 'Csv',
    name,
    pane: 'p1',
    path: '/r/wt/csv',
    kind: 'claude',
  });
  assert.deepEqual(deps.unlinked, ['/r/wt/csv/.orc/report.md']);
  assert.deepEqual(deps.calls.slice(0, 4), [
    ['herdr', 'agent', 'get', name],
    ['herdr', 'tab', 'list', '--workspace', 'w1'],
    [
      'herdr',
      'tab',
      'create',
      '--workspace',
      'w1',
      '--label',
      'orc:F',
      '--cwd',
      '/r/wt/csv',
      '--env',
      'ORC=1',
      '--env',
      'ORC_ROLE=implementer',
      '--no-focus',
    ],
    [
      'herdr',
      'agent',
      'start',
      name,
      '--kind',
      'claude',
      '--pane',
      'p1',
      '--',
      '--model',
      'sonnet',
    ],
  ]);
  const [, , , sentTo, text, ...rest] = deps.calls[4];
  assert.equal(sentTo, name);
  assert.deepEqual(rest, PROMPT_WAIT);
  assert.match(
    text,
    /^You are an orc implementer\. Read and follow \/plugin\/agents\/implementer\.md\./,
  );
  assert.match(text, /Your brief: \/r\/b\.md\./);
  assert.match(text, /Work only in \/r\/wt\/csv\. Do not commit\./);
  assert.match(
    text,
    /\(Status, Changes, Validation, Notes, Docs\) to \/r\/wt\/csv\/\.orc\/report\.md\.$/,
  );
});

test('start with ORC_LEVEL=high passes the level env and runs claude on opus', () => {
  const deps = fake(
    {
      ...NO_TAB,
      ...CREATE,
      'herdr agent start': agent({}),
      'herdr agent prompt': prompted(),
    },
    { env: { ORC_LEVEL: 'high' } },
  );
  assert.equal(run(START, deps, '/r').code, 0);
  assert.deepEqual(call(deps, 'herdr tab create').slice(-3), [
    '--env',
    'ORC_LEVEL=high',
    '--no-focus',
  ]);
  assert.deepEqual(call(deps, 'herdr agent start').slice(-2), ['--model', 'opus']);
});

test('start in an existing tab splits right for the 2nd worker, down from pane n-2 after', () => {
  const cases = [
    [['p1'], 'p1', 'right'],
    [['p1', 'p2'], 'p1', 'down'],
    [['p1', 'p2', 'p3'], 'p2', 'down'],
  ];
  for (const [ids, target, direction] of cases) {
    const deps = fake({
      ...TAB,
      'herdr pane list': panes(...ids),
      'herdr pane split': ok({ type: 'pane_info', pane: { pane_id: 'new' } }),
      'herdr agent start': agent({}),
      'herdr agent prompt': prompted(),
    });
    const { result } = run([...START, '--kind', 'codex'], deps, '/r');
    assert.equal(result.pane, 'new');
    assert.deepEqual(call(deps, 'herdr pane list'), ['herdr', 'pane', 'list', '--workspace', 'w1']);
    assert.deepEqual(call(deps, 'herdr pane split'), [
      'herdr',
      'pane',
      'split',
      target,
      '--direction',
      direction,
      '--cwd',
      '/a',
      '--env',
      'ORC=1',
      '--env',
      'ORC_ROLE=implementer',
      '--no-focus',
    ]);
    assert.deepEqual(call(deps, 'herdr agent start').slice(-7), [
      '--kind',
      'codex',
      '--pane',
      'new',
      '--',
      '--sandbox',
      'workspace-write',
    ]);
  }
});

test('start: not-sent for agent_not_ready or agent_blocked; started with state blocked', () => {
  const notReady = fake({ ...NO_TAB, ...CREATE, 'herdr agent start': err('agent_not_ready') });
  assert.deepEqual(run(START, notReady, '/r'), {
    code: 0,
    result: {
      status: 'not-sent',
      state: 'blocked',
      task: 'T',
      name: NAME,
      pane: 'p1',
      path: '/a',
      kind: 'claude',
    },
  });
  assert.equal(call(notReady, 'herdr agent prompt'), undefined);
  assert.equal(call(notReady, 'herdr pane close'), undefined);

  const routes = { ...NO_TAB, ...CREATE, 'herdr agent start': agent({}) };
  const atDialog = fake({ ...routes, 'herdr agent prompt': err('agent_blocked') });
  const r1 = run(START, atDialog, '/r');
  assert.equal(r1.code, 0);
  assert.equal(r1.result.status, 'not-sent');
  assert.equal(r1.result.state, 'blocked');

  const blockedAfter = fake({ ...routes, 'herdr agent prompt': prompted('blocked') });
  const r2 = run(START, blockedAfter, '/r');
  assert.equal(r2.result.status, 'started');
  assert.equal(r2.result.state, 'blocked');
});

test('start re-run reuses the live agent and its pane, and only sends the prompt', () => {
  const deps = fake(
    {
      'herdr agent get': agent({ pane_id: 'p7', agent_status: 'idle' }),
      'herdr agent prompt': prompted(),
    },
    { files: { '/a/.orc/report.md': 'stale' } },
  );
  assert.deepEqual(run([...START, '--kind', 'codex'], deps, '/r'), {
    code: 0,
    result: {
      status: 'started',
      state: 'working',
      task: 'T',
      name: NAME,
      pane: 'p7',
      path: '/a',
      kind: 'codex',
    },
  });
  assert.deepEqual(
    deps.calls.map((c) => c.slice(0, 3).join(' ')),
    ['herdr agent get', 'herdr agent prompt'],
  );
  assert.deepEqual(deps.fs, {});
});

test('start closes the pane it opened when agent start fails', () => {
  const deps = fake({
    ...NO_TAB,
    ...CREATE,
    'herdr agent start': err('kind_not_installed'),
    'herdr pane close': ok({ type: 'ok' }),
  });
  const { code, result } = run(START, deps, '/r');
  assert.equal(code, 1);
  assert.deepEqual(result, { status: 'error', task: 'T', stderr: result.stderr });
  assert.match(result.stderr, /kind_not_installed/);
  assert.deepEqual(call(deps, 'herdr pane close'), ['herdr', 'pane', 'close', 'p1']);
  assert.equal(call(deps, 'herdr agent prompt'), undefined);
});

test('start errors: herdr failures, malformed responses, an undeletable report', () => {
  const started = { ...NO_TAB, ...CREATE, 'herdr agent start': agent({}) };
  const cases = [
    [{ 'herdr agent get': err('server_down', 'no server') }, /server_down/],
    [{ 'herdr agent get': agent({ cwd: '/a' }) }, /no pane_id/],
    [{ 'herdr tab list': err('server_down', 'no server') }, /server_down/],
    [{ 'herdr tab list': ok({ type: 'tab_list' }) }, /no tabs array/],
    [
      { 'herdr tab list': { status: 0, stdout: 'not json', stderr: '' } },
      /unparseable herdr output/,
    ],
    [{ 'herdr tab list': ok(null) }, /unparseable/],
    [{ ...NO_TAB, 'herdr tab create': ok({ type: 'tab_created', root_pane: {} }) }, /no pane_id/],
    [{ ...NO_TAB, 'herdr tab create': err('bad') }, /bad/],
    [{ ...TAB, 'herdr pane list': err('gone') }, /gone/],
    [{ ...TAB, 'herdr pane list': ok({ type: 'pane_list' }) }, /no panes array/],
    [{ ...TAB, 'herdr pane list': panes() }, /tab orc:F has no panes/],
    [{ ...TAB, 'herdr pane list': panes('p1'), 'herdr pane split': err('nope') }, /nope/],
    [
      { ...NO_TAB, ...CREATE, 'herdr agent start': { status: 2, stdout: '', stderr: 'usage' } },
      /^usage$/,
    ],
    [{ ...started, 'herdr agent prompt': err('agent_prompt_stalled') }, /agent_prompt_stalled/],
    [{ ...started, 'herdr agent prompt': ok({ type: 'agent_prompted' }) }, /no agent_status/],
  ];
  for (const [routes, stderr] of cases) {
    const { code, result } = run(START, fake({ ...NEW, ...routes }), '/r');
    assert.equal(code, 1);
    assert.equal(result.status, 'error');
    assert.equal(result.task, 'T');
    assert.match(result.stderr, stderr);
  }
  const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
  const locked = fake({ ...started }, { unlinkError: eacces });
  const r = run(START, locked, '/r');
  assert.equal(r.code, 1);
  assert.equal(r.result.stderr, 'orc: cannot delete /a/.orc/report.md: denied');
  assert.equal(call(locked, 'herdr agent prompt'), undefined);
});

test('herdr: a failing command without stderr reports stdout and no code', () => {
  const deps = fake({ 'herdr x': { status: 1, stdout: 'out', stderr: '' } });
  assert.deepEqual(herdr(deps, ['x']), { error: 'out', code: null });
});

test('wait: settled state with a report that has evidence; default 30 min timeout', () => {
  const name = agentName('T', '/r/wt');
  const deps = fake(
    {
      'herdr agent wait': agent({ agent_status: 'idle' }),
      'herdr agent get': agent({ agent_status: 'idle' }),
    },
    { files: { '/r/wt/.orc/report.md': REPORT } },
  );
  assert.deepEqual(run(['wait', 'T', '--path', 'wt'], deps, '/r'), {
    code: 0,
    result: { task: 'T', state: 'idle', report: '/r/wt/.orc/report.md', evidence: true },
  });
  assert.equal(WAIT_TIMEOUT, '1800000');
  assert.deepEqual(deps.calls, [
    ['herdr', 'agent', 'get', name],
    ['herdr', 'agent', 'wait', name, '--timeout', WAIT_TIMEOUT],
    ['herdr', 'agent', 'get', name],
  ]);
  run(['wait', 'T', '--path', 'wt', '--timeout', '5000'], deps, '/r');
  assert.deepEqual(deps.calls[4], ['herdr', 'agent', 'wait', name, '--timeout', '5000']);
});

test('wait on a blocked agent first waits for the dialog to clear, then settles', () => {
  let gets = 0;
  const deps = fake({ 'herdr agent wait': agent({}) }, { files: { '/a/.orc/report.md': 'x' } });
  const exec = deps.exec.bind(deps);
  deps.exec = (cmd, args) => {
    if (args[1] === 'get') {
      deps.calls.push([cmd, ...args]);
      gets += 1;
      return agent({ agent_status: gets === 1 ? 'blocked' : 'idle' });
    }
    return exec(cmd, args);
  };
  assert.deepEqual(run(['wait', 'T', '--path', '/a', '--timeout', '9'], deps, '/r').result, {
    task: 'T',
    state: 'idle',
    report: '/a/.orc/report.md',
    evidence: false,
  });
  const until = ['--until', 'working', '--until', 'idle', '--until', 'done'];
  assert.deepEqual(deps.calls.slice(1, 3), [
    ['herdr', 'agent', 'wait', NAME, ...until, '--timeout', '9'],
    ['herdr', 'agent', 'wait', NAME, '--timeout', '9'],
  ]);
});

test('wait: a timeout at either step gives state timeout; a missing report is null', () => {
  const plain = fake({
    'herdr agent get': agent({ agent_status: 'working' }),
    'herdr agent wait': err('timeout'),
  });
  assert.deepEqual(run(['wait', 'T', '--path', '/a'], plain, '/r'), {
    code: 0,
    result: { task: 'T', state: 'timeout', report: null, evidence: false },
  });
  assert.equal(plain.calls.length, 2);

  const blocked = fake({
    'herdr agent get': agent({ agent_status: 'blocked' }),
    'herdr agent wait': err('timeout'),
  });
  assert.equal(run(['wait', 'T', '--path', '/a'], blocked, '/r').result.state, 'timeout');
  assert.equal(blocked.calls.length, 2);
  assert.ok(blocked.calls[1].includes('--until'));
});

test('wait errors: first get, wait failure, final get, missing agent_status', () => {
  const idle = { 'herdr agent get': agent({ agent_status: 'idle' }) };
  const cases = [
    [{ 'herdr agent get': err('agent_not_found') }, /agent_not_found/],
    [{ 'herdr agent get': ok({ type: 'agent_info' }) }, /no agent_status/],
    [{ ...idle, 'herdr agent wait': err('server_down') }, /server_down/],
  ];
  for (const [routes, stderr] of cases) {
    const { code, result } = run(['wait', 'T', '--path', '/a'], fake(routes), '/r');
    assert.equal(code, 1);
    assert.equal(result.status, 'error');
    assert.match(result.stderr, stderr);
  }
  const deps = fake({ 'herdr agent wait': agent({}) });
  let gets = 0;
  const exec = deps.exec.bind(deps);
  deps.exec = (cmd, args) => {
    if (args[1] !== 'get') return exec(cmd, args);
    gets += 1;
    return gets === 1 ? agent({ agent_status: 'working' }) : err('gone');
  };
  assert.match(run(['wait', 'T', '--path', '/a'], deps, '/r').result.stderr, /gone/);
});

test('prompt: Follow-up text, fresh report, waits for activity', () => {
  const deps = fake(
    { 'herdr agent prompt': prompted() },
    { files: { '/a/.orc/report.md': 'old' } },
  );
  assert.deepEqual(run(['prompt', 'T', '--path', '/a', '--text=-fix the test'], deps, '/r'), {
    code: 0,
    result: { status: 'prompted', state: 'working', task: 'T', name: NAME },
  });
  assert.deepEqual(deps.unlinked, ['/a/.orc/report.md']);
  const tail =
    'When done, rewrite your full report (Status, Changes, Validation, Notes, Docs) to /a/.orc/report.md.';
  assert.deepEqual(deps.calls[0], [
    'herdr',
    'agent',
    'prompt',
    NAME,
    `Follow-up: -fix the test ${tail}`,
    ...PROMPT_WAIT,
  ]);
  run(['prompt', 'T', '--path', '/a', '--file', 'fix.md'], deps, '/r');
  assert.equal(deps.calls[1][4], `Follow-up: read and act on /r/fix.md. ${tail}`);
});

test('prompt: not-sent at a dialog; errors for herdr and an undeletable report', () => {
  const argv = ['prompt', 'T', '--path', '/a', '--text', 'x'];
  assert.deepEqual(run(argv, fake({ 'herdr agent prompt': err('agent_blocked') }), '/r'), {
    code: 0,
    result: { status: 'not-sent', state: 'blocked', task: 'T', name: NAME },
  });
  const blockedAfter = run(argv, fake({ 'herdr agent prompt': prompted('blocked') }), '/r');
  assert.equal(blockedAfter.result.status, 'prompted');
  assert.equal(blockedAfter.result.state, 'blocked');
  const failed = run(argv, fake({ 'herdr agent prompt': err('agent_prompt_stalled') }), '/r');
  assert.equal(failed.code, 1);
  assert.match(failed.result.stderr, /agent_prompt_stalled/);
  const locked = fake({}, { unlinkError: Object.assign(new Error('ro'), { code: 'EROFS' }) });
  assert.match(run(argv, locked, '/r').result.stderr, /cannot delete \/a\/\.orc\/report\.md: ro/);
  assert.equal(locked.calls.length, 0);
});

const tabInfo = (label) => ok({ type: 'tab_info', tab: { tab_id: 't1', label } });
const IN_TAB = {
  'herdr agent get': agent({ cwd: '/r/.git/wt/trash/F--T-1', pane_id: 'p3', tab_id: 't1' }),
};
const CLOSE = ['close', 'T', '--path', '/a'];

test('close closes the pane of an agent in an orc:* tab, whatever its cwd', () => {
  const deps = fake({
    ...IN_TAB,
    'herdr tab get': tabInfo('orc:F'),
    'herdr pane close': ok({ type: 'ok' }),
  });
  assert.deepEqual(run(CLOSE, deps, '/r'), {
    code: 0,
    result: { status: 'closed', task: 'T', pane: 'p3' },
  });
  assert.deepEqual(deps.calls, [
    ['herdr', 'agent', 'get', NAME],
    ['herdr', 'tab', 'get', 't1'],
    ['herdr', 'pane', 'close', 'p3'],
  ]);
});

test('close refuses outside an orc:* tab and reports herdr failures', () => {
  const refused = [
    { ...IN_TAB, 'herdr tab get': tabInfo('main') },
    { ...IN_TAB, 'herdr tab get': ok({ type: 'tab_info' }) },
    { 'herdr agent get': agent({ pane_id: 'p1' }) },
    { 'herdr agent get': agent({ tab_id: 't1' }) },
    { 'herdr agent get': ok({ type: 'agent_info' }) },
  ];
  for (const routes of refused) {
    const deps = fake(routes);
    assert.deepEqual(run(CLOSE, deps, '/r'), {
      code: 1,
      result: { status: 'refused', task: 'T', stderr: `orc: ${NAME} is not in an orc:* tab` },
    });
    assert.ok(!call(deps, 'herdr pane close'));
  }
  const errors = [
    [{ 'herdr agent get': err('gone') }, /gone/],
    [{ ...IN_TAB, 'herdr tab get': err('tab_not_found') }, /tab_not_found/],
    [{ ...IN_TAB, 'herdr tab get': tabInfo('orc:F'), 'herdr pane close': err('busy') }, /busy/],
  ];
  for (const [routes, stderr] of errors) {
    const { code, result } = run(CLOSE, fake(routes), '/r');
    assert.equal(code, 1);
    assert.equal(result.status, 'error');
    assert.match(result.stderr, stderr);
  }
});
