# Boots services.bht in a NixOS VM: the API and the web bundle answer on loopback,
# the database lives in the state dir, backups hold real rows, and another machine
# on the network cannot reach the port.
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
  '';
}
