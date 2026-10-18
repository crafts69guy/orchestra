#!/bin/sh
# `npm run eval`: build .eval-plugin/, then run the behaviour suite. Extra args pass through.
# Without a --tag argument only the behaviour cases (tag orc) run, not the costly benchmark.
# The suite cost cap is ORC_EVAL_MAX_COST (USD, default 5); pass it here, not as a flag.
set -eu
cd "$(dirname "$0")/../.."
case " $* " in
*" --tag "*) ;;
*) set -- --tag orc "$@" ;;
esac
sh evals/_support/build-plugin.sh
claude_bin=$(command -v claude)
node_dir=$(dirname "$(node -p process.execPath)")
git_bin=$(command -v git)

# Two sandbox workarounds for the runs' Bash (and the orc wt / wt processes it starts):
# - On macOS a bare `git` resolves to the /usr/bin/git xcrun shim, which cannot write its cache
#   in the sandbox and prints every output twice; wt then rejects `git --version`. A wrapper
#   that execs the git found here comes first on PATH. It lives in the plugin root because
#   the sandbox can read that but not /tmp or $HOME.
# - Most of $HOME is unreadable, and Node's spawn of `git` fails with EPERM at the first
#   unreadable PATH entry, so only node's directory and entries outside $HOME are kept.
shim=$PWD/.eval-plugin/sandbox-bin
mkdir -p "$shim"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$git_bin" >"$shim/git"
chmod +x "$shim/git"
PATH="$shim:$node_dir:$(printf %s "$PATH" | tr ':' '\n' | grep -v "^$HOME/" | paste -sd: -)"
export PATH

exec "$claude_bin" plugin eval . --trust-plugin --scaffold --max-cost-usd "${ORC_EVAL_MAX_COST:-5}" \
  --no-publish \
  --allow-tools Bash Edit Write "$@"
