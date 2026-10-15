import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentName, GATE_ERROR, herdr, run } from '../scripts/orch-pane.mjs';

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

/** Fake deps: `routes` maps a "herdr arg ..." prefix (longest first wins) to a result. */
function fake(routes = {}, { env = {}, files = {} } = {}) {
  const calls = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  return {
    calls,
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
      if (Object.hasOwn(files, p)) return files[p];
      throw new Error(`ENOENT ${p}`);
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
  'herdr tab list': ok({ type: 'tab_list', tabs: [{ label: 'orch:F', tab_id: 't1' }] }),
};
const panes = (...ids) =>
  ok({
    type: 'pane_list',
    panes: [{ tab_id: 't0', pane_id: 'x' }, ...ids.map((pane_id) => ({ tab_id: 't1', pane_id }))],
  });

test('gate: needs HERDR_ENV=1, a workspace id and herdr on PATH', () => {
  const cases = [
    { env: { HERDR_ENV: '0' } },
    { env: { HERDR_WORKSPACE_ID: '' } },
    { hasCommand: () => false },
  ];
  for (const { env = {}, hasCommand } of cases) {
    const deps = fake({}, { env });
    if (hasCommand) deps.hasCommand = hasCommand;
    assert.deepEqual(run(['close', 'T'], deps, '/r'), {
      code: 1,
      result: { status: 'error', stderr: GATE_ERROR },
    });
    assert.equal(deps.calls.length, 0);
  }
});

test('usage errors: bad flags, unknown command, missing args, bad kind, text and file', () => {
  const argvs = [
    ['start', 'F', 'T', '--bogus'],
    ['nope'],
    [],
    ['start', 'F', 'T'],
    ['start', 'F', 'T', '--path', 'p', '--kind', 'gemini'],
    ['wait', 'T'],
    ['prompt', 'T'],
    ['prompt', 'T', '--text', 'a', '--file', 'b'],
    ['close'],
  ];
  for (const argv of argvs) {
    const { code, result } = run(argv, fake(), '/r');
    assert.equal(code, 1, argv.join(' '));
    assert.match(result.stderr, /usage: orch pane start/);
  }
});

test('agentName lowercases, replaces other chars and truncates to 32', () => {
  assert.equal(agentName('Parse_CSV v2'), 'orch-parse_csv-v2');
  assert.equal(agentName('x'.repeat(40)).length, 32);
  assert.match(agentName('Ünï'), /^[a-z][a-z0-9_-]{0,31}$/);
});

test('start in a new tab: tab create with env, claude on sonnet, then the prompt', () => {
  const deps = fake({
    ...NO_TAB,
    'herdr tab create': ok({ type: 'tab_created', tab: {}, root_pane: { pane_id: 'p1' } }),
    'herdr agent start': agent({ agent_status: 'idle' }),
    'herdr agent prompt': prompted(),
  });
  const { code, result } = run(['start', 'F', 'Csv', '--path', 'wt/csv'], deps, '/r');
  assert.equal(code, 0);
  assert.deepEqual(result, {
    status: 'started',
    task: 'Csv',
    name: 'orch-csv',
    pane: 'p1',
    path: '/r/wt/csv',
    kind: 'claude',
  });
  assert.deepEqual(deps.calls.slice(0, 4), [
    ['herdr', 'agent', 'get', 'orch-csv'],
    ['herdr', 'tab', 'list', '--workspace', 'w1'],
    [
      'herdr',
      'tab',
      'create',
      '--workspace',
      'w1',
      '--label',
      'orch:F',
      '--cwd',
      '/r/wt/csv',
      '--env',
      'ORCH=1',
      '--env',
      'ORCH_ROLE=implementer',
      '--no-focus',
    ],
    [
      'herdr',
      'agent',
      'start',
      'orch-csv',
      '--kind',
      'claude',
      '--pane',
      'p1',
      '--',
      '--model',
      'sonnet',
    ],
  ]);
  const [, , , name, text, ...rest] = deps.calls[4];
  assert.equal(name, 'orch-csv');
  assert.deepEqual(rest, [
    '--wait',
    '--until',
    'working',
    '--until',
    'blocked',
    '--timeout',
    '30000',
  ]);
  assert.match(
    text,
    /^You are an orch implementer\. Read and follow \/plugin\/agents\/implementer\.md\./,
  );
  assert.match(text, /Your brief: the plan task Csv in \.scratch\/F\/plan\.md\./);
  assert.match(text, /Work only in \/r\/wt\/csv\. Do not commit\./);
  assert.match(
    text,
    /\(Status, Changes, Validation, Notes, Docs\) to \/r\/wt\/csv\/\.orch\/report\.md\.$/,
  );
});

test('start with ORCH_LEVEL=high passes the level env and runs claude on opus; --brief is absolute', () => {
  const deps = fake(
    {
      ...NO_TAB,
      'herdr tab create': ok({ type: 'tab_created', root_pane: { pane_id: 'p1' } }),
      'herdr agent start': agent({}),
      'herdr agent prompt': prompted(),
    },
    { env: { ORCH_LEVEL: 'high' } },
  );
  assert.equal(run(['start', 'F', 'T', '--path', '/a', '--brief', 'b.md'], deps, '/r').code, 0);
  assert.deepEqual(call(deps, 'herdr tab create').slice(-3), [
    '--env',
    'ORCH_LEVEL=high',
    '--no-focus',
  ]);
  assert.deepEqual(call(deps, 'herdr agent start').slice(-2), ['--model', 'opus']);
  assert.match(call(deps, 'herdr agent prompt')[4], /Your brief: \/r\/b\.md\./);
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
    const { result } = run(['start', 'F', 'T', '--path', '/a', '--kind', 'codex'], deps, '/r');
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
      'ORCH=1',
      '--env',
      'ORCH_ROLE=implementer',
      '--no-focus',
    ]);
    assert.deepEqual(call(deps, 'herdr agent start').slice(-4), [
      '--kind',
      'codex',
      '--pane',
      'new',
    ]);
  }
});

