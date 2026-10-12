// Hidden suite: packed into the run's .git by fixture.sh and run only by check.sh.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from '../../src/csv.mjs';

const bad = (s) => assert.throws(() => parse(s), SyntaxError, JSON.stringify(s));

test('simple rows', () =>
  assert.deepEqual(parse('a,b\nc,d'), [
    ['a', 'b'],
    ['c', 'd'],
  ]));
test('empty input', () => assert.deepEqual(parse(''), []));
test('one trailing terminator adds no row', () => {
  assert.deepEqual(parse('a,b\n'), [['a', 'b']]);
  assert.deepEqual(parse('a,b\r\n'), [['a', 'b']]);
});
test('CRLF records', () =>
  assert.deepEqual(parse('a,b\r\nc,d\r\n'), [
    ['a', 'b'],
    ['c', 'd'],
  ]));
test('mixed LF and CRLF', () => assert.deepEqual(parse('a\r\nb\nc'), [['a'], ['b'], ['c']]));
test('a lone CR is data', () => {
  assert.deepEqual(parse('a\rb,c'), [['a\rb', 'c']]);
  assert.deepEqual(parse('a\r'), [['a\r']]);
});
test('empty fields are kept', () => {
  assert.deepEqual(parse('a,,b'), [['a', '', 'b']]);
  assert.deepEqual(parse(','), [['', '']]);
  assert.deepEqual(parse('a,'), [['a', '']]);
  assert.deepEqual(parse(',a'), [['', 'a']]);
});
test('empty lines in the middle are rows with one empty field', () => {
  assert.deepEqual(parse('a\n\nb'), [['a'], [''], ['b']]);
  assert.deepEqual(parse('\n'), [['']]);
  assert.deepEqual(parse('a\n\n'), [['a'], ['']]);
});
test('nothing is trimmed', () => assert.deepEqual(parse(' a , b '), [[' a ', ' b ']]));
test('quoted fields', () => {
  assert.deepEqual(parse('"a","b c"'), [['a', 'b c']]);
  assert.deepEqual(parse('""'), [['']]);
  assert.deepEqual(parse('"",""'), [['', '']]);
});
test('escaped quotes', () => {
  assert.deepEqual(parse('"say ""hi"""'), [['say "hi"']]);
  assert.deepEqual(parse('""""'), [['"']]);
});
test('commas and newlines inside quotes are literal', () => {
  assert.deepEqual(parse('"a,b",c'), [['a,b', 'c']]);
  assert.deepEqual(parse('"line1\nline2",x\ny'), [['line1\nline2', 'x'], ['y']]);
  assert.deepEqual(parse('"a\r\nb"\r\nc'), [['a\r\nb'], ['c']]);
});
test('quoted field at end of input and before CRLF', () => {
  assert.deepEqual(parse('a,"b"'), [['a', 'b']]);
  assert.deepEqual(parse('"a"\r\n"b"\r\n'), [['a'], ['b']]);
});
test('ragged rows', () =>
  assert.deepEqual(parse('a,b,c\nd\ne,f'), [['a', 'b', 'c'], ['d'], ['e', 'f']]));
test('unterminated quote throws', () => {
  bad('"abc');
  bad('a,"b\nc');
  bad('"a""');
});
test('quote inside an unquoted field throws', () => {
  bad('a"b');
  bad('abc"');
});
test('text after a closing quote throws', () => {
  bad('"a"b');
  bad('"a" ,b');
  bad('"a"\rb');
});
test('non-string throws TypeError', () => {
  for (const v of [undefined, null, 1, ['a']]) assert.throws(() => parse(v), TypeError);
});
