# Sourced by each case's fixture.sh. Starts a node:test repo in the empty workspace;
# the case writes its files, then calls commit_on_feat_x.
set -euo pipefail

git init -q -b main
git config user.name eval
git config user.email eval@example.com
git config commit.gpgsign false
mkdir -p src test
printf '{ "name": "fixture", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n' >package.json

# check.sh records the final state for the graders. It is ignored, so it never dirties the tree.
# git stderr is dropped: on macOS the /usr/bin/git shim prints cache errors inside the sandbox.
cat >check.sh <<'SH'
{
  echo "branch: $(git branch --show-current 2>/dev/null)"
  git log --format='commit: %s' main..feat/x 2>/dev/null
  echo "dirty: $(git status --porcelain -- . ':(exclude).scratch' 2>/dev/null | wc -l | tr -d ' ')"
  echo "worktrees: $(git worktree list 2>/dev/null | wc -l | tr -d ' ')"
  node --test --test-reporter=tap 2>&1 | grep -E '^# (pass|fail) '
} >check.out
SH
printf 'check.sh\ncheck.out\n' >>.git/info/exclude

commit_on_feat_x() {
  git add -A
  git commit -q -m 'chore: initial'
  git checkout -q -b feat/x
}
