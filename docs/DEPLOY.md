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

Use `bht-restore`. Give it a snapshot file name from `backup.directory`, or a
full path:

```sh
ls /var/backup/bht
sudo bht-restore bht-20261029T120000Z.db
```

It checks a staged copy of the snapshot with `PRAGMA integrity_check` before it
touches anything. A missing, empty or corrupt snapshot is refused, and the
live database and running services are left as they were. If the check passes,
it stops the server, the backup timer and any backup in progress. It then moves
the old `bht.db`, `bht.db-wal` and `bht.db-shm` together into
`/var/lib/bht/restore-<time>/previous/`; it never deletes them. Finally it
installs the snapshot, checks it again and restarts everything. If the server
does not answer `/api/health` within 30 s, or any step fails, the old files go
back automatically, the server and timer restart, and the command exits
non-zero. It checks `/api/health` again after a rollback.

If the rollback itself cannot finish (the server will not stop, or a file will
not move), it prints `ROLLBACK INCOMPLETE` and leaves the server and the backup
timer stopped, with every file kept. Restarting then could open the wrong
database or create an empty one. The message lists what is at the live path
and the steps to finish by hand: stop `bht.service`, move anything at the live
path into `restore-<time>/failed/`, move `bht.db` and its `-wal`/`-shm` from
`restore-<time>/previous/` back into `/var/lib/bht` together, then run
`systemctl reset-failed bht.service` (failed starts can use up its start
limit) and start `bht.service` and `bht-backup.timer`.

Don't copy files into `/var/lib/bht` by hand. The `-wal` file belongs to its
database, so moving one without the other loses or corrupts recent writes.

### Rolling back a restore

`bht-restore` prints the `restore-<time>` directory it used. To go back to
the database you had before, restore from its `previous/` copy:

```sh
sudo bht-restore /var/lib/bht/restore-20261029T130000Z/previous/bht.db
```

The `-wal` beside it comes along and is folded in. Once you are happy with the
result, delete the `restore-*` directories.
