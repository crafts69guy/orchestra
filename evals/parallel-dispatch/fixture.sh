source "$(dirname "$0")/../_support/repo.sh"
bench=$(cd "$(dirname "$0")/../bench-large" && pwd)

# Two substantial modules (~100 and ~200 reference lines): the cron and expression sections of
# bench-large's SPEC.md, without the schema section. Copied at scaffold time, which runs outside
# the sandbox, so the spec has a single source.
awk '/^## `src\/schema\.mjs`/ { skip = 1 } /^## `src\/expr\.mjs`/ { skip = 0 } !skip' "$bench/SPEC.md" |
  sed -e 's/^# SPEC: three parsers and evaluators$/# SPEC: a cron parser and an expression evaluator/' \
    -e 's/^Three independent ES modules\./Two independent ES modules./' >SPEC.md
if ! grep -q '^Two independent' SPEC.md || grep -q schema SPEC.md; then
  echo 'parallel-dispatch: bench-large/SPEC.md changed shape, update the extraction' >&2
  exit 1
fi
commit_on_feat_x
