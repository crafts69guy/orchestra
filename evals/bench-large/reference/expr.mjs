const TOKEN =
  /(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\|\||&&|==|!=|<=|>=|[()?:,<>+\-*/%!^]))/y;

const num = (x, what) => {
  if (typeof x !== 'number') throw new TypeError(`${what} needs a number, got ${typeof x}`);
  return x;
};
const bool = (x, what) => {
  if (typeof x !== 'boolean') throw new TypeError(`${what} needs a boolean, got ${typeof x}`);
  return x;
};

const FUNCS = {
  abs: [1, Math.abs],
  floor: [1, Math.floor],
  ceil: [1, Math.ceil],
  round: [1, (x) => Math.sign(x) * Math.round(Math.abs(x))],
  sqrt: [
    1,
    (x) => {
      if (x < 0) throw new RangeError('sqrt of a negative number');
      return Math.sqrt(x);
    },
  ],
  min: [-1, Math.min],
  max: [-1, Math.max],
};

const BINARY = {
  '+': (a, b) => num(a, '+') + num(b, '+'),
  '-': (a, b) => num(a, '-') - num(b, '-'),
  '*': (a, b) => num(a, '*') * num(b, '*'),
  '/': (a, b) => num(a, '/') / nonZero(num(b, '/')),
  '%': (a, b) => num(a, '%') % nonZero(num(b, '%')),
  '^': (a, b) => num(a, '^') ** num(b, '^'),
  '<': (a, b) => num(a, '<') < num(b, '<'),
  '<=': (a, b) => num(a, '<=') <= num(b, '<='),
  '>': (a, b) => num(a, '>') > num(b, '>'),
  '>=': (a, b) => num(a, '>=') >= num(b, '>='),
  '==': (a, b) => same(a, b, '=='),
  '!=': (a, b) => !same(a, b, '!='),
};
const LEVELS = [
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/', '%'],
];

function nonZero(x) {
  if (x === 0) throw new RangeError('division by zero');
  return x;
}

function same(a, b, op) {
  const ok = ['number', 'boolean'].includes(typeof a) && typeof a === typeof b;
  if (!ok) throw new TypeError(`${op} needs two numbers or two booleans`);
  return a === b;
}

function tokenize(src) {
  const tokens = [];
  let pos = 0;
  for (;;) {
    while (/\s/.test(src[pos] ?? '')) pos++;
    if (pos === src.length) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw syntax('unexpected character', pos);
    if (m[1] !== undefined) tokens.push({ type: 'num', value: Number(m[1]), pos });
    else if (m[2] === 'true' || m[2] === 'false') {
      tokens.push({ type: 'bool', value: m[2] === 'true', pos });
    } else if (m[2] !== undefined) tokens.push({ type: 'id', value: m[2], pos });
    else tokens.push({ type: 'op', value: m[3], pos });
    pos = TOKEN.lastIndex;
  }
  tokens.push({ type: 'end', value: null, pos: src.length });
  return tokens;
}

function syntax(message, position) {
  const e = new SyntaxError(`${message} at position ${position}`);
  e.position = position;
  return e;
}

// Recursive descent producing closures, so && || ?: can skip evaluating an operand.
function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v) => peek().type === 'op' && peek().value === v;
  const expect = (v) => {
    if (!isOp(v)) throw syntax(`expected ${v}`, peek().pos);
    i++;
  };

  const ternary = () => {
    const cond = or();
    if (!isOp('?')) return cond;
    i++;
    const a = ternary();
    expect(':');
    const b = ternary();
    return (env) => (bool(cond(env), '?:') ? a(env) : b(env));
  };
  const logical = (op, operand) => () => {
    let left = operand();
    while (isOp(op)) {
      i++;
      const l = left;
      const r = operand();
      left =
        op === '&&'
          ? (env) => bool(l(env), op) && bool(r(env), op)
          : (env) => bool(l(env), op) || bool(r(env), op);
    }
    return left;
  };
  const binary = (level) => () => {
    const ops = LEVELS[level];
    const operand = level === LEVELS.length - 1 ? unary : binary(level + 1);
    let left = operand();
    while (peek().type === 'op' && ops.includes(peek().value)) {
      const op = tokens[i++].value;
      const l = left;
      const r = operand();
      left = (env) => BINARY[op](l(env), r(env));
    }
    return left;
  };
  const and = logical('&&', binary(0));
  const or = logical('||', and);

  const unary = () => {
    if (isOp('-') || isOp('!')) {
      const op = tokens[i++].value;
      const x = unary();
      return op === '-' ? (env) => -num(x(env), '-') : (env) => !bool(x(env), '!');
    }
    const base = primary();
    if (!isOp('^')) return base;
    i++;
    const exp = unary();
    return (env) => BINARY['^'](base(env), exp(env));
  };

  const primary = () => {
    const t = tokens[i++];
    if (t.type === 'num' || t.type === 'bool') return () => t.value;
    if (t.type === 'id' && isOp('(')) return call(t.value);
    if (t.type === 'id') return (env) => lookup(env, t.value);
    if (t.type === 'op' && t.value === '(') {
      const inner = ternary();
      expect(')');
      return inner;
    }
    throw syntax('unexpected token', t.pos);
  };

  const call = (name) => {
    i++;
    const args = [];
    if (!isOp(')')) {
      args.push(ternary());
      while (isOp(',')) {
        i++;
        args.push(ternary());
      }
    }
    expect(')');
    return (env) => {
      if (!Object.hasOwn(FUNCS, name)) throw new ReferenceError(`unknown function ${name}`);
      const [arity, fn] = FUNCS[name];
      if (arity === -1 ? args.length === 0 : args.length !== arity) {
        throw new TypeError(`wrong number of arguments to ${name}`);
      }
      return fn(...args.map((a) => num(a(env), name)));
    };
  };

  const root = ternary();
  if (peek().type !== 'end') throw syntax('unexpected token', peek().pos);
  return root;
}

function lookup(vars, name) {
  if (!Object.hasOwn(vars, name)) throw new ReferenceError(`unknown variable ${name}`);
  const v = vars[name];
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  throw new TypeError(`variable ${name} must be a finite number or a boolean`);
}

export function evaluate(src, vars = {}) {
  if (typeof src !== 'string') throw new TypeError('expression must be a string');
  if (typeof vars !== 'object' || vars === null) throw new TypeError('vars must be an object');
  return parse(tokenize(src))(vars);
}