test('start reports blocked for agent_not_ready and for a prompt that blocks', () => {
  const routes = {
    ...NO_TAB,
    'herdr tab create': ok({ type: 'tab_created', root_pane: { pane_id: 'p1' } }),
  };
  const notReady = fake({ ...routes, 'herdr agent start': err('agent_not_ready') });
  const r1 = run(['start', 'F', 'T', '--path', '/a'], notReady, '/r');
  assert.equal(r1.code, 0);
  assert.equal(r1.result.status, 'blocked');
  assert.equal(r1.result.pane, 'p1');
  assert.equal(call(notReady, 'herdr agent prompt'), undefined);

  const blocked = fake({
    ...routes,
    'herdr agent start': agent({}),
    'herdr agent prompt': prompted('blocked'),
  });
  assert.equal(run(['start', 'F', 'T', '--path', '/a'], blocked, '/r').result.status, 'blocked');

  const atDialog = fake({
    ...routes,
    'herdr agent start': agent({}),
    'herdr agent prompt': err('agent_blocked'),
  });
  const r2 = run(['start', 'F', 'T', '--path', '/a'], atDialog, '/r');
  assert.equal(r2.code, 0);
  assert.equal(r2.result.status, 'blocked');
});

test('start re-run reuses the live agent and its pane, and only sends the prompt', () => {
  const deps = fake({
    'herdr agent get': agent({ pane_id: 'p7', agent_status: 'idle' }),
    'herdr agent prompt': prompted(),
  });
  assert.deepEqual(run(['start', 'F', 'T', '--path', '/a', '--kind', 'codex'], deps, '/r'), {
    code: 0,
    result: { status: 'started', task: 'T', name: 'orch-t', pane: 'p7', path: '/a', kind: 'codex' },
  });
  assert.deepEqual(
    deps.calls.map((c) => c.slice(0, 3).join(' ')),
    ['herdr agent get', 'herdr agent prompt'],
  );
});

