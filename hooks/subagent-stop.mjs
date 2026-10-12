#!/usr/bin/env node
import { readStdin, roleOf } from './guard.mjs';
import { isEntry } from './session-start.mjs';

const STATUS = /^[\s>*#-]*Status\W*(done|partial|blocked)\b/im;
const VALIDATION = /^[\s>*#-]*Validation\b/im;

export const BLOCK_REASON =
  'orch: your report is incomplete. Reply again with a `Status: done|partial|blocked` line and a `Validation` section listing each command you ran and its result.';

/** True when the implementer report carries both a Status line and a Validation section. */
export function hasEvidence(message) {
  return typeof message === 'string' && STATUS.test(message) && VALIDATION.test(message);
}

/** Returns the exit code; never throws, bad stdin JSON is a silent allow. */
export function run({ env, input, stdout }) {
  if (env.ORCH !== '1') return 0;
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return 0;
  }
  if (roleOf(payload?.agent_type) !== 'implementer' || payload?.stop_hook_active === true) return 0;
  if (!hasEvidence(payload?.last_assistant_message)) {
    stdout(JSON.stringify({ decision: 'block', reason: BLOCK_REASON }));
  }
  return 0;
}

export function main(proc = process, read = readStdin) {
  proc.exitCode = run({
    env: proc.env,
    input: proc.env.ORCH === '1' ? read() : '',
    stdout: (s) => proc.stdout.write(s),
  });
}

if (isEntry(process.argv[1], import.meta.url)) main();
