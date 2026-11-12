prepare_runtime() {
  lab_root=$1
  lab_owner=$2
  cursor=$lab_root
  while test "$cursor" != /; do
    test ! -L "$cursor" || return 1
    cursor=$(/usr/bin/dirname "$cursor")
  done
  test ! -L "$lab_root/.ted-lab-owner" || return 1
  test "$(/bin/cat "$lab_root/.ted-lab-owner")" = "$lab_owner" || return 1
  if test -e "$lab_root/runtime" || test -L "$lab_root/runtime"; then
    for relative in runtime runtime/.owner runtime/node.tar.gz runtime/node runtime/node/bin runtime/node/bin/node runtime/pnpm runtime/pnpm/node_modules runtime/pnpm/node_modules/pnpm runtime/pnpm/node_modules/pnpm/bin runtime/pnpm/node_modules/pnpm/bin/pnpm.cjs; do
      test ! -L "$lab_root/$relative" || return 1
    done
    test "$(/bin/cat "$lab_root/runtime/.owner")" = "$lab_owner" || return 1
    test -f "$lab_root/runtime/node/bin/node" || return 1
    test -f "$lab_root/runtime/pnpm/node_modules/pnpm/bin/pnpm.cjs" || return 1
    printf 'ready\n'
    return 0
  fi
  stage=$(/usr/bin/mktemp -d "$lab_root/.runtime-XXXXXXXX") || return 1
  printf '%s\n' "$lab_owner" > "$stage/.owner"
  printf '%s\n' "$stage"
}

remove_runtime_stage() {
  stage=$1
  lab_root=$2
  lab_owner=$3
  case "$stage" in "$lab_root"/.runtime-????????) ;; *) return 1 ;; esac
  test -d "$stage" && test ! -L "$stage" && test ! -L "$stage/.owner" || return 1
  test "$(/bin/cat "$stage/.owner")" = "$lab_owner" || return 1
  /bin/rm -rf -- "$stage"
}
