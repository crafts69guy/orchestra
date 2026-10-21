import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { lessonsPath, parseLessons, selectLessons } from './lib/lessons.mjs';
import { collect, mainRoot, parseBase } from './status.mjs';

const USAGE =
  'usage: orc inkdrop init [--book <name>] [--parent <name>] [--create] [--move] | inbox [--json] | claim <note-id> <feature> | push <feature> [--done] | pull <feature> | lessons\n';
const DEFAULT_URL = 'http://localhost:19840';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']); // URL.hostname keeps IPv6 brackets
const TIMEOUT_MS = 5000;
const TAG = 'orc';
const LESSON_TAG = 'orc-lesson';
const LESSON_ID = /^lesson: (.+)$/m;
const REMOTE = /^(?:[a-z][\w+.-]*:\/\/[^/]+\/|[^@/\s]+@[^:/\s]+:)(.+?)(?:\.git)?\/?$/;
const TITLE_MAX = 60;
const BEGIN = '<!-- orc:begin -->';
const END = '<!-- orc:end -->';
// A marker is a whole line (CRLF-tolerant); a CR before its newline stays outside the block.
const MARKER = /^<!-- orc:(begin|end) -->(?=\r?$)/gm;
const DAMAGED = 'damaged';
const NOTE_ID = /^note:[\w-]+$/;
const FEATURE = /^[\w.-]+$/;
const NOT_RUNNING =
  'orc inkdrop: Inkdrop is not running or its local server is off (Preferences → Local Server)';
const UNCONFIGURED = 'orc inkdrop: this repo has no Inkdrop notebook; run orc inkdrop init';

/** An expected failure: its message is the one stderr line. */
class Fail extends Error {}
/** HTTP 409 on a write: the note's `_rev` is stale. */
class Conflict extends Fail {}

/**
 * The repo's Inkdrop mapping from local git config (one `git config --get-regexp ^orc\.inkdrop`):
 * `{ book, bookName, tag }`, each null when unset. `deps.exec` never throws.
 */
