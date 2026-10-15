/** Check-result helpers shared by `orch doctor` and `orch context`. */
export const pass = (name, detail) => ({ mark: '✓', name, detail });
export const fail = (name, detail, fix) => ({ mark: '✗', name, detail, fix });
export const warn = (name, detail, fix) => ({ mark: '!', name, detail, fix });
export const info = (name, detail) => ({ mark: '·', name, detail });
export const format = ({ mark, name, detail, fix }) =>
  `${mark} ${name}  ${detail}${fix ? ` — fix: ${fix}` : ''}`;
