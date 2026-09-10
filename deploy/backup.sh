#!/usr/bin/env bash
#
# Nightly snapshot of every reader's library.
#
# WHAT THIS PROTECTS AGAINST, and what it does not. A local snapshot covers the losses that
# actually happen: somebody types DELETE into the delete box, a deploy goes wrong, a file is
# corrupted, a reader's library is removed to force a re-clone. It does NOT cover the disk
# going away, because it lives on that disk. Off-site is the second half and is optional here
# only because it needs a bucket; set GURU_BACKUP_REMOTE and this starts using it.
#
# INSTALL (on the deploy box, one-time):
#   install -m755 backup.sh /home/deploy/backup-guru.sh
#   install -m644 snapshot.cjs verify-snapshot.cjs /home/deploy/
#   (crontab -l 2>/dev/null; echo '30 2 * * * /home/deploy/backup-guru.sh >> /home/deploy/backups/guru-backup.log 2>&1') | crontab -
#
# OFF-SITE (owner action, needs a bucket, ~$0.005/GB/mo at Backblaze B2):
#   curl https://rclone.org/install.sh | sudo bash
#   rclone config                      # create a remote, e.g. "b2"
#   echo 'GURU_BACKUP_REMOTE=b2:your-guru-backups' >> ~/.guru-backup.env
#
# pipefail so a failing sqlite step fails the script rather than writing a truncated .gz that
# looks like a backup until the day it is needed.
set -euo pipefail

BACKUP_ENV="${GURU_BACKUP_ENV:-$HOME/.guru-backup.env}"
[ -f "$BACKUP_ENV" ] && . "$BACKUP_ENV"

# The staging directory lives on the volume itself, so no volume name is needed here.
DIR="${GURU_BACKUP_DIR:-/home/deploy/backups}"
REMOTE="${GURU_BACKUP_REMOTE:-}"
KEEP_DAYS="${GURU_BACKUP_KEEP_DAYS:-7}"
OFFSITE_RETAIN_DAYS="${GURU_OFFSITE_RETAIN_DAYS:-30}"

mkdir -p "$DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/guru-$TS.tar.gz"
WORK=$(mktemp -d)

# `VACUUM INTO`, not `cp`. These databases run in WAL mode, so the .db file on its own is
# missing whatever is still in the -wal sidecar, and a plain copy of a live one restores as a
# library with books missing and no error to say so. VACUUM INTO takes a consistent snapshot
# of a database being written to, and compacts it on the way out.
#
# Run inside the RUNNING container rather than a throwaway one with the volume mounted
# read-only. A WAL database has to touch its -shm sidecar even to be read, so a read-only mount
# fails with SQLITE_CANTOPEN before it reads a byte. The serving container already has the
# volume open the ordinary way, and VACUUM INTO only ever writes to its destination, so this
# takes a consistent snapshot without touching what the app is using.
APP="${GURU_CONTAINER:-$(docker ps --filter name=guru- --format '{{.Names}}' | head -1)}"
[ -n "$APP" ] || { echo "$(date -u) FAIL: guru container not running, nothing to back up" >&2; exit 1; }
STAGE=/app/data/.backup-$TS
docker exec "$APP" mkdir -p "$STAGE"
# Always clear the staging directory, including when the snapshot fails half way, or the next
# run inherits a partial copy and the volume grows a hidden directory per failure.
trap 'rm -rf "$WORK"; docker exec "$APP" rm -rf "$STAGE" >/dev/null 2>&1 || true' EXIT

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
docker exec -i -e GURU_STAGE="$STAGE" "$APP" node < "$SCRIPT_DIR/snapshot.cjs"

docker cp "$APP:$STAGE/." "$WORK/"
tar -czf "$OUT" -C "$WORK" .
find "$DIR" -name 'guru-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
echo "$(date -u) backup ok: guru-$TS.tar.gz ($(du -h "$OUT" | cut -f1))"

# Off-site. Additive: without a remote the local snapshot above still ran, and the warning is
# the only difference, so a missing bucket never costs you the backup you did get.
if [ -n "$REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    if rclone copy "$OUT" "$REMOTE/" --no-traverse; then
      echo "$(date -u) off-site ok: $REMOTE/guru-$TS.tar.gz"
      rclone delete "$REMOTE/" --min-age "${OFFSITE_RETAIN_DAYS}d" --include 'guru-*.tar.gz' 2>/dev/null || true
    else
      echo "$(date -u) FAIL off-site copy for guru-$TS.tar.gz" >&2
      exit 1
    fi
  else
    echo "$(date -u) FAIL GURU_BACKUP_REMOTE is set but rclone is not installed" >&2
    exit 1
  fi
else
  echo "$(date -u) NOTE local only. This disk dying still loses everything. Set GURU_BACKUP_REMOTE." >&2
fi
