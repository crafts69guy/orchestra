import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { which } from '../hooks/session-start.mjs';
import { FISH } from '../scripts/completion.mjs';
import { USAGE as inkdropUsage } from '../scripts/inkdrop.mjs';
import { commands, run, USAGE } from '../scripts/orc.mjs';
import { USAGE as paneUsage } from '../scripts/orc-pane.mjs';
import { USAGE as wtUsage } from '../scripts/orc-wt.mjs';

function io() {
  const o = { out: '', err: '' };
  o.stdout = (s) => {
    o.out += s;
  };
  o.stderr = (s) => {
    o.err += s;
  };
  return o;
}

test('every command is a top-level fish completion', () => {
  for (const cmd of [...Object.keys(commands), 'help']) {
    assert.match(FISH, new RegExp(`-n __fish_use_subcommand -a ${cmd} `), cmd);
  }
  assert.match(FISH, /-n __fish_use_subcommand -s h -l help /);
  assert.match(FISH, /-n __fish_use_subcommand -s V -l version /);
});

test('every --flag in the USAGE strings has a fish completion', () => {
  const flags = new Set(
    [USAGE, wtUsage, paneUsage, inkdropUsage].join('\n').match(/--[a-z][a-z-]*/g),
  );
  for (const flag of flags) {
    if (flag === '--help' || flag === '--version') continue; // -s h -l help, checked above
    assert.match(FISH, new RegExp(`-l ${flag.slice(2)} `), flag);
  }
});

test('completion fish prints the script; anything else is a usage error', () => {
  const ok = io();
  assert.equal(run(['completion', 'fish'], ok), 0);
  assert.equal(ok.out, FISH);
  assert.equal(ok.err, '');
  for (const args of [[], ['bash'], ['fish', 'extra']]) {
    const bad = io();
    assert.equal(run(['completion', ...args], bad), 1);
    assert.equal(bad.out, '');
    assert.equal(bad.err, 'usage: orc completion fish\n');
  }
});

test('USAGE lists completion fish', () => {
  assert.match(USAGE, /completion fish/);
});

test('the fish script parses (fish -n)', {
  skip: !which('fish', process.env.PATH) && 'no fish',
}, () => {
  const r = spawnSync('fish', ['-n'], { input: FISH, cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
