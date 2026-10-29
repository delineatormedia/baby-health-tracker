# Deploying on NixOS (#8)

The flake ships a NixOS module, `services.bht`. It runs the server, which also
serves the web app, keeps the SQLite database in `/var/lib/bht`, and takes
hourly snapshots into `/var/backup/bht`. The server listens on `127.0.0.1:8787`
only and the module opens no firewall port. Phones reach it over Tailscale.

## First deploy, step by step

Follow these in order, on the family server and the two phones. Each step ends with a
check; don't go on until it passes. Steps 7 and 8 need the sign-in release (#5 step 3).

**Before you start:** a NixOS server whose configuration is a flake, a Tailscale account,
the Tailscale app signed in on both phones, and passkeys on both phones (iOS 16 or later,
Android 9 or later, with a screen lock).

1. **Turn on MagicDNS and HTTPS certificates** for the tailnet: admin console, DNS page.
   *Check:* both switches show enabled.

2. **Turn on Tailscale on the server.** In the server's NixOS configuration, set
   `services.tailscale.enable = true;`, then run
   `sudo nixos-rebuild switch --flake .#family-server` (this guide calls the
   configuration `family-server`; use yours).
   *Check:* `tailscale status` answers (before `tailscale up` it says `Logged out.`), not
   `failed to connect to local tailscaled`.

3. **Put the server on the tailnet and settle its name.** Run `sudo tailscale up`, then
   rename the machine in the admin console if you want a different name. Its HTTPS name
   is what both parents will open.
   *Check:* `tailscale status --json | nix run nixpkgs#jq -- -r .Self.DNSName` prints the name, like
   `family-server.tail1234.ts.net.` (with a trailing dot).

   > **Warning: this name is final.** Every passkey is bound to it. Renaming the machine,
   > renaming the tailnet or changing `origin` later makes both parents' passkeys stop
   > working, and each has to register again.

4. **Add the app to the server's flake.** Pin a release rather than following `main`:

   ```nix
   # flake.nix of the family server
   {
     inputs.bht.url = "github:delineatormedia/baby-health-tracker/<commit or tag>";

     outputs = { nixpkgs, bht, ... }: {
       nixosConfigurations.family-server = nixpkgs.lib.nixosSystem {
         system = "x86_64-linux";
         modules = [
           ./configuration.nix
           bht.nixosModules.default
           ./bht.nix
         ];
       };
     };
   }
   ```

   For `bht.nix`, copy [`nix/example-host.nix`](../nix/example-host.nix) and set
   `origin` to `https://` plus the name from step 3, without the trailing dot. CI builds a
   whole system from that file, so its options are known to work.
   *Check:* `nix flake check` on the server's flake passes. A wrong `origin`, or an `rpId`
   that doesn't fit it, fails here with a message saying which.

5. **Deploy.** `sudo nixos-rebuild switch --flake .#family-server`.
   *Check:*

   ```sh
   systemctl is-active bht.service bht-tailscale-serve.service bht-backup.timer
   curl -fsS http://127.0.0.1:8787/api/health
   tailscale serve status
   ```

   All three units say `active`, health answers `{"ok":true,…}`, and `tailscale serve status`
   shows `https://<name>` proxying to `http://127.0.0.1:8787`. If
   `bht-tailscale-serve` failed, `journalctl -u bht-tailscale-serve` says why: Tailscale
   not up yet (run `tailscale up`, then `sudo systemctl restart bht-tailscale-serve`), or a
   machine name that doesn't match `origin`. It publishes nothing until the name matches.

6. **Open it on a phone.** On the tailnet, open `https://<name>` in Safari or Chrome and
   add it to the Home Screen. The first load can take a few seconds while Tailscale gets
   the certificate.
   *Check:* the page loads over HTTPS with no certificate warning, and the app opens from
   the Home Screen icon.

7. **First parent: create the household.** In the app, set up the baby, then Settings →
   **Share with the other parent**, and save the passkey.
   *Check:* Settings shows the household and that it's synced. On the server:
   `sudo -u bht sqlite3 /var/lib/bht/bht.db 'SELECT COUNT(*) FROM households'` prints `1`.

