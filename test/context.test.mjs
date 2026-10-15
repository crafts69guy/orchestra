import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALWAYS_WARN_TOKENS,
  analyze,
  collect,
  findImports,
  findPaths,
  parseToml,
  run,
  tokens,
} from '../scripts/context.mjs';

const HOME = '/h';
const ROOT = '/h/proj';

/** Fake io over a `{ path: content }` map; directories are implied by file paths. */
function fakeIo(files, { unreadable = [], exec, cwd = ROOT } = {}) {
  const dirs = new Set();
  for (const p of Object.keys(files)) {
    for (let d = p.slice(0, p.lastIndexOf('/')); d; d = d.slice(0, d.lastIndexOf('/'))) dirs.add(d);
  }
  return {
    env: { HOME },
    cwd,
    exists: (p) => p in files || dirs.has(p),
    read: (p) => {
      if (unreadable.includes(p)) throw new Error('EACCES');
      return files[p];
    },
    readdir: (d) => [
      ...new Set(
        Object.keys(files)
          .filter((p) => p.startsWith(`${d}/`))
          .map((p) => p.slice(d.length + 1).split('/')[0]),
      ),
    ],
    exec: exec ?? (() => ({ status: 0, stdout: `${ROOT}\n`, stderr: '' })),
  };
}

const skill = (desc, body = 'body') => `---\nname: x\ndescription: ${desc}\n---\n${body}`;
const names = (r) => r.findings.map((f) => f.name);

test('findImports keeps path-like @tokens outside code', () => {
  const text = [
    'see @./a.md and @~/b.md, not @anthropic-ai/sdk or mail@x.com',
    '`@./inline.md`',
    '```',
    '@./fenced.md',
    '```',
    '@/abs/c.md. @file.txt',
  ].join('\n');
  assert.deepEqual(findImports(text), ['./a.md', '~/b.md', '/abs/c.md', 'file.txt']);
});

test('findPaths returns backticked absolute paths only', () => {
  assert.deepEqual(findPaths('`~/a/b` `/usr/bin` `/context` `/x/*.md` `/bin/...` `plain`'), [
    '~/a/b',
    '/usr/bin',
  ]);
});

test('parseToml reads top keys and sections', () => {
  const t = parseToml('a = 1\n[plugins."x@m"]\nenabled = false # c\n[mcp_servers.s.env]\nK = "v"');
  assert.equal(t.top.a, '1');
  assert.equal(t.sections.get('plugins.x@m').enabled, 'false');
  assert.ok(t.sections.has('mcp_servers.s.env'));
});

test('claude memory: imports counted, broken/cycle/depth/dangling reported', () => {
  const files = {
    [`${HOME}/.claude/CLAUDE.md`]: 'user mem',
    [`${ROOT}/CLAUDE.md`]: 'root @./a.md @./gone.md `~/nope/x` `/h/proj/CLAUDE.md`',
    [`${ROOT}/a.md`]: 'a @./b.md @./cyc.md',
    [`${ROOT}/b.md`]: 'b @./c.md',
    [`${ROOT}/c.md`]: 'c @./d.md',
    [`${ROOT}/d.md`]: 'd @./e.md',
    [`${ROOT}/e.md`]: 'e @./f.md',
    [`${ROOT}/f.md`]: 'f @./g.md',
    [`${ROOT}/g.md`]: 'g',
    [`${ROOT}/cyc.md`]: 'cyc @./a.md',
    [`${ROOT}/CLAUDE.local.md`]: 'local',
  };
  const r = collect(fakeIo(files), ROOT);
  const mem = r.sources.filter((s) => s.kind === 'memory' && s.harness === 'claude');
  assert.deepEqual(
    mem.map((s) => s.name),
    ['~/.claude/CLAUDE.md', '~/proj/CLAUDE.md', '~/proj/CLAUDE.local.md'],
  );
  assert.ok(mem[1].always > files[`${ROOT}/CLAUDE.md`].length);
  assert.deepEqual(names(r).sort(), [
    'broken-import',
    'dangling-path',
    'import-cycle',
    'import-depth',
  ]);
  assert.equal(r.findings.find((f) => f.name === 'broken-import').mark, '✗');
});

