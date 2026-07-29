#!/bin/sh
set -eu

# The starter library is 14 public-domain books, identical for every reader, and every new
# reader's database is a copy of it. Building it means fetching from Gutenberg and embedding
# ~3300 chunks, so it happens once onto the volume rather than at image build (where it would
# bloat the layer and go stale) or per signup (where it would be minutes of CPU each).
STARTER="${GURU_STARTER:-/app/data/starter.db}"

if [ ! -f "$STARTER" ]; then
  echo "building the starter library at $STARTER (one time, several minutes)…" >&2
  GURU_DB="$STARTER" node src/cli.ts starter
fi

case "${1:-serve}" in
  serve)  exec node src/server.ts ;;
  worker) exec node src/cli.ts worker ;;
  *)      exec "$@" ;;
esac
