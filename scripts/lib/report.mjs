/**
 * Check-result helpers shared by `orc doctor` and `orc context`. `status` is the
 * machine-readable twin of `mark` for `--json` consumers: pass, fail, warn or info.
 */
export const pass = (name, detail) => ({ mark: '✓', status: 'pass', name, detail });
export const fail = (name, detail, fix) => ({ mark: '✗', status: 'fail', name, detail, fix });
export const warn = (name, detail, fix) => ({ mark: '!', status: 'warn', name, detail, fix });
export const info = (name, detail) => ({ mark: '·', status: 'info', name, detail });
export const format = ({ mark, name, detail, fix }) =>
  `${mark} ${name}  ${detail}${fix ? ` — fix: ${fix}` : ''}`;
