# Promote orc lessons

Only in the orc repository (it has `rules/orchestrator.md` and `evals/`), on a
feature branch, when the user asks. One lesson per round.

1. **Collect** `orc`-scope lessons: this repo's `.orc/lessons.md`, plus other
   repos' through `mcp__inkdrop__search-notes` with `tag:orc-lesson
   status:active` and no notebook qualifier: notebook search does not include
   sub-notebooks (read at most 10 notes). A candidate has
   a net score of `+2` or more, or shows up in 2+ repos.
2. **Locate** the behaviour to change: a line of `rules/orchestrator.md`, an
   `agents/*.md` body or a skill. If no wording change would have prevented it,
   stop: it is not a rule gap.
3. **RED.** Add `evals/<slug>/case.yaml` and `fixture.sh` (start from
   `evals/delegate-multi/`) that reproduce the failure with deterministic
   graders only (`tool_used`, `regex`, `file_exists`). Run
   `npm run eval -- --case <slug> --runs 3 --ablation none` on the current
   rules. It must fail; if it passes, stop.
4. **GREEN.** Make the smallest edit that names the trigger and the action.
   Rerun the new case: it must pass in at least 2 of 3 runs. Then run
   `npm run eval -- --case inline-small --runs 2 --ablation none` and the same
   for `delegate-multi`; neither may score lower than on the base branch
   (`node evals/_support/summarize.mjs <aggregate-result.json>` prints both).
5. **Check** `npm run check` (agent bodies stay at most 25 lines; run
   `npm run gen:codex` after an agent change).
6. **Approve.** Show the user the diff and the eval numbers. Shipping goes to
   `shipper`.
7. **Retire.** `EDIT` the promoted lessons to `→ promoted to <file>` and
   `REMOVE` them at the next reflect, in every repo that holds them.

Don't edit or delete an existing case or grader (only add), loosen a grader to
reach green, use an `llm` grader as the gate, or promote without a RED run.