test('start errors: herdr failures and malformed responses', () => {
  const create = { 'herdr tab create': ok({ type: 'tab_created', root_pane: { pane_id: 'p1' } }) };
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
    [{ ...TAB, 'herdr pane list': panes() }, /tab orch:F has no panes/],
    [{ ...TAB, 'herdr pane list': panes('p1'), 'herdr pane split': err('nope') }, /nope/],
    [
      { ...NO_TAB, ...create, 'herdr agent start': { status: 2, stdout: '', stderr: 'usage' } },
      /^usage$/,
    ],
    [
      {
        ...NO_TAB,
        ...create,
        'herdr agent start': agent({}),
        'herdr agent prompt': err('agent_prompt_stalled'),
      },
      /agent_prompt_stalled/,
    ],
    [
      {
        ...NO_TAB,
        ...create,
        'herdr agent start': agent({}),
        'herdr agent prompt': ok({ type: 'agent_prompted' }),
      },
      /no agent_status/,
    ],
  ];
  for (const [routes, stderr] of cases) {
    const { code, result } = run(
      ['start', 'F', 'T', '--path', '/a'],
      fake({ ...NEW, ...routes }),
      '/r',
    );
    assert.equal(code, 1);
    assert.equal(result.status, 'error');
    assert.equal(result.task, 'T');
    assert.match(result.stderr, stderr);
  }
});

test('herdr: a failing command without stderr reports stdout and no code', () => {
  const deps = fake({ 'herdr x': { status: 1, stdout: 'out', stderr: '' } });
  assert.deepEqual(herdr(deps, ['x']), { error: 'out', code: null });
});

test('wait: settled state with a report that has evidence', () => {
  const deps = fake(
    {
      'herdr agent wait': agent({ agent_status: 'idle' }),
      'herdr agent get': agent({ agent_status: 'idle' }),
    },
    { files: { '/r/wt/.orch/report.md': REPORT } },
  );
  assert.deepEqual(run(['wait', 'T', '--path', 'wt', '--timeout', '5000'], deps, '/r'), {
    code: 0,
    result: { task: 'T', state: 'idle', report: '/r/wt/.orch/report.md', evidence: true },
  });
  assert.deepEqual(deps.calls[0], ['herdr', 'agent', 'wait', 'orch-t', '--timeout', '5000']);
});

test('wait: blocked, report without evidence', () => {
  const deps = fake(
    { 'herdr agent wait': agent({}), 'herdr agent get': agent({ agent_status: 'blocked' }) },
    { files: { '/a/.orch/report.md': 'done, trust me' } },
  );
  assert.deepEqual(run(['wait', 'T', '--path', '/a'], deps, '/r').result, {
    task: 'T',
    state: 'blocked',
    report: '/a/.orch/report.md',
    evidence: false,
  });
  assert.deepEqual(deps.calls[0], ['herdr', 'agent', 'wait', 'orch-t']);
});

test('wait: timeout skips agent get; a missing report is null', () => {
  const deps = fake({ 'herdr agent wait': err('timeout') });
  assert.deepEqual(run(['wait', 'T', '--path', '/a'], deps, '/r'), {
    code: 0,
    result: { task: 'T', state: 'timeout', report: null, evidence: false },
  });
  assert.equal(deps.calls.length, 1);
});

test('wait errors: wait failure, get failure, missing agent_status', () => {
  const cases = [
    [{ 'herdr agent wait': err('agent_not_found') }, /agent_not_found/],
    [{ 'herdr agent wait': agent({}), 'herdr agent get': err('gone') }, /gone/],
    [
      { 'herdr agent wait': agent({}), 'herdr agent get': ok({ type: 'agent_info' }) },
      /no agent_status/,
    ],
  ];
  for (const [routes, stderr] of cases) {
    const { code, result } = run(['wait', 'T', '--path', '/a'], fake(routes), '/r');
    assert.equal(code, 1);
    assert.deepEqual(result.status, 'error');
    assert.match(result.stderr, stderr);
  }
});

