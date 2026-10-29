# Deploying on NixOS (#8)

The flake ships a NixOS module, `services.bht`. It runs the server, which also
serves the web app, keeps the SQLite database in `/var/lib/bht`, and takes
hourly snapshots into `/var/backup/bht`. The server listens on `127.0.0.1:8787`
only and the module opens no firewall port. Phones reach it over Tailscale.

## Configure

```nix
# flake.nix of the family server
{
  inputs.bht.url = "github:delineatormedia/baby-health-tracker";

  outputs = { nixpkgs, bht, ... }: {
    nixosConfigurations.family-server = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        bht.nixosModules.default
        {
          services.bht = {
            enable = true;
            # This machine's Tailscale HTTPS name. Read the warning below first.
            origin = "https://family-server.tail1234.ts.net";
          };
        }
      ];
    };
  };
}
```

| Option | Default | |
| --- | --- | --- |
| `origin` | none, required | The `https://` URL parents open |
| `rpId` | the hostname of `origin` | WebAuthn relying-party ID |
| `host`, `port` | `127.0.0.1`, `8787` | Keep `host` on loopback |
| `backup.enable` | `true` | |
| `backup.directory` | `/var/backup/bht` | |
| `backup.startAt` | `hourly` | systemd calendar expression |
| `backup.keep` | `168` | One week of hourly snapshots |

## Publish over Tailscale

The tailnet needs MagicDNS and HTTPS certificates turned on (admin console,
DNS page). Then, once, on the server:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status
```

`tailscale serve` keeps this setting across reboots. Open the `https://…ts.net`
URL from a phone on the tailnet. Passkeys and the service worker both need
HTTPS, so the plain `http://` LAN address will not work for sign-in.

> **Warning: keep the hostname stable.** Every passkey is bound to `rpId`,
> which is the machine's Tailscale name. Renaming the machine, renaming the
> tailnet or changing `origin` makes every parent's passkey stop working, and
> each parent has to register again. Pick the name before the first sign-in.

## Backups

`bht-backup.service` runs on `backup.startAt`. It uses `sqlite3 .backup`,
SQLite's online backup, so a snapshot is consistent even while the server is
writing. Copying `bht.db` by hand is not a backup: recent writes may sit in
`bht.db-wal`. Each snapshot passes `PRAGMA integrity_check` before it gets its
final name, `bht-<UTC time>.db`, and only the newest `backup.keep` are kept.

The snapshots sit on the same disk as the database. Point the machine's
off-site backup (restic, borg, …) at `backup.directory`.

Take one now, and see when the next one runs:

```sh
sudo systemctl start bht-backup.service
journalctl -u bht-backup.service -n 5
systemctl list-timers bht-backup.timer
```

## Restore

Stop the server and remove the old write-ahead log **before** copying the
snapshot in. A leftover `-wal` from the old database would be replayed onto
the restored one.

```sh
sudo systemctl stop bht.service
sudo rm -f /var/lib/bht/bht.db-wal /var/lib/bht/bht.db-shm
sudo install -o bht -g bht -m 600 /var/backup/bht/bht-20261029T120000Z.db /var/lib/bht/bht.db
sudo systemctl start bht.service
curl -fsS http://127.0.0.1:8787/api/health
```