test('claude skills, agents, commands, plugins, hooks and MCP', () => {
  const inst = '/h/.claude/plugins/cache/p/1';
  const files = {
    [`${HOME}/.claude/skills/s1/SKILL.md`]: skill('does the thing'),
    [`${HOME}/.claude/skills/.hidden/SKILL.md`]: skill('hidden'),
    [`${ROOT}/.claude/agents/a1.md`]: skill('an agent'),
    [`${ROOT}/.claude/agents/notes.txt`]: 'ignored',
    [`${ROOT}/.claude/commands/c1.md`]: 'no frontmatter',
    [`${HOME}/.claude/settings.json`]: JSON.stringify({
      enabledPlugins: { 'p@m': true, 'off@m': false, 'gone@m': true },
      hooks: { SessionStart: [{}] },
    }),
    [`${ROOT}/.claude/settings.json`]: JSON.stringify({ enabledPlugins: { 'p@m': true } }),
    [`${ROOT}/.claude/settings.local.json`]: JSON.stringify({ enabledPlugins: { 'q@m': true } }),
    [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
      plugins: {
        'p@m': [{ scope: 'user', installPath: inst }],
        'q@m': [
          { scope: 'project', projectPath: '/other', installPath: '/h/q' },
          { scope: 'project', projectPath: ROOT, installPath: '/h/q' },
        ],
        'gone@m': [{ scope: 'user' }],
      },
    }),
    [`${inst}/skills/ps/SKILL.md`]: skill('plugin skill'),
    [`${inst}/hooks/hooks.json`]: JSON.stringify({ hooks: { SessionStart: [] } }),
    '/h/q/commands/qc.md': 'cmd',
    [`${HOME}/.claude.json`]: JSON.stringify({
      mcpServers: { u: {} },
      projects: { [ROOT]: { mcpServers: { p: {} } } },
    }),
    [`${ROOT}/.mcp.json`]: JSON.stringify({ mcpServers: { m: {} } }),
  };
  const r = collect(fakeIo(files), ROOT);
  const claude = r.sources.filter((s) => s.harness === 'claude');
  const key = (s) => `${s.kind}:${s.name}:${s.origin}:${s.scope}`;
  assert.deepEqual(claude.map(key).sort(), [
    'agent:x:project:project',
    'command:c1:project:project',
    'command:qc:q@m:project',
    'hook:SessionStart:p@m:user',
    'hook:SessionStart:user:user',
    'mcp:m:project:project',
    'mcp:p:project:project',
    'mcp:u:user:user',
    'skill:x:p@m:user',
    'skill:x:user:user',
  ]);
  assert.deepEqual(names(r), ['plugin-both-scopes']);
  assert.equal(r.findings[0].detail, 'p@m');
});

test('unreadable and invalid files become findings, never throw', () => {
  const files = {
    [`${HOME}/.claude/CLAUDE.md`]: 'x',
    [`${HOME}/.claude/settings.json`]: '{bad',
    [`${HOME}/.claude/skills/s/SKILL.md`]: skill('d'),
  };
  const io = fakeIo(files, {
    unreadable: [`${HOME}/.claude/CLAUDE.md`, `${HOME}/.claude/skills/s/SKILL.md`],
  });
  const r = collect(io, ROOT);
  assert.deepEqual(names(r), ['unreadable', 'unreadable', 'unreadable']);
  const broken = {
    ...io,
    readdir: () => {
      throw new Error('boom');
    },
  };
  assert.equal(collect(broken, ROOT).sources.length, 1);
});

test('block-scalar descriptions are re-read from the indented lines', () => {
  const files = {
    [`${HOME}/.claude/skills/s/SKILL.md`]:
      '---\nname: s\ndescription: >\n  first line\n  second line\n---\nbody',
    [`${HOME}/.claude/skills/t/SKILL.md`]: '---\nname: t\ndescription: |\n---\nbody',
  };
  const { sources } = collect(fakeIo(files), ROOT);
  assert.equal(sources.find((s) => s.name === 's').description, 'first line second line');
  assert.equal(sources.find((s) => s.name === 't').description, '');
});

