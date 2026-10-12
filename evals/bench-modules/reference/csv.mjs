export function parse(text) {
  if (typeof text !== 'string') throw new TypeError('csv text must be a string');
  const rows = [];
  let row = [];
  let i = 0;
  const n = text.length;
  if (n === 0) return rows;
  while (true) {
    let field = '';
    if (text[i] === '"') {
      i++;
      while (true) {
        if (i >= n) throw new SyntaxError('unterminated quoted field');
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else field += text[i++];
      }
      if (i < n && text[i] !== ',' && text[i] !== '\n' && !text.startsWith('\r\n', i)) {
        throw new SyntaxError(`unexpected character after closing quote at ${i}`);
      }
    } else {
      while (i < n && text[i] !== ',' && text[i] !== '\n' && !text.startsWith('\r\n', i)) {
        if (text[i] === '"') throw new SyntaxError(`quote in unquoted field at ${i}`);
        field += text[i++];
      }
    }
    row.push(field);
    if (i >= n) break;
    if (text[i] === ',') {
      i++;
      continue;
    }
    i += text[i] === '\r' ? 2 : 1;
    rows.push(row);
    row = [];
    if (i >= n) return rows;
  }
  rows.push(row);
  return rows;
}
