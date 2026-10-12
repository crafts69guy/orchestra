// Hidden suite: packed into the run's .git by fixture.sh and run only by check.sh.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from '../../src/schema.mjs';

// Errors as sorted "path keyword" strings: the spec leaves their order open.
const errs = (value, schema) => {
  const out = validate(value, schema);
  assert.ok(Array.isArray(out), 'validate returns an array');
  for (const e of out) {
    assert.equal(typeof e.path, 'string');
    assert.equal(typeof e.keyword, 'string');
    assert.ok(typeof e.message === 'string' && e.message.length > 0, 'message is non-empty');
  }
  return out.map((e) => `${e.path} ${e.keyword}`).sort();
};
const ok = (value, schema) => assert.deepEqual(errs(value, schema), [], JSON.stringify(value));
const bad = (value, schema, ...expected) =>
  assert.deepEqual(errs(value, schema), expected.sort(), JSON.stringify(value));

test('empty schema and true accept anything', () => {
  for (const v of [null, 0, 'x', [], {}, true]) {
    ok(v, {});
    ok(v, true);
  }
});
test('false rejects with keyword false', () => {
  bad(1, false, ' false');
  bad({ a: 1 }, { properties: { a: false } }, '/a false');
});
test('type names', () => {
  ok(null, { type: 'null' });
  ok(true, { type: 'boolean' });
  ok({}, { type: 'object' });
  ok([], { type: 'array' });
  ok(1.5, { type: 'number' });
  ok(3, { type: 'number' });
  ok('s', { type: 'string' });
  bad([], { type: 'object' }, ' type');
  bad(null, { type: 'object' }, ' type');
  bad('1', { type: 'number' }, ' type');
  bad(0, { type: 'boolean' }, ' type');
});
test('integer means no fractional part', () => {
  ok(1, { type: 'integer' });
  ok(1.0, { type: 'integer' });
  ok(-0, { type: 'integer' });
  bad(1.5, { type: 'integer' }, ' type');
});
test('type arrays give one error', () => {
  ok(null, { type: ['string', 'null'] });
  bad(1, { type: ['string', 'null'] }, ' type');
});
test('enum and const use deep JSON equality', () => {
  ok({ b: [1, 2], a: 1 }, { enum: [0, { a: 1, b: [1, 2] }] });
  bad({ a: 1 }, { enum: [{ a: 1, b: 2 }] }, ' enum');
  bad([1, 2], { const: [2, 1] }, ' const');
  bad('1', { const: 1 }, ' const');
  bad(null, { const: {} }, ' const');
  bad({}, { const: [] }, ' const');
  ok(null, { const: null });
  ok([{ x: [null] }], { const: [{ x: [null] }] });
});
test('required gives one error per missing property at the object', () => {
  const s = { required: ['a', 'b', 'c'] };
  bad({ b: 1 }, s, ' required', ' required');
  ok({ a: 0, b: null, c: false }, s);
  ok('not an object', s);
});
test('properties validate at their own path', () => {
  const s = { properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } } };
  ok({ name: 'x', age: 3, other: true }, s);
  ok({}, s);
  bad({ name: 1, age: -1.5 }, s, '/name type', '/age type', '/age minimum');
});
test('additionalProperties false reports each extra key at the object', () => {
  const s = { properties: { a: {} }, additionalProperties: false };
  ok({ a: 1 }, s);
  bad({ a: 1, b: 2, c: 3 }, s, ' additionalProperties', ' additionalProperties');
});
test('additionalProperties schema applies to unlisted keys only', () => {
  const s = { properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } };
  ok({ a: 'x', b: 1 }, s);
  bad({ a: 1, b: 'x' }, s, '/a type', '/b type');
});
test('items validate each element at its index', () => {
  const s = { items: { type: 'number' } };
  ok([], s);
  bad([1, 'a', 2, null], s, '/1 type', '/3 type');
});
test('JSON Pointer escaping of keys', () => {
  const s = { additionalProperties: { type: 'string' } };
  bad({ 'a/b': 1, 'c~d': 2, '': 3 }, s, '/a~1b type', '/c~0d type', '/ type');
});
test('nested paths', () => {
  const s = {
    properties: {
      users: { items: { properties: { tags: { items: { type: 'string' } } } } },
    },
  };
  bad({ users: [{ tags: ['a'] }, { tags: ['b', 7] }] }, s, '/users/1/tags/1 type');
});
test('string length counts code points', () => {
  const s = { minLength: 2, maxLength: 3 };
  ok('ab', s);
  ok('abc', s);
  bad('a', s, ' minLength');
  bad('abcd', s, ' maxLength');
  ok('😀😀', s);
  bad('😀', s, ' minLength');
  bad('😀😀😀😀', { maxLength: 3 }, ' maxLength');
});
test('array length bounds are inclusive', () => {
  const s = { minItems: 1, maxItems: 2 };
  ok([1], s);
  ok([1, 2], s);
  bad([], s, ' minItems');
  bad([1, 2, 3], s, ' maxItems');
});
test('numeric bounds are inclusive', () => {
  const s = { minimum: 0, maximum: 10 };
  ok(0, s);
  ok(10, s);
  bad(-0.1, s, ' minimum');
  bad(10.5, s, ' maximum');
});
test('pattern is unanchored and unicode-aware', () => {
  ok('xx123yy', { pattern: '\\d+' });
  bad('abc', { pattern: '^\\d+$' }, ' pattern');
  ok('😀', { pattern: '^.$' });
});
test('keywords for other types are ignored', () => {
  const s = { minLength: 5, minItems: 5, minimum: 5, pattern: 'x', required: ['a'] };
  for (const v of [5, 'xxxxx', [1, 2, 3, 4, 5], { a: 1 }, null, true]) ok(v, s);
  bad(1, s, ' minimum');
});
test('all failing keywords are reported, not just the first', () =>
  bad(
    'ab',
    { type: 'number', minLength: 3, pattern: '^x', enum: ['x'] },
    ' type',
    ' minLength',
    ' pattern',
    ' enum',
  ));
