import { join } from 'node:path';

/** One lesson line; groups: id, up, down, scope (project|orc), feature, text. */
export const LESSON = /^- \[(L\d{3,})\] \+(\d+) -(\d+) (project|orc) · ([^·]+?) · (.+)$/;

/** Most lessons injected per session; the rest are counted as hidden. */
export const LESSONS_CAP = 40;

/** `<root>/.orc/lessons.md`, `root` being the main checkout. */
export const lessonsPath = (root) => join(root, '.orc', 'lessons.md');

/** `<root>/.orc/signals.jsonl`, `root` being the main checkout. */
export const signalsPath = (root) => join(root, '.orc', 'signals.jsonl');

/**
 * `{ lessons, invalid }`: each matching line as `{ id, up, down, scope, feature, text, line }`
 * (`line` is the raw line), and the 1-based numbers of lines starting `- [` that do not match.
 * Other lines (headings, blanks, prose) are ignored.
 */
export function parseLessons(text) {
  const lessons = [];
  const invalid = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = LESSON.exec(line);
    if (m) {
      const [, id, up, down, scope, feature, body] = m;
      lessons.push({ id, up: Number(up), down: Number(down), scope, feature, text: body, line });
    } else if (line.startsWith('- [')) invalid.push(i + 1);
  });
  return { lessons, invalid };
}

/**
 * `{ kept, hidden }`: retired lessons (`down >= up`) dropped, the rest sorted by `up - down`
 * descending (file order on ties), the first `cap` kept and `hidden` the count cut by the cap.
 */
export function selectLessons(lessons, cap = LESSONS_CAP) {
  const active = lessons
    .filter((l) => l.down < l.up)
    .sort((a, b) => b.up - b.down - (a.up - a.down));
  return { kept: active.slice(0, cap), hidden: Math.max(0, active.length - cap) };
}
