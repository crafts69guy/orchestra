import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  inkdropConfig,
  inkdropEnabled,
  inkdropFlag,
  probe,
  push,
  remoteKey,
  renderBlock,
  renderLesson,
  run,
  spec,
  splice,
} from '../scripts/inkdrop.mjs';

const ROOT = '/repo';
const DIR = `${ROOT}/.scratch/feat`;
const USER = 'secret-user';
const PASS = 'secret-pass';
const ENV = { PATH: '/bin', INKDROP_LOCAL_USERNAME: USER, INKDROP_LOCAL_PASSWORD: PASS };
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const CONFIG = 'orc.inkdropbook book:B1\norc.inkdropbookname My Book\norc.inkdroptag tag:T1\n';
const NOW = new Date(2026, 9, 18, 14, 2);
const BLOCK_RE = /<!-- orc:begin -->[\s\S]*<!-- orc:end -->/;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

/**
 * A fake Inkdrop local server: `notes` by id, `books`, `tags`; `conflicts` 409s the next note
 * POSTs. Creates (no `_id`) get a server-assigned `<kind>:newN` id, returned as `{ ok, id, rev }`.
 */
function inkdrop({
  notes = {},
  books = [],
  tags = [],
  conflicts = 0,
  fail = null,
  onConflict,
} = {}) {
  const state = { notes, books, tags, conflicts, calls: [] };
  let seq = 0;
  const assign = (kind, doc) => ({ _id: `${kind}:new${++seq}`, ...doc });
  state.fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ method: init.method, path: u.pathname, query: u.searchParams, body, init });
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.redirect, 'error', 'auth never follows a redirect');
    const send = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (init.headers.Authorization !== AUTH) return send({ error: 'unauthorized' }, 401);
    if (fail) return send({}, fail);
    const key = `${init.method} ${u.pathname}`;
    if (key === 'GET /notes') return send(Object.values(state.notes));
    if (key === 'GET /books') return send(state.books);
    if (key === 'GET /tags') return send(state.tags);
    if (key === 'POST /books' || key === 'POST /tags') {
      assert.equal(body._id, undefined, 'orc never picks ids');
      const doc = assign(u.pathname.slice(1, -1), body);
      state[u.pathname.slice(1)].push(doc);
      return send({ ok: true, id: doc._id, rev: '1-x' });
    }
    if (key === 'POST /notes' && body._id === undefined) {
      const doc = { ...assign('note', body), _rev: '1-x' };
      state.notes[doc._id] = doc;
      return send({ ok: true, id: doc._id, rev: doc._rev });
    }
    if (key === 'POST /notes') {
      const old = state.notes[body._id];
      if (state.conflicts > 0 || (old && old._rev !== body._rev)) {
        state.conflicts--;
        onConflict?.(state);
        return send({ error: 'conflict' }, 409);
      }
      const rev = `${Number.parseInt(old?._rev ?? '0', 10) + 1}-x`;
      state.notes[body._id] = { ...body, _rev: rev };
      return send({ ok: true, id: body._id, rev });
    }
    if (init.method === 'GET' && state.notes[u.pathname.slice(1)]) {
      return send(state.notes[u.pathname.slice(1)]);
    }
    return send({ error: 'not_found' }, 404);
  };
  return state;
}

/** Fake deps over an in-memory fs (`files`) and git (`config` is the --get-regexp stdout). */
function fake({ files = {}, config = CONFIG, env = ENV, server = inkdrop(), git = {} } = {}) {
  const calls = [];
  return {
    calls,
    files,
    server,
    env,
    fetch: server.fetch,
    now: () => NOW,
    hasCommand: () => false,
    exec(cmd, args) {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      if (Object.hasOwn(git, line)) return git[line];
      if (line === 'git rev-parse --path-format=absolute --git-common-dir')
        return ok(`${ROOT}/.git\n`);
      if (line === 'git config --get-regexp ^orc\\.inkdrop') {
        return config ? ok(config) : { status: 1, stdout: '', stderr: '' };
      }
      if (line.startsWith('git config ')) return ok('');
      return { status: 127, stdout: '', stderr: `${cmd}: ENOENT` };
    },
    readdir(dir) {
      const prefix = `${dir}/`;
      const names = Object.keys(files)
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length).split('/')[0]);
      if (!names.length) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...new Set(names)];
    },
    readFile(p) {
      if (!Object.hasOwn(files, p))
        throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return files[p];
    },
    writeFile(p, s) {
      files[p] = s;
    },
    mkdir(p) {
      calls.push(`mkdir ${p}`);
    },
  };
}

const PLAN = `# Retry the fetcher

Base branch: feat/retry

## Decisions

- one retry
  with backoff
- no deps

not a bullet

## Tasks

\`\`\`yaml
- id: T1
  goal: parse config
- id: T2
  goal: retry loop
\`\`\`
`;
const link = (noteId, specHash) => JSON.stringify({ noteId, specHash });
const note = (id, extra = {}) => ({
  _id: id,
  _rev: '1-a',
  title: `title ${id}`,
  body: 'spec text',
  bookId: 'book:B1',
  tags: ['tag:T1'],
  status: 'active',
  updatedAt: 5,
  ...extra,
});

test('inkdropConfig reads one git config regexp; inkdropEnabled gates on env and book', () => {
  const deps = fake();
  assert.deepEqual(inkdropConfig(ROOT, deps), {
    book: 'book:B1',
    bookName: 'My Book',
    tag: 'tag:T1',
  });
  assert.deepEqual(inkdropConfig(ROOT, fake({ config: null })), {
    book: null,
    bookName: null,
    tag: null,
  });
  assert.equal(inkdropEnabled(ENV, ROOT, deps), true);
  assert.equal(inkdropEnabled({ ...ENV, ORC_INKDROP: '0' }, ROOT, deps), false);
  assert.equal(inkdropEnabled({ ...ENV, INKDROP_LOCAL_PASSWORD: '' }, ROOT, deps), false);
  assert.equal(inkdropEnabled({ INKDROP_LOCAL_PASSWORD: PASS }, ROOT, deps), false);
  const noBook = fake({ config: 'orc.inkdroptag tag:T1\n' });
  assert.equal(inkdropEnabled(ENV, ROOT, noBook), false);
  assert.equal(inkdropEnabled({}, ROOT, deps), false);
});

