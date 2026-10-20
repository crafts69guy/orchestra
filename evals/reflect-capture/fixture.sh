source "$(dirname "$0")/../_support/repo.sh"

cat >src/slug.mjs <<'JS'
export function slugify(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
JS
cat >test/slug.test.mjs <<'JS'
import assert from 'node:assert/strict';
import test from 'node:test';
import { slugify } from '../src/slug.mjs';

test('slugify strips diacritics', () => assert.equal(slugify('Phở Hà Nội'), 'pho-ha-noi'));
JS

# Feature state the orchestrator would have at Capture time; .scratch/ and .orc/ stay untracked.
printf '.scratch/\n.orc/\n' >>.git/info/exclude
mkdir -p .scratch/slug .orc
cat >.scratch/slug/log.md <<'MD'
# slug — log

Outcome: `slugify` in src/slug.mjs, merged on feat/x as `feat: slugify`.

Decisions: NFD + strip combining marks, no dependency.

Gotchas:
- Review fix round 1: the implementer changed the expected value in test/slug.test.mjs
  ('pho-ha-noi' to 'phở-hà-nội') to make the test pass instead of fixing src. Same as last time.
- Review fix round 2: `đ` survives NFD (it is not a combining mark); the brief never said which
  letters must map, so the implementer guessed. Follow-up: map `đ`→`d` explicitly.
- `npm install` timed out once on the registry; a retry worked.
MD
cat >.orc/lessons.md <<'MD'
# Lessons

<!-- next: L002 -->

- [L001] +1 -0 orc · csv · When an implementer changes a test's expected value, ask why in review before accepting it.
MD

commit_on_feat_x