test('allOf reports every subschema error', () => {
  const s = { allOf: [{ type: 'string' }, { minLength: 3 }, { maxLength: 1 }] };
  ok('', { allOf: [{ type: 'string' }, { maxLength: 1 }] });
  bad('ab', s, ' minLength', ' maxLength');
  bad({ a: 'x' }, { allOf: [{ properties: { a: { type: 'number' } } }] }, '/a type');
});
test('anyOf gives one error and hides branch errors', () => {
  const s = { anyOf: [{ type: 'string' }, { type: 'number', minimum: 10 }] };
  ok('x', s);
  ok(12, s);
  bad(5, s, ' anyOf');
  bad({ a: 1 }, { properties: { a: s } }, '/a anyOf');
});
test('oneOf needs exactly one match', () => {
  const s = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
  ok(1.5, s);
  bad(2, s, ' oneOf');
  bad('x', s, ' oneOf');
});
test('$ref resolves to the root definitions and ignores siblings', () => {
  const s = {
    definitions: { pos: { type: 'integer', minimum: 1 } },
    properties: { n: { $ref: '#/definitions/pos', type: 'string' } },
  };
  ok({ n: 3 }, s);
  bad({ n: 0 }, s, '/n minimum');
  bad({ n: 'x' }, s, '/n type');
});
test('recursive $ref', () => {
  const s = {
    definitions: {
      node: {
        type: 'object',
        required: ['value'],
        properties: {
          value: { type: 'number' },
          children: { items: { $ref: '#/definitions/node' } },
        },
      },
    },
    $ref: '#/definitions/node',
  };
  ok({ value: 1, children: [{ value: 2, children: [{ value: 3 }] }] }, s);
  bad(
    { value: 1, children: [{ value: 2, children: [{}, { value: 'x' }] }] },
    s,
    '/children/0/children/0 required',
    '/children/0/children/1/value type',
  );
});
test('unresolvable $ref throws ReferenceError when reached', () => {
  assert.throws(
    () => validate(1, { $ref: '#/definitions/missing', definitions: {} }),
    ReferenceError,
  );
  assert.throws(() => validate(1, { $ref: 'http://x/y.json' }), ReferenceError);
  assert.throws(() => validate(1, { $ref: '#/properties/a' }), ReferenceError);
  assert.throws(() => validate(1, { anyOf: [{ $ref: '#/definitions/x' }] }), ReferenceError);
  ok({}, { properties: { a: { $ref: '#/definitions/missing' } } });
});
test('a schema that is not an object or boolean throws TypeError', () => {
  for (const s of [null, 1, 'string', []]) assert.throws(() => validate(1, s), TypeError);
  assert.throws(() => validate({ a: 1 }, { properties: { a: 'string' } }), TypeError);
  assert.throws(() => validate([1], { items: [{}] }), TypeError);
});
