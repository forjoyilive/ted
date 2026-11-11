#!/bin/sh
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
if test ! -e "$root/runtime"; then
  /bin/mkdir "$root/runtime"
  printf '%s\n' "$owner" > "$root/runtime/.owner"
fi
test ! -L "$root/runtime"
test ! -L "$root/runtime/.owner"
test "$(/bin/cat "$root/runtime/.owner")" = "$owner"
for name in home cache node pnpm; do test ! -L "$root/runtime/$name"; done
/bin/mkdir -p "$root/runtime/home" "$root/runtime/cache"
arch=$(/usr/bin/uname -m)
case "$arch" in
  arm64) asset=node-v24.7.0-darwin-arm64.tar.gz; checksum=ff8298faaf82c85444aad7f1e12a4882496286ea9008702029b359d7fac7f8b3 ;;
  x86_64) asset=node-v24.7.0-darwin-x64.tar.gz; checksum=b99548ef56ec86da2ce50eff041d97e14077b77b517c4bcce0925d14c26cbee3 ;;
  *) exit 1 ;;
esac
if test ! -e "$root/runtime/node/bin/node"; then
/usr/bin/curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 180 \
  "https://nodejs.org/dist/v24.7.0/$asset" -o "$root/runtime/node.tar.gz"
test "$(/usr/bin/shasum -a 256 "$root/runtime/node.tar.gz" | /usr/bin/awk '{print $1}')" = "$checksum"
/bin/mkdir -p "$root/runtime/node"
/usr/bin/tar -xzf "$root/runtime/node.tar.gz" --strip-components=1 -C "$root/runtime/node"
/bin/rm "$root/runtime/node.tar.gz"
fi
/usr/bin/env -i HOME="$root/runtime/home" PATH="$root/runtime/node/bin:/usr/bin:/bin" \
  npm_config_cache="$root/runtime/cache" npm_config_userconfig=/dev/null npm_config_globalconfig="$root/runtime/home/global.npmrc" \
  "$root/runtime/node/bin/node" "$root/runtime/node/lib/node_modules/npm/bin/npm-cli.js" \
  install --prefix "$root/runtime/pnpm" --ignore-scripts --no-audit --no-fund pnpm@10.28.0
"$root/runtime/node/bin/node" --version
"$root/runtime/node/bin/node" "$root/runtime/pnpm/node_modules/pnpm/bin/pnpm.cjs" --version
