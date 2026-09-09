#!/usr/bin/env bash
#
# Restore the newest backup and prove it is a working library.
#
# A backup nobody has restored is a file, not a backup. This unpacks the latest archive into a
# throwaway directory, runs SQLite's own integrity check on every database in it, and counts
# what came back, so the failure is found on an ordinary Tuesday rather than on the day the
# volume is gone.
#
#   ./backup-verify.sh              # newest archive
#   ./backup-verify.sh /path/to.tar.gz
#
# Worth running monthly from cron alongside the backup itself.
set -euo pipefail

[ -f "$HOME/.guru-backup.env" ] && . "$HOME/.guru-backup.env"
DIR="${GURU_BACKUP_DIR:-/home/deploy/backups}"

ARCHIVE="${1:-$(ls -t "$DIR"/guru-*.tar.gz 2>/dev/null | head -1)}"
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || { echo "no backup archive found in $DIR" >&2; exit 1; }

APP="${GURU_CONTAINER:-$(docker ps --filter name=guru- --format '{{.Names}}' | head -1)}"
IMAGE=$(docker inspect "$APP" --format '{{.Config.Image}}' 2>/dev/null || echo "")
[ -n "$IMAGE" ] || { echo "guru image not found; is the app running?" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
echo "restoring $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1))"
tar -xzf "$ARCHIVE" -C "$WORK"

# The checker is written to a file rather than passed with -e, because it travels through ssh,
# sh and docker on the way in and every layer wants its own quoting. A file has none of that.
cat > "$WORK/verify.cjs" <<'JS'
const D = require("better-sqlite3"), fs = require("fs");
let bad = 0;
for (const f of fs.readdirSync("/r").filter((f) => f.endsWith(".db")).sort()) {
  // Copied out of the read-only mount first: opening a database sets journal mode, which is
  // a write, and the point here is to leave the archive untouched.
  fs.copyFileSync(`/r/${f}`, `/tmp/${f}`);
  const db = new D(`/tmp/${f}`);
  const integrity = db.pragma("integrity_check")[0].integrity_check;
  let detail = "";
  try {
    const books = db.prepare("select count(*) n from books").get().n;
    const chunks = db.prepare("select count(*) n from chunks").get().n;
    // A library that opens but whose text is gone would pass a row count, so read one.
    const sample = db.prepare("select text from chunks limit 1").get();
    detail = `${books} books, ${chunks} chunks, first chunk ${sample ? sample.text.length : 0} chars`;
    if (!books || !chunks || !sample) { detail += "  <-- EMPTY"; bad++; }
  } catch {
    detail = "no library tables (expected for the job queue)";
  }
  if (integrity !== "ok") bad++;
  console.log(`  ${f.padEnd(26)} integrity=${integrity}  ${detail}`);
  db.close();
}
console.log(bad ? `FAIL: ${bad} database(s) did not verify` : "RESTORE OK: every database opened and read back");
process.exit(bad ? 1 : 0);
JS

# NODE_PATH because require() resolves from the script's own directory, and the script is
# mounted at /r while better-sqlite3 lives in /app/node_modules.
docker run --rm -v "$WORK:/r:ro" -e NODE_PATH=/app/node_modules "$IMAGE" node /r/verify.cjs
