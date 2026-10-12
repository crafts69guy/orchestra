source "$(dirname "$0")/../_support/repo.sh"

cat >src/strings.mjs <<'JS'
export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
JS
cat >src/math.mjs <<'JS'
export const add = (a, b) => a + b;
JS
cat >test/strings.test.mjs <<'JS'
import assert from 'node:assert/strict';
import test from 'node:test';
import { capitalize } from '../src/strings.mjs';

test('capitalize', () => assert.equal(capitalize('hello'), 'Hello'));
JS
cat >test/math.test.mjs <<'JS'
import assert from 'node:assert/strict';
import test from 'node:test';
import { add } from '../src/math.mjs';

test('add', () => assert.equal(add(2, 3), 5));
JS
commit_on_feat_x
