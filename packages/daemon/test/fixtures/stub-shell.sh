#!/bin/sh
case "$1" in
  -lc|-c) shift; exec /bin/sh -c "$1" ;;
  -l|-i|-li|-il) exec /bin/sh -i ;;
  "") exec /bin/sh ;;
  *) exit 64 ;;
esac
