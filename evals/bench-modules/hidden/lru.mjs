// Hidden suite: packed into the run's .git by fixture.sh and run only by check.sh.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LRUCache } from '../../src/lru.mjs';

test('get and set', () => {
  const c = new LRUCache(2);
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), undefined);
});
test('set returns the cache for chaining', () => {
  const c = new LRUCache(3);
  assert.equal(c.set('a', 1), c);
  c.set('b', 2).set('c', 3);
  assert.equal(c.size, 3);
});
test('evicts the least recently used on overflow', () => {
  const c = new LRUCache(2);
  c.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(c.has('a'), false);
  assert.equal(c.has('b'), true);
  assert.equal(c.has('c'), true);
  assert.equal(c.size, 2);
});
test('get refreshes recency', () => {
  const c = new LRUCache(2);
  c.set('a', 1).set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.has('a'), true);
  assert.equal(c.has('b'), false);
});
test('updating a key refreshes recency without growing', () => {
  const c = new LRUCache(2);
  c.set('a', 1).set('b', 2).set('a', 10);
  assert.equal(c.size, 2);
  c.set('c', 3);
  assert.equal(c.get('a'), 10);
  assert.equal(c.has('b'), false);
});
test('has does not refresh recency', () => {
  const c = new LRUCache(2);
  c.set('a', 1).set('b', 2);
  assert.equal(c.has('a'), true);
  c.set('c', 3);
  assert.equal(c.has('a'), false);
});
test('a get miss changes nothing', () => {
  const c = new LRUCache(2);
  c.set('a', 1).set('b', 2);
  c.get('zzz');
  c.set('c', 3);
  assert.equal(c.has('a'), false);
  assert.equal(c.size, 2);
});
test('delete', () => {
  const c = new LRUCache(2);
  c.set('a', 1);
  assert.equal(c.delete('a'), true);
  assert.equal(c.delete('a'), false);
  assert.equal(c.has('a'), false);
  assert.equal(c.size, 0);
});
test('delete frees a slot', () => {
  const c = new LRUCache(2);
  c.set('a', 1).set('b', 2);
  c.delete('a');
  c.set('c', 3);
  assert.equal(c.has('b'), true);
  assert.equal(c.size, 2);
});
test('capacity 1', () => {
  const c = new LRUCache(1);
  c.set('a', 1).set('b', 2);
  assert.equal(c.has('a'), false);
  assert.equal(c.get('b'), 2);
  assert.equal(c.size, 1);
});
test('long eviction sequence keeps the newest', () => {
  const c = new LRUCache(3);
  for (let i = 0; i < 100; i++) c.set(i, i);
  assert.equal(c.size, 3);
  assert.deepEqual(
    [97, 98, 99].map((k) => c.get(k)),
    [97, 98, 99],
  );
  assert.equal(c.has(96), false);
});
test('undefined values are stored', () => {
  const c = new LRUCache(2);
  c.set('u', undefined);
  assert.equal(c.has('u'), true);
  assert.equal(c.size, 1);
  c.get('u');
  c.set('x', 1).set('y', 2);
  assert.equal(c.has('u'), false);
});
test('undefined values refresh recency on get', () => {
  const c = new LRUCache(2);
  c.set('u', undefined).set('x', 1);
  c.get('u');
  c.set('y', 2);
  assert.equal(c.has('u'), true);
  assert.equal(c.has('x'), false);
});
test('keys compare like Map keys', () => {
  const c = new LRUCache(4);
  const obj = {};
  c.set(Number.NaN, 'nan').set(0, 'zero').set(obj, 'obj');
  assert.equal(c.get(Number.NaN), 'nan');
  assert.equal(c.get(-0), 'zero');
  assert.equal(c.get({}), undefined);
  assert.equal(c.get(obj), 'obj');
  c.set('1', 'string');
  assert.equal(c.get(1), undefined);
  assert.equal(c.size, 4);
});
test('size is a getter', () => {
  const c = new LRUCache(2);
  assert.equal(typeof c.size, 'number');
  assert.equal(c.size, 0);
});
test('invalid capacity throws RangeError', () => {
  for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, '2']) {
    assert.throws(() => new LRUCache(v), RangeError, String(v));
  }
});
