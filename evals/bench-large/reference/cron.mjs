const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC' },
  { name: 'dayOfWeek', min: 0, max: 7, names: 'SUN MON TUE WED THU FRI SAT' },
];
const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};
const ITEM = /^(?:(\*)|([0-9]+|[A-Za-z]+)(?:-([0-9]+|[A-Za-z]+))?)(?:\/([0-9]+))?$/;

function fieldsOf(expr) {
  if (typeof expr !== 'string') throw new TypeError('cron expression must be a string');
  let text = expr.trim();
  if (text.startsWith('@')) {
    if (!Object.hasOwn(MACROS, text)) throw new SyntaxError(`unknown macro ${text}`);
    text = MACROS[text];
  }
  const fields = text.split(/[ \t]+/);
  if (fields.length !== 5) throw new SyntaxError(`expected 5 fields, got ${fields.length}`);
  return fields;
}

function value(token, field) {
  if (/^[0-9]+$/.test(token)) {
    const n = Number(token);
    if (n < field.min || n > field.max) throw new RangeError(`${token} out of range`);
    return n;
  }
  const i = field.names ? field.names.split(' ').indexOf(token.toUpperCase()) : -1;
  if (i < 0) throw new SyntaxError(`unknown name ${token}`);
  return i + (field.min === 1 ? 1 : 0);
}

function parseField(text, field) {
  const set = new Set();
  for (const item of text.split(',')) {
    const m = ITEM.exec(item);
    // A bare value with a step (`5/15`) is not a form the spec allows.
    if (!m || (m[4] !== undefined && !m[1] && m[3] === undefined)) {
      throw new SyntaxError(`bad item ${JSON.stringify(item)}`);
    }
    const lo = m[1] ? field.min : value(m[2], field);
    const hi = m[1] ? field.max : m[3] !== undefined ? value(m[3], field) : lo;
    const step = m[4] === undefined ? 1 : Number(m[4]);
    if (lo > hi) throw new RangeError(`range ${item} starts after it ends`);
    if (step === 0) throw new RangeError('step must be positive');
    for (let v = lo; v <= hi; v += step) set.add(field.name === 'dayOfWeek' ? v % 7 : v);
  }
  return [...set].sort((a, b) => a - b);
}

export function parse(expr) {
  const fields = fieldsOf(expr);
  const out = {};
  FIELDS.forEach((field, i) => {
    out[field.name] = parseField(fields[i], field);
  });
  return out;
}

export function next(expr, from) {
  const fields = fieldsOf(expr);
  const sets = parse(fields.join(' '));
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new TypeError('from must be a valid Date');
  }
  const doms = new Set(sets.dayOfMonth);
  const months = new Set(sets.month);
  const dows = new Set(sets.dayOfWeek);
  const either = fields[2] !== '*' && fields[4] !== '*';
  const dayMatches = (d) => {
    const a = doms.has(d.getUTCDate());
    const b = dows.has(d.getUTCDay());
    return either ? a || b : a && b;
  };

  const start = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  const limit = new Date(from.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + 8);
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (; day <= limit; day.setUTCDate(day.getUTCDate() + 1)) {
    if (!months.has(day.getUTCMonth() + 1) || !dayMatches(day)) continue;
    for (const h of sets.hour) {
      for (const m of sets.minute) {
        const t = new Date(day.getTime() + h * 3600000 + m * 60000);
        if (t >= start) return t <= limit ? t : null;
      }
    }
  }
  return null;
}
