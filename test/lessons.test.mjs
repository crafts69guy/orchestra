import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LESSON,
  LESSONS_CAP,
  lessonsPath,
  parseLessons,
  selectLessons,
  signalsPath,
} from '../scripts/lib/lessons.mjs';

test('paths live under the root .orc/', () => {
  assert.equal(lessonsPath('/r'), '/r/.orc/lessons.md');
  assert.equal(signalsPath('/r'), '/r/.orc/signals.jsonl');
  assert.equal(LESSONS_CAP, 40);
});

test('parseLessons reads lesson lines, ignores prose and numbers invalid ones', () => {
  const text = [
    '# Lessons',
    '',
    '- [L007] +2 -0 project · session-isolation · Use a session worktree.',
    '- [L1] +1 -0 project · x · id too short',
    'prose - [L008] +1 -0 orc · y · not at line start',
    '- [L1234] +10 -3 orc · multi word feature · text · with a dot',
    '- [L009] +1 project · x · missing down',
  ].join('\r\n');
  const { lessons, invalid } = parseLessons(text);
  assert.deepEqual(lessons, [
    {
      id: 'L007',
      up: 2,
      down: 0,
      scope: 'project',
      feature: 'session-isolation',
      text: 'Use a session worktree.',
      line: '- [L007] +2 -0 project · session-isolation · Use a session worktree.',
    },
    {
      id: 'L1234',
      up: 10,
      down: 3,
      scope: 'orc',
      feature: 'multi word feature',
      text: 'text · with a dot',
      line: '- [L1234] +10 -3 orc · multi word feature · text · with a dot',
    },
  ]);
  assert.deepEqual(invalid, [4, 7]);
  assert.ok(LESSON.test('- [L100] +0 -0 orc · f · t'));
});

test('selectLessons drops retired, sorts by score with file order on ties, and caps', () => {
  const l = (id, up, down) => ({ id, up, down });
  const all = [l('a', 1, 0), l('b', 3, 1), l('c', 1, 1), l('d', 0, 2), l('e', 2, 1), l('f', 5, 0)];
  assert.deepEqual(
    selectLessons(all).kept.map((x) => x.id),
    ['f', 'b', 'a', 'e'],
  );
  assert.equal(selectLessons(all).hidden, 0);
  assert.deepEqual(selectLessons(all, 2), { kept: [all[5], all[1]], hidden: 2 });
  assert.deepEqual(selectLessons([]), { kept: [], hidden: 0 });
});
