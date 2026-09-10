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

BACKUP_ENV="${GURU_BACKUP_ENV:-$HOME/.guru-backup.env}"
[ -f "$BACKUP_ENV" ] && . "$BACKUP_ENV"
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
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cp "$SCRIPT_DIR/verify-snapshot.cjs" "$WORK/verify.cjs"

# NODE_PATH because require() resolves from the script's own directory, and the script is
# mounted at /r while better-sqlite3 lives in /app/node_modules.
docker run --rm --network none -v "$WORK:/r:ro" -e NODE_PATH=/app/node_modules "$IMAGE" node /r/verify.cjs
