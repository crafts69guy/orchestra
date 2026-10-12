const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function unquote(value) {
  const quoted = value.length >= 2 && value[0] === value.at(-1) && ['"', "'"].includes(value[0]);
  return quoted ? value.slice(1, -1) : value;
}

/**
 * Parse flat `key: value` YAML frontmatter (the only shape agents/*.md use).
 * Returns `{ data, body }`, or `null` when the text has no frontmatter block.
 * ponytail: no nested maps or lists; upgrade to a real YAML parser if agents need them.
 */
export function parseFrontmatter(text) {
  const match = FENCE.exec(text);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) data[line.slice(0, idx).trim()] = unquote(line.slice(idx + 1).trim());
  }
  return { data, body: match[2] };
}
