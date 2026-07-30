#!/bin/sh
set -eu

# The starter library is 14 public-domain books, identical for every reader, and every new
# reader's database is a copy of it. Building it means fetching from Gutenberg and embedding
# ~3300 chunks, so it happens once onto the volume rather than at image build (where it would
# bloat the layer and go stale) or per signup (where it would be minutes of CPU each).
STARTER="${GURU_STARTER:-/app/data/starter.db}"

build_starter() {
  [ -f "$STARTER" ] && return 0
  echo "building the starter library at $STARTER (one time, ~20 minutes)…" >&2

  # A private path per container. Both roles share this volume, and when both built into one
  # `.building` file they interleaved writes and each deleted the other's write-ahead log ,
  # which is how the first deployment produced a zero-byte starter and cloned every reader an
  # empty library. Only `serve` builds now, but the unique name keeps that failure impossible
  # rather than merely unlikely.
  tmp="$STARTER.building.$$"
  rm -f "$tmp" "$tmp-wal" "$tmp-shm"
  GURU_DB="$tmp" node src/cli.ts starter

  # Fold the write-ahead log in before moving: the sidecars are not carried across, so a
  # database moved with a populated -wal arrives valid and missing every book. CommonJS
  # explicitly, because better-sqlite3 is CJS and `-e` must not inherit the package's ESM type.
  node --input-type=commonjs -e \
    "const D=require('better-sqlite3');const db=new D(process.argv[1]);db.pragma('wal_checkpoint(TRUNCATE)');db.close();" \
    "$tmp"

  # Refuse to publish an empty library rather than serving one that answers nothing.
  books=$(node --input-type=commonjs -e \
    "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});process.stdout.write(String(db.prepare('select count(*) n from books').get().n));" \
    "$tmp")
  if [ "$books" -lt 1 ]; then
    echo "starter build produced $books books; refusing to publish it" >&2
    rm -f "$tmp" "$tmp-wal" "$tmp-shm"
    exit 1
  fi

  mv "$tmp" "$STARTER"          # atomic within the volume
  rm -f "$tmp-wal" "$tmp-shm"
  echo "starter library ready: $books books" >&2
}

case "${1:-serve}" in
  serve)
    build_starter
    exec node src/server.ts
    ;;
  worker)
    # The worker never builds it. Two builders is the race described above, and the worker
    # has nothing to do until a library exists anyway.
    while [ ! -f "$STARTER" ]; do
      echo "waiting for the starter library…" >&2
      sleep 15
    done
    exec node src/cli.ts worker
    ;;
  *)
    exec "$@"
    ;;
esac
