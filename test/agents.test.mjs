import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseFrontmatter } from '../scripts/lib/frontmatter.mjs';

const dir = new URL('../agents/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.md'));

test('ships exactly the four workflow agents', () => {
  assert.deepEqual(files.sort(), ['implementer.md', 'reviewer.md', 'scoper.md', 'shipper.md']);
});

for (const file of files) {
  test(`${file} has valid frontmatter`, () => {
    const parsed = parseFrontmatter(readFileSync(new URL(file, dir), 'utf8'));
    assert.ok(parsed, 'frontmatter block present');
    const { data, body } = parsed;
    for (const key of ['name', 'description', 'model', 'tools']) {
      assert.ok(data[key], `${key} is set`);
    }
    assert.equal(data.name, file.replace(/\.md$/, ''));
    assert.ok(data.description.startsWith('orch workflow:'), 'description prefix');
    assert.doesNotMatch(data.description, /proactively/i);
    assert.ok(body.trim().split('\n').length <= 25, 'body stays under ~25 lines');
  });
}