test('codex: memory chain, doc limit, skills, plugins, MCP', () => {
  const cache = `${HOME}/.codex/plugins/cache/mk/pl`;
  const files = {
    [`${HOME}/.codex/AGENTS.override.md`]: 'override',
    [`${HOME}/.codex/AGENTS.md`]: 'ignored',
    [`${HOME}/.codex/config.toml`]: [
      'project_doc_max_bytes = 100',
      '[plugins."pl@mk"]',
      'enabled = true',
      '[plugins."off@mk"]',
      'enabled = false',
      '[plugins."nover@mk"]',
      '[mcp_servers.srv]',
      '[mcp_servers.srv.env]',
    ].join('\n'),
    [`${ROOT}/AGENTS.md`]: 'x'.repeat(60),
    [`${ROOT}/sub/AGENTS.override.md`]: 'y'.repeat(60),
    [`${HOME}/.codex/skills/cs/SKILL.md`]: skill('codex skill'),
    [`${HOME}/.codex/skills/.system/SKILL.md`]: skill('skip'),
    [`${HOME}/.agents/skills/as/SKILL.md`]: skill('agents skill'),
    [`${ROOT}/.agents/skills/ps/SKILL.md`]: skill('project skill'),
    [`${cache}/1.2.0/skills/old/SKILL.md`]: skill('old'),
    [`${cache}/1.10.0/skills/new/SKILL.md`]: skill('new'),
    [`${cache}/1.10.0/hooks.json`]: JSON.stringify({ SessionStart: [] }),
  };
  const r = collect(fakeIo(files, { cwd: `${ROOT}/sub` }), ROOT);
  const codex = r.sources.filter((s) => s.harness === 'codex');
  assert.deepEqual(codex.map((s) => `${s.kind}:${s.name}:${s.scope}`).sort(), [
    'hook:SessionStart:user',
    'mcp:srv:user',
    'memory:~/.codex/AGENTS.override.md:user',
    'memory:~/proj/AGENTS.md:project',
    'memory:~/proj/sub/AGENTS.override.md:project',
    'skill:x:project',
    'skill:x:user',
    'skill:x:user',
    'skill:x:user',
  ]);
  assert.ok(codex.some((s) => s.origin === 'pl@mk' && s.path.includes('/1.10.0/')));
  const limit = r.findings.find((f) => f.name === 'codex-doc-limit');
  assert.equal(limit.mark, '✗');
  assert.equal(run([], fakeIo(files, { cwd: `${ROOT}/sub` })).code, 1);
});

test('codex doc limit warns over 80% and is quiet below, default limit applies', () => {
  const near = fakeIo({ [`${ROOT}/AGENTS.md`]: 'x'.repeat(30000) });
  const f = collect(near, ROOT).findings.find((x) => x.name === 'codex-doc-limit');
  assert.equal(f.mark, '!');
  assert.deepEqual(collect(fakeIo({ [`${ROOT}/AGENTS.md`]: 'x' }), ROOT).findings, []);
});

test('analyze: budget, top, description, duplicate and overlap findings', () => {
  const long = 'x'.repeat(301);
  const s = (kind, name, origin, description, extra = {}) => ({
    harness: 'claude',
    scope: 'user',
    origin,
    kind,
    name,
    path: '/p',
    always: 0,
    listing: name.length + description.length,
    body: 0,
    description,
    ...extra,
  });
  const sources = [
    s('skill', 'a', 'user', 'parse csv files quickly'),
    s('skill', 'a', 'pl@m', 'parse csv files quickly'),
    s('agent', 'b', 'user', ''),
    s('skill', 'c', 'user', long),
    s('skill', 'p1', 'pl@m', `${long}y`),
    s('skill', 'p2', 'pl@m', `${long}yy`),
    s('skill', 'd', 'user', 'ALWAYS do this'),
    s('skill', 'e', 'user', 'Use for every task'),
    s('command', 'cmd', 'user', ''),
    s('skill', 'f', 'user', 'totally unrelated words here'),
    s('skill', 'g', 'user', 'a b c'),
    s('memory', 'm', 'user', '', { always: 4 * (ALWAYS_WARN_TOKENS + 1) }),
  ];
  const r = analyze({ sources, findings: [] });
  const by = (n) => r.findings.filter((f) => f.name === n);
  assert.equal(by('budget')[0].mark, '!');
  assert.equal(r.findings[0].name, 'budget');
  assert.equal(by('top').length, 5);
  assert.equal(by('description-missing').length, 1);
  assert.deepEqual(
    by('description-long').map((f) => f.detail),
    ['skill c (user): 301 chars', 'pl@m: 2 over 300 chars (p1 302, p2 303)'],
  );
  assert.equal(by('broad-trigger').length, 2);
  assert.equal(by('duplicate-name').length, 1);
  assert.equal(by('overlap').length, 1);
  assert.match(by('budget')[0].detail, /~6\.0k tokens/);
  assert.equal(tokens(5), 2);
});

test('analyze --scope filters sources and findings; empty harnesses are skipped', () => {
  const base = {
    harness: 'codex',
    origin: 'user',
    kind: 'mcp',
    name: 'n',
    path: '/p',
    always: 0,
    listing: 0,
    body: 0,
    description: '',
  };
  const sources = [
    { ...base, scope: 'user' },
    { ...base, scope: 'project', name: 'q' },
  ];
  const findings = [{ mark: '!', name: 'f', detail: '', harness: 'codex', scope: 'project' }];
  const user = analyze({ sources, findings }, { scope: 'user' });
  assert.equal(user.sources.length, 1);
  assert.deepEqual(names(user), ['budget']);
  assert.deepEqual(analyze({ sources: [], findings: [] }), { sources: [], findings: [] });
});

