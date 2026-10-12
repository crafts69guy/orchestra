source "$(dirname "$0")/../_support/repo.sh"

cat >src/math.mjs <<'JS'
export const add = (a, b) => a - b;
export const mul = (a, b) => a * b;
JS
cat >test/math.test.mjs <<'JS'
import assert from 'node:assert/strict';
import test from 'node:test';
import { add, mul } from '../src/math.mjs';

test('add', () => assert.equal(add(2, 3), 5));
test('mul', () => assert.equal(mul(2, 3), 6));
JS
commit_on_feat_x