test('spec strips the managed block and trims', () => {
  const body = '  my spec\n\n<!-- orc:begin -->\n## orc\n<!-- orc:end -->\n\nafter\n';
  assert.equal(spec(body), 'my spec\n\n\n\nafter');
  assert.equal(spec('just text\n'), 'just text');
  assert.equal(
    spec('x\n  <!-- orc:begin -->\n  <!-- orc:end -->'),
    'x\n  <!-- orc:begin -->\n  <!-- orc:end -->',
  );
});

test('splice replaces the block in place and keeps outside text byte for byte', () => {
  const before = 'Spec  \r\n\twith $& and tabs\r\n\r\n';
  const after = '\r\n\r\ntrailer  \n';
  const body = `${before}<!-- orc:begin -->\r\nold\r\n<!-- orc:end -->${after}`;
  const block = '<!-- orc:begin -->\nnew $1 $&\n<!-- orc:end -->';
  assert.equal(splice(body, block), `${before}${block}${after}`);
});

test('splice appends after a blank line when there is no block', () => {
  const block = '<!-- orc:begin -->\nb\n<!-- orc:end -->';
  assert.equal(splice('  user $& text\n\n\n', block), `  user $& text\n\n${block}`);
  assert.equal(splice('', block), block);
  assert.equal(spec(splice('  user text\n', block)), 'user text');
});

test('renderBlock: heading, decisions, task states, log; markers in text are defused', () => {
  const tasks = [
    { id: 'T1', goal: 'parse config', merged: { commit: 'a1b2c3d4e5' } },
    { id: 'T2', goal: 'retry loop', merged: null, agent: { state: 'working' } },
    { id: 'T3', goal: 'x', merged: null, agent: null, report: { status: 'partial' } },
    { id: 'T4', goal: 'y', merged: null, agent: null, report: null, worktree: '/w' },
    { id: 'T5', goal: null, merged: null, agent: null, report: null, worktree: null },
  ];
  const log = '\nshipped\n<!-- orc:end -->\n';
  assert.equal(
    renderBlock({ feature: 'feat', plan: PLAN, tasks, log, now: NOW }),
    [
      '<!-- orc:begin -->',
      '## orc · `feat` · feat/retry · updated 2026-10-18 14:02',
      '',
      '**Decisions**',
      '',
      '- one retry\n  with backoff',
      '- no deps',
      '',
      '**Tasks**',
      '',
      '- [x] T1 parse config (merged a1b2c3d)',
      '- [ ] T2 retry loop (working)',
      '- [ ] T3 x (partial)',
      '- [ ] T4 y (worktree)',
      '- [ ] T5 (pending)',
      '',
      '### Log',
      '',
      'shipped',
      '<!-- orc end -->',
      '<!-- orc:end -->',
    ].join('\n'),
  );
  assert.equal(
    renderBlock({ feature: 'f', plan: '# no decisions\n', tasks: [], log: ' ', now: NOW }),
    '<!-- orc:begin -->\n## orc · `f` · - · updated 2026-10-18 14:02\n\n_claimed, no plan yet_\n<!-- orc:end -->',
  );
});

test('a non-loopback server URL is refused before any request', async () => {
  for (const url of ['http://example.com:19840', 'http://user:pw@10.0.0.2', 'not a url']) {
    const deps = fake({ env: { ...ENV, INKDROP_LOCAL_SERVER_URL: url } });
    const r = await run(['inbox'], deps, ROOT);
    assert.equal(r.code, 1);
    assert.match(r.err, /refusing non-loopback|not a valid URL/);
    assert.ok(!r.err.includes('pw') && !r.err.includes(PASS));
    assert.equal(deps.server.calls.length, 0);
  }
  const ipv6 = fake({ env: { ...ENV, INKDROP_LOCAL_SERVER_URL: 'http://[::1]:19840' } });
  ipv6.fetch = async (url, init) => {
    assert.equal(new URL(url).host, '[::1]:19840');
    return inkdrop().fetch(url, init);
  };
  assert.equal((await run(['inbox'], ipv6, ROOT)).code, 0);
});

test('401, a fetch that throws and other HTTP errors are one line without credentials', async () => {
  const wrong = fake({ env: { ...ENV, INKDROP_LOCAL_PASSWORD: 'nope' } });
  const r401 = await run(['inbox'], wrong, ROOT);
  assert.deepEqual(r401, {
    code: 1,
    out: '',
    err: 'orc inkdrop: unauthorized; check INKDROP_LOCAL_USERNAME and INKDROP_LOCAL_PASSWORD\n',
  });

  const down = fake();
  down.fetch = async () => {
    throw new TypeError(`fetch failed ${USER}:${PASS}`);
  };
  const rDown = await run(['inbox'], down, ROOT);
  assert.equal(
    rDown.err,
    'orc inkdrop: Inkdrop is not running or its local server is off (Preferences → Local Server)\n',
  );

  const r500 = await run(['inbox'], fake({ server: inkdrop({ fail: 500 }) }), ROOT);
  assert.equal(r500.err, 'orc inkdrop: GET /notes failed: HTTP 500\n');

  const garbage = fake();
  garbage.fetch = async () => new Response('<html>', { status: 200 });
  const rJson = await run(['inbox'], garbage, ROOT);
  assert.equal(rJson.code, 1);
  assert.match(rJson.err, /^orc inkdrop: /);

  for (const r of [r401, rDown, r500, rJson]) {
    assert.ok(![USER, PASS, AUTH].some((s) => r.out.includes(s) || r.err.includes(s)));
  }
});

test('missing credentials, outside git and an uninitialised repo fail early', async () => {
  const noCreds = await run(['inbox'], fake({ env: { PATH: '/bin' } }), ROOT);
  assert.equal(noCreds.err, 'orc inkdrop: set INKDROP_LOCAL_USERNAME and INKDROP_LOCAL_PASSWORD\n');
  const noGit = fake({
    git: {
      'git rev-parse --path-format=absolute --git-common-dir': {
        status: 128,
        stdout: '',
        stderr: '',
      },
    },
  });
  assert.equal(
    (await run(['pull', 'feat'], noGit, '/x')).err,
    'orc inkdrop: not a git repository: /x\n',
  );
  const bare = await run(['push', 'feat'], fake({ config: 'orc.inkdropbook book:B1\n' }), ROOT);
  assert.equal(bare.err, 'orc inkdrop: this repo has no Inkdrop notebook; run orc inkdrop init\n');
});

