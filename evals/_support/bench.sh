#!/bin/sh
# `npm run eval:bench`: run the benchmark cases (tag bench) through run.sh, then print the
# per-arm time/cost/score table for the newest results. Extra args pass through to run.sh.
# --threshold 0: a benchmark has no pass bar, so only a cost-ceiling stop (exit 2) or a real
# failure makes this exit non-zero. The cost cap is ORC_EVAL_MAX_COST (USD, default 20 here);
# override it from the environment, e.g. `ORC_EVAL_MAX_COST=40 npm run eval:bench`.
cd "$(dirname "$0")/../.." || exit 1
ORC_EVAL_MAX_COST=${ORC_EVAL_MAX_COST:-20} sh evals/_support/run.sh --tag bench --threshold 0 \
  --judge-model sonnet "$@"
code=$?
node evals/_support/summarize.mjs || code=1
exit "$code"
