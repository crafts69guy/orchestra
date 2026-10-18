// The bench-modules acceptance suite must pass against the reference implementations, laid out
// the way check.sh runs it (src/ next to .git/acceptance/), so a red hidden test means the agent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CASE = fileURLToPath(new URL('../evals/bench-modules/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'orc-bench-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('hidden acceptance suite passes against the reference', () => {
  cpSync(join(CASE, 'reference'), join(tmp, 'src'), { recursive: true });
  mkdirSync(join(tmp, '.git'));
  cpSync(join(CASE, 'hidden'), join(tmp, '.git', 'acceptance'), { recursive: true });
  // Drop NODE_V8_COVERAGE (keeps the suite and reference out of this repo's coverage) and
  // NODE_TEST_CONTEXT (else the nested runner reports to this one instead of printing TAP).
  const { NODE_V8_COVERAGE, NODE_TEST_CONTEXT, ...env } = process.env;
  const modules = ['duration', 'semver', 'csv', 'lru'];
  const r = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...modules.map((m) => `.git/acceptance/${m}.mjs`)],
    { cwd: tmp, env, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# fail 0$/m);
  assert.ok(Number(/^# pass (\d+)$/m.exec(r.stdout)[1]) >= 60);
});
