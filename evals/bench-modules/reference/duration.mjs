const UNITS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
const ORDER = Object.keys(UNITS);
const SEGMENT = /(\d+)(ms|d|h|m|s)/y;

export function parseDuration(str) {
  if (typeof str !== 'string') throw new TypeError('duration must be a string');
  const s = str.trim();
  if (s === '') throw new SyntaxError('empty duration');
  let total = 0;
  let last = -1;
  SEGMENT.lastIndex = 0;
  while (SEGMENT.lastIndex < s.length) {
    const at = SEGMENT.lastIndex;
    const m = SEGMENT.exec(s);
    if (m === null) throw new SyntaxError(`bad duration at ${at}: ${str}`);
    const rank = ORDER.indexOf(m[2]);
    if (rank <= last) throw new SyntaxError(`unit ${m[2]} out of order or repeated: ${str}`);
    last = rank;
    total += Number(m[1]) * UNITS[m[2]];
  }
  if (total > Number.MAX_SAFE_INTEGER) throw new RangeError(`duration too large: ${str}`);
  return total;
}
