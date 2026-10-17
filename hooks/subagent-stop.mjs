#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readStdin, roleOf } from './guard.mjs';
import { isEntry } from './session-start.mjs';

/** Matches a report's `Status: done|partial|blocked` line; group 1 is the status. */
export const STATUS = /^[\s>*#-]*Status\W*(done|partial|blocked)\b/im;
const VALIDATION = /^[\s>*#-]*Validation\b/im;

export const BLOCK_REASON =
  'orch: your report is incomplete. Reply again with a `Status: done|partial|blocked` line and a `Validation` section listing each command you ran and its result.';

/** True when the implementer report carries both a Status line and a Validation section. */
export function hasEvidence(message) {
  return typeof message === 'string' && STATUS.test(message) && VALIDATION.test(message);
}

/**
 * The `message` of the last `SubagentHandback` tool call in a subagent transcript (JSONL), or
 * undefined when the path is missing, unreadable or holds no handback. Never throws.
 */
export function handbackReport(path, readFile = (p) => readFileSync(p, 'utf8')) {
  if (typeof path !== 'string' || path === '') return undefined;
  let report;
  try {
    for (const line of readFile(path).split('\n')) {
      let content;
      try {
        content = JSON.parse(line)?.message?.content;
      } catch {
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type === 'tool_use' && part.name === 'SubagentHandback') {
          report = part.input?.message;
        }
      }
    }
  } catch {
    return undefined;
  }
  return report;
}

/** Returns the exit code; never throws, bad stdin JSON is a silent allow. */
export function run({ env, input, stdout, readFile }) {
  if (env.ORCH !== '1') return 0;
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return 0;
  }
  if (roleOf(payload?.agent_type) !== 'implementer' || payload?.stop_hook_active === true) return 0;
  if (
    !hasEvidence(payload?.last_assistant_message) &&
    !hasEvidence(handbackReport(payload?.agent_transcript_path, readFile))
  ) {
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
