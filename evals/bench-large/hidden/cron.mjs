// Hidden suite: packed into the run's .git by fixture.sh and run only by check.sh.
import assert from 'node:assert/strict';
import test from 'node:test';
import { next, parse } from '../../src/cron.mjs';

const range = (a, b, s = 1) =>
  Array.from({ length: Math.floor((b - a) / s) + 1 }, (_, i) => a + i * s);
const ALL = { minute: range(0, 59), hour: range(0, 23), dayOfMonth: range(1, 31) };
const at = (iso) => new Date(iso);
const nextIso = (expr, from) => next(expr, at(from))?.toISOString() ?? null;
const throws = (expr, type) => assert.throws(() => parse(expr), type, JSON.stringify(expr));

test('stars cover the full bounds', () =>
  assert.deepEqual(parse('* * * * *'), {
    ...ALL,
    month: range(1, 12),
    dayOfWeek: range(0, 6),
  }));
test('single values, lists and ranges, sorted and distinct', () => {
  const p = parse('5,1,3 0-2 10-12,11 6 0');
  assert.deepEqual(p.minute, [1, 3, 5]);
  assert.deepEqual(p.hour, [0, 1, 2]);
  assert.deepEqual(p.dayOfMonth, [10, 11, 12]);
  assert.deepEqual(p.month, [6]);
  assert.deepEqual(p.dayOfWeek, [0]);
});
test('steps over star and over a range', () => {
  const p = parse('*/15 1-10/4 */10 */5 */2');
  assert.deepEqual(p.minute, [0, 15, 30, 45]);
  assert.deepEqual(p.hour, [1, 5, 9]);
  assert.deepEqual(p.dayOfMonth, [1, 11, 21, 31]);
  assert.deepEqual(p.month, [1, 6, 11]);
  assert.deepEqual(p.dayOfWeek, [0, 2, 4, 6]);
});
test('a step larger than the range keeps only the start', () =>
  assert.deepEqual(parse('*/100 * * * *').minute, [0]));
