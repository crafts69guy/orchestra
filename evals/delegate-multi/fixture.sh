source "$(dirname "$0")/../_support/repo.sh"

cat >src/currency.mjs <<'JS'
export const DEFAULT_CURRENCY = 'USD';
JS
cat >src/format.mjs <<'JS'
export function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
JS
cat >test/format.test.mjs <<'JS'
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPrice } from '../src/format.mjs';

test('formatPrice formats cents as dollars', () => assert.equal(formatPrice(1999), '$19.99'));
JS
commit_on_feat_x