8. **Second parent: join.** On the first phone, Settings → **Invite the other parent**
   shows a code. It works once, for 24 hours. On the second phone, open the URL, add it to
   the Home Screen, set up the baby, then Settings → **Join the other parent** and enter
   the code.
   *Check:* log a wet diaper on each phone. Each shows up on the other phone once it syncs (reopen the app if it hasn't).

   With `registration = "first"` (the default), nobody else on the tailnet can create a
   second household now. A third phone that tries **Share** is told to ask for an invite.

9. **Take a backup, and send it off the machine.**
   `sudo systemctl start bht-backup.service`.
   *Check:* `sudo ls /var/backup/bht` shows a `bht-<time>.db`, and
   `systemctl list-timers bht-backup.timer` shows the next run. Then point the machine's
   off-site backup (restic, borg, …) at `/var/backup/bht`; snapshots on the same disk do
   not survive a lost disk.

10. **Rehearse a restore, before the family relies on it.** Do this right after step 9,
    while nobody is logging:

    ```sh
    sudo systemctl start bht-backup.service
    sudo bht-restore "$(sudo ls /var/backup/bht | tail -n 1)"
    ```

    *Check:* it ends with the server healthy, both phones still sync (log one more
    wet diaper on each), and the counts match:
    `sudo -u bht sqlite3 /var/lib/bht/bht.db 'SELECT COUNT(*) FROM event_versions'` before
    and after. Then delete `/var/lib/bht/restore-*`.

    > **Restoring once the family uses it loses recent entries.** Phones don't re-send
    > what the server already accepted, so anything logged after the snapshot is gone
    > from the server and from the other phone. New entries can also be missed by a phone
    > until the server catches up with where that phone had read to. Restore only to
    > recover from a lost or corrupt database, and see "Restore" below.

**Upgrading** later: change the commit or tag in `inputs.bht.url`, run
`nix flake update bht`, then step 5 again with its check. Take a backup first
(step 9).

## Options

| Option | Default | |
| --- | --- | --- |
| `origin` | none, required | The `https://` URL parents open |
| `rpId` | the hostname of `origin` | WebAuthn relying-party ID; must be exactly `origin`'s host. Parent domains are not supported |
| `registration` | `first` | `first`: only the first household can register, everyone else joins by invite. `open`: any phone that reaches the server can create one |
| `tailscaleServe.enable` | `false` | Publish `origin` with `tailscale serve`, once the machine's Tailscale name matches it |
| `tailscaleServe.package` | `services.tailscale.package` | |
| `host`, `port` | `127.0.0.1`, `8787` | Keep `host` on loopback |
| `backup.enable` | `true` | |
| `backup.directory` | `/var/backup/bht` | |
| `backup.startAt` | `hourly` | systemd calendar expression |
| `backup.keep` | `168` | One week of hourly snapshots |

Without `tailscaleServe`, publish it by hand once; `tailscale serve` keeps the setting
across reboots:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status
```

Passkeys and the service worker both need HTTPS, so the plain `http://` LAN address will
not work for sign-in.

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

A restore puts the server back to the snapshot. Entries logged after it are lost (see
the warning in step 10), so restore only to recover a lost or corrupt database.

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
not move), it prints `ROLLBACK INCOMPLETE` and the step that failed, and leaves
the server and the backup timer stopped, with every file kept. Restarting then
could open the wrong database or create an empty one. If stopping the server is
what failed, the message says its state is unconfirmed.

What it prints next depends on how far the rollback got:

- **Nothing moved back yet.** The old set is still whole in
  `restore-<time>/previous/`, and the message lists the steps to finish by hand:
  stop `bht.service`, move anything at the live path into
  `restore-<time>/failed/`, move `bht.db` and its `-wal`/`-shm` from
  `previous/` back into `/var/lib/bht` together, then run
  `systemctl reset-failed bht.service` (failed starts can use up its start
  limit) and start `bht.service` and `bht-backup.timer`.
- **Anything else**, such as some files already moved back. The old set may be
  split between `previous/` and the live path, so the message gives no move steps. It prints an inventory of
  `bht.db`, `bht.db-wal` and `bht.db-shm` in `/var/lib/bht`, `previous/` and
  `failed/`, with each file's size and modification time. Don't move or delete
  anything yet: keep the server stopped, copy all of `/var/lib/bht` somewhere
  safe, then follow the next section.

Don't copy files into `/var/lib/bht` by hand. The `-wal` file belongs to its
database, so moving one without the other loses or corrupts recent writes.

### Reassembling a split set

Do this only after the inventory from `ROLLBACK INCOMPLETE` and a full copy of
`/var/lib/bht`. Read the inventory this way:

- Files at the live path and in `previous/` are all from the database you had
  before the restore. Together they make one set.
- Files in `failed/` are the snapshot that failed. Leave them where they are.

Then:

1. Check `systemctl is-active bht.service` says `inactive` or `failed`. If it
   doesn't, run `systemctl stop bht.service` and check again.
2. For each of `bht.db`, `bht.db-wal` and `bht.db-shm` in `previous/`,
   check the inventory shows `(none)` for the same name at the live
   path. If both places have a file with the same name, stop here: the two are
   different files and only one belongs to the set. Keep both and compare sizes
   and times against the inventory before choosing.
3. Move each one back without overwriting, `bht.db` first:
   `mv -n /var/lib/bht/restore-<time>/previous/bht.db /var/lib/bht/`, and so on.
   `ls -la /var/lib/bht/restore-<time>/previous/` should then be empty.
4. Check the set as the service user:
   `sudo -u bht sqlite3 /var/lib/bht/bht.db 'PRAGMA integrity_check'` should say `ok`.
5. `systemctl reset-failed bht.service`, then
   `systemctl start bht.service bht-backup.timer`, and check
   `curl -fsS http://127.0.0.1:8787/api/health` (use your `port` if you changed it).

Keep the copy from before step 2 until the server is running on the right data.

### Rolling back a restore

`bht-restore` prints the `restore-<time>` directory it used. To go back to
the database you had before, restore from its `previous/` copy:

```sh
sudo bht-restore /var/lib/bht/restore-20261029T130000Z/previous/bht.db
```

The `-wal` beside it comes along and is folded in. Once you are happy with the
result, delete the `restore-*` directories.