test('month and weekday names, any case, also as range ends', () => {
  const p = parse('0 0 * jan-Mar,DEC mon-FRI');
  assert.deepEqual(p.month, [1, 2, 3, 12]);
  assert.deepEqual(p.dayOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(parse('0 0 * * SUN,sat').dayOfWeek, [0, 6]);
  assert.deepEqual(parse('0 0 * * MON-FRI/2').dayOfWeek, [1, 3, 5]);
});
test('day-of-week 7 is Sunday', () => {
  assert.deepEqual(parse('0 0 * * 7').dayOfWeek, [0]);
  assert.deepEqual(parse('0 0 * * 5-7').dayOfWeek, [0, 5, 6]);
  assert.deepEqual(parse('0 0 * * 0,7').dayOfWeek, [0]);
});
test('leading zeros and extra whitespace are fine', () => {
  const p = parse('  05\t\t08   * *  * ');
  assert.deepEqual(p.minute, [5]);
  assert.deepEqual(p.hour, [8]);
});
test('macros expand to their five-field form', () => {
  assert.deepEqual(parse('@yearly'), parse('0 0 1 1 *'));
  assert.deepEqual(parse('@annually'), parse('0 0 1 1 *'));
  assert.deepEqual(parse('@monthly'), parse('0 0 1 * *'));
  assert.deepEqual(parse('@weekly'), parse('0 0 * * 0'));
  assert.deepEqual(parse('@daily'), parse('0 0 * * *'));
  assert.deepEqual(parse('@midnight'), parse('0 0 * * *'));
  assert.deepEqual(parse(' @hourly '), parse('0 * * * *'));
});
test('wrong field count, bad macros and empty items are SyntaxError', () => {
  for (const e of ['', '* * * *', '* * * * * *', '@reboot', '@DAILY', '@daily *']) {
    throws(e, SyntaxError);
  }
  for (const e of ['1,,2 * * * *', '1, * * * *', ',1 * * * *']) throws(e, SyntaxError);
});
test('malformed items are SyntaxError', () => {
  for (const item of ['5/15', '1-', '-1', '1.5', '**', '*/', '*-5', 'a', '1-2-3', '1/2/3']) {
    throws(`${item} * * * *`, SyntaxError);
  }
});
test('names outside their field and unknown names are SyntaxError', () => {
  throws('MON * * * *', SyntaxError);
  throws('0 0 JAN * *', SyntaxError);
  throws('0 0 * MON *', SyntaxError);
  throws('0 0 * * JAN', SyntaxError);
  throws('0 0 * JANUARY *', SyntaxError);
  throws('0 0 * * */MON', SyntaxError);
});
test('out-of-bounds values are RangeError', () => {
  for (const e of [
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * 32 * *',
    '* * * 0 *',
    '* * * 13 *',
  ]) {
    throws(e, RangeError);
  }
  throws('* * * * 8', RangeError);
  throws('0-60 * * * *', RangeError);
});
test('reversed ranges and zero steps are RangeError', () => {
  throws('5-1 * * * *', RangeError);
  throws('* * * * FRI-SUN', RangeError);
  throws('*/0 * * * *', RangeError);
  throws('1-5/0 * * * *', RangeError);
});
test('non-string expression is TypeError', () => {
  for (const v of [undefined, null, 5, ['* * * * *']]) assert.throws(() => parse(v), TypeError);
});
test('next is strictly later and drops seconds', () => {
  assert.equal(nextIso('* * * * *', '2026-03-10T10:00:00.000Z'), '2026-03-10T10:01:00.000Z');
  assert.equal(nextIso('* * * * *', '2026-03-10T10:00:59.999Z'), '2026-03-10T10:01:00.000Z');
  assert.equal(nextIso('30 10 * * *', '2026-03-10T10:30:00.000Z'), '2026-03-11T10:30:00.000Z');
  assert.equal(nextIso('30 10 * * *', '2026-03-10T10:29:30.000Z'), '2026-03-10T10:30:00.000Z');
});
test('next rolls over hour, day, month and year', () => {
  assert.equal(nextIso('0 * * * *', '2026-03-10T23:15:00Z'), '2026-03-11T00:00:00.000Z');
  assert.equal(nextIso('0 0 1 * *', '2026-01-31T12:00:00Z'), '2026-02-01T00:00:00.000Z');
  assert.equal(nextIso('@yearly', '2026-12-31T23:59:00Z'), '2027-01-01T00:00:00.000Z');
  assert.equal(nextIso('15 9 * * *', '2026-03-10T09:16:00Z'), '2026-03-11T09:15:00.000Z');
});
test('next skips months without the day', () => {
  assert.equal(nextIso('0 0 31 * *', '2026-04-01T00:00:00Z'), '2026-05-31T00:00:00.000Z');
  assert.equal(nextIso('0 0 29 2 *', '2025-03-01T00:00:00Z'), '2028-02-29T00:00:00.000Z');
  assert.equal(nextIso('0 0 29 2 *', '2096-03-01T00:00:00Z'), '2104-02-29T00:00:00.000Z');
});
test('next with a restricted weekday only', () => {
  // 2026-10-12 is a Monday.
  assert.equal(nextIso('0 9 * * MON', '2026-10-12T09:00:00Z'), '2026-10-19T09:00:00.000Z');
  assert.equal(nextIso('0 9 * * 7', '2026-10-12T00:00:00Z'), '2026-10-18T09:00:00.000Z');
  assert.equal(nextIso('@weekly', '2026-10-12T00:00:00Z'), '2026-10-18T00:00:00.000Z');
});
test('day-of-month and day-of-week both restricted means either', () => {
  assert.equal(nextIso('0 0 13 * FRI', '2026-10-12T00:00:00Z'), '2026-10-13T00:00:00.000Z');
  assert.equal(nextIso('0 0 13 * FRI', '2026-10-13T00:00:00Z'), '2026-10-16T00:00:00.000Z');
  assert.equal(nextIso('0 0 1 * MON', '2026-10-27T00:00:00Z'), '2026-11-01T00:00:00.000Z');
  // A step is not `*`, so it restricts too: every odd day or every Sunday.
  assert.equal(nextIso('0 0 */2 * 0', '2026-10-17T00:00:00Z'), '2026-10-18T00:00:00.000Z');
  assert.equal(nextIso('0 0 30 2 MON', '2026-10-12T00:00:00Z'), '2027-02-01T00:00:00.000Z');
});
test('a star on one day field means only the other restricts', () => {
  assert.equal(nextIso('0 0 */2 * *', '2026-10-17T00:00:00Z'), '2026-10-19T00:00:00.000Z');
  assert.equal(nextIso('0 0 * * 0', '2026-10-15T00:00:00Z'), '2026-10-18T00:00:00.000Z');
});
test('next honours month lists and steps', () => {
  assert.equal(nextIso('0 12 1 JAN,JUL *', '2026-03-10T00:00:00Z'), '2026-07-01T12:00:00.000Z');
  assert.equal(nextIso('*/20 */6 * * *', '2026-03-10T06:41:00Z'), '2026-03-10T12:00:00.000Z');
});
test('impossible schedules return null quickly', () => {
  const t = performance.now();
  assert.equal(nextIso('0 0 30 2 *', '2026-01-01T00:00:00Z'), null);
  assert.equal(nextIso('0 0 31 4,6,9,11 *', '2026-01-01T00:00:00Z'), null);
  assert.ok(performance.now() - t < 2000, 'took longer than 2s');
});
test('next returns a new Date and leaves from unchanged', () => {
  const from = at('2026-03-10T10:00:00Z');
  const r = next('* * * * *', from);
  assert.ok(r instanceof Date);
  assert.notEqual(r, from);
  assert.equal(from.toISOString(), '2026-03-10T10:00:00.000Z');
});
test('next validates its arguments', () => {
  assert.throws(() => next('* * * * *', '2026-03-10'), TypeError);
  assert.throws(() => next('* * * * *', 0), TypeError);
  assert.throws(() => next('* * * * *', new Date('nope')), TypeError);
  assert.throws(() => next('60 * * * *', at('2026-03-10T00:00:00Z')), RangeError);
  assert.throws(() => next('* * *', at('2026-03-10T00:00:00Z')), SyntaxError);
});
