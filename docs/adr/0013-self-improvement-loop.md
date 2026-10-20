# ADR-0013: Self-improvement loop

- Status: accepted
- Date: 2026-10-20

## Context

Capture writes `.scratch/<feature>/log.md` with gotchas and follow-ups, but nothing reads it
back: a lesson learned in one feature is gone by the next session. Inkdrop recall (ADR-0011)
finds it only by luck, and ADR-0011 deferred promoting learnings into atomic notes.

Research on self-improving harnesses agrees on one point: self-edits help only when something
checks them.

- Self-generated skills averaged −1.3pp against no skill, while curated ones gained +16.6pp
  ([SkillsBench](https://arxiv.org/abs/2602.12670)).
- Context files rarely raise task success and add about 20% inference cost
  ([AGENTS.md study](https://arxiv.org/abs/2602.11988)).
- Rewriting a whole playbook collapsed one from about 18k to 122 tokens and dropped accuracy
  below the no-learning baseline. Itemized delta updates with helpful/harmful counters avoided it
  ([ACE](https://arxiv.org/abs/2510.04618)).
- Explicit votes with removal at zero ([ExpeL](https://arxiv.org/abs/2308.10144)), candidates
  promoted on signal ([Bugbot learned rules](https://cursor.com/blog/bugbot-learning)) and
  benchmark-gated self-edits ([DGM](https://arxiv.org/abs/2505.22954)) are the validated shapes.
  DGM also showed the risk: it faked test logs to pass its own gate.

## Decision

- **Two scopes, one file.** Lessons live in `<main checkout>/.orc/lessons.md` (git-excluded,
  shared by every worktree), one per line:
  `- [L007] +2 -0 project · <feature> · <lesson>`. Scope `project` is about the codebase; `orc` is
  about the workflow itself. A lesson is retired once its down count reaches its up count. The
  parser is `scripts/lib/lessons.mjs`.
- **Inject.** SessionStart and `orc codex` append the 40 best-scored active lessons after the
  rules (`readLessons` in `hooks/session-start.mjs`), with a count of any hidden ones. Pane
  workers get none; the orchestrator passes the relevant ones into briefs. `orc context` counts
  the file as always-loaded and warns over the cap or on malformed lines.
- **Reflect, with approval.** The Capture rule ends with the `reflect` skill. It proposes `ADD`
  (at most 3 per feature), `UPVOTE`, `DOWNVOTE`, `EDIT` and `REMOVE` rows, built only from the
  session's own verified evidence (log gotchas, review fix rounds, user corrections, signals,
  red-then-green tests), never from tool or web output. The user approves each row; edits are
  line by line, never a rewrite.
- **Signals.** The guard's denies and the SubagentStop gate's blocks append one JSON line to
  `.orc/signals.jsonl`. No model call, and nothing on the allow path touches git or disk.
- **Share.** `orc inkdrop lessons` mirrors each active lesson into its own note tagged
  `orc-lesson` (identity `<repo>/<id>` in a managed block) and sets retired ones to `dropped`.
  The existing Knowledge step then recalls lessons from other repos.
- **Promote, eval-gated.** `reflect promote` (`skills/reflect/references/promote.md`) runs only
  in the orc repo, on request. An `orc` lesson with a net score of +2, or seen in 2+ repos, first
  gets a new eval case with deterministic graders that fails on the current rules (RED). Then the
  smallest rule, agent or skill edit makes it pass in 2 of 3 runs without lowering
  `inline-small` or `delegate-multi` (GREEN), and the user approves the diff. Existing cases and
  graders are never edited.

## Consequences

- Lessons reach the next session on both harnesses at a bounded cost (40 lines at most).
- Every lesson costs one approval, which keeps the store small and stops poisoning, but it
  depends on the user reading the table.
- Counters are only as good as the reflect step's judgement of "helped" and "misled"; there is
  no automatic outcome tracking.
- Promotion costs real eval runs (about $1–2 per candidate) and stays manual.
- Lessons are local to a checkout until pushed to Inkdrop; a fresh clone starts empty.
- Deferred: embedding retrieval (only once the cap actually drops useful lessons), automatic
  consolidation in the style of Anthropic's Dreams, and any self-edit without approval.
