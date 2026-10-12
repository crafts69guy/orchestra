source "$(dirname "$0")/../_support/repo.sh"
case_dir=$(cd "$(dirname "$0")" && pwd)

cp "$case_dir/SPEC.md" SPEC.md
commit_on_feat_x

# The acceptance suite lives in hidden/ in the orchestra checkout, which the run's sandbox cannot
# read. It is packed into .git (no tracked file, no git object, skipped by Glob/Grep) and only
# check.sh unpacks it, runs it and deletes it again. A run that reads check.sh can still find it.
tar -czf .git/acceptance.tgz -C "$case_dir/hidden" duration.mjs semver.mjs csv.mjs lru.mjs

cat >>check.sh <<'CHECK'
rm -rf .git/acceptance && mkdir .git/acceptance && tar -xzf .git/acceptance.tgz -C .git/acceptance
for m in duration semver csv lru; do
  out=$(node --test --test-reporter=tap ".git/acceptance/$m.mjs" 2>&1)
  total=$(printf '%s\n' "$out" | sed -n 's/^# tests //p')
  pass=$(printf '%s\n' "$out" | sed -n 's/^# pass //p')
  total=${total:-0} pass=${pass:-0}
  echo "acceptance $m: $pass/$total $((total > 0 ? pass * 100 / total : 0))%"
done >>check.out
rm -rf .git/acceptance
{
  cat SPEC.md
  printf '\n--- git diff main..feat/x\n'
  git diff main..feat/x -- . ':(exclude).scratch' 2>/dev/null
} >review.out
CHECK
printf 'review.out\n' >>.git/info/exclude