test('run: text output, json output, usage errors and exit codes', () => {
  const files = { [`${ROOT}/CLAUDE.md`]: 'hello @./gone.md', [`${ROOT}/AGENTS.md`]: 'x' };
  const text = run(['--scope', 'project'], fakeIo(files));
  assert.equal(text.code, 1);
  assert.match(text.out, /^claude\n {2}· budget {2}always-loaded/);
  assert.match(text.out, /\ncodex\n/);
  assert.match(text.out, /✗ broken-import/);
  const ok = run(['--json', '--scope=user'], fakeIo({}));
  assert.deepEqual(JSON.parse(ok.out), { sources: [], findings: [] });
  assert.equal(ok.code, 0);
  for (const bad of [['--nope'], ['--scope', 'x'], ['--scope']]) {
    const r = run(bad, fakeIo({}));
    assert.deepEqual([r.code, r.out], [1, '']);
    assert.match(r.err, /usage: orch context/);
  }
});

test('run: git root fallback and never throws', () => {
  const files = { [`${ROOT}/CLAUDE.md`]: 'x' };
  for (const exec of [
    () => ({ status: 128, stdout: '' }),
    () => {
      throw new Error('no git');
    },
  ]) {
    assert.match(run([], fakeIo(files, { exec })).out, /budget/);
  }
  const boom = {
    ...fakeIo(files),
    exists: () => {
      throw new Error('boom');
    },
  };
  const r = run([], boom);
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ context {2}boom/);
});

test('manual-only skills cost no listing and skip description checks', () => {
  const manualMd = (desc) =>
    `---\nname: m\ndescription: ${desc}\ndisable-model-invocation: true\n---\nbody`;
  const long = 'x'.repeat(301);
  const files = {
    [`${HOME}/.claude/skills/m1/SKILL.md`]: manualMd(`grill a plan ${long}`),
    [`${HOME}/.claude/skills/m2/SKILL.md`]: manualMd('grill a plan ALWAYS'),
    [`${HOME}/.claude/skills/auto/SKILL.md`]: skill('grill a plan ALWAYS'),
    [`${HOME}/.agents/skills/c1/SKILL.md`]: skill(long),
    [`${HOME}/.agents/skills/c1/agents/openai.yaml`]:
      'policy:\n  allow_implicit_invocation: false\n',
    [`${HOME}/.agents/skills/c2/SKILL.md`]: skill('auto'),
    [`${HOME}/.agents/skills/c2/agents/openai.yaml`]: 'interface:\n  display_name: "C2"\n',
  };
  const collected = collect(fakeIo(files), ROOT);
  const manual = collected.sources.filter((s) => s.manual).map((s) => `${s.harness}:${s.path}`);
  assert.deepEqual(manual.sort(), [
    `claude:${HOME}/.claude/skills/m1/SKILL.md`,
    `claude:${HOME}/.claude/skills/m2/SKILL.md`,
    `codex:${HOME}/.agents/skills/c1/SKILL.md`,
  ]);
  assert.ok(collected.sources.filter((s) => s.manual).every((s) => s.listing === 0));
  const r = analyze(collected);
  const budget = (h) => r.findings.find((f) => f.harness === h && f.name === 'budget').detail;
  assert.match(budget('claude'), /1 skills, 0 agents, 0 commands; 2 manual-only, not listed\)/);
  assert.match(budget('codex'), /1 skills, 0 agents, 0 commands; 1 manual-only, not listed\)/);
  // Only the auto skill is checked: one broad-trigger, no description-long, no overlap.
  assert.deepEqual(
    names(r).filter((n) => !['budget', 'top'].includes(n)),
    ['broad-trigger'],
  );
});

test('a project root at $HOME does not read ~/.agents/skills twice', () => {
  const files = { [`${HOME}/.agents/skills/as/SKILL.md`]: skill('agents skill') };
  const r = collect(fakeIo(files, { cwd: HOME }), HOME);
  assert.equal(r.sources.filter((s) => s.kind === 'skill').length, 1);
});

test('skill over 500 lines is flagged', () => {
  const files = { [`${HOME}/.claude/skills/big/SKILL.md`]: skill('d', 'l\n'.repeat(500)) };
  assert.deepEqual(names(collect(fakeIo(files), ROOT)), ['skill-body-large']);
});