test('prompt sends --text as is, --file as an absolute pointer, and waits for activity', () => {
  const deps = fake({ 'herdr agent prompt': prompted() });
  assert.deepEqual(run(['prompt', 'T', '--text', 'fix the test'], deps, '/r'), {
    code: 0,
    result: { status: 'prompted', task: 'T', name: 'orch-t' },
  });
  assert.deepEqual(deps.calls[0], [
    'herdr',
    'agent',
    'prompt',
    'orch-t',
    'fix the test',
    '--wait',
    '--until',
    'working',
    '--until',
    'blocked',
    '--timeout',
    '30000',
  ]);
  run(['prompt', 'T', '--file', 'fix.md'], deps, '/r');
  assert.equal(deps.calls[1][4], 'Read and act on /r/fix.md');

  const blocked = fake({ 'herdr agent prompt': prompted('blocked') });
  assert.equal(run(['prompt', 'T', '--text', 'x'], blocked, '/r').result.status, 'blocked');
  const atDialog = fake({ 'herdr agent prompt': err('agent_blocked') });
  assert.deepEqual(run(['prompt', 'T', '--text', 'x'], atDialog, '/r'), {
    code: 0,
    result: { status: 'blocked', task: 'T', name: 'orch-t' },
  });
  const failed = run(
    ['prompt', 'T', '--text', 'x'],
    fake({ 'herdr agent prompt': err('agent_prompt_stalled') }),
    '/r',
  );
  assert.equal(failed.code, 1);
  assert.match(failed.result.stderr, /agent_prompt_stalled/);
});

const tabInfo = (label) => ok({ type: 'tab_info', tab: { tab_id: 't1', label } });
const IN_TAB = {
  'herdr agent get': agent({ cwd: '/r/.git/wt/trash/F--T-1', pane_id: 'p3', tab_id: 't1' }),
};

test('close closes the pane of an agent in an orch:* tab, whatever its cwd', () => {
  const deps = fake({
    ...IN_TAB,
    'herdr tab get': tabInfo('orch:F'),
    'herdr pane close': ok({ type: 'ok' }),
  });
  assert.deepEqual(run(['close', 'T'], deps, '/r'), {
    code: 0,
    result: { status: 'closed', task: 'T', pane: 'p3' },
  });
  assert.deepEqual(deps.calls.slice(1), [
    ['herdr', 'tab', 'get', 't1'],
    ['herdr', 'pane', 'close', 'p3'],
  ]);
});

test('close refuses outside an orch:* tab and reports herdr failures', () => {
  const refused = [
    { ...IN_TAB, 'herdr tab get': tabInfo('main') },
    { ...IN_TAB, 'herdr tab get': ok({ type: 'tab_info' }) },
    { 'herdr agent get': agent({ pane_id: 'p1' }) },
    { 'herdr agent get': agent({ tab_id: 't1' }) },
    { 'herdr agent get': ok({ type: 'agent_info' }) },
  ];
  for (const routes of refused) {
    const deps = fake(routes);
    assert.deepEqual(run(['close', 'T'], deps, '/r'), {
      code: 1,
      result: { status: 'refused', task: 'T', stderr: 'orch: orch-t is not in an orch:* tab' },
    });
    assert.ok(!call(deps, 'herdr pane close'));
  }
  const errors = [
    [{ 'herdr agent get': err('gone') }, /gone/],
    [{ ...IN_TAB, 'herdr tab get': err('tab_not_found') }, /tab_not_found/],
    [{ ...IN_TAB, 'herdr tab get': tabInfo('orch:F'), 'herdr pane close': err('busy') }, /busy/],
  ];
  for (const [routes, stderr] of errors) {
    const { code, result } = run(['close', 'T'], fake(routes), '/r');
    assert.equal(code, 1);
    assert.equal(result.status, 'error');
    assert.match(result.stderr, stderr);
  }
});
