import { dirname, join, resolve } from 'node:path';
import { parseFrontmatter } from './lib/frontmatter.mjs';
import { fail, format, info, warn } from './lib/report.mjs';

export const USAGE = 'usage: orch context [--scope user|project|all] [--json]\n';
// ponytail: heuristics, not harness limits; tune when real sessions say otherwise.
export const ALWAYS_WARN_TOKENS = 6000;
export const LISTING_WARN_TOKENS = 5000;
const DOC_BODY_LINES = 500;
const DESC_MAX = 300;
const IMPORT_DEPTH = 5;
const DEFAULT_DOC_BYTES = 32768;
const SCOPES = ['user', 'project', 'all'];
const BROAD = [
  /use proactively|\b(ANY|ALWAYS|EVERY|MUST)\b/,
  /\b(any|every) (coding )?task\b|\balways (use|load|invoke)\b/i,
];

export const tokens = (chars) => Math.ceil(chars / 4);
const fmtTokens = (chars) => {
  const n = tokens(chars);
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`;
};

/** Memory-file `@imports`: outside code, `@path` after whitespace that looks like a path. */
export function findImports(text) {
  let fenced = false;
  const found = [];
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of line.replace(/`[^`]*`/g, ' ').matchAll(/(?:^|\s)@(\S+)/g)) {
      const spec = m[1].replace(/[.,;:)]+$/, '');
      if (/^(~\/|\.\/|\.\.\/|\/)/.test(spec) || /\.\w+$/.test(spec)) found.push(spec);
    }
  }
  return found;
}

/** Backticked absolute-ish paths (`~/x`, `/a/b`) in a memory file; globs and templates skipped. */
export function findPaths(text) {
  return [...text.matchAll(/`((?:~\/|\/[^/\s`]+\/)[^\s`*{<$]*)`/g)]
    .map((m) => m[1])
    .filter((x) => !x.includes('...'));
}

/**
 * Description from frontmatter. ponytail: the flat parser yields `>`/`|` for block scalars, so
 * those re-read the indented lines after the key; no folding rules, no nested YAML.
 */
