# Boots services.bht in a NixOS VM: the API and the web bundle answer on loopback,
# the database lives in the state dir, backups hold real rows, and another machine
# on the network cannot reach the port. bht-restore brings a snapshot back, refuses
# a missing or corrupt one without touching live data, and rolls back on its own
# when the restored database will not run.
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
    # Test-only: the server refuses to start on a database holding a vm_poison
    # table, standing in for a snapshot that passes integrity_check but will not run.
    systemd.services.bht.serviceConfig.ExecStartPre = pkgs.writeShellScript "bht-vm-poison" ''
      [ -z "$(${pkgs.sqlite}/bin/sqlite3 /var/lib/bht/bht.db \
        "SELECT name FROM sqlite_master WHERE name = 'vm_poison'")" ]
    '';
    environment.systemPackages = [
      pkgs.curl
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
  '';
}
