import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BLOCK_REASON, handbackReport, hasEvidence, main, run } from '../hooks/subagent-stop.mjs';

// Not a git repo: a deny/block from main or the script records no signal into this checkout.
const NO_REPO = mkdtempSync(join(tmpdir(), 'orc-signal-'));
after(() => rmSync(NO_REPO, { recursive: true, force: true }));
const script = fileURLToPath(new URL('../hooks/subagent-stop.mjs', import.meta.url));
const GOOD = 'Status: done\n\nChanges: x\n\nValidation: `npm test` passed\n';

test('hasEvidence accepts the documented report shapes', () => {
  assert.equal(hasEvidence(GOOD), true);
  assert.equal(hasEvidence('- Status: partial\n- Validation: ran it'), true);
  assert.equal(hasEvidence('**Status:** blocked\n## Validation\nnone'), true);
  assert.equal(hasEvidence('Status: DONE\nValidation (commands + results)\n'), true);
});

test('hasEvidence rejects missing or malformed pieces', () => {
  assert.equal(hasEvidence('Status: done\nChanges: x'), false);
  assert.equal(hasEvidence('Validation: ok\nChanges: x'), false);
  assert.equal(hasEvidence('Status: finished\nValidation: ok'), false);
  assert.equal(hasEvidence('I did the status: done thing and validation too'), false);
  assert.equal(hasEvidence(''), false);
  assert.equal(hasEvidence(undefined), false);
});

function call(env, payload, readFile) {
  let stdout = '';
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const code = run({ env, input, stdout: (s) => (stdout += s), readFile });
  return { code, stdout };
}
const stop = (extra) => ({ agent_type: 'orc:implementer', stop_hook_active: false, ...extra });
const ON = { ORC: '1' };
const SILENT = { code: 0, stdout: '' };

test('run is silent unless ORC=1', () => {
  assert.deepEqual(call({}, stop({ last_assistant_message: 'nope' })), SILENT);
});

test('run blocks an incomplete implementer report once', () => {
  const r = call(ON, stop({ last_assistant_message: 'all done!' }));
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { decision: 'block', reason: BLOCK_REASON });
  assert.equal(call(ON, stop({})).stdout.includes('block'), true);
  assert.equal(
    call(ON, stop({ agent_type: 'implementer', last_assistant_message: 'x' })).stdout.includes(
      'block',
    ),
    true,
  );
});

test('run allows a complete report, a retry, and other roles', () => {
  assert.deepEqual(call(ON, stop({ last_assistant_message: GOOD })), SILENT);
  assert.deepEqual(call(ON, stop({ stop_hook_active: true, last_assistant_message: 'x' })), SILENT);
  assert.deepEqual(
    call(ON, stop({ agent_type: 'orc:reviewer', last_assistant_message: 'x' })),
    SILENT,
  );
  assert.deepEqual(call(ON, { last_assistant_message: 'x' }), SILENT);
});

test('run exits 0 silently on bad or oddly shaped input', () => {
  for (const input of ['', '{nope', 'null']) assert.deepEqual(call(ON, input), SILENT);
});

test('main wires env, stdin reader and stdout; skips reading without ORC', () => {
  const proc = (env) => ({
    env,
    out: '',
    cwd: () => NO_REPO,
    stdout: { write: (s) => (proc.out += s) },
  });
  const on = proc(ON);
  main(on, () => JSON.stringify(stop({ last_assistant_message: 'x' })));
  assert.equal(on.exitCode, 0);
  assert.match(proc.out, /block/);

  const off = proc({});
  main(off, () => assert.fail('must not read stdin'));
  assert.equal(off.exitCode, 0);
});

test('script entrypoint reads stdin end to end', () => {
  const opts = (env, input) => ({
    env: { ...process.env, ...env },
    input,
    cwd: NO_REPO,
    encoding: 'utf8',
  });
  const blocked = spawnSync(
    process.execPath,
    [script],
    opts(ON, JSON.stringify(stop({ last_assistant_message: 'x' }))),
  );
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).decision, 'block');
  const garbage = spawnSync(process.execPath, [script], opts(ON, 'nope'));
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});

const handback = (message) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message } }] },
  });
const transcript =
  (...lines) =>
  () =>
    lines.join('\n');

test('handbackReport takes the last SubagentHandback message and tolerates junk', () => {
  const text = transcript(
    'not json',
    '{"message":{"content":"str"}}',
    handback('first'),
    handback('last'),
    '',
  );
  assert.equal(handbackReport('/t', text), 'last');
  assert.equal(handbackReport('/t', transcript('{}')), undefined);
  assert.equal(handbackReport('', text), undefined);
  assert.equal(handbackReport(undefined, text), undefined);
  assert.equal(
    handbackReport('/t', () => {
      throw new Error('ENOENT');
    }),
    undefined,
  );
  assert.equal(handbackReport('/definitely/missing.jsonl'), undefined);
});

test('run allows a complete SubagentHandback report from the transcript', () => {
  const p = stop({ last_assistant_message: '', agent_transcript_path: '/t' });
  assert.deepEqual(call(ON, p, transcript(handback(GOOD))), SILENT);
  assert.equal(call(ON, p, transcript(handback('all done'))).stdout.includes('block'), true);
  assert.equal(call(ON, p, () => assert.fail).stdout.includes('block'), true);
  assert.equal(call(ON, stop({ last_assistant_message: '' })).stdout.includes('block'), true);
});

test('run records a no-evidence signal on block only', () => {
  const appended = [];
  const signals = {
    cwd: '/repo',
    exec: () => ({ status: 0, stdout: '/repo/.git\n' }),
    mkdir: () => {},
    append: (p, text) => appended.push([p, JSON.parse(text)]),
  };
  const input = (msg) => JSON.stringify(stop({ last_assistant_message: msg }));
  let out = '';
  run({ env: ON, input: input('done!'), stdout: (s) => (out += s), signals });
  assert.deepEqual(JSON.parse(out), { decision: 'block', reason: BLOCK_REASON });
  assert.equal(appended.length, 1);
  assert.equal(appended[0][0], '/repo/.orc/signals.jsonl');
  assert.deepEqual(
    { ...appended[0][1], ts: undefined },
    {
      ts: undefined,
      kind: 'no-evidence',
      role: 'implementer',
      reason: 'missing Status/Validation',
    },
  );

  const touch = () => assert.fail('the allow path must not touch git or fs');
  out = '';
  run({
    env: ON,
    input: input(GOOD),
    stdout: (s) => (out += s),
    signals: { cwd: '/repo', exec: touch, mkdir: touch, append: touch },
  });
  assert.equal(out, '');
});
