#!/bin/sh
set -eu
ENGINE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "${1:-serve}" in
  serve|worker) exec node "$ENGINE_DIR/src/boot.ts" "${1:-serve}" ;;
  *) exec "$@" ;;
esac
