const TYPES = {
  null: (v) => v === null,
  boolean: (v) => typeof v === 'boolean',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  number: (v) => typeof v === 'number',
  integer: (v) => Number.isInteger(v),
  string: (v) => typeof v === 'string',
};

const pointer = (path, key) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function equal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => equal(x, b[i]))
    );
  }
  if (!TYPES.object(a) || !TYPES.object(b)) return false;
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  );
}

export function validate(value, schema) {
  const errors = [];
  check(value, schema, '', schema, errors);
  return errors;
}

function resolve(ref, root) {
  const prefix = '#/definitions/';
  const name = typeof ref === 'string' && ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
  const defs = TYPES.object(root) ? root.definitions : undefined;
  if (name === null || !TYPES.object(defs) || !Object.hasOwn(defs, name)) {
    throw new ReferenceError(`cannot resolve $ref ${JSON.stringify(ref)}`);
  }
  return defs[name];
}

function check(v, s, path, root, errors) {
  const fail = (keyword, message) => errors.push({ path, keyword, message });
  if (s === true) return;
  if (s === false) return fail('false', 'no value is allowed here');
  if (!TYPES.object(s)) throw new TypeError('a schema must be an object or a boolean');
  if ('$ref' in s) return check(v, resolve(s.$ref, root), path, root, errors);
  const passes = (sub) => {
    const e = [];
    check(v, sub, path, root, e);
    return e.length === 0;
  };

  if ('type' in s) {
    const types = [s.type].flat();
    if (!types.some((t) => TYPES[t]?.(v))) fail('type', `must be ${types.join(' or ')}`);
  }
  if ('enum' in s && !s.enum.some((x) => equal(v, x))) fail('enum', 'must be one of the enum');
  if ('const' in s && !equal(v, s.const)) fail('const', 'must equal the constant');

  if (TYPES.object(v)) {
    for (const key of s.required ?? []) {
      if (!Object.hasOwn(v, key)) fail('required', `missing property ${key}`);
    }
    const props = s.properties ?? {};
    for (const [key, item] of Object.entries(v)) {
      if (Object.hasOwn(props, key)) check(item, props[key], pointer(path, key), root, errors);
      else if (s.additionalProperties === false) {
        fail('additionalProperties', `unexpected property ${key}`);
      } else if (s.additionalProperties !== undefined) {
        check(item, s.additionalProperties, pointer(path, key), root, errors);
      }
    }
  }
  if (Array.isArray(v)) {
    if (s.items !== undefined) {
      for (const [i, x] of v.entries()) check(x, s.items, pointer(path, i), root, errors);
    }
    if (v.length < s.minItems) fail('minItems', `must have at least ${s.minItems} items`);
    if (v.length > s.maxItems) fail('maxItems', `must have at most ${s.maxItems} items`);
  }
  if (typeof v === 'string') {
    const n = [...v].length;
    if (n < s.minLength) fail('minLength', `must be at least ${s.minLength} characters`);
    if (n > s.maxLength) fail('maxLength', `must be at most ${s.maxLength} characters`);
    if ('pattern' in s && !new RegExp(s.pattern, 'u').test(v)) fail('pattern', 'must match');
  }
  if (typeof v === 'number') {
    if (v < s.minimum) fail('minimum', `must be >= ${s.minimum}`);
    if (v > s.maximum) fail('maximum', `must be <= ${s.maximum}`);
  }

  for (const sub of s.allOf ?? []) check(v, sub, path, root, errors);
  if (s.anyOf && !s.anyOf.some(passes)) fail('anyOf', 'must match a schema in anyOf');
  if (s.oneOf && s.oneOf.filter(passes).length !== 1) {
    fail('oneOf', 'must match exactly one schema in oneOf');
  }
}
