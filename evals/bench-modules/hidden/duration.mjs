// Hidden suite: packed into the run's .git by fixture.sh and run only by check.sh.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDuration } from '../../src/duration.mjs';

const bad = (s) => assert.throws(() => parseDuration(s), SyntaxError, JSON.stringify(s));

test('spec examples', () => {
  assert.equal(parseDuration('1h30m15s'), 5415000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('2d'), 172800000);
  assert.equal(parseDuration('1m30s500ms'), 90500);
});
test('every unit alone', () => {
  assert.equal(parseDuration('1d'), 86400000);
  assert.equal(parseDuration('1h'), 3600000);
  assert.equal(parseDuration('1m'), 60000);
  assert.equal(parseDuration('1s'), 1000);
  assert.equal(parseDuration('1ms'), 1);
});
test('all units together', () => assert.equal(parseDuration('1d2h3m4s5ms'), 93784005));
test('zero and leading zeros', () => {
  assert.equal(parseDuration('0s'), 0);
  assert.equal(parseDuration('05m'), 300000);
  assert.equal(parseDuration('0d0h0m0s0ms'), 0);
});
test('multi-digit values beyond the next unit', () => {
  assert.equal(parseDuration('90m'), 5400000);
  assert.equal(parseDuration('1500ms'), 1500);
});
test('m followed by ms is two units', () => assert.equal(parseDuration('1m1ms'), 60001));
test('surrounding whitespace is ignored', () => {
  assert.equal(parseDuration('  1h '), 3600000);
  assert.equal(parseDuration('\t2s\n'), 2000);
});
test('non-strings throw TypeError', () => {
  for (const v of [undefined, null, 5, {}, ['1s']])
    assert.throws(() => parseDuration(v), TypeError);
});
test('empty or whitespace-only', () => {
  bad('');
  bad('   ');
});
test('number or unit missing', () => {
  bad('h');
  bad('10');
  bad('1h30');
  bad('ms');
});
test('unknown or upper-case unit', () => {
  bad('5w');
  bad('1H');
  bad('1Ms');
  bad('1sec');
});
test('out of order or repeated units', () => {
  bad('1s1m');
  bad('1m1m');
  bad('1ms1s');
  bad('1h1d');
});
test('signs, decimals, exponents and separators', () => {
  bad('-1s');
  bad('+1s');
  bad('1.5h');
  bad('1e3ms');
  bad('1_000ms');
});
test('inner whitespace and separators between segments', () => {
  bad('1h 30m');
  bad('1h,30m');
  bad('1 h');
});
test('result above MAX_SAFE_INTEGER throws RangeError', () => {
  assert.throws(() => parseDuration('104249991375d'), RangeError);
  assert.equal(parseDuration('9007199254740991ms'), Number.MAX_SAFE_INTEGER);
});
