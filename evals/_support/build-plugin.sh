#!/bin/sh
# Builds .eval-plugin/, the copy of orc that `npm run eval` loads. A copy, because:
# - eval runs pass only EVAL_* variables, so ORC=1 is prefixed to each hook command here
#   (the hooks' own ORC gate is unchanged);
# - the ponytail dependency cannot be installed in the run's isolated home, so the
#   manifest omits it;
# - sandboxed Bash can read the plugin root but not symlink targets outside it (package.json
#   is copied so Node finds `"type": "module"` without walking up into the unreadable repo).
set -eu
cd "$(dirname "$0")/../.."
rm -rf .eval-plugin
mkdir -p .eval-plugin/.claude-plugin
cp -R package.json agents skills hooks rules bin scripts .eval-plugin/
sed 's/"command": "node /"command": "ORC=1 node /' hooks/hooks.json >.eval-plugin/hooks/hooks.json
if grep -q '"command": "node ' .eval-plugin/hooks/hooks.json; then
  echo 'build-plugin: a hook command was not prefixed with ORC=1' >&2
  exit 1
fi
printf '{ "name": "orc", "version": "0.1.0" }\n' >.eval-plugin/.claude-plugin/plugin.json
