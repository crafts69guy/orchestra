import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontmatter } from '../scripts/lib/frontmatter.mjs';

test('parses keys, strips quotes, keeps colons in values and returns the body', () => {
  const text = '---\nname: a\ndescription: "x: y"\nmodel: \'m\'\nlone: "\n---\n# Body\n';
  assert.deepEqual(parseFrontmatter(text), {
    data: { name: 'a', description: 'x: y', model: 'm', lone: '"' },
    body: '# Body\n',
  });
});

test('handles CRLF, empty body and lines without a key', () => {
  const text = '---\r\nname: a\r\nnot a pair\r\n: nokey\r\n---\r\n';
  assert.deepEqual(parseFrontmatter(text), { data: { name: 'a' }, body: '' });
});

test('returns null without a frontmatter block', () => {
  assert.equal(parseFrontmatter('# just markdown\n'), null);
  assert.equal(parseFrontmatter('---\nunterminated: true\n'), null);
});
