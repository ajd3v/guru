#!/bin/sh
set -eu

# The starter library is 14 public-domain books, identical for every reader, and every new
# reader's database is a copy of it. Building it means fetching from Gutenberg and embedding
# ~3300 chunks, so it happens once onto the volume rather than at image build (where it would
# bloat the layer and go stale) or per signup (where it would be minutes of CPU each).
STARTER="${GURU_STARTER:-/app/data/starter.db}"

# The manifest this starter was built from. Without it the build was keyed on the file merely
# existing, so growing starter/library.json from 14 books to 50 changed nothing on any box that
# had already built one: no error, no warning, just an old corpus for ever.
STAMP="$STARTER.manifest"
MANIFEST_HASH=$(sha256sum starter/library.json | cut -d' ' -f1)

build_starter() {
  if [ -f "$STARTER" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$MANIFEST_HASH" ]; then
    return 0
  fi
  if [ -f "$STARTER" ]; then
    echo "starter/library.json changed since this starter was built; rebuilding" >&2
  fi
  echo "building the starter library at $STARTER (~70 minutes for 50 books)…" >&2

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
  # Stamped only after the move, so an interrupted build is retried rather than recorded done.
  printf '%s' "$MANIFEST_HASH" > "$STAMP"
  echo "starter library ready: $books books" >&2
}

case "${1:-serve}" in
  serve)
    build_starter
    exec node src/server.ts
    ;;
  worker)
    # The worker never builds it. Two builders is the race described above, and the worker
    # has nothing to do until a library exists anyway. It waits on the stamp rather than the
    # file, or it would start against a half-rebuilt starter after a manifest change.
    while [ ! -f "$STAMP" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$MANIFEST_HASH" ]; do
      echo "waiting for the starter library…" >&2
      sleep 15
    done
    exec node src/cli.ts worker
    ;;
  *)
    exec "$@"
    ;;
esac