export function inkdropConfig(cwd, { exec }) {
  const r = exec('git', ['config', '--get-regexp', '^orc\\.inkdrop'], cwd);
  const values = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf(' ');
    if (i > 0) values[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return {
    book: values['orc.inkdropbook'] || null,
    bookName: values['orc.inkdropbookname'] || null,
    tag: values['orc.inkdroptag'] || null,
  };
}

/**
 * True when Inkdrop is wired for this repo: not `ORC_INKDROP=0`, both `INKDROP_LOCAL_USERNAME` and
 * `INKDROP_LOCAL_PASSWORD` set and `orc.inkdropBook` configured. Offline: no HTTP.
 */
export function inkdropEnabled(env, cwd, { exec }) {
  return (
    env.ORC_INKDROP !== '0' &&
    Boolean(env.INKDROP_LOCAL_USERNAME) &&
    Boolean(env.INKDROP_LOCAL_PASSWORD) &&
    inkdropConfig(cwd, { exec }).book !== null
  );
}

/** The `buildContext` flag: `{ name, id }` of the mapped notebook when `inkdropEnabled`, else false. */
export function inkdropFlag(env, cwd, { exec }) {
  if (env.ORC_INKDROP === '0' || !env.INKDROP_LOCAL_USERNAME || !env.INKDROP_LOCAL_PASSWORD) {
    return false;
  }
  const { book, bookName } = inkdropConfig(cwd, { exec });
  return book === null ? false : { name: bookName ?? book, id: book };
}

/**
 * The managed block's `{ start, end }` offsets: exactly one BEGIN line followed by exactly one END
 * line. Null with no marker lines; `DAMAGED` for any other combination (an unterminated BEGIN, a
 * lone END, two blocks, END before BEGIN), where guessing the bounds could eat user text.
 */
function locate(body) {
  const marks = [...body.matchAll(MARKER)];
  if (marks.length === 0) return null;
  const [begin, end] = marks;
  if (marks.length !== 2 || begin[1] !== 'begin' || end[1] !== 'end') return DAMAGED;
  return { start: begin.index, end: end.index + END.length };
}

/** Throws unless `body`'s markers are intact (one whole block, or none). */
function intact(id, body) {
  if (locate(body) === DAMAGED) {
    throw new Fail(`orc inkdrop: ${id} has a damaged orc block; fix it in Inkdrop`);
  }
}

/** The user's spec: `body` without the managed block, trimmed. Throws on damaged markers. */
export function spec(body) {
  intact('note', body);
  const at = locate(body);
  return (at ? body.slice(0, at.start) + body.slice(at.end) : body).trim();
}

/**
 * `body` with the managed block replaced in place, else `block` appended after a blank line (an
 * empty body becomes the block). Text outside the block is kept byte for byte. Throws on damaged
 * markers rather than guess.
 */
export function splice(body, block) {
  intact('note', body);
  const at = locate(body);
  if (at) return body.slice(0, at.start) + block + body.slice(at.end);
  const head = body.trimEnd();
  return head ? `${head}\n\n${block}` : block;
}

/** Top-level bullets (with their indented continuation lines) of the plan's `## Decisions`. */
function decisions(plan) {
  const section = plan.split(/^(?=## )/m).find((s) => /^## Decisions\b/.test(s)) ?? '';
  const bullets = [];
  let open = false;
  for (const line of section.split('\n')) {
    if (line.startsWith('- ')) {
      bullets.push(line);
      open = true;
    } else if (open && /^\s+\S/.test(line)) bullets[bullets.length - 1] += `\n${line}`;
    else open = false;
  }
  return bullets;
}

/** Local `YYYY-MM-DD HH:MM`. */
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The managed block for a feature: heading (feature, base branch, update time), the plan's
 * Decisions, a checkbox per task (merged tasks checked with their short sha, others with their
 * agent, report or worktree state) and `log`. `plan` and `log` are file text or null; `tasks` are
 * `orc status` tasks. Marker lines inside plan or log text are defused so the block stays whole.
 */
export function renderBlock({ feature, plan, tasks, log, now }) {
  const parts = [
    `## orc · \`${feature}\` · ${parseBase(plan ?? '') ?? '-'} · updated ${stamp(now)}`,
  ];
  const ds = plan ? decisions(plan.replace(/\r\n/g, '\n')) : [];
  if (ds.length) parts.push(`**Decisions**\n\n${ds.join('\n')}`);
  if (tasks.length) {
    const lines = tasks.map((t) => {
      const label = t.goal ? `${t.id} ${t.goal}` : t.id;
      if (t.merged) return `- [x] ${label} (merged ${t.merged.commit.slice(0, 7)})`;
      const state = t.agent?.state ?? t.report?.status ?? (t.worktree ? 'worktree' : 'pending');
      return `- [ ] ${label} (${state})`;
    });
    parts.push(`**Tasks**\n\n${lines.join('\n')}`);
  } else parts.push('_claimed, no plan yet_');
  if (log?.trim()) parts.push(`### Log\n\n${log.trim()}`);
  const body = parts.join('\n\n').replace(/^<!-- orc:(begin|end) -->/gm, '<!-- orc $1 -->');
  return `${BEGIN}\n${body}\n${END}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Base URL and auth header from env; refuses a non-loopback host. Never echoes the credentials. */
function server(env) {
  if (!env.INKDROP_LOCAL_USERNAME || !env.INKDROP_LOCAL_PASSWORD) {
    throw new Fail('orc inkdrop: set INKDROP_LOCAL_USERNAME and INKDROP_LOCAL_PASSWORD');
  }
  let url;
  try {
    url = new URL(env.INKDROP_LOCAL_SERVER_URL || DEFAULT_URL);
  } catch {
    throw new Fail('orc inkdrop: INKDROP_LOCAL_SERVER_URL is not a valid URL');
  }
  if (!LOOPBACK.has(url.hostname)) {
    throw new Fail(`orc inkdrop: refusing non-loopback Inkdrop server host ${url.hostname}`);
  }
  const auth = Buffer.from(`${env.INKDROP_LOCAL_USERNAME}:${env.INKDROP_LOCAL_PASSWORD}`);
  return { base: url.origin, auth: `Basic ${auth.toString('base64')}` };
}

/** One JSON request to the local server; throws `Fail` (`Conflict` on 409). */
async function request(deps, srv, method, path, { query, body, timeout = TIMEOUT_MS } = {}) {
  const url = new URL(path, srv.base);
  if (query) url.search = new URLSearchParams(query).toString();
  const headers = { Authorization: srv.auth };
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await deps.fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', // a redirect could carry the auth header off the loopback host
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Fail(NOT_RUNNING);
  }
  if (res.status === 401) {
    throw new Fail(
      'orc inkdrop: unauthorized; check INKDROP_LOCAL_USERNAME and INKDROP_LOCAL_PASSWORD',
    );
  }
  if (res.status === 409) throw new Conflict('orc inkdrop: note changed concurrently; retry');
  if (!res.ok) throw new Fail(`orc inkdrop: ${method} ${url.pathname} failed: HTTP ${res.status}`);
  return res.json();
}

/** POSTs a new doc to `/<kind>s` and returns the server-assigned `<kind>:…` id from `{ ok, id, rev }`. */
async function create(ctx, kind, doc) {
  const r = await ctx.call('POST', `/${kind}s`, { body: doc });
  if (typeof r?.id !== 'string' || !r.id.startsWith(`${kind}:`)) {
    throw new Fail(`orc inkdrop: POST /${kind}s returned no ${kind} id`);
  }
  return r.id;
}

/**
 * Doctor probe: `GET /` with a 1.5 s timeout, the same auth and loopback rules as every command.
 * Resolves to `{ version }` or `{ error }` (one line, no `orc inkdrop:` prefix); never throws.
 */
export async function probe(env, fetch) {
  try {
    const meta = await request({ fetch }, server(env), 'GET', '/', { timeout: 1500 });
    return { version: String(meta?.version) };
  } catch (e) {
    return { error: e.message.replace(/^orc inkdrop: /, '') };
  }
}

/** Root, mapping and a bound `call(method, path, opts)`; `needConfig` requires `init` to have run. */
function setup(deps, cwd, needConfig = true) {
  const root = mainRoot(deps, cwd);
  if (root === null) throw new Fail(`orc inkdrop: not a git repository: ${cwd}`);
  const srv = server(deps.env);
  const config = inkdropConfig(root, deps);
  if (needConfig && !(config.book && config.bookName && config.tag)) throw new Fail(UNCONFIGURED);
  return { root, config, call: (method, path, opts) => request(deps, srv, method, path, opts) };
}

/** `<root>/.scratch/<feature>` after validating the name (no paths, no `.`/`..`). */
function featureDir(root, feature) {
  if (!FEATURE.test(feature) || /^\.+$/.test(feature)) {
    throw new Fail(`orc inkdrop: invalid feature name: ${feature}`);
  }
  return join(root, '.scratch', feature);
}

/** File text, or null when it cannot be read. */
function readOptional(deps, path) {
  try {
    return deps.readFile(path);
  } catch {
    return null;
  }
}

/** `{ noteId, specHash }` from `inkdrop.json`, null when missing; invalid content fails. */
function readLink(deps, dir) {
  const text = readOptional(deps, join(dir, 'inkdrop.json'));
  if (text === null) return null;
  let link;
  try {
    link = JSON.parse(text);
  } catch {
    link = null;
  }
  if (!NOTE_ID.test(link?.noteId))
    throw new Fail(`orc inkdrop: invalid ${join(dir, 'inkdrop.json')}`);
  return link;
}

function writeLink(deps, dir, link) {
  deps.writeFile(join(dir, 'inkdrop.json'), `${JSON.stringify(link, null, 2)}\n`);
}

/** The feature's block from its plan.md, log.md and `orc status` task state. */
function featureBlock(deps, cwd, dir, feature) {
  const plan = readOptional(deps, join(dir, 'plan.md'));
  const log = readOptional(deps, join(dir, 'log.md'));
  const found = collect(deps, cwd).result?.features.find((f) => f.feature === feature);
  return {
    plan,
    block: renderBlock({ feature, plan, tasks: found?.tasks ?? [], log, now: deps.now() }),
  };
}

/**
 * Read-modify-write of a note: GET, `modify(note)`, then `POST /notes` with the full doc and its
 * `_rev`. One retry from a fresh GET on a conflict. Returns the doc written.
 */
async function save(ctx, deps, id, modify, retry = true) {
  const note = await ctx.call('GET', `/${id}`);
  const doc = { ...modify(note), updatedAt: deps.now().getTime() };
  try {
    await ctx.call('POST', '/notes', { body: doc });
    return doc;
  } catch (e) {
    if (retry && e instanceof Conflict) return save(ctx, deps, id, modify, false);
    throw e;
  }
}

async function pushFeature(deps, cwd, feature, done) {
  const ctx = setup(deps, cwd);
  const dir = featureDir(ctx.root, feature);
  const { plan, block } = featureBlock(deps, cwd, dir, feature);
  const link = readLink(deps, dir);
  const status = done ? { status: 'completed' } : {};
  if (link) {
    await save(ctx, deps, link.noteId, (note) => {
      intact(link.noteId, note.body ?? '');
      return { ...note, body: splice(note.body ?? '', block), ...status };
    });
    return `pushed ${link.noteId}\n`;
  }
  const time = deps.now().getTime();
  deps.mkdir(dir);
  const note = {
    doctype: 'markdown',
    title: plan?.match(/^# (.+)$/m)?.[1].trim() ?? feature,
    body: block,
    bookId: ctx.config.book,
    tags: [ctx.config.tag],
    status: 'active',
    ...status,
    createdAt: time,
    updatedAt: time,
  };
  const noteId = await create(ctx, 'note', note);
  writeLink(deps, dir, { noteId, specHash: sha256(spec(note.body)) });
  return `created ${noteId}\n`;
}

/** `{ code: 0, out }`, or `{ code: 1, error }` with the one-line message of any failure. */
async function attempt(fn) {
  try {
    return { code: 0, out: await fn() };
  } catch (e) {
    return { code: 1, error: e instanceof Fail ? e.message : `orc inkdrop: ${e.message}` };
  }
}

/**
 * Renders the feature's block and saves it into its linked note (creating and linking the note,
 * titled from plan.md's `# ` heading, when there is none); `done` sets status `completed`. Never
 * updates `specHash`. Returns `{ code, out }` or `{ code: 1, error }`; never throws. `deps`: `exec`,
 * `readFile`, `writeFile`, `readdir`, `env`, `hasCommand`, `fetch`, `now`.
 */
export function push(deps, cwd, feature, { done = false } = {}) {
  return attempt(() => pushFeature(deps, cwd, feature, done));
}

/** The tag named `name` from `tags` (default: `GET /tags`), created when missing. */
async function ensureTag(ctx, name, time, tags = null) {
  tags ??= await ctx.call('GET', '/tags', { query: { limit: '1000' } });
  const tag = tags.find((t) => t.name === name);
  if (tag) return tag;
  const doc = { name, color: 'default', createdAt: time, updatedAt: time };
  return { ...doc, _id: await create(ctx, 'tag', doc) };
}

const sameName = (b, name) => b.name?.toLowerCase() === name.toLowerCase();

/** The first of `books` matching `pick`, else a new notebook (`--create`), else a `Fail`. */
async function findBook(ctx, flags, books, pick, doc, missing) {
  const book = books.find(pick);
  if (book) return book;
  if (!flags.create) throw new Fail(`orc inkdrop: ${missing}; pass --create to create it`);
  return { ...doc, _id: await create(ctx, 'book', doc) };
}

/** `orc.inkdropParent` from git config (local or global), or null. */
function parentName(deps, root) {
  const r = deps.exec('git', ['config', '--get', 'orc.inkdropParent'], root);
  return (r.status === 0 && r.stdout.trim()) || null;
}

/**
 * Moves this repo's notes from the `old` book to `bookId`, changing only `bookId` (never deletes):
 * `orc-lesson` notes whose identity is this repo's, and `orc` notes linked locally or unclaimed (no
 * block). Without `flags.move` any such note fails the run before a write. Returns the output line.
 */
async function relocate(ctx, deps, flags, old, bookId, { tag, lesson }) {
  // ponytail: one page of 1000; add skip paging if a notebook ever holds more orc notes.
  const found = await ctx.call('GET', '/notes', {
    query: { keyword: `bookId:${old}`, limit: '1000' },
  });
  const repo = repoKey(deps, ctx.root);
  const linked = linkedNotes(deps, ctx.root);
  // Identify every candidate first, so a damaged lesson block fails the run before any write.
  const notes = found.filter((n) => {
    if (n.bookId !== old) return false;
    const body = n.body ?? '';
    const isLesson =
      lesson && n.tags?.includes(lesson._id) && lessonIdentity(n._id, body)?.startsWith(`${repo}/`);
    const isOrc = n.tags?.includes(tag._id) && (linked.has(n._id) || locate(body) === null);
    return Boolean(isLesson || isOrc);
  });
  if (!flags.move) {
    if (!notes.length) return '';
    throw new Fail(
      `orc inkdrop: ${notes.length} orc notes in ${old}; rerun with --move to move them, or move them in Inkdrop first`,
    );
  }
  for (const n of notes) await save(ctx, deps, n._id, (note) => ({ ...note, bookId }));
  return `moved ${notes.length} notes from ${old}\n`;
}

/**
 * Maps the repo to a notebook (`--book`, default the repo basename), under the root notebook
 * `--parent` (else `orc.inkdropParent`) when given; `--create` creates what is missing. On a remap,
 * `--move` moves the old book's orc notes of this repo; without it, any such note fails the run.
 */
async function init(deps, cwd, flags) {
  const ctx = setup(deps, cwd, false);
  const name = flags.book ?? basename(ctx.root);
  const parent = flags.parent ?? parentName(deps, ctx.root);
  const time = deps.now().getTime();
  const stamps = { createdAt: time, updatedAt: time };
  const books = await ctx.call('GET', '/books', { query: { limit: '1000' } });
  let book;
  let display;
  if (parent === null) {
    book = await findBook(
      ctx,
      flags,
      books,
      (b) => sameName(b, name),
      { name, parentBookId: null, ...stamps },
      `no notebook named "${name}"`,
    );
    display = book.name;
  } else {
    const top = await findBook(
      ctx,
      flags,
      books,
      (b) => !b.parentBookId && sameName(b, parent),
      { name: parent, parentBookId: null, ...stamps },
      `no root notebook named "${parent}"`,
    );
    book = await findBook(
      ctx,
      flags,
      books,
      (b) => b.parentBookId === top._id && sameName(b, name),
      { name, parentBookId: top._id, ...stamps },
      `no notebook named "${name}" under "${top.name}"`,
    );
    display = `${top.name}/${book.name}`;
  }
  const tags = await ctx.call('GET', '/tags', { query: { limit: '1000' } });
  const tag = await ensureTag(ctx, TAG, time, tags);
  const lesson = tags.find((t) => t.name === LESSON_TAG);
  const old = ctx.config.book;
  let moved = '';
  if (old && old !== book._id) {
    moved = await relocate(ctx, deps, flags, old, book._id, { tag, lesson });
  }
  const settings = [
    ['orc.inkdropBook', book._id],
    ['orc.inkdropBookName', display],
    ['orc.inkdropTag', tag._id],
  ];
  for (const [key, value] of settings) {
    const r = deps.exec('git', ['config', key, value], ctx.root);
    if (r.status !== 0) throw new Fail(`orc inkdrop: git config ${key} failed: ${r.stderr.trim()}`);
  }
  return `notebook ${display} (${book._id}), tag ${TAG} (${tag._id})\n${moved}`;
}

/** Note ids linked by any `<root>/.scratch/<feature>/inkdrop.json`; unreadable ones are skipped. */
function linkedNotes(deps, root) {
  let names = [];
  try {
    names = deps.readdir(join(root, '.scratch'));
  } catch {
    // no .scratch: nothing linked
  }
  const ids = new Set();
  for (const name of names) {
    try {
      ids.add(JSON.parse(deps.readFile(join(root, '.scratch', name, 'inkdrop.json'))).noteId);
    } catch {
      // not linked
    }
  }
  return ids;
}

async function inbox(deps, cwd, json) {
  const { root, config, call } = setup(deps, cwd);
  const linked = linkedNotes(deps, root);
  const keyword = `bookId:${config.book} tag:${TAG} status:active`;
  const found = await call('GET', '/notes', { query: { keyword, limit: '100' } });
  // The keyword is a hint; the filter decides: exact book, tag id, no marker lines at all (a damaged
  // block counts as claimed) and not linked locally (a truncated body may hide the block).
  const notes = found.filter(
    (n) =>
      n.bookId === config.book &&
      n.tags?.includes(config.tag) &&
      locate(n.body ?? '') === null &&
      !linked.has(n._id),
  );
  if (json) {
    const list = notes.map((n) => ({ id: n._id, title: n.title, updatedAt: n.updatedAt }));
    return `${JSON.stringify({ schemaVersion: 1, notes: list }, null, 2)}\n`;
  }
  return notes.length ? notes.map((n) => `${n._id}  ${n.title}\n`).join('') : 'no queued notes\n';
}

async function claim(deps, cwd, id, feature) {
  const ctx = setup(deps, cwd);
  if (!NOTE_ID.test(id)) throw new Fail(`orc inkdrop: invalid note id: ${id}`);
  const dir = featureDir(ctx.root, feature);
  const link = readLink(deps, dir);
  if (link) throw new Fail(`orc inkdrop: feature ${feature} is already linked to ${link.noteId}`);
  const { block } = featureBlock(deps, cwd, dir, feature);
  const doc = await save(ctx, deps, id, (note) => {
    if (note.bookId !== ctx.config.book) {
      throw new Fail(`orc inkdrop: ${id} is not in notebook ${ctx.config.bookName}`);
    }
    const body = note.body ?? '';
    intact(id, body);
    if (locate(body)) throw new Fail(`orc inkdrop: ${id} is already claimed`);
    const tags = note.tags ?? [];
    return {
      ...note,
      body: splice(body, block),
      tags: tags.includes(ctx.config.tag) ? tags : [...tags, ctx.config.tag],
    };
  });
  const request = spec(doc.body);
  deps.mkdir(dir);
  writeLink(deps, dir, { noteId: id, specHash: sha256(request) });
  return `# ${doc.title}\n\n${request}\n`;
}

async function pull(deps, cwd, feature) {
  const { root, call } = setup(deps, cwd);
  const dir = featureDir(root, feature);
  const link = readLink(deps, dir);
  if (!link) throw new Fail(`orc inkdrop: feature ${feature} has no linked note`);
  const note = await call('GET', `/${link.noteId}`);
  intact(link.noteId, note.body ?? '');
  const current = spec(note.body ?? '');
  const specHash = sha256(current);
  if (specHash === link.specHash) return 'changed: no\n';
  writeLink(deps, dir, { ...link, specHash });
  return `changed: yes\n\n${current}\n`;
}

/**
 * A lesson note's title and managed block: `<repo>:<id> <text cut to 60 chars>`, and the identity
 * line `lesson: <repo>/<id>` (`repo` is the origin's `<owner>/<name>` or the checkout's basename), score, scope, feature and text. Marker lines in the text are defused.
 */
export function renderLesson(repo, lesson) {
  const { id, up, down, scope, feature, text } = lesson;
  const cut = text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
  const body = [
    `lesson: ${repo}/${id}`,
    `score: +${up} -${down} · scope: ${scope} · feature: ${feature}`,
    '',
    text,
  ]
    .join('\n')
    .replace(/^<!-- orc:(begin|end) -->/gm, '<!-- orc $1 -->');
  return { title: `${repo}:${id} ${cut}`, block: `${BEGIN}\n${body}\n${END}` };
}

/**
 * `<owner>/<name>` from a git remote URL, https (`https://host/owner/name(.git)`) or scp
 * (`git@host:owner/name(.git)`) style; the last two path segments, `.git` stripped. Null otherwise.
 */
export function remoteKey(url) {
  const parts = url.trim().match(REMOTE)?.[1].split('/') ?? [];
  return parts.length >= 2 && parts.every(Boolean) ? parts.slice(-2).join('/') : null;
}

/** The repo key for lesson identities: `remoteKey` of origin, else the main checkout's basename. */
function repoKey(deps, root) {
  const r = deps.exec('git', ['remote', 'get-url', 'origin'], root);
  return (r.status === 0 && remoteKey(r.stdout)) || basename(root);
}

/** The `<key>/<id>` identity in a note's managed block, or null (no block or no line). */
function lessonIdentity(id, body) {
  intact(id, body);
  const at = locate(body);
  return at ? (body.slice(at.start, at.end).match(LESSON_ID)?.[1] ?? null) : null;
}

async function lessons(deps, cwd) {
  const root = mainRoot(deps, cwd);
  const path = root && lessonsPath(root);
  const text = path && readOptional(deps, path);
  if (path && text === null) return `no lessons in ${path}\n`;
  const ctx = setup(deps, cwd);
  const repo = repoKey(deps, ctx.root);
  const active = new Map(
    selectLessons(parseLessons(text).lessons, Number.POSITIVE_INFINITY).kept.map((l) => [
      `${repo}/${l.id}`,
      renderLesson(repo, l),
    ]),
  );
  const time = deps.now().getTime();
  const tag = await ensureTag(ctx, LESSON_TAG, time);
  // ponytail: one page of 1000; add skip paging if a notebook ever holds more lesson notes.
  const keyword = `bookId:${ctx.config.book} tag:${LESSON_TAG}`;
  const found = await ctx.call('GET', '/notes', { query: { keyword, limit: '1000' } });
  // Identify every tagged note first, so a damaged block fails the run before any write.
  const mine = found
    .filter((n) => n.bookId === ctx.config.book && n.tags?.includes(tag._id))
    .map((n) => ({ n, identity: lessonIdentity(n._id, n.body ?? '') }))
    .filter(({ identity }) => identity?.startsWith(`${repo}/`));
  const counts = { created: 0, updated: 0, dropped: 0, unchanged: 0 };
  const seen = new Set();
  for (const { n, identity } of mine) {
    seen.add(identity);
    const want = active.get(identity);
    if (!want) {
      if (n.status === 'dropped') continue;
      await save(ctx, deps, n._id, (note) => ({ ...note, status: 'dropped' }));
      counts.dropped++;
      continue;
    }
    const doc = (note) => ({
      ...note,
      title: want.title,
      body: splice(note.body ?? '', want.block),
      status: 'active',
    });
    const next = doc(n);
    if (next.title === n.title && next.body === n.body && n.status === 'active') {
      counts.unchanged++;
      continue;
    }
    await save(ctx, deps, n._id, doc);
    counts.updated++;
  }
  for (const [identity, want] of active) {
    if (seen.has(identity)) continue;
    await create(ctx, 'note', {
      doctype: 'markdown',
      title: want.title,
      body: want.block,
      bookId: ctx.config.book,
      tags: [tag._id],
      status: 'active',
      createdAt: time,
      updatedAt: time,
    });
    counts.created++;
  }
  const { created, updated, dropped, unchanged } = counts;
  return `lessons: ${created} created, ${updated} updated, ${dropped} dropped, ${unchanged} unchanged\n`;
}

/** `init` flags, or null on anything unexpected. */
function initFlags(rest) {
  const flags = { book: undefined, parent: undefined, create: false, move: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--create') flags.create = true;
    else if (rest[i] === '--move') flags.move = true;
    else if (
      (rest[i] === '--book' || rest[i] === '--parent') &&
      rest[i + 1] &&
      !rest[i + 1].startsWith('--')
    ) {
      flags[rest[i].slice(2)] = rest[++i];
    } else return null;
  }
  return flags;
}

/** The subcommand as a thunk, or null for bad args. */
function parse(deps, cwd, [sub, ...rest]) {
  if (sub === 'init') {
    const flags = initFlags(rest);
    return flags && (() => init(deps, cwd, flags));
  }
  if (sub === 'inbox' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--json'))) {
    return () => inbox(deps, cwd, rest.length === 1);
  }
  if (sub === 'claim' && rest.length === 2) return () => claim(deps, cwd, rest[0], rest[1]);
  const positional = rest.filter((a) => a !== '--done');
  if (sub === 'push' && positional.length === 1 && rest.length <= 2) {
    return () => pushFeature(deps, cwd, positional[0], rest.length === 2);
  }
  if (sub === 'pull' && rest.length === 1) return () => pull(deps, cwd, rest[0]);
  if (sub === 'lessons' && rest.length === 0) return () => lessons(deps, cwd);
  return null;
}

/**
 * `orc inkdrop init|inbox|claim|push|pull|lessons`. `lessons` mirrors the active lessons of
 * `<mainRoot>/.orc/lessons.md` into one `orc-lesson` note each and drops this repo's removed ones.
 * Resolves to `{ code, out, err }`; failures are one stderr line, never a throw. `deps`: `exec` (never throws), `readFile` (utf8), `writeFile`,
 * `readdir`, `mkdir` (recursive), `env`, `hasCommand`, `fetch`, `now` (a Date).
 */
export async function run(args, deps, cwd) {
  const thunk = parse(deps, cwd, args);
  if (!thunk) return { code: 1, out: '', err: USAGE };
  const r = await attempt(thunk);
  return r.code === 0
    ? { code: 0, out: r.out, err: '' }
    : { code: 1, out: '', err: `${r.error}\n` };
}
