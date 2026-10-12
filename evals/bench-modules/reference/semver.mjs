const NUM = '0|[1-9]\\d*';
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION = new RegExp(
  `^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

function parse(v) {
  const m = typeof v === 'string' ? VERSION.exec(v) : null;
  if (m === null) throw new TypeError(`invalid version: ${v}`);
  return { core: [m[1], m[2], m[3]], pre: m[4] === undefined ? [] : m[4].split('.') };
}

const isNum = (id) => /^\d+$/.test(id);
const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);
// Numeric strings without leading zeros: longer is larger, else lexical.
const cmpNum = (a, b) => sign(a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
const cmpId = (a, b) => {
  if (isNum(a) && isNum(b)) return cmpNum(a, b);
  if (isNum(a) !== isNum(b)) return isNum(a) ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

export function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const c = cmpNum(x.core[i], y.core[i]);
    if (c !== 0) return c;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const c = cmpId(x.pre[i], y.pre[i]);
    if (c !== 0) return c;
  }
  return sign(x.pre.length - y.pre.length);
}