test('bad args print the usage', async () => {
  const usage =
    'usage: orc inkdrop init [--book <name>] [--parent <name>] [--create] [--move] | inbox [--json] | claim <note-id> <feature> | push <feature> [--done] | pull <feature> | lessons\n';
  for (const args of [
    [],
    ['nope'],
    ['init', '--book'],
    ['init', '--book', '--create'],
    ['init', '--parent'],
    ['init', '--parent', '--move'],
    ['init', 'x'],
    ['inbox', '--all'],
    ['inbox', '--json', 'x'],
    ['claim', 'note:a'],
    ['push'],
    ['push', 'a', 'b'],
    ['push', 'a', '--done', '--done'],
    ['pull'],
  ]) {
    assert.deepEqual(
      await run(args, fake(), ROOT),
      { code: 1, out: '', err: usage },
      args.join(' '),
    );
  }
});

test('init matches the notebook case-insensitively and finds or creates the tag', async () => {
  const server = inkdrop({
    books: [{ _id: 'book:R', name: 'Repo' }],
    tags: [{ _id: 'tag:O', name: 'orc' }],
  });
  const deps = fake({ server, config: null });
  const r = await run(['init'], deps, ROOT);
  assert.deepEqual(r, { code: 0, out: 'notebook Repo (book:R), tag orc (tag:O)\n', err: '' });
  assert.deepEqual(
    deps.calls.filter((c) => c.startsWith('git config orc.')),
    [
      'git config orc.inkdropBook book:R',
      'git config orc.inkdropBookName Repo',
      'git config orc.inkdropTag tag:O',
    ],
  );
  assert.ok(!server.calls.some((c) => c.method === 'POST'));
  for (const c of server.calls) assert.equal(c.query.get('limit'), '1000', c.path);

  const fresh = inkdrop({ books: [{ _id: 'book:R', name: 'repo' }] });
  const r2 = await run(['init', '--book', 'REPO'], fake({ server: fresh, config: null }), ROOT);
  assert.equal(r2.code, 0);
  assert.equal(fresh.tags.length, 1);
  assert.equal(fresh.tags[0].name, 'orc');
  assert.equal(fresh.tags[0]._id, 'tag:new1', 'the id comes from the POST response');
  assert.match(r2.out, /tag orc \(tag:new1\)/);
});

test('init without a match fails unless --create, which creates the notebook', async () => {
  const none = await run(['init', '--book', 'Orchestra'], fake({ config: null }), ROOT);
  assert.equal(
    none.err,
    'orc inkdrop: no notebook named "Orchestra"; pass --create to create it\n',
  );

  const server = inkdrop({ tags: [{ _id: 'tag:O', name: 'orc' }] });
  const deps = fake({ server, config: null });
  const r = await run(['init', '--create', '--book', 'Orchestra'], deps, ROOT);
  assert.equal(r.code, 0);
  assert.equal(server.books.length, 1);
  assert.equal(server.books[0].name, 'Orchestra');
  assert.equal(server.books[0]._id, 'book:new1');
  assert.ok(deps.calls.includes('git config orc.inkdropBook book:new1'));

  const gitFails = fake({
    server: inkdrop({
      books: [{ _id: 'book:R', name: 'repo' }],
      tags: [{ _id: 'tag:O', name: 'orc' }],
    }),
    config: null,
    git: { 'git config orc.inkdropBook book:R': { status: 1, stdout: '', stderr: 'locked\n' } },
  });
  assert.equal(
    (await run(['init'], gitFails, ROOT)).err,
    'orc inkdrop: git config orc.inkdropBook failed: locked\n',
  );
});

test('init --parent picks the child under a root parent; git config supplies the parent', async () => {
  const books = [
    { _id: 'book:Other', name: 'repo', parentBookId: null },
    { _id: 'book:P', name: 'Work', parentBookId: null },
    { _id: 'book:Nested', name: 'work', parentBookId: 'book:Other' },
    { _id: 'book:C', name: 'Repo', parentBookId: 'book:P' },
  ];
  const server = inkdrop({ books, tags: [{ _id: 'tag:O', name: 'orc' }] });
  const deps = fake({ server, config: null });
  const r = await run(['init', '--parent', 'WORK'], deps, ROOT);
  assert.deepEqual(r, { code: 0, out: 'notebook Work/Repo (book:C), tag orc (tag:O)\n', err: '' });
  assert.ok(deps.calls.includes('git config orc.inkdropBookName Work/Repo'));
  assert.ok(!deps.calls.includes('git config --get orc.inkdropParent'), 'the flag wins');

  const viaGit = fake({
    server,
    config: null,
    git: { 'git config --get orc.inkdropParent': ok('Work\n') },
  });
  assert.equal((await run(['init'], viaGit, ROOT)).out, r.out);
  assert.ok(viaGit.calls.includes('git config orc.inkdropBook book:C'));
});

test('init --parent fails naming the missing notebook unless --create, which nests it', async () => {
  const noParent = await run(['init', '--parent', 'Work'], fake({ config: null }), ROOT);
  assert.equal(
    noParent.err,
    'orc inkdrop: no root notebook named "Work"; pass --create to create it\n',
  );
  const server = inkdrop({ books: [{ _id: 'book:P', name: 'Work' }] });
  const noChild = await run(['init', '--parent', 'Work'], fake({ server, config: null }), ROOT);
  assert.equal(
    noChild.err,
    'orc inkdrop: no notebook named "repo" under "Work"; pass --create to create it\n',
  );
  assert.ok(!server.calls.some((c) => c.method === 'POST'));

  const empty = inkdrop({ tags: [{ _id: 'tag:O', name: 'orc' }] });
  const r = await run(
    ['init', '--create', '--parent', 'Work', '--book', 'Orc'],
    fake({ server: empty, config: null }),
    ROOT,
  );
  assert.equal(r.out, 'notebook Work/Orc (book:new2), tag orc (tag:O)\n');
  assert.deepEqual(
    empty.books.map((b) => [b._id, b.name, b.parentBookId]),
    [
      ['book:new1', 'Work', null],
      ['book:new2', 'Orc', 'book:new1'],
    ],
  );
});

