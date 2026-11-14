#!/bin/sh
# Stands in for sandbox-exec or bwrap inside TED's own sandbox, where a second sandbox can't
# start (ADR 0147): it drops the sandbox's options and runs the command in the outer sandbox.
if [ "$1" = "--help" ]; then
  exit 0
fi
case "$1" in
--*)
  for arg do
    shift
    if [ "$arg" = "--" ]; then
      exec "$@"
    fi
    last="$arg"
  done
  exec "$last"
  ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
  -D)
    shift 2
    ;;
  -p)
    shift 2
    break
    ;;
  *)
    break
    ;;
  esac
done
exec "$@"
