#!/bin/sh
set -eu

# The starter library is 14 public-domain books, identical for every reader, and every new
# reader's database is a copy of it. Building it means fetching from Gutenberg and embedding
# ~3300 chunks, so it happens once onto the volume rather than at image build (where it would
# bloat the layer and go stale) or per signup (where it would be minutes of CPU each).
STARTER="${GURU_STARTER:-/app/data/starter.db}"

# Built under a temporary name and moved into place only on success. Writing directly to
# $STARTER means any interruption — a redeploy, an OOM, a lost network mid-fetch — leaves a
# partial database that every later boot sees as finished, and every reader is then cloned a
# library missing most of its books.
if [ ! -f "$STARTER" ]; then
  echo "building the starter library at $STARTER (one time, several minutes)…" >&2
  rm -f "$STARTER.building" "$STARTER.building-wal" "$STARTER.building-shm"
  GURU_DB="$STARTER.building" node src/cli.ts starter
  # Fold the write-ahead log in before moving. The sidecar files are not carried across, so
  # a database moved with a populated -wal arrives valid and missing every book.
  node -e "const D=(await import('better-sqlite3')).default; const db=new D(process.argv[1]); db.pragma('wal_checkpoint(TRUNCATE)'); db.close();" "$STARTER.building"
  mv "$STARTER.building" "$STARTER"
  rm -f "$STARTER.building-wal" "$STARTER.building-shm"
fi

case "${1:-serve}" in
  serve)  exec node src/server.ts ;;
  worker) exec node src/cli.ts worker ;;
  *)      exec "$@" ;;
esac
