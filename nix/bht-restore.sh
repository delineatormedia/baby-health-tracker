# bht-restore <snapshot>: replace the live database with a snapshot, keeping the old
# one. module.nix prepends BHT_DB, BHT_STATE_DIR, BHT_BACKUP_DIR, BHT_HEALTH_URL and
# BHT_STOP_UNITS / BHT_START_UNITS (the server plus, when backups are on, the timer).
#
# Nothing live is touched until the snapshot passes PRAGMA integrity_check in a
# staging copy. The old bht.db and its -wal/-shm are moved, never deleted, into
# restore-<time>/previous/. If the restored database fails to verify or the server
# does not come back, the old files go back automatically.

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
  for _ in $(seq 30); do
    if curl -fsS --max-time 2 "$BHT_HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "bht-restore: the server did not answer $BHT_HEALTH_URL within 30 s" >&2
  return 1
}

rollback() {
  echo "bht-restore: restore failed, putting the previous database back" >&2
  systemctl stop bht.service || true
  # Keep going past a failed step: the server must come back either way.
  ok=1
  # Before the snapshot is in place, files at $BHT_DB are still the old ones.
  if [ "$installed" -eq 1 ]; then
    mkdir -p -m 700 "$work/failed" || ok=0
    for f in "$BHT_DB" "$BHT_DB-wal" "$BHT_DB-shm"; do
      if [ -e "$f" ]; then mv -- "$f" "$work/failed/" || ok=0; fi
    done
  fi
  for f in "$work"/previous/*; do
    if [ -e "$f" ]; then mv -- "$f" "$BHT_STATE_DIR/" || ok=0; fi
  done
  # shellcheck disable=SC2086
  systemctl start $BHT_START_UNITS || ok=0
  if [ "$ok" -ne 1 ]; then
    die "ROLLBACK INCOMPLETE. Check $BHT_STATE_DIR by hand: the previous database is in $work/previous or already back, the attempted copy in $work/failed"
  fi
  die "rolled back; the live database is the one from before. Leftovers are in $work"
}

if ! install_snapshot; then rollback; fi
# shellcheck disable=SC2086
systemctl start $BHT_START_UNITS
echo "restored $src"
echo "the previous database is in $work/previous; delete $work once you are happy"