test('inbox lists only unclaimed tagged notes of the configured book', async () => {
  const server = inkdrop({
    notes: {
      'note:a': note('note:a'),
      'note:claimed': note('note:claimed', {
        body: 'x\n\n<!-- orc:begin -->\nb\n<!-- orc:end -->',
      }),
      'note:other': note('note:other', { bookId: 'book:B2' }),
      'note:untagged': note('note:untagged', { tags: [] }),
      'note:notags': note('note:notags', { tags: undefined, body: undefined }),
      'note:nobody': note('note:nobody', { body: undefined }),
    },
  });
  const deps = fake({ server });
  assert.deepEqual(await run(['inbox'], deps, ROOT), {
    code: 0,
    out: 'note:a  title note:a\nnote:nobody  title note:nobody\n',
    err: '',
  });
  const { query } = server.calls[0];
  assert.equal(query.get('keyword'), 'bookId:book:B1 tag:orc status:active');
  assert.equal(query.get('limit'), '100');
  const json = JSON.parse((await run(['inbox', '--json'], deps, ROOT)).out);
  assert.deepEqual(json, {
    schemaVersion: 1,
    notes: [
      { id: 'note:a', title: 'title note:a', updatedAt: 5 },
      { id: 'note:nobody', title: 'title note:nobody', updatedAt: 5 },
    ],
  });
  const local = {
    [`${ROOT}/.scratch/feat/inkdrop.json`]: link('note:a', 'h'),
    [`${ROOT}/.scratch/broken/inkdrop.json`]: '{oops',
    [`${ROOT}/.scratch/plain/plan.md`]: '# p\n',
  };
  assert.equal(
    (await run(['inbox'], fake({ server, files: local }), ROOT)).out,
    'note:nobody  title note:nobody\n',
    'a note linked locally is excluded even when its body hides the block',
  );
  const empty = await run(['inbox'], fake(), ROOT);
  assert.equal(empty.out, 'no queued notes\n');
});

test('claim inserts the block, links the feature and prints the request', async () => {
  const server = inkdrop({ notes: { 'note:a': note('note:a', { body: 'Do X.\n', tags: [] }) } });
  const deps = fake({ server });
  const r = await run(['claim', 'note:a', 'feat'], deps, ROOT);
  assert.deepEqual(r, { code: 0, out: '# title note:a\n\nDo X.\n', err: '' });
  const saved = server.notes['note:a'];
  assert.equal(saved._rev, '2-x');
  assert.match(
    saved.body,
    /^Do X\.\n\n<!-- orc:begin -->\n[\s\S]*_claimed, no plan yet_\n<!-- orc:end -->$/,
  );
  assert.deepEqual(saved.tags, ['tag:T1']);
  assert.equal(saved.updatedAt, NOW.getTime());
  assert.ok(deps.calls.includes(`mkdir ${DIR}`));
  assert.deepEqual(JSON.parse(deps.files[`${DIR}/inkdrop.json`]), {
    noteId: 'note:a',
    specHash: sha('Do X.'),
  });
});

test('claim refuses a claimed note, another book, a linked feature and bad names', async () => {
  const notes = {
    'note:c': note('note:c', { body: 'x\n<!-- orc:begin -->\n<!-- orc:end -->' }),
    'note:o': note('note:o', { bookId: 'book:B2' }),
    'note:u': note('note:u', { body: undefined }),
  };
  const server = inkdrop({ notes });
  const claim = (id, feature = 'feat', files = {}) =>
    run(['claim', id, feature], fake({ server, files }), ROOT);
  assert.equal((await claim('note:c')).err, 'orc inkdrop: note:c is already claimed\n');
  assert.equal((await claim('note:o')).err, 'orc inkdrop: note:o is not in notebook My Book\n');
  const linked = { [`${DIR}/inkdrop.json`]: link('note:z', 'h') };
  assert.equal(
    (await claim('note:u', 'feat', linked)).err,
    'orc inkdrop: feature feat is already linked to note:z\n',
  );
  assert.equal((await claim('../x')).err, 'orc inkdrop: invalid note id: ../x\n');
  for (const bad of ['..', 'a/b', '']) {
    assert.equal((await claim('note:u', bad)).err, `orc inkdrop: invalid feature name: ${bad}\n`);
  }
  assert.equal(
    (await claim('note:missing')).err,
    'orc inkdrop: GET /note:missing failed: HTTP 404\n',
  );
  assert.ok(!server.calls.some((c) => c.method === 'POST'), 'nothing written');
  const invalid = { [`${DIR}/inkdrop.json`]: '{oops' };
  assert.equal(
    (await claim('note:u', 'feat', invalid)).err,
    `orc inkdrop: invalid ${DIR}/inkdrop.json\n`,
  );
  const r = await claim('note:u');
  assert.equal(r.code, 0, 'a note without body is claimable');
  assert.deepEqual(server.notes['note:u'].tags, ['tag:T1']);
});

