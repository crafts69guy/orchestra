// Hidden suite: packed into the run's .git by fixture.sh and run only by check.sh.
import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from '../../src/expr.mjs';

const is = (src, expected, vars) => assert.equal(evaluate(src, vars), expected, src);
const syntaxAt = (src, position) =>
  assert.throws(
    () => evaluate(src),
    (e) => e instanceof SyntaxError && e.position === position,
    `${JSON.stringify(src)} should be a SyntaxError at ${position}`,
  );
const fails = (src, type, vars) => assert.throws(() => evaluate(src, vars), type, src);

test('number literals', () => {
  is('42', 42);
  is('3.25', 3.25);
  is('1e3', 1000);
  is('2.5E-1', 0.25);
  is('007', 7);
});
test('boolean literals', () => {
  is('true', true);
  is('false', false);
});
test('arithmetic precedence and left associativity', () => {
  is('1 + 2 * 3', 7);
  is('(1 + 2) * 3', 9);
  is('10 - 4 - 3', 3);
  is('64 / 4 / 2', 8);
  is('2 * 3 % 4', 2);
  is('1 + 2 * 3 - 4 / 2', 5);
});
test('remainder keeps the sign of the dividend', () => {
  is('7 % 3', 1);
  is('-7 % 3', -1);
  is('7 % -3', 1);
});
test('power is right-associative and tighter than prefix minus', () => {
  is('2 ^ 3 ^ 2', 512);
  is('-2 ^ 2', -4);
  is('(-2) ^ 2', 4);
  is('2 ^ -1', 0.5);
  is('2 * 3 ^ 2', 18);
});
test('prefix operators stack', () => {
  is('- -3', 3);
  is('--3', 3);
  is('!!true', true);
  is('!false && true', true);
  is('-(2 + 3)', -5);
});
test('comparison and equality', () => {
  is('1 < 2', true);
  is('2 <= 2', true);
  is('3 > 4', false);
  is('4 >= 5', false);
  is('1 + 1 == 2', true);
  is('1 != 1', false);
  is('true == false', false);
  is('1 < 2 == true', true);
});
test('logical operators and their precedence', () => {
  is('true || false && false', true);
  is('(true || false) && false', false);
  is('1 < 2 && 3 < 4', true);
  is('false || 2 == 2', true);
});
test('ternary is lowest and right-associative', () => {
  is('true ? 1 : 2', 1);
  is('false ? 1 : 2', 2);
  is('false ? 1 : true ? 2 : 3', 2);
  is('true ? false ? 1 : 2 : 3', 2);
  is('1 < 2 ? 10 + 1 : 0', 11);
  is('(true ? 2 : 3) * 2', 4);
});
test('short-circuit skips the unused operand', () => {
  is('false && missing', false);
  is('true || missing', true);
  is('true ? 1 : 1 / 0', 1);
  is('false ? nope(1) : 2', 2);
  fails('true && missing', ReferenceError);
});
test('whitespace is free', () => is(' \t1\n+\n2 ', 3));
test('variables are own properties of vars', () => {
  is('x * 2 + y', 10, { x: 3, y: 4 });
  is('flag && x > 1', true, { flag: true, x: 2 });
  is('_a1 + B', 3, { _a1: 1, B: 2 });
  fails('z', ReferenceError, { x: 1 });
  fails('toString', ReferenceError, {});
  fails('x', ReferenceError, Object.create({ x: 1 }));
});
test('variables must be finite numbers or booleans', () => {
  for (const x of ['1', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, [1], {}]) {
    fails('x', TypeError, { x });
  }
});
test('vars and src are type-checked', () => {
  fails(1, TypeError);
  fails(null, TypeError);
  fails('1', TypeError, null);
  fails('1', TypeError, 5);
  is('1 + 1', 2, undefined);
});
test('operand types are strict', () => {
  fails('1 + true', TypeError);
  fails('-true', TypeError);
  fails('!1', TypeError);
  fails('1 && true', TypeError);
  fails('false || 0', TypeError);
  fails('1 ? 2 : 3', TypeError);
  fails('1 == true', TypeError);
  fails('true < false', TypeError);
  fails('1 < 2 < 3', TypeError);
});
test('division and remainder by zero are RangeError', () => {
  fails('1 / 0', RangeError);
  fails('1 % 0', RangeError);
  fails('1 / (2 - 2)', RangeError);
});
test('functions', () => {
  is('abs(-3)', 3);
  is('floor(2.7) + ceil(2.1)', 5);
  is('sqrt(16)', 4);
  is('min(3, 1, 2)', 1);
  is('max(4)', 4);
  is('max(1, min(5, 9), -2)', 5);
  is('abs(x - 10)', 7, { x: 3 });
});
test('round sends halves away from zero', () => {
  is('round(2.5)', 3);
  is('round(-2.5)', -3);
  is('round(2.4)', 2);
  is('round(-0.4) == 0', true);
});
test('function errors', () => {
  fails('sqrt(-1)', RangeError);
  fails('max()', TypeError);
  fails('abs(1, 2)', TypeError);
  fails('abs(true)', TypeError);
  fails('nope(1)', ReferenceError);
  fails('toString(1)', ReferenceError);
  fails('constructor(1)', ReferenceError);
});
test('a variable and a function may share a name', () => is('min + max(min, 1)', 1, { min: 0 }));
test('SyntaxError positions for incomplete input', () => {
  syntaxAt('', 0);
  syntaxAt('   ', 3);
  syntaxAt('1 +', 3);
  syntaxAt('(1', 2);
  syntaxAt('max(1', 5);
  syntaxAt('true ?', 6);
  syntaxAt('true ? 1', 8);
});
test('SyntaxError positions for unexpected tokens', () => {
  syntaxAt('1 2', 2);
  syntaxAt(')', 0);
  syntaxAt('(1))', 3);
  syntaxAt('max(1,)', 6);
  syntaxAt('1 + * 2', 4);
  syntaxAt('true ? 1 , 2', 9);
  syntaxAt('f(1)(2)', 4);
});
test('SyntaxError positions for characters that are not tokens', () => {
  syntaxAt('1 # 2', 2);
  syntaxAt('1 = 2', 2);
  syntaxAt('a & b', 2);
  syntaxAt('1.', 1);
  syntaxAt('.5', 0);
  syntaxAt('1 2 $', 4);
});