function descriptionOf(text, data) {
  const d = data.description ?? '';
  if (!/^[>|][-+]?$/.test(d)) return d;
  const m = /^description:\s*[>|][-+]?[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(text);
  return m
    ? m[1]
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ')
    : '';
}

/** Minimal line-based TOML: top-level keys and `[section]` keys, quotes stripped from headers. */
export function parseToml(text) {
  const top = {};
  const sections = new Map();
  let cur = top;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[([^\][]+)\]$/.exec(line);
    if (head) {
      cur = {};
      sections.set(head[1].replace(/"/g, '').trim(), cur);
    } else {
      const kv = /^([\w.-]+)\s*=\s*(.*)$/.exec(line);
      if (kv) cur[kv[1]] = kv[2].replace(/\s+#.*$/, '').trim();
    }
  }
  return { top, sections };
}

/** Reads one harness-agnostic world: all sources and structural findings. Never throws. */
export function collect(io, root) {
  const home = io.env.HOME ?? '';
  const sources = [];
  const findings = [];
  let harness = 'claude';
  const scopeOf = (p) => (p === root || p.startsWith(`${root}/`) ? 'project' : 'user');
  const add = (f, scope) => findings.push({ ...f, harness, scope });
  const short = (p) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

  const text = (p, scope = scopeOf(p)) => {
    if (!io.exists(p)) return null;
    try {
      return String(io.read(p, 'utf8'));
    } catch (e) {
      add(warn('unreadable', `${short(p)}: ${e.message}`, 'check file permissions'), scope);
      return null;
    }
  };
  const json = (p) => {
    const t = text(p);
    if (t === null) return null;
    try {
      return JSON.parse(t);
    } catch (e) {
      add(warn('unreadable', `${short(p)}: ${e.message}`, 'fix the JSON syntax'), scopeOf(p));
      return null;
    }
  };
  const ls = (dir) => {
    try {
      return io.exists(dir) ? [...io.readdir(dir)].sort() : [];
    } catch {
      return [];
    }
  };
  const push = (scope, origin, kind, name, path, size = {}, description = '') =>
    sources.push({
      harness,
      scope,
      origin,
      kind,
      name,
      path,
      always: 0,
      listing: 0,
      body: 0,
      manual: false,
      ...size,
      description,
    });

  const doc = (kind, fallback, p, scope, origin) => {
    const t = text(p, scope);
    if (t === null) return;
    const fm = parseFrontmatter(t);
    const data = fm?.data ?? {};
    const description = descriptionOf(t, data);
    const name = data.name || fallback;
    const body = fm ? fm.body : t;
    // Manual-only skills are never listed to the model: Claude's frontmatter flag, Codex's
    // `agents/openai.yaml` policy.
    const manual =
      harness === 'claude'
        ? data['disable-model-invocation'] === 'true'
        : kind === 'skill' &&
          /^\s*allow_implicit_invocation:\s*false\b/m.test(
            text(join(dirname(p), 'agents', 'openai.yaml'), scope) ?? '',
          );
    push(
      scope,
      origin,
      kind,
      name,
      p,
      { listing: manual ? 0 : name.length + description.length, body: body.length, manual },
      description,
    );
    if (kind === 'skill' && t.split('\n').length > DOC_BODY_LINES) {
      add(
        warn(
          'skill-body-large',
          `${name}: over ${DOC_BODY_LINES} lines`,
          'move detail into referenced files',
        ),
        scope,
      );
    }
  };
  const skills = (dir, scope, origin) => {
    for (const n of ls(dir)) {
      if (!n.startsWith('.')) doc('skill', n, join(dir, n, 'SKILL.md'), scope, origin);
    }
  };
  const mdFiles = (kind, dir, scope, origin) => {
    for (const n of ls(dir)) {
      if (n.endsWith('.md')) doc(kind, n.slice(0, -3), join(dir, n), scope, origin);
    }
  };
  const components = (base, scope, origin) => {
    skills(join(base, 'skills'), scope, origin);
    mdFiles('agent', join(base, 'agents'), scope, origin);
    mdFiles('command', join(base, 'commands'), scope, origin);
  };
  const hookIn = (hooks, p, scope, origin) => {
    if (hooks?.SessionStart || hooks?.hooks?.SessionStart) {
      push(scope, origin, 'hook', 'SessionStart', p);
    }
  };
  const mcp = (servers, scope, origin, p) => {
    for (const n of Object.keys(servers ?? {}).sort()) push(scope, origin, 'mcp', n, p);
  };

  // Memory with imports (Claude only).
  const resolveSpec = (spec, file) =>
    spec.startsWith('~/') ? join(home, spec.slice(2)) : resolve(dirname(file), spec);
  const walk = (p, depth, stack, scope) => {
    const t = text(p, scope);
    if (t === null) return { chars: 0, bytes: 0 };
    let chars = t.length;
    const gone = findPaths(t).filter(
      (x) => !io.exists(x.startsWith('~/') ? join(home, x.slice(2)) : x),
    );
    if (gone.length)
      add(
        warn('dangling-path', `${short(p)}: ${gone.join(', ')}`, 'remove or fix the path'),
        scope,
      );
    for (const spec of findImports(t)) {
      const target = resolveSpec(spec, p);
      if (stack.has(target))
        add(warn('import-cycle', `${short(p)} -> ${spec}`, 'remove the circular @import'), scope);
      else if (depth >= IMPORT_DEPTH)
        add(
          warn(
            'import-depth',
            `${short(p)} -> ${spec}`,
            `keep imports within ${IMPORT_DEPTH} levels`,
          ),
          scope,
        );
      else if (!io.exists(target))
        add(fail('broken-import', `${short(p)} -> ${spec}`, 'fix or remove the @import'), scope);
      else chars += walk(target, depth + 1, new Set([...stack, target]), scope).chars;
    }
    return { chars, bytes: Buffer.byteLength(t) };
  };
  const memory = (p, scope, origin) => {
    if (!io.exists(p)) return 0;
    const { chars, bytes } = walk(p, 0, new Set([p]), scope);
    push(scope, origin, 'memory', short(p), p, { always: chars });
    return bytes;
  };

  // ---- Claude
  const cdir = join(home, '.claude');
  const userMemory = join(cdir, 'CLAUDE.md');
  memory(userMemory, 'user', 'user');
  const seen = new Set([userMemory]);
  for (let d = io.cwd; ; d = dirname(d)) {
    for (const f of ['CLAUDE.md', 'CLAUDE.local.md', join('.claude', 'CLAUDE.md')]) {
      const p = join(d, f);
      if (!seen.has(p)) {
        seen.add(p);
        memory(p, 'project', 'project');
      }
    }
    if (dirname(d) === d) break;
  }
  components(cdir, 'user', 'user');
  if (root !== home) components(join(root, '.claude'), 'project', 'project');
  const userSettings = join(cdir, 'settings.json');
  // A project root at $HOME makes its settings.json the user one: read it once, as user.
  const settings = [
    [userSettings, 'user'],
    [join(root, '.claude', 'settings.json'), 'project'],
    [join(root, '.claude', 'settings.local.json'), 'project'],
  ].filter(([p, scope]) => scope === 'user' || p !== userSettings);
  const enabled = new Map();
  for (const [p, scope] of settings) {
    const s = json(p);
    if (!s) continue;
    hookIn(s.hooks, p, scope, scope);
    for (const [id, on] of Object.entries(s.enabledPlugins ?? {})) {
      if (on === true) enabled.set(id, new Set([...(enabled.get(id) ?? []), scope]));
    }
  }
  const installed = json(join(cdir, 'plugins', 'installed_plugins.json'))?.plugins ?? {};
  for (const [id, scopes] of [...enabled].sort()) {
    const scope = scopes.has('user') ? 'user' : 'project';
    if (scopes.size > 1) {
      add(warn('plugin-both-scopes', id, 'enable it in one scope only'), 'user');
    }
    const entries = installed[id] ?? [];
    const entry =
      entries.find((e) => e.scope === 'user') ??
      entries.find((e) => e.projectPath === root) ??
      entries[0];
    if (!entry?.installPath) continue;
    components(entry.installPath, scope, id);
    const hp = join(entry.installPath, 'hooks', 'hooks.json');
    hookIn(json(hp), hp, scope, id);
  }
  const cj = json(join(home, '.claude.json'));
  mcp(cj?.mcpServers, 'user', 'user', join(home, '.claude.json'));
  mcp(cj?.projects?.[root]?.mcpServers, 'project', 'project', join(home, '.claude.json'));
  mcp(json(join(root, '.mcp.json'))?.mcpServers, 'project', 'project', join(root, '.mcp.json'));

  // ---- Codex
  harness = 'codex';
  const xdir = join(home, '.codex');
  const pick = (d) =>
    io.exists(join(d, 'AGENTS.override.md')) ? 'AGENTS.override.md' : 'AGENTS.md';
  memory(join(xdir, pick(xdir)), 'user', 'user');
  const chain = [];
  for (let d = io.cwd; ; d = dirname(d)) {
    chain.unshift(d);
    if (d === root || dirname(d) === d) break;
  }
  const cfgText = text(join(xdir, 'config.toml'));
  const cfg = parseToml(cfgText ?? '');
  const limit = Number(cfg.top.project_doc_max_bytes) || DEFAULT_DOC_BYTES;
  let bytes = 0;
  for (const d of chain) bytes += memory(join(d, pick(d)), 'project', 'project');
  if (bytes > limit) {
    add(
      fail(
        'codex-doc-limit',
        `project docs ${bytes} bytes > project_doc_max_bytes ${limit}; Codex truncates`,
        'shorten AGENTS.md or raise project_doc_max_bytes',
      ),
      'project',
    );
  } else if (bytes > limit * 0.8) {
    add(
      warn(
        'codex-doc-limit',
        `project docs ${bytes} of ${limit} bytes`,
        'shorten AGENTS.md before Codex truncates it',
      ),
      'project',
    );
  }
  skills(join(xdir, 'skills'), 'user', 'user');
  skills(join(home, '.agents', 'skills'), 'user', 'user');
  if (root !== home) skills(join(root, '.agents', 'skills'), 'project', 'project');
  for (const [header, kv] of cfg.sections) {
    const plugin = /^plugins\.(.+)@([^@]+)$/.exec(header);
    if (plugin && kv.enabled !== 'false') {
      const dir = join(xdir, 'plugins', 'cache', plugin[2], plugin[1]);
      const ver = ls(dir)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .at(-1);
      if (!ver) continue;
      const base = join(dir, ver);
      skills(join(base, 'skills'), 'user', `${plugin[1]}@${plugin[2]}`);
      const hp = io.exists(join(base, 'hooks', 'hooks.json'))
        ? join(base, 'hooks', 'hooks.json')
        : join(base, 'hooks.json');
      hookIn(json(hp), hp, 'user', `${plugin[1]}@${plugin[2]}`);
    }
    const server = /^mcp_servers\.([^.]+)$/.exec(header);
    if (server) push('user', 'user', 'mcp', server[1], join(xdir, 'config.toml'));
  }
  return { sources, findings };
}

const jaccard = (a, b) => {
  const both = [...a].filter((w) => b.has(w)).length;
  return both / (a.size + b.size - both);
};
const words = (s) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);

/** Budget, top and description/duplicate/overlap findings per harness, scope-filtered. */
export function analyze({ sources, findings }, { scope = 'all' } = {}) {
  const keep = (x) => scope === 'all' || x.scope === scope;
  const kept = sources.filter(keep);
  const out = [];
  for (const harness of ['claude', 'codex']) {
    const own = kept.filter((s) => s.harness === harness);
    if (!own.length && !findings.some((f) => f.harness === harness)) continue;
    const add = (f) => out.push({ ...f, harness });
    const count = (kind) => own.filter((s) => s.kind === kind && !s.manual).length;
    const manual = own.filter((s) => s.manual).length;
    const always = own.reduce((n, s) => n + s.always, 0);
    const listing = own.reduce((n, s) => n + s.listing, 0);
    const heavy = tokens(always) > ALWAYS_WARN_TOKENS || tokens(listing) > LISTING_WARN_TOKENS;
    const detail =
      `always-loaded ${fmtTokens(always)} tokens (${count('memory')} files), ` +
      `listing ${fmtTokens(listing)} tokens (${count('skill')} skills, ${count('agent')} agents, ` +
      `${count('command')} commands${manual ? `; ${manual} manual-only, not listed` : ''}), ` +
      `${count('mcp')} MCP servers, ` +
      `${count('hook')} SessionStart hooks (not measured)`;
    add(
      heavy
        ? warn('budget', detail, 'disable unused plugins or trim memory files and descriptions')
        : info('budget', detail),
    );
    const size = (s) => s.always + s.listing;
    for (const s of own
      .filter((x) => size(x) > 0)
      .sort((a, b) => size(b) - size(a))
      .slice(0, 5)) {
      add(info('top', `${fmtTokens(size(s))}  ${s.kind} ${s.name} (${s.origin})`));
    }
    // Manual-only entries cost no listing and cannot mis-trigger, so description checks skip them.
    const docs = own.filter((s) => ['skill', 'agent', 'command'].includes(s.kind) && !s.manual);
    // Plugin descriptions are not the user's to edit: one line per plugin, not per skill.
    const pluginLong = new Map();
    for (const s of docs) {
      const label = `${s.kind} ${s.name} (${s.origin})`;
      if (!s.description && s.kind !== 'command') {
        add(warn('description-missing', label, 'add a description to the frontmatter'));
      }
      if (s.description.length > DESC_MAX && ['user', 'project'].includes(s.origin)) {
        add(
          warn(
            'description-long',
            `${label}: ${s.description.length} chars`,
            `keep it under ${DESC_MAX}`,
          ),
        );
      } else if (s.description.length > DESC_MAX) {
        const list = pluginLong.get(s.origin) ?? [];
        pluginLong.set(s.origin, [...list, `${s.name} ${s.description.length}`]);
      }
      if (BROAD.some((re) => re.test(s.description))) {
        add(warn('broad-trigger', label, 'name the situations that should trigger it'));
      }
    }
    for (const [origin, list] of pluginLong) {
      add(
        warn(
          'description-long',
          `${origin}: ${list.length} over ${DESC_MAX} chars (${list.join(', ')})`,
          'report upstream or disable the plugin if unused',
        ),
      );
    }
    const byName = new Map();
    for (const s of docs) {
      const k = `${s.kind} ${s.name}`;
      byName.set(k, [...(byName.get(k) ?? []), s.origin]);
    }
    for (const [k, origins] of byName) {
      if (new Set(origins).size > 1) {
        add(warn('duplicate-name', `${k}: ${[...new Set(origins)].join(', ')}`, 'keep one copy'));
      }
    }
    // ponytail: O(n^2) pairwise Jaccard; fine for tens of skills, index words if it ever is not.
    const pool = docs.filter((s) => s.kind !== 'command' && s.description);
    for (let i = 0; i < pool.length; i++) {
      const a = words(pool[i].description);
      for (let j = i + 1; j < pool.length; j++) {
        if (a.size && jaccard(a, words(pool[j].description)) >= 0.5) {
          add(
            warn(
              'overlap',
              `${pool[i].name} (${pool[i].origin}) ~ ${pool[j].name} (${pool[j].origin})`,
              'merge or sharpen one description',
            ),
          );
        }
      }
    }
  }
  return { sources: kept, findings: [...out, ...findings.filter(keep)] };
}

/** Returns `{ code, out, err }`; code is 1 on any `✗` or a usage error. Never throws. */
export function run(args, io) {
  let scope = 'all';
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') asJson = true;
    else if (a === '--scope' || a.startsWith('--scope=')) {
      scope = a === '--scope' ? args[++i] : a.slice(8);
      if (!SCOPES.includes(scope)) return { code: 1, out: '', err: USAGE };
    } else return { code: 1, out: '', err: USAGE };
  }
  let root = io.cwd;
  try {
    const r = io.exec('git', ['rev-parse', '--show-toplevel'], io.cwd);
    if (r.status === 0 && r.stdout.trim()) root = r.stdout.trim();
  } catch {
    // not a git checkout: the cwd is the project root
  }
  let result;
  try {
    result = analyze(collect(io, root), { scope });
  } catch (e) {
    result = { sources: [], findings: [{ ...fail('context', e.message), harness: 'claude' }] };
  }
  const code = result.findings.some((f) => f.mark === '✗') ? 1 : 0;
  if (asJson) {
    const doc = { schemaVersion: 1, ...result }; // ADR-0010 contract
    return { code, out: `${JSON.stringify(doc, null, 2)}\n`, err: '' };
  }
  const lines = [];
  for (const harness of ['claude', 'codex']) {
    const own = result.findings.filter((f) => f.harness === harness);
    if (own.length) lines.push(harness, ...own.map((f) => `  ${format(f)}`));
  }
  return { code, out: `${lines.join('\n')}\n`, err: '' };
}
