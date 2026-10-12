// Hidden suite: packed into the run's .git by fixture.sh and run only by check.sh.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compare } from '../../src/semver.mjs';

const lt = (a, b) => {
  assert.equal(compare(a, b), -1, `${a} < ${b}`);
  assert.equal(compare(b, a), 1, `${b} > ${a}`);
};
const invalid = (v) => {
  assert.throws(() => compare(v, '1.0.0'), TypeError, JSON.stringify(v));
  assert.throws(() => compare('1.0.0', v), TypeError, JSON.stringify(v));
};

test('equal versions', () => {
  assert.equal(compare('1.2.3', '1.2.3'), 0);
  assert.equal(compare('1.0.0-rc.1', '1.0.0-rc.1'), 0);
});
test('major, minor, patch', () => {
  lt('1.0.0', '2.0.0');
  lt('2.0.0', '2.1.0');
  lt('2.1.0', '2.1.1');
  lt('0.9.9', '1.0.0');
});
test('core numbers compare numerically, not lexically', () => {
  lt('1.2.3', '1.10.0');
  lt('1.0.9', '1.0.10');
  lt('9.0.0', '10.0.0');
});
test('prerelease is lower than the release', () => lt('1.0.0-alpha', '1.0.0'));
test('the spec precedence chain', () => {
  const chain = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];
  for (let i = 0; i < chain.length - 1; i++) lt(chain[i], chain[i + 1]);
});
test('numeric prerelease identifiers compare numerically', () => lt('1.0.0-2', '1.0.0-10'));
test('numeric identifiers are lower than alphanumeric', () => {
  lt('1.0.0-1', '1.0.0-a');
  lt('1.0.0-alpha.9', '1.0.0-alpha.a');
  lt('1.0.0-99', '1.0.0-1a');
});
test('alphanumeric identifiers compare in ASCII order', () => {
  lt('1.0.0-Beta', '1.0.0-alpha');
  lt('1.0.0-a-b', '1.0.0-abb');
  lt('1.0.0-alpha', '1.0.0-alphb');
});
test('a longer prerelease wins when the prefix is equal', () => lt('1.0.0-a.b', '1.0.0-a.b.c'));
test('a prerelease of a higher core is still higher', () => lt('1.0.0', '1.0.1-alpha'));
test('build metadata is ignored', () => {
  assert.equal(compare('1.0.0+a', '1.0.0+b'), 0);
  assert.equal(compare('1.0.0-rc.1+build.5', '1.0.0-rc.1'), 0);
  assert.equal(compare('1.0.0+001', '1.0.0'), 0);
  lt('1.0.0-alpha+zzz', '1.0.0-beta+aaa');
});
test('numbers above MAX_SAFE_INTEGER compare exactly', () => {
  lt('9007199254740992.0.0', '9007199254740993.0.0');
  lt('1.0.0-9007199254740992', '1.0.0-9007199254740993');
});
test('malformed versions throw TypeError', () => {
  for (const v of ['1.0', '1', '1.0.0.0', 'v1.0.0', ' 1.0.0', '1.0.0 ', 'a.b.c', '', '1..0']) {
    invalid(v);
  }
});
test('leading zeros and empty identifiers throw TypeError', () => {
  for (const v of ['01.0.0', '1.02.0', '1.0.00', '1.0.0-01', '1.0.0-', '1.0.0-a..b', '1.0.0+']) {
    invalid(v);
  }
});
test('bad characters and non-strings throw TypeError', () => {
  for (const v of ['1.0.0-a_b', '1.0.0+a b', '-1.0.0', null, 1, undefined]) invalid(v);
});