test('push saves the block from plan, status and log into the linked note', async () => {
  const user = '  My spec $&\r\n\r\n';
  const server = inkdrop({
    notes: {
      'note:a': note('note:a', { body: `${user}<!-- orc:begin -->\nold\n<!-- orc:end -->\ntail` }),
    },
  });
  const files = {
    [`${DIR}/plan.md`]: PLAN,
    [`${DIR}/log.md`]: 'learned things\n',
    [`${DIR}/merged`]: 'T1 a1b2c3d4\n',
    [`${DIR}/inkdrop.json`]: link('note:a', 'stored'),
  };
  const deps = fake({ server, files });
  assert.deepEqual(await run(['push', 'feat'], deps, ROOT), {
    code: 0,
    out: 'pushed note:a\n',
    err: '',
  });
  const saved = server.notes['note:a'];
  assert.ok(saved.body.startsWith(user) && saved.body.endsWith('\ntail'));
  assert.match(
    saved.body,
    /- \[x\] T1 parse config \(merged a1b2c3d\)\n- \[ \] T2 retry loop \(pending\)/,
  );
  assert.match(saved.body, /### Log\n\nlearned things\n<!-- orc:end -->/);
  assert.equal(saved.status, 'active');
  assert.equal(
    JSON.parse(files[`${DIR}/inkdrop.json`]).specHash,
    'stored',
    'push never updates specHash',
  );

  assert.equal((await push(deps, ROOT, 'feat', { done: true })).code, 0);
  assert.equal(server.notes['note:a'].status, 'completed');
  assert.equal((await run(['push', '--done', 'feat'], deps, ROOT)).code, 0);
});

test('push creates and links a note when the feature has none', async () => {
  const server = inkdrop();
  const files = { [`${DIR}/plan.md`]: PLAN };
  const deps = fake({ server, files });
  const r = await push(deps, ROOT, 'feat');
  assert.equal(r.code, 0);
  const id = 'note:new1';
  assert.deepEqual(Object.keys(server.notes), [id], 'created with the server-assigned id');
  assert.equal(r.out, `created ${id}\n`);
  const created = server.notes[id];
  assert.equal(created.title, 'Retry the fetcher');
  assert.equal(created.bookId, 'book:B1');
  assert.deepEqual(created.tags, ['tag:T1']);
  assert.equal(created.status, 'active');
  assert.equal(created.doctype, 'markdown');
  assert.match(created.body, BLOCK_RE);
  assert.deepEqual(JSON.parse(files[`${DIR}/inkdrop.json`]), { noteId: id, specHash: sha('') });

  const bare = inkdrop();
  const done = await run(['push', 'solo', '--done'], fake({ server: bare }), ROOT);
  assert.equal(done.code, 0);
  const [solo] = Object.values(bare.notes);
  assert.equal(solo.title, 'solo');
  assert.equal(solo.status, 'completed');
  assert.match(solo.body, /_claimed, no plan yet_/);

  for (const reply of [{ ok: true }, null, { id: 'book:x' }]) {
    const noId = fake({ files: {} });
    noId.fetch = async () => new Response(JSON.stringify(reply), { status: 200 });
    assert.deepEqual(await push(noId, ROOT, 'feat'), {
      code: 1,
      error: 'orc inkdrop: POST /notes returned no note id',
    });
    assert.equal(noId.files[`${DIR}/inkdrop.json`], undefined, 'nothing linked');
  }
});

test('a 409 conflict re-reads and retries once; a second conflict fails', async () => {
  // the user edits the note while orc is writing: the 409 carries a new body and _rev
  const userEdit = (st) => {
    st.notes['note:a'] = {
      ...st.notes['note:a'],
      body: 'spec text\nplus a user edit\n',
      _rev: '2-u',
    };
  };
  const once = inkdrop({
    notes: { 'note:a': note('note:a', { body: undefined }) },
    conflicts: 1,
    onConflict: userEdit,
  });
  const files = { [`${DIR}/inkdrop.json`]: link('note:a', 'h') };
  const r = await push(fake({ server: once, files }), ROOT, 'feat');
  assert.equal(r.code, 0);
  assert.deepEqual(
    once.calls.map((c) => `${c.method} ${c.path}`),
    ['GET /note:a', 'POST /notes', 'GET /note:a', 'POST /notes'],
  );
  assert.equal(once.calls[3].body._rev, '2-u', 'the retry carries the fresh _rev');
  const saved = once.notes['note:a'].body;
  assert.ok(saved.startsWith('spec text\nplus a user edit\n\n<!-- orc:begin -->\n'), saved);
  assert.match(saved, BLOCK_RE);

  const twice = inkdrop({ notes: { 'note:a': note('note:a') }, conflicts: 2 });
  assert.deepEqual(await push(fake({ server: twice, files }), ROOT, 'feat'), {
    code: 1,
    error: 'orc inkdrop: note changed concurrently; retry',
  });
  assert.equal(twice.notes['note:a'].body, 'spec text', 'nothing written');
});

test('pull reports changed: yes with the spec once, then changed: no', async () => {
  const server = inkdrop({
    notes: {
      'note:a': note('note:a', { body: 'new spec\n<!-- orc:begin -->\nb\n<!-- orc:end -->' }),
    },
  });
  const files = { [`${DIR}/inkdrop.json`]: link('note:a', sha('old spec')) };
  const deps = fake({ server, files });
  assert.deepEqual(await run(['pull', 'feat'], deps, ROOT), {
    code: 0,
    out: 'changed: yes\n\nnew spec\n',
    err: '',
  });
  assert.deepEqual(JSON.parse(files[`${DIR}/inkdrop.json`]), {
    noteId: 'note:a',
    specHash: sha('new spec'),
  });
  assert.equal((await run(['pull', 'feat'], deps, ROOT)).out, 'changed: no\n');
  assert.ok(!server.calls.some((c) => c.method === 'POST'), 'pull never writes the note');

  server.notes['note:a'].body = undefined;
  assert.equal((await run(['pull', 'feat'], deps, ROOT)).out, 'changed: yes\n\n\n');
  assert.equal(
    (await run(['pull', 'other'], deps, ROOT)).err,
    'orc inkdrop: feature other has no linked note\n',
  );
});

test('inkdropFlag is the mapped notebook when enabled, else false', () => {
  assert.deepEqual(inkdropFlag(ENV, ROOT, fake()), { name: 'My Book', id: 'book:B1' });
  const idOnly = fake({ config: 'orc.inkdropbook book:B1\n' });
  assert.deepEqual(inkdropFlag(ENV, ROOT, idOnly), { name: 'book:B1', id: 'book:B1' });
  assert.equal(inkdropFlag({ ...ENV, ORC_INKDROP: '0' }, ROOT, fake()), false);
  for (const env of [{ ...ENV, INKDROP_LOCAL_USERNAME: '' }, { INKDROP_LOCAL_USERNAME: USER }]) {
    const deps = fake();
    assert.equal(inkdropFlag(env, ROOT, deps), false);
    assert.deepEqual(deps.calls, [], 'no git spawn without credentials');
  }
  const unmapped = fake({ config: null });
  assert.equal(inkdropFlag(ENV, ROOT, unmapped), false);
  const once = fake();
  inkdropFlag(ENV, ROOT, once);
  assert.deepEqual(once.calls, ['git config --get-regexp ^orc\\.inkdrop'], 'one git spawn');
});

const LONE_BEGIN = 'Spec.\n\n<!-- orc:begin -->\n## orc\n\nmy notes after the block\n';
const DAMAGED_BODIES = {
  'a lone begin with user notes after it': LONE_BEGIN,
  'a spec with the begin marker on its own line':
    'Write this literally:\r\n<!-- orc:begin -->\r\nthat is all\r\n',
  'two complete blocks':
    'x\n<!-- orc:begin -->\na\n<!-- orc:end -->\ny\n<!-- orc:begin -->\nb\n<!-- orc:end -->\n',
  'end before begin': 'x\n<!-- orc:end -->\nmine\n<!-- orc:begin -->\nz\n',
};

test('a damaged block fails push, claim and pull without writing; inbox never offers it', async () => {
  for (const [label, body] of Object.entries(DAMAGED_BODIES)) {
    const damaged = `orc inkdrop: note:d has a damaged orc block; fix it in Inkdrop\n`;
    const server = inkdrop({ notes: { 'note:d': note('note:d', { body }) } });
    const linked = () => ({ [`${DIR}/inkdrop.json`]: link('note:d', 'h') });
    assert.equal(
      (await run(['push', 'feat'], fake({ server, files: linked() }), ROOT)).err,
      damaged,
      label,
    );
    assert.equal(
      (await run(['claim', 'note:d', 'feat'], fake({ server }), ROOT)).err,
      damaged,
      label,
    );
    assert.equal(
      (await run(['pull', 'feat'], fake({ server, files: linked() }), ROOT)).err,
      damaged,
      label,
    );
    assert.equal((await run(['inbox'], fake({ server }), ROOT)).out, 'no queued notes\n', label);
    assert.ok(!server.calls.some((c) => c.method === 'POST'), `${label}: nothing written`);
    assert.equal(server.notes['note:d'].body, body, `${label}: user text intact`);
    assert.throws(() => spec(body), /damaged orc block/, label);
    assert.throws(() => splice(body, '<!-- orc:begin -->\n<!-- orc:end -->'), /damaged/, label);
  }
});

test('probe GETs / with a 1.5 s timeout and reports the version or one error line', async () => {
  let seen;
  const meta = async (url, init) => {
    seen = { url: String(url), init };
    return new Response('{"version":"6.1.0","ok":true}');
  };
  assert.deepEqual(await probe(ENV, meta), { version: '6.1.0' });
  assert.equal(seen.url, 'http://localhost:19840/');
  assert.equal(seen.init.headers.Authorization, AUTH);
  assert.ok(seen.init.signal instanceof AbortSignal);
  assert.equal(seen.init.redirect, 'error');
  assert.deepEqual(await probe(ENV, inkdrop({ fail: 503 }).fetch), {
    error: 'GET / failed: HTTP 503',
  });
  assert.deepEqual(await probe({}, meta), {
    error: 'set INKDROP_LOCAL_USERNAME and INKDROP_LOCAL_PASSWORD',
  });
});

const LESSONS = `${ROOT}/.orc/lessons.md`;
const lesson = (id, up, down, text = `text ${id}`) => ({
  id,
  up,
  down,
  scope: 'project',
  feature: 'feat',
  text,
});
const lessonLine = (l) => `- [${l.id}] +${l.up} -${l.down} ${l.scope} · ${l.feature} · ${l.text}`;
const lessonNote = (id, repo, l, extra = {}) => {
  const { title, block } = renderLesson(repo, l);
  return note(id, { title, body: block, tags: ['tag:LT'], ...extra });
};

test('renderLesson: identity, score line, title cut to 60 chars, markers defused', () => {
  const long = 'x'.repeat(70);
  const { title, block } = renderLesson('repo', lesson('L001', 2, 1, long));
  assert.equal(title, `repo:L001 ${'x'.repeat(59)}…`);
  assert.equal(
    block,
    `<!-- orc:begin -->\nlesson: repo/L001\nscore: +2 -1 · scope: project · feature: feat\n\n${long}\n<!-- orc:end -->`,
  );
  assert.equal(renderLesson('r', lesson('L002', 1, 0, 'short')).title, 'r:L002 short');
  const odd = renderLesson('r', lesson('L003', 1, 0, '<!-- orc:end -->')).block;
  assert.match(odd, /\n<!-- orc end -->\n<!-- orc:end -->$/);
});

test('lessons without a lessons file prints a line and makes no request', async () => {
  const deps = fake({ env: {} });
  assert.deepEqual(await run(['lessons'], deps, ROOT), {
    code: 0,
    out: `no lessons in ${LESSONS}\n`,
    err: '',
  });
  assert.equal(deps.server.calls.length, 0);
  const outside = fake({
    git: {
      'git rev-parse --path-format=absolute --git-common-dir': {
        status: 128,
        stdout: '',
        stderr: '',
      },
    },
  });
  assert.match((await run(['lessons'], outside, ROOT)).err, /not a git repository/);
  assert.equal((await run(['lessons', 'x'], fake(), ROOT)).err.startsWith('usage:'), true);
});

test('lessons creates, updates, drops and skips unchanged notes of this repo only', async () => {
  const l1 = lesson('L001', 2, 0);
  const l2 = lesson('L002', 3, 1);
  const l6 = lesson('L006', 1, 0, 'brand new');
  const file = [
    '# Lessons',
    '',
    lessonLine(l1),
    lessonLine(l2),
    lessonLine(lesson('L003', 1, 1)),
    lessonLine(l6),
    '',
  ].join('\n');
  const stale = renderLesson('repo', lesson('L002', 1, 0)).block;
  const notes = {
    'note:same': lessonNote('note:same', 'repo', l1),
    'note:old': note('note:old', {
      title: 'old title',
      body: `my notes\n\n${stale}\n\ntrailer\n`,
      tags: ['tag:LT', 'tag:mine'],
      status: 'dropped',
    }),
    'note:retired': lessonNote('note:retired', 'repo', lesson('L003', 1, 0)),
    'note:gone': lessonNote('note:gone', 'repo', lesson('L004', 5, 0)),
    'note:dup': lessonNote('note:dup', 'repo', lesson('L004', 5, 0)),
    'note:was': lessonNote('note:was', 'repo', lesson('L005', 1, 0), { status: 'dropped' }),
    'note:other': lessonNote('note:other', 'other', lesson('L009', 1, 0)),
    'note:book': lessonNote('note:book', 'repo', lesson('L007', 1, 0), { bookId: 'book:X' }),
    'note:untagged': lessonNote('note:untagged', 'repo', lesson('L008', 1, 0), { tags: [] }),
    'note:plain': note('note:plain', { tags: ['tag:LT'], body: undefined }),
    'note:noid': note('note:noid', {
      tags: ['tag:LT'],
      body: '<!-- orc:begin -->\nx\n<!-- orc:end -->',
    }),
    'note:damaged-other-book': note('note:damaged-other-book', {
      bookId: 'book:X',
      tags: ['tag:LT'],
      body: LONE_BEGIN,
    }),
  };
  const before = structuredClone(notes);
  const server = inkdrop({ notes, tags: [{ _id: 'tag:LT', name: 'orc-lesson' }] });
  const deps = fake({ server, files: { [LESSONS]: file } });
  assert.deepEqual(await run(['lessons'], deps, ROOT), {
    code: 0,
    out: 'lessons: 1 created, 1 updated, 3 dropped, 1 unchanged\n',
    err: '',
  });
  const list = server.calls.find((c) => c.method === 'GET' && c.path === '/notes');
  assert.equal(list.query.get('keyword'), 'bookId:book:B1 tag:orc-lesson');
  const { 'note:new1': fresh, ...rest } = server.notes;
  const want = renderLesson('repo', l6);
  assert.deepEqual(fresh, {
    _id: 'note:new1',
    _rev: '1-x',
    doctype: 'markdown',
    title: want.title,
    body: want.block,
    bookId: 'book:B1',
    tags: ['tag:LT'],
    status: 'active',
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
  });
  const now = renderLesson('repo', l2);
  assert.deepEqual(rest['note:old'], {
    ...before['note:old'],
    _rev: '2-x',
    title: now.title,
    body: `my notes\n\n${now.block}\n\ntrailer\n`,
    status: 'active',
    updatedAt: NOW.getTime(),
  });
  for (const id of ['note:retired', 'note:gone', 'note:dup']) {
    assert.deepEqual(rest[id], {
      ...before[id],
      _rev: '2-x',
      status: 'dropped',
      updatedAt: NOW.getTime(),
    });
  }
  for (const id of ['note:old', 'note:retired', 'note:gone', 'note:dup']) {
    delete rest[id];
    delete before[id];
  }
  assert.deepEqual(rest, before, 'everything else untouched');
  assert.equal(server.calls.filter((c) => c.method === 'POST' && c.path === '/tags').length, 0);

  const again = fake({ server, files: { [LESSONS]: file } });
  const writes = server.calls.length;
  assert.equal(
    (await run(['lessons'], again, ROOT)).out,
    'lessons: 0 created, 0 updated, 0 dropped, 3 unchanged\n',
  );
  assert.ok(
    !server.calls.slice(writes).some((c) => c.method === 'POST'),
    'second run writes nothing',
  );
});

test('lessons creates the orc-lesson tag when missing; API failures exit 1', async () => {
  const server = inkdrop();
  const deps = fake({ server, files: { [LESSONS]: lessonLine(lesson('L001', 1, 0)) } });
  assert.equal(
    (await run(['lessons'], deps, ROOT)).out,
    'lessons: 1 created, 0 updated, 0 dropped, 0 unchanged\n',
  );
  assert.deepEqual(
    server.tags.map((t) => [t._id, t.name]),
    [['tag:new1', 'orc-lesson']],
  );
  assert.deepEqual(server.notes['note:new2'].tags, ['tag:new1']);
  const down = fake({ server: inkdrop({ fail: 503 }), files: { [LESSONS]: '' } });
  assert.deepEqual(await run(['lessons'], down, ROOT), {
    code: 1,
    out: '',
    err: 'orc inkdrop: GET /tags failed: HTTP 503\n',
  });
  const r = await run(['lessons'], fake({ config: null, files: { [LESSONS]: '' } }), ROOT);
  assert.match(r.err, /run orc inkdrop init/);
  assert.ok(!r.err.includes(PASS));
});

test('remoteKey parses https and scp remotes to owner/name; anything else is null', () => {
  assert.equal(remoteKey('https://github.com/me/orchestra.git\n'), 'me/orchestra');
  assert.equal(remoteKey('https://gitlab.com/group/sub/my repo/'), 'sub/my repo');
  assert.equal(remoteKey('ssh://git@host:22/me/x'), 'me/x');
  assert.equal(remoteKey('git@github.com:me/orchestra.git'), 'me/orchestra');
  assert.equal(remoteKey('git@github.com:orchestra'), null);
  assert.equal(remoteKey('/local/path/repo.git'), null);
  assert.equal(remoteKey(''), null);
});

test('lessons keys identities by the origin remote, else the checkout name (spaces too)', async () => {
  const origin = (url) => ({
    'git remote get-url origin': url ? ok(`${url}\n`) : { status: 2, stdout: '', stderr: '' },
  });
  const cases = [
    ['/w/my repo', origin('git@github.com:me/orchestra.git'), 'me/orchestra'],
    ['/w/my repo', origin('file:///nowhere'), 'my repo'],
    ['/w/my repo', origin(null), 'my repo'],
  ];
  for (const [root, remote, key] of cases) {
    const git = {
      'git rev-parse --path-format=absolute --git-common-dir': ok(`${root}/.git\n`),
      ...remote,
    };
    const files = { [`${root}/.orc/lessons.md`]: lessonLine(lesson('L001', 1, 0, 'x')) };
    const server = inkdrop({ tags: [{ _id: 'tag:LT', name: 'orc-lesson' }] });
    assert.equal(
      (await run(['lessons'], fake({ server, files, git }), root)).out,
      'lessons: 1 created, 0 updated, 0 dropped, 0 unchanged\n',
      key,
    );
    const [created] = Object.values(server.notes);
    assert.equal(created.title, `${key}:L001 x`);
    assert.match(created.body, new RegExp(`\nlesson: ${key}/L001\n`));
    assert.equal(
      (await run(['lessons'], fake({ server, files, git }), root)).out,
      'lessons: 0 created, 0 updated, 0 dropped, 1 unchanged\n',
      key,
    );
  }
});

test('lessons fails before any write when a tagged note in the book has a damaged block', async () => {
  const notes = {
    'note:gone': lessonNote('note:gone', 'repo', lesson('L004', 5, 0)),
    'note:bad': note('note:bad', { tags: ['tag:LT'], body: LONE_BEGIN }),
  };
  const server = inkdrop({ notes, tags: [{ _id: 'tag:LT', name: 'orc-lesson' }] });
  const deps = fake({ server, files: { [LESSONS]: lessonLine(lesson('L001', 1, 0)) } });
  assert.deepEqual(await run(['lessons'], deps, ROOT), {
    code: 1,
    out: '',
    err: 'orc inkdrop: note:bad has a damaged orc block; fix it in Inkdrop\n',
  });
  assert.ok(!server.calls.some((c) => c.method === 'POST'), 'nothing written');
});

/** `fake` whose git config is stateful: `git config <key> <value>` changes later reads. */
function statefulGit(opts, initial) {
  const deps = fake(opts);
  const values = new Map(Object.entries(initial));
  const exec = deps.exec;
  deps.exec = (cmd, args, cwd) => {
    if (args[0] === 'config' && args[1] === '--get-regexp') {
      deps.calls.push([cmd, ...args].join(' '));
      return ok([...values].map(([k, v]) => `${k.toLowerCase()} ${v}\n`).join(''));
    }
    if (args[0] === 'config' && args.length === 3 && !args[1].startsWith('--')) {
      values.set(args[1], args[2]);
    }
    return exec(cmd, args, cwd);
  };
  return { deps, values };
}

test('init on a remap fails while this repo has orc notes in the old book; --move moves them', async () => {
  const BAD_LESSON = { tags: ['tag:LT'], body: LONE_BEGIN, bookId: 'book:Old' };
  const old = { bookId: 'book:Old' };
  const notes = {
    'note:inbox': note('note:inbox', old),
    'note:linked': note('note:linked', {
      ...old,
      body: 'x\n\n<!-- orc:begin -->\nb\n<!-- orc:end -->',
    }),
    'note:claimed-elsewhere': note('note:claimed-elsewhere', {
      ...old,
      body: 'x\n\n<!-- orc:begin -->\nb\n<!-- orc:end -->',
    }),
    'note:lesson': lessonNote('note:lesson', 'repo', lesson('L001', 1, 0), old),
    'note:other-repo': lessonNote('note:other-repo', 'other', lesson('L001', 1, 0), old),
    'note:lesson-noblock': note('note:lesson-noblock', { ...old, tags: ['tag:LT'] }),
    'note:plain': note('note:plain', { ...old, tags: ['tag:x'] }),
    'note:notags': note('note:notags', { ...old, tags: undefined, body: undefined }),
    'note:elsewhere': note('note:elsewhere', { bookId: 'book:B9' }),
  };
  const tags = [
    { _id: 'tag:T1', name: 'orc' },
    { _id: 'tag:LT', name: 'orc-lesson' },
  ];
  const books = [{ _id: 'book:New', name: 'repo' }];
  const files = { [`${ROOT}/.scratch/feat/inkdrop.json`]: link('note:linked', 'h') };
  const initial = {
    'orc.inkdropBook': 'book:Old',
    'orc.inkdropBookName': 'Orchestra',
    'orc.inkdropTag': 'tag:T1',
  };
  const server = inkdrop({ notes, books, tags, conflicts: 1 });
  const before = structuredClone(server.notes);
  const { deps, values } = statefulGit({ server, files }, initial);

  assert.deepEqual(await run(['init'], deps, ROOT), {
    code: 1,
    out: '',
    err: 'orc inkdrop: 3 orc notes in book:Old; rerun with --move to move them, or move them in Inkdrop first\n',
  });
  assert.deepEqual(server.notes, before, 'no note write');
  assert.deepEqual(Object.fromEntries(values), initial, 'no config write');
  const list = server.calls.find((c) => c.path === '/notes');
  assert.equal(list.query.get('keyword'), 'bookId:book:Old');
  assert.equal(list.query.get('limit'), '1000');
  assert.equal(server.calls.filter((c) => c.path === '/tags').length, 1, 'tags fetched once');

  assert.equal(
    (await run(['init', '--move'], deps, ROOT)).out,
    'notebook repo (book:New), tag orc (tag:T1)\nmoved 3 notes from book:Old\n',
  );
  for (const id of ['note:inbox', 'note:linked', 'note:lesson']) {
    assert.deepEqual(server.notes[id], {
      ...before[id],
      bookId: 'book:New',
      _rev: '2-x',
      updatedAt: NOW.getTime(),
    });
  }
  for (const id of Object.keys(before)) {
    if (!['note:inbox', 'note:linked', 'note:lesson'].includes(id)) {
      assert.deepEqual(server.notes[id], before[id], id);
    }
  }
  assert.equal(values.get('orc.inkdropBook'), 'book:New');
  assert.equal(values.get('orc.inkdropBookName'), 'repo');
  assert.equal(
    (await run(['init', '--move'], deps, ROOT)).out,
    'notebook repo (book:New), tag orc (tag:T1)\n',
  );

  const damaged = inkdrop({ notes: { 'note:bad': note('note:bad', BAD_LESSON) }, books, tags });
  const bad = await run(['init', '--move'], statefulGit({ server: damaged }, initial).deps, ROOT);
  assert.equal(bad.err, 'orc inkdrop: note:bad has a damaged orc block; fix it in Inkdrop\n');
  assert.ok(!damaged.calls.some((c) => c.method === 'POST'), 'nothing written');

  const noLessonTag = inkdrop({
    notes: { 'note:lesson': lessonNote('note:lesson', 'repo', lesson('L001', 1, 0), old) },
    books,
    tags: [tags[0]],
  });
  const { deps: d2, values: v2 } = statefulGit({ server: noLessonTag }, initial);
  assert.equal(
    (await run(['init'], d2, ROOT)).out,
    'notebook repo (book:New), tag orc (tag:T1)\n',
    'no movable notes: remaps normally',
  );
  assert.equal(v2.get('orc.inkdropBook'), 'book:New');
});
