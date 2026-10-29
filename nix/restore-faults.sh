# Fault injection for bht-restore.sh: real SQLite files, stand-in systemctl, runuser,
# chown, id, curl and sleep, and an mv that fails on the moves a case names. The VM
# test covers real systemd; this covers the failure paths it can't reach cheaply.
#
# usage: bash restore-faults.sh <path to bht-restore.sh>
set -euo pipefail

script=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
real_mv=$(command -v mv)
bash=$(command -v bash)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

stubs=$root/stubs
mkdir "$stubs"
for name in id chown runuser curl sleep systemctl mv; do
  cat >"$stubs/$name" <<EOF
#!$bash
REAL_MV=$real_mv
EOF
done
cat >>"$stubs/id" <<'EOF'
echo 0
EOF
cat >>"$stubs/chown" <<'EOF'
exit 0
EOF
cat >>"$stubs/runuser" <<'EOF'
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
EOF
cat >>"$stubs/sleep" <<'EOF'
exit 0
EOF
cat >>"$stubs/curl" <<'EOF'
echo "curl" >>"$CASE/calls"
[ -e "$CASE/active" ] || exit 7
case " $FAULTS " in *" health "*) exit 22 ;; esac
case " $FAULTS " in *" health-after-rollback "*) [ ! -d "$CASE/state/restore-"*/failed ] || exit 22 ;; esac
exit 0
EOF
# start bht.service opens the database like the server does: SQLite creates a
# missing file, so a start with nothing in place makes an empty live database.
cat >>"$stubs/systemctl" <<'EOF'
echo "systemctl $*" >>"$CASE/calls"
verb=$1
shift
n=$(grep -c "^systemctl $verb" "$CASE/calls")
case " $FAULTS " in *" $verb$n "*) exit 1 ;; esac
for unit in "$@"; do
  if [ "$unit" = bht.service ]; then
    if [ "$verb" = start ]; then
      sqlite3 "$BHT_DB" 'PRAGMA journal_mode=WAL' >/dev/null
      touch "$CASE/active"
    else
      rm -f "$CASE/active"
    fi
  fi
done
EOF
cat >>"$stubs/mv" <<'EOF'
src=$2
echo "mv $src" >>"$CASE/calls"
case " $FAULTS " in
  *" mv-previous-db "*) case $src in */previous/bht.db) exit 1 ;; esac ;;
esac
case " $FAULTS " in
  *" mv-quarantine "*) case $src in "$BHT_DB") [ ! -d "$(dirname "$BHT_DB")"/restore-*/failed ] || exit 1 ;; esac ;;
esac
exec "$REAL_MV" "$@"
EOF
chmod +x "$stubs"/*

failures=0
fail() {
  echo "  FAIL: $*"
  failures=$((failures + 1))
}

# run_case <name> <faults...>: live bht.db holds 7, the snapshot holds 42.
run_case() {
  CASE=$root/$1
  shift
  FAULTS="$*"
  mkdir -p "$CASE/state" "$CASE/backup"
  : >"$CASE/calls"
  sqlite3 "$CASE/state/bht.db" 'CREATE TABLE probe (n); INSERT INTO probe VALUES (7)'
  sqlite3 "$CASE/backup/snap.db" 'CREATE TABLE probe (n); INSERT INTO probe VALUES (42)'
  touch "$CASE/active"
  export CASE FAULTS
  export BHT_DB=$CASE/state/bht.db BHT_STATE_DIR=$CASE/state BHT_BACKUP_DIR=$CASE/backup
  export BHT_HEALTH_URL=http://bht.invalid/api/health
  export BHT_STOP_UNITS="bht-backup.timer bht-backup.service bht.service"
  export BHT_START_UNITS="bht.service bht-backup.timer"
  status=0
  out=$(PATH=$stubs:$PATH bash -euo pipefail "$script" snap.db 2>&1) || status=$?
  echo "case $(basename "$CASE") [$FAULTS] exit $status"
}

rows() { sqlite3 "$1" 'SELECT n FROM probe ORDER BY n' 2>&1 | tr '\n' ' '; }
says() { case $out in *"$1"*) ;; *) fail "output lacks '$1': $out" ;; esac; }
calls_after() { sed -n "/^$1\$/,\$p" "$CASE/calls" | tail -n +2; }
no_start_after() {
  if calls_after "$1" | grep -q '^systemctl start'; then
    fail "started a unit after '$1': $(calls_after "$1" | tr '\n' ';')"
  fi
}
prev() { echo "$BHT_STATE_DIR"/restore-*/previous; }

run_case ok
[ "$status" -eq 0 ] || fail "exit $status: $out"
[ "$(rows "$BHT_DB")" = "42 " ] || fail "live rows $(rows "$BHT_DB")"
[ "$(rows "$(prev)/bht.db")" = "7 " ] || fail "previous rows"

run_case stop-fails stop1
[ "$status" -ne 0 ] || fail "exit 0"
says "the live database is untouched"
grep -q '^mv' "$CASE/calls" && fail "moved files after a failed stop: $(tr '\n' ';' <"$CASE/calls")"
[ "$(rows "$BHT_DB")" = "7 " ] || fail "live rows $(rows "$BHT_DB")"
ls -d "$BHT_STATE_DIR"/restore-* >/dev/null 2>&1 && fail "left a restore dir"

run_case rollback-ok start1
[ "$status" -ne 0 ] || fail "exit 0"
says "rolled back"
[ "$(rows "$BHT_DB")" = "7 " ] || fail "live rows $(rows "$BHT_DB")"
calls_after "systemctl start bht.service bht-backup.timer" | grep -q '^curl$' || fail "no health poll after the rollback restart"

run_case rollback-health-fails start1 health-after-rollback
[ "$status" -ne 0 ] || fail "exit 0"
says "the previous database is back, but the server did not answer"
[ "$(rows "$BHT_DB")" = "7 " ] || fail "live rows $(rows "$BHT_DB")"

run_case rollback-stop-fails health stop2
[ "$status" -ne 0 ] || fail "exit 0"
says "ROLLBACK INCOMPLETE: could not stop bht.service"
says "To finish by hand"
no_start_after "systemctl stop bht.service"
calls_after "systemctl stop bht.service" | grep -q '^mv' && fail "moved files after the rollback stop failed"
[ "$(rows "$(prev)/bht.db")" = "7 " ] || fail "previous rows"

run_case quarantine-fails start1 mv-quarantine
[ "$status" -ne 0 ] || fail "exit 0"
says "ROLLBACK INCOMPLETE: could not move $BHT_DB out of the way"
no_start_after "systemctl stop bht.service"
grep -q "^mv .*/previous/" "$CASE/calls" && fail "moved previous files back over a live database"
[ "$(rows "$(prev)/bht.db")" = "7 " ] || fail "previous rows"
[ "$(rows "$BHT_DB")" = "42 " ] || fail "live rows $(rows "$BHT_DB")"

run_case move-back-fails start1 mv-previous-db
[ "$status" -ne 0 ] || fail "exit 0"
says "ROLLBACK INCOMPLETE: could not move $(prev)/bht.db back"
says "systemctl start bht.service bht-backup.timer"
no_start_after "systemctl stop bht.service"
[ -e "$BHT_DB" ] && fail "a database exists at the live path: $(rows "$BHT_DB")"
[ -e "$CASE/active" ] && fail "the server is running"
[ "$(rows "$(prev)/bht.db")" = "7 " ] || fail "previous rows"
[ "$(rows "$BHT_STATE_DIR"/restore-*/failed/bht.db)" = "42 " ] || fail "failed rows"

if [ "$failures" -ne 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "all restore fault cases pass"
