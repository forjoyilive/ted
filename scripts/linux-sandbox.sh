#!/bin/sh
# Runs a command (by default the sandbox tests) in a Debian container with bubblewrap and passt, as a
# normal user, so the Linux sandbox can be tested from macOS. bwrap needs --privileged for user namespaces.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -eq 0 ]; then
  set -- pnpm vitest run packages/daemon/test/sandbox.test.ts
fi
command=""
for word in "$@"; do
  command="$command '$(printf '%s' "$word" | sed "s/'/'\\\\''/g")'"
done
git ls-files -co --exclude-standard -z | tar --null -T - -cf - |
  docker run --rm -i --init --privileged -e COMMAND="$command" -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 node:24-trixie-slim sh -euc '
    mkdir /work
    tar -xf - -C /work
    apt-get update -qq </dev/null
    apt-get install -y -qq --no-install-recommends bubblewrap passt util-linux ca-certificates </dev/null >/dev/null
    corepack enable
    useradd -m tester
    chown -R tester /work
    su tester -c "cd /work && ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --reporter=silent && eval \"\$COMMAND\""
  '
