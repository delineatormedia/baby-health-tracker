# bht-restore <snapshot>: replace the live database with a snapshot, keeping the old
# one. module.nix prepends BHT_DB, BHT_STATE_DIR, BHT_BACKUP_DIR, BHT_HEALTH_URL and
# BHT_STOP_UNITS / BHT_START_UNITS (the server plus, when backups are on, the timer).
#
# Nothing live is touched until the snapshot passes PRAGMA integrity_check in a
# staging copy. The old bht.db and its -wal/-shm are moved, never deleted, into
# restore-<time>/previous/. If the restored database fails to verify or the server
# does not come back, the old files go back automatically. Writers restart only once
# the whole old file set is back; if the rollback itself fails, the server and the
# backup timer stay stopped and the script prints how to finish by hand.

die() {
  echo "bht-restore: $*" >&2
  exit 1
}

as_bht() { runuser -u bht -- "$@"; }

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: bht-restore <snapshot>   (a path, or a file name in $BHT_BACKUP_DIR)" >&2
  exit 2
fi
[ "$(id -u)" -eq 0 ] || die "run it as root: sudo bht-restore $1"

src=$1
case $src in
  */*) ;;
  *) src=$BHT_BACKUP_DIR/$src ;;
esac
[ -f "$src" ] || die "no snapshot at $src; the live database is untouched"
[ -s "$src" ] || die "$src is empty; the live database is untouched"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$BHT_STATE_DIR/restore-$stamp
mkdir -m 700 "$work" || die "could not create $work; the live database is untouched"
staged=$work/staged.db

# Stage a copy. A -wal next to the source (a previous/ database from an earlier
# restore) comes along, and the checkpoint folds it into the staged file.
cp -- "$src" "$staged"
if [ -s "$src-wal" ]; then cp -- "$src-wal" "$staged-wal"; fi
chown -R bht:bht "$work"
chmod 600 "$staged"
check=$(as_bht sqlite3 "$staged" 'PRAGMA integrity_check' 2>&1) || true
if [ "$check" = ok ]; then
  # busy|log|checkpointed; 0 busy means every WAL frame is now in the file.
  folded=$(as_bht sqlite3 "$staged" 'PRAGMA wal_checkpoint(TRUNCATE)' 2>&1) || true
  case $folded in
    0\|*) ;;
    *) check="could not fold its write-ahead log: $folded" ;;
  esac
fi
if [ "$check" != ok ] || [ -s "$staged-wal" ]; then
  rm -rf -- "$work"
  die "$src failed its integrity check: ${check:-no output}. The live database is untouched"
fi
rm -f -- "$staged-wal" "$staged-shm"

echo "snapshot $src passed its integrity check"
echo "stopping $BHT_STOP_UNITS"
# shellcheck disable=SC2086 # unit lists are space-separated by design
systemctl stop $BHT_STOP_UNITS || {
  rm -rf -- "$work"
  # shellcheck disable=SC2086
  systemctl start $BHT_START_UNITS || true
  die "could not stop the server and backups; the live database is untouched"
}

installed=0
moved_back=0

# Polls /api/health for up to 30 s.
wait_healthy() {
  for _ in $(seq 30); do
    if curl -fsS --max-time 2 "$BHT_HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# Runs with the services stopped. Any failing step returns 1 and triggers rollback.
install_snapshot() {
  mkdir -m 700 "$work/previous" || return 1
  chown bht:bht "$work/previous" || return 1
  for f in "$BHT_DB" "$BHT_DB-wal" "$BHT_DB-shm"; do
    if [ -e "$f" ]; then mv -- "$f" "$work/previous/" || return 1; fi
  done
  mv -- "$staged" "$BHT_DB" || return 1
  installed=1
  [ "$(as_bht sqlite3 "$BHT_DB" 'PRAGMA integrity_check' 2>&1)" = ok ] || return 1
  systemctl start bht.service || return 1
  wait_healthy && return 0
  echo "bht-restore: the server did not answer $BHT_HEALTH_URL within 30 s" >&2
  return 1
}

# A rollback that cannot finish leaves writers stopped and every file where it is.
# Restarting would let the server open, or create, the wrong database.
# stranded <what failed> [unconfirmed]: the second argument means stopping
# bht.service itself failed, so its state is not known.
stranded() {
  {
    echo "bht-restore: ROLLBACK INCOMPLETE: $1"
    if [ "${2:-}" = unconfirmed ]; then
      echo "The backup timer is stopped. The server's state is unconfirmed: stopping it failed."
    else
      echo "The server and the backup timer are stopped."
    fi
    echo "No file was deleted."
    if [ "$installed" -eq 1 ] && [ "$moved_back" -eq 0 ]; then
      # The old set is still whole in previous/, so the moves below are safe.
      echo "At the live path now:"
      ls -la -- "$BHT_DB" "$BHT_DB-wal" "$BHT_DB-shm" 2>/dev/null || true
      echo "The database from before the restore: $work/previous/"
      echo "The snapshot that failed: $work/failed/ (or still at the live path)"
      echo "To finish by hand:"
      echo "  1. systemctl stop bht.service, and check systemctl is-active bht.service says inactive or failed"
      echo "  2. move anything left at $BHT_DB, $BHT_DB-wal and $BHT_DB-shm into $work/failed/"
      echo "  3. move bht.db, bht.db-wal and bht.db-shm from $work/previous/ into $BHT_STATE_DIR/, all together"
      echo "  4. systemctl reset-failed bht.service, then systemctl start $BHT_START_UNITS"
    else
      # The old set is split between previous/ and the live path. Any move recipe
      # written in advance could split it further, so only report where things are.
      echo "The database from before the restore may be split across locations. Where each file is:"
      for dir in "$BHT_STATE_DIR" "$work/previous" "$work/failed"; do
        for name in bht.db bht.db-wal bht.db-shm; do
          f=$dir/$name
          if [ -e "$f" ]; then
            echo "  $f  $(wc -c <"$f" | tr -d ' ') bytes, modified $(date -u -r "$f" +%Y-%m-%dT%H:%M:%SZ)"
          else
            echo "  $f  (none)"
          fi
        done
      done
      echo "Do not move or delete anything. Keep bht.service stopped (systemctl is-active bht.service"
      echo "must say inactive or failed), copy all of $BHT_STATE_DIR somewhere safe, and see"
      echo "\"Reassembling a split set\" in docs/DEPLOY.md."
    fi
  } >&2
  exit 1
}

rollback() {
  echo "bht-restore: restore failed, putting the previous database back" >&2
  systemctl stop bht.service || stranded "could not stop bht.service, so nothing was moved back" unconfirmed
  # Before the snapshot is in place, files at $BHT_DB are still the old ones.
  if [ "$installed" -eq 1 ]; then
    mkdir -m 700 "$work/failed" || stranded "could not create $work/failed"
    for f in "$BHT_DB" "$BHT_DB-wal" "$BHT_DB-shm"; do
      if [ -e "$f" ]; then
        mv -- "$f" "$work/failed/" || stranded "could not move $f out of the way"
      fi
    done
  fi
  # The database goes first: a -wal back at the live path without it is worse than none.
  for name in bht.db bht.db-wal bht.db-shm; do
    f=$work/previous/$name
    [ -e "$f" ] || continue
    [ ! -e "$BHT_STATE_DIR/$name" ] || stranded "$BHT_STATE_DIR/$name is in the way"
    mv -- "$f" "$BHT_STATE_DIR/" || stranded "could not move $f back"
    moved_back=1
  done
  # The failed start may have used up the unit's start limit.
  systemctl reset-failed bht.service || true
  # shellcheck disable=SC2086
  systemctl start $BHT_START_UNITS || die "the previous database is back, but $BHT_START_UNITS did not start. See journalctl -u bht.service. Leftovers are in $work"
  wait_healthy || die "the previous database is back, but the server did not answer $BHT_HEALTH_URL within 30 s. See journalctl -u bht.service. Leftovers are in $work"
  die "rolled back; the live database is the one from before. Leftovers are in $work"
}

if ! install_snapshot; then rollback; fi
# shellcheck disable=SC2086
systemctl start $BHT_START_UNITS || die "restored $src, but $BHT_START_UNITS did not all start"
echo "restored $src"
echo "the previous database is in $work/previous; delete $work once you are happy"
