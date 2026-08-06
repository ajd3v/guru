#!/bin/sh
set -eu

# The starter library is the public-domain shelf in starter/library.json, identical for every
# reader, and every new
# reader's database is a copy of it. Building it means fetching from Gutenberg and embedding
# ~3300 chunks, so it happens once onto the volume rather than at image build (where it would
# bloat the layer and go stale) or per signup (where it would be minutes of CPU each).
STARTER="${GURU_STARTER:-/app/data/starter.db}"

# The manifest this starter was built from. Without it the build was keyed on the file merely
# existing, so growing starter/library.json from 14 books to 50 changed nothing on any box that
# had already built one: no error, no warning, just an old corpus for ever.
STAMP="$STARTER.manifest"
# The manifest AND the code that turns books into chunks. Hashing the book list alone meant a
# change to the extractor could not trigger a rebuild, so a fix to how pages or authors are
# read would never reach a box that already had a starter. Same bug, one layer down.
MANIFEST_HASH=$(cat starter/library.json ingest/ingest.py | sha256sum | cut -d' ' -f1)

build_starter() {
  if [ -f "$STARTER" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$MANIFEST_HASH" ]; then
    return 0
  fi
  if [ -f "$STARTER" ]; then
    echo "starter/library.json or the extractor changed since this starter was built; rebuilding" >&2
  fi
  echo "building the starter library at $STARTER ($(grep -c gutenberg starter/library.json) books, hours not minutes)…" >&2

  # A private path per container. Both roles share this volume, and when both built into one
  # `.building` file they interleaved writes and each deleted the other's write-ahead log ,
  # which is how the first deployment produced a zero-byte starter and cloned every reader an
  # empty library. Only `serve` builds now, but the unique name keeps that failure impossible
  # rather than merely unlikely.
  tmp="$STARTER.building.$$"
  # The name is unique per container, so a build that died left its partial database on the
  # volume for ever and the next one picked a different name rather than reusing it. Nothing
  # reads these, they are just tens of megabytes each accumulating behind a failed deploy.
  rm -f "$STARTER".building.*
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

  # A user's library is copied from the starter once and never again (store.ts only clones
  # when the file is absent), so growing the manifest reached nobody who already existed: the
  # shelf went from 50 books to 124 and every reader on the box kept reading the 50. Drop the
  # clones that are still pure starter and they are recopied on next use. A library holding
  # anything the reader uploaded is left alone, because that book exists nowhere else.
  node --input-type=commonjs -e "$(cat <<'JS'
const D = require('better-sqlite3'), fs = require('fs'), path = require('path');
const dir = process.env.GURU_USER_DIR || 'data/users';
if (!fs.existsSync(dir)) process.exit(0);
// `source` is a bare filename either way, so there is no path to test: a starter book is
// named after its manifest entry and an upload is named after what the reader sent. Anything
// the manifest cannot account for is theirs. A book dropped FROM the manifest therefore reads
// as the reader's and keeps the library, which is the safe direction to be wrong in.
const mine = new Set(JSON.parse(fs.readFileSync('starter/library.json', 'utf8'))
  .map(b => `${b.author} - ${b.title}.epub`));
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.db'))) {
  const p = path.join(dir, f);
  let own;
  try {
    const db = new D(p, { readonly: true });
    own = db.prepare('select source from books').all().filter(r => !mine.has(r.source));
    db.close();
  } catch (e) { continue; }   // unreadable or mid-write: leave it, it is not ours to delete
  if (own.length) { console.error(`keeping ${f}: ${own.length} book(s) not from the manifest`); continue; }
  for (const s of ['', '-wal', '-shm']) fs.rmSync(p + s, { force: true });
  console.error(`reset ${f} to the new starter`);
}
JS
)"
}

case "${1:-serve}" in
  serve)
    # Block only when there is nothing to serve. A starter that merely went stale is still a
    # working library, so growing starter/library.json rebuilds it in the background and the
    # old one keeps answering until the atomic mv swaps it. Blocking here meant every book
    # added to the manifest bought an outage the length of the whole rebuild: 50 books is
    # about 70 minutes, and at 124 it also overran the healthcheck's start window, so the
    # deploy went unhealthy and Traefik stopped routing to a container that was merely busy.
    if [ -f "$STARTER" ] && [ "$(cat "$STAMP" 2>/dev/null)" != "$MANIFEST_HASH" ]; then
      # ponytail: the child is reparented to node as PID 1 and left unreaped, which costs one
      # process-table entry until the container stops. An init shim is the fix if that ever
      # stops being true.
      build_starter &
    else
      build_starter
    fi
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
