#!/bin/sh
# The runner prepends bootstrap-paths.sh before sending this script.
set -eu
umask 077
root=$1
lab_id=$2
expected_id=$3
approved_home=$4
case "$lab_id" in ''|*[!a-z0-9-]*) exit 1 ;; esac
case "$approved_home" in /Users/*) ;; *) exit 1 ;; esac
test "$root" = "$approved_home/ted-validation-lab"
test "$(/usr/bin/id -u)" != 0
test "$(/usr/bin/id -un)" = "$(/usr/bin/basename "$approved_home")"
test "$(/bin/sh -c 'printf "%s" "$HOME"')" = "$approved_home"
cursor=$root
while test "$cursor" != /; do
  test ! -L "$cursor"
  cursor=$(/usr/bin/dirname "$cursor")
done
actual_id=$(/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | /usr/bin/awk -F '"' '/"IOPlatformUUID"/ {print $4}')
test "$actual_id" = "$expected_id"
owner="$lab_id:$(/usr/bin/id -u):$actual_id"
if test ! -e "$root"; then
  /bin/mkdir -m 700 "$root"
  printf '%s\n' "$owner" > "$root/.ted-lab-owner"
fi
test ! -L "$root/.ted-lab-owner"
test "$(/bin/cat "$root/.ted-lab-owner")" = "$owner"
test "$(/usr/bin/stat -f %u "$root")" = "$(/usr/bin/id -u)"
root_mode=$(/usr/bin/stat -f %Lp "$root")
case "$root_mode" in ''|*[!0-7]*) exit 1 ;; esac
test "$((0$root_mode & 022))" = 0
stage=$(prepare_runtime "$root" "$owner") || { printf 'Runtime is unsafe or incomplete; inspect it before recovery.\n' >&2; exit 1; }
if test "$stage" = ready; then
  printf 'Existing owned runtime preserved; use preflight to verify versions.\n'
  exit 0
fi
trap 'remove_runtime_stage "$stage" "$root" "$owner" || true' EXIT
/bin/mkdir "$stage/home" "$stage/cache"
arch=$(/usr/bin/uname -m)
case "$arch" in
  arm64) asset=node-v24.7.0-darwin-arm64.tar.gz; checksum=ff8298faaf82c85444aad7f1e12a4882496286ea9008702029b359d7fac7f8b3 ;;
  x86_64) asset=node-v24.7.0-darwin-x64.tar.gz; checksum=b99548ef56ec86da2ce50eff041d97e14077b77b517c4bcce0925d14c26cbee3 ;;
  *) exit 1 ;;
esac
/usr/bin/curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 180 --max-filesize 100000000 \
  "https://nodejs.org/dist/v24.7.0/$asset" -o "$stage/node.tar.gz"
test "$(/usr/bin/shasum -a 256 "$stage/node.tar.gz" | /usr/bin/awk '{print $1}')" = "$checksum"
/bin/mkdir "$stage/node"
/usr/bin/tar -xzf "$stage/node.tar.gz" --strip-components=1 -C "$stage/node"
/bin/rm "$stage/node.tar.gz"
/usr/bin/env -i HOME="$stage/home" PATH="$stage/node/bin:/usr/bin:/bin" \
  npm_config_cache="$stage/cache" npm_config_userconfig=/dev/null npm_config_globalconfig="$stage/home/global.npmrc" \
  "$stage/node/bin/node" "$stage/node/lib/node_modules/npm/bin/npm-cli.js" \
  install --prefix "$stage/pnpm" --ignore-scripts --no-audit --no-fund pnpm@10.28.0
/bin/mkdir -m 700 "$root/runtime"
printf '%s\n' "$owner" > "$root/runtime/.owner"
/bin/mv "$stage/node" "$stage/pnpm" "$stage/home" "$stage/cache" "$root/runtime/"
"$root/runtime/node/bin/node" --version
"$root/runtime/node/bin/node" "$root/runtime/pnpm/node_modules/pnpm/bin/pnpm.cjs" --version
