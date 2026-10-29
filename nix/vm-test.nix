# Boots services.bht in a NixOS VM: the API and the web bundle answer on loopback,
# the database lives in the state dir, backups hold real rows, and another machine
# on the network cannot reach the port. bht-restore brings a snapshot back, refuses
# a missing or corrupt one without touching live data, rolls back on its own when
# the restored database will not run, and leaves writers stopped when the rollback
# itself fails. A backup SIGKILLed mid-copy leaves a .partial that bht-restore refuses
# and the next run removes. nix/restore-faults.sh injects the remaining failures.
#
# One boot per VM and the default 9p-shared store (no useNixStoreImage), so the
# erofs store-image initrd race and per-boot store.img leaks don't apply here.
{ pkgs, self }:
pkgs.testers.runNixOSTest {
  name = "bht";

  nodes.server = {
    imports = [ self.nixosModules.default ];
    services.bht = {
      enable = true;
      origin = "https://bht.example.ts.net";
      backup.keep = 2;
    };
    # Room for the killed-backup subtest's 128 MiB database, its WAL and the torn copy.
    virtualisation.diskSize = 2048;
    # Test-only, run as root ("+"): the server refuses to start on a database holding
    # a vm_poison table, standing in for a snapshot that passes integrity_check but
    # will not run. A vm_jam table also makes the old database immovable, so the
    # rollback itself fails.
    systemd.services.bht.serviceConfig.ExecStartPre = "+${pkgs.writeShellScript "bht-vm-poison" ''
      # sqlite3 runs as bht: as root it would create a root-owned bht.db (or -shm)
      # on first boot that the server then cannot open.
      has() {
        [ -n "$(${pkgs.util-linux}/bin/runuser -u bht -- ${pkgs.sqlite}/bin/sqlite3 /var/lib/bht/bht.db \
          "SELECT name FROM sqlite_master WHERE name = '$1'")" ]
      }
      if has vm_jam; then
        ${pkgs.e2fsprogs}/bin/chattr +i /var/lib/bht/restore-*/previous/bht.db
      fi
      ! has vm_poison
    ''}";
    environment.systemPackages = [
      pkgs.curl
      pkgs.e2fsprogs
      pkgs.sqlite
    ];
  };

  nodes.client = {
    environment.systemPackages = [ pkgs.curl ];
  };

  testScript = ''
    import json

    start_all()
    server.wait_for_unit("bht.service")
    server.wait_for_open_port(8787)

    with subtest("API answers"):
        health = json.loads(server.succeed("curl -fsS http://127.0.0.1:8787/api/health"))
        assert health["ok"] is True, health
        server.fail("curl -fsS http://127.0.0.1:8787/api/nope")

    with subtest("web bundle is served, with an SPA fallback"):
        page = server.succeed("curl -fsS http://127.0.0.1:8787/")
        assert "_app/immutable" in page, page[:400]
        route = server.succeed("curl -fsS http://127.0.0.1:8787/settings")
        assert route == page, "a client route should get index.html"
        server.succeed("curl -fsS http://127.0.0.1:8787/manifest.webmanifest")
        sw = server.succeed("curl -fsSI http://127.0.0.1:8787/service-worker.js").lower()
        assert "cache-control: no-cache" in sw, sw

    with subtest("passkey settings reach the server"):
        env = server.succeed("systemctl show -p Environment bht.service")
        assert "BHT_ORIGIN=https://bht.example.ts.net" in env, env
        assert "BHT_RP_ID=bht.example.ts.net" in env, env

    with subtest("database lives in the state dir, readable only by bht"):
        server.succeed("test -s /var/lib/bht/bht.db")
        server.succeed("stat -c '%U %a' /var/lib/bht | grep -Fx 'bht 700'")
        server.succeed("stat -c '%U %a' /var/backup/bht | grep -Fx 'bht 700'")

    with subtest("listens on loopback only"):
        server.succeed("ss -Hltn 'sport = :8787' | grep -F '127.0.0.1:8787'")
        server.fail("ss -Hltn 'sport = :8787' | grep -vF '127.0.0.1:8787'")
        client.wait_for_unit("multi-user.target")
        client.succeed("command -v curl && ping -c 1 -W 5 server")
        client.fail("curl -fsS --max-time 5 http://server:8787/api/health")

    with subtest("backups are consistent snapshots holding real rows"):
        server.succeed(
            "runuser -u bht -- sqlite3 /var/lib/bht/bht.db "
            "'CREATE TABLE vm_probe (n INTEGER); INSERT INTO vm_probe VALUES (42);'"
        )
        for _ in range(3):
            server.succeed("systemctl start bht-backup.service")
            server.succeed("sleep 1.1")
        snapshots = server.succeed("ls -1 /var/backup/bht").split()
        assert len(snapshots) == 2, f"keep = 2, found {snapshots}"
        assert all(s.startswith("bht-") and s.endswith(".db") for s in snapshots), snapshots
        newest = sorted(snapshots)[-1]
        server.succeed(f"sqlite3 /var/backup/bht/{newest} 'PRAGMA integrity_check' | grep -Fx ok")
        server.succeed(f"sqlite3 /var/backup/bht/{newest} 'SELECT n FROM vm_probe' | grep -Fx 42")
        server.succeed("systemctl list-timers bht-backup.timer | grep -F bht-backup.timer")

    with subtest("a backup killed mid-run leaves nothing a restore or the next run trips on"):
        # 128 MiB of filler keeps the copy and its integrity check running long enough
        # to SIGKILL the unit once its .partial exists.
        server.succeed(
            "runuser -u bht -- sqlite3 -cmd '.timeout 5000' /var/lib/bht/bht.db "
            "'CREATE TABLE vm_filler (b BLOB); "
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 128) "
            "INSERT INTO vm_filler SELECT randomblob(1048576) FROM n;'"
        )
        server.succeed(
            "systemctl start --no-block bht-backup.service; "
            "for _ in $(seq 3000); do "
            "  ls /var/backup/bht/.bht-*.db.partial >/dev/null 2>&1 && break; sleep 0.01; "
            "done; "
            "systemctl kill --signal=SIGKILL bht-backup.service"
        )
        server.wait_until_fails("systemctl is-active bht-backup.service")
        # The kill must have landed mid-run, or the rest of this subtest proves nothing.
        server.succeed("systemctl is-failed bht-backup.service")
        stale = server.succeed("ls /var/backup/bht/.bht-*.db.partial").strip()
        out = server.fail(f"bht-restore {stale} 2>&1")
        assert "unfinished backup" in out, out
        out = server.fail(f"bht-restore $(basename {stale}) 2>&1")
        assert "unfinished backup" in out, out

        server.succeed(
            "runuser -u bht -- sqlite3 -cmd '.timeout 5000' /var/lib/bht/bht.db "
            "'DROP TABLE vm_filler; VACUUM;'"
        )
        server.succeed("systemctl reset-failed bht-backup.service")
        server.succeed("systemctl start bht-backup.service")
        server.fail("ls -a /var/backup/bht | grep -F .partial")
        journal = server.succeed("journalctl -u bht-backup.service -o cat")
        assert f"removing stale {stale.split('/')[-1]}" in journal, journal
        snapshots = server.succeed("ls -1 /var/backup/bht").split()
        assert len(snapshots) == 2, f"keep = 2, found {snapshots}"
        newest = sorted(snapshots)[-1]
        server.succeed(f"sqlite3 /var/backup/bht/{newest} 'SELECT n FROM vm_probe' | grep -Fx 42")

    with subtest("the database survives a restart"):
        server.systemctl("restart bht.service")
        server.wait_for_open_port(8787)
        server.succeed("curl -fsS http://127.0.0.1:8787/api/health")
        server.succeed("runuser -u bht -- sqlite3 /var/lib/bht/bht.db 'SELECT n FROM vm_probe' | grep -Fx 42")
    def rows():
        return server.succeed(
            "runuser -u bht -- sqlite3 /var/lib/bht/bht.db 'SELECT n FROM vm_probe ORDER BY n'"
        ).split()

    def assert_untouched(before, pid):
        assert rows() == before, (rows(), before)
        assert server.succeed("systemctl show -p MainPID --value bht.service").strip() == pid
        server.succeed("systemctl is-active bht-backup.timer")
        server.fail("ls -d /var/lib/bht/restore-*")

    with subtest("bht-restore refuses a missing or corrupt snapshot, live data untouched"):
        server.succeed("runuser -u bht -- sqlite3 /var/lib/bht/bht.db 'INSERT INTO vm_probe VALUES (7)'")
        before = rows()
        pid = server.succeed("systemctl show -p MainPID --value bht.service").strip()
        out = server.fail("bht-restore bht-19990101T000000Z.db 2>&1")
        assert "untouched" in out, out
        assert_untouched(before, pid)
        server.succeed("head -c 8192 /dev/urandom > /root/corrupt.db")
        out = server.fail("bht-restore /root/corrupt.db 2>&1")
        assert "failed its integrity check" in out, out
        assert_untouched(before, pid)
        server.succeed("cp /var/backup/bht/$(ls /var/backup/bht | tail -n 1) /root/torn.db")
        server.succeed("truncate -s 2048 /root/torn.db")
        server.fail("bht-restore /root/torn.db")
        assert_untouched(before, pid)

    with subtest("bht-restore round trip brings back the snapshot and keeps the old db"):
        snapshot = sorted(server.succeed("ls -1 /var/backup/bht").split())[-1]
        server.succeed("runuser -u bht -- sqlite3 /var/lib/bht/bht.db 'INSERT INTO vm_probe VALUES (99)'")
        assert rows() == ["7", "42", "99"], rows()
        out = server.succeed(f"bht-restore {snapshot} 2>&1")
        assert "restored" in out, out
        assert rows() == ["42"], rows()
        server.succeed("curl -fsS http://127.0.0.1:8787/api/health")
        server.succeed("systemctl is-active bht.service bht-backup.timer")
        server.succeed("stat -c '%U %a' /var/lib/bht/bht.db | grep -Fx 'bht 600'")
        old = server.succeed("ls -d /var/lib/bht/restore-*/previous").strip()
        kept = server.succeed(f"sqlite3 {old}/bht.db 'SELECT n FROM vm_probe ORDER BY n'").split()
        assert kept == ["7", "42", "99"], kept
        server.succeed("rm -rf /var/lib/bht/restore-*")

    with subtest("bht-restore rolls back when the restored database will not run"):
        server.succeed("runuser -u bht -- sqlite3 /var/lib/bht/bht.db 'INSERT INTO vm_probe VALUES (5)'")
        server.succeed(
            "cp /var/backup/bht/$(ls /var/backup/bht | tail -n 1) /root/poison.db && "
            "sqlite3 /root/poison.db 'CREATE TABLE vm_poison (x)'"
        )
        before = rows()
        out = server.fail("bht-restore /root/poison.db 2>&1")
        assert "rolled back" in out, out
        assert rows() == before == ["5", "42"], (rows(), before)
        server.wait_for_open_port(8787)
        server.succeed("curl -fsS http://127.0.0.1:8787/api/health")
        server.succeed("systemctl is-active bht.service bht-backup.timer")
        server.succeed(
            "sqlite3 /var/lib/bht/restore-*/failed/bht.db "
            "\"SELECT name FROM sqlite_master WHERE name = 'vm_poison'\" | grep -Fx vm_poison"
        )
        server.succeed("rm -rf /var/lib/bht/restore-*")

    with subtest("a rollback that cannot finish leaves the server and timer stopped"):
        server.succeed(
            "cp /var/backup/bht/$(ls /var/backup/bht | tail -n 1) /root/jam.db && "
            "sqlite3 /root/jam.db 'CREATE TABLE vm_poison (x); CREATE TABLE vm_jam (x)'"
        )
        before = rows()
        out = server.fail("bht-restore /root/jam.db 2>&1")
        assert "ROLLBACK INCOMPLETE: could not move" in out, out
        assert "To finish by hand" in out, out
        server.fail("systemctl is-active bht.service")
        server.fail("systemctl is-active bht-backup.timer")
        server.fail("test -e /var/lib/bht/bht.db")
        work = server.succeed("ls -d /var/lib/bht/restore-*").strip()
        kept = server.succeed(f"sqlite3 {work}/previous/bht.db 'SELECT n FROM vm_probe ORDER BY n'").split()
        assert kept == before, (kept, before)
        server.succeed(f"sqlite3 {work}/failed/bht.db \"SELECT name FROM sqlite_master WHERE name = 'vm_jam'\"")
        # The printed steps finish the job once the cause is fixed.
        server.succeed(f"chattr -i {work}/previous/bht.db")
        server.succeed(f"mv {work}/previous/bht.db* /var/lib/bht/")
        server.succeed("systemctl reset-failed bht.service")
        server.succeed("systemctl start bht.service bht-backup.timer")
        server.wait_for_open_port(8787)
        server.succeed("curl -fsS http://127.0.0.1:8787/api/health")
        assert rows() == before, (rows(), before)
  '';
}
