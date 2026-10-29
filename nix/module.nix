# services.bht: the sync server, serving the web bundle, with SQLite under
# /var/lib/bht and timed `sqlite3 .backup` snapshots. It listens on loopback only;
# reach it through `tailscale serve` (see docs/DEPLOY.md). It opens no firewall port.
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.bht;
  system = pkgs.stdenv.hostPlatform.system;
  stateDir = "/var/lib/bht";
  dbPath = "${stateDir}/bht.db";
  originHost = builtins.match "https://([^/:]+)(:[0-9]+)?" cfg.origin;
in
{
  options.services.bht = {
    enable = lib.mkEnableOption "the Baby Health Tracker server";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${system}.bht-server;
      defaultText = lib.literalExpression "bht.packages.\${system}.bht-server";
      description = "The server package.";
    };

    webPackage = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${system}.bht-web;
      defaultText = lib.literalExpression "bht.packages.\${system}.bht-web";
      description = "The built web bundle the server serves.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address to listen on. Keep it on loopback and publish it with `tailscale serve`.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8787;
      description = "Port to listen on.";
    };

    origin = lib.mkOption {
      type = lib.types.str;
      example = "https://bht.tail1234.ts.net";
      description = ''
        The HTTPS origin parents open, normally the machine's `tailscale serve` name.
        Passkeys are bound to its hostname: changing it later breaks every passkey.
      '';
    };

    rpId = lib.mkOption {
      type = lib.types.str;
      default = if originHost == null then "" else builtins.head originHost;
      defaultText = lib.literalMD "the hostname of `origin`";
      description = "The WebAuthn relying-party ID. Changing it breaks every passkey.";
    };

    backup = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to take timed snapshots of the database.";
      };

      directory = lib.mkOption {
        type = lib.types.str;
        default = "/var/backup/bht";
        description = "Where snapshots go. Point your off-machine backup at this directory.";
      };

      startAt = lib.mkOption {
        type = lib.types.str;
        default = "hourly";
        description = "When to take a snapshot, as a systemd calendar expression.";
      };

      keep = lib.mkOption {
        type = lib.types.ints.positive;
        default = 168;
        description = "How many snapshots to keep. The default is one week of hourly snapshots.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = originHost != null;
        message = "services.bht.origin must be an https:// origin with no path, like https://bht.tail1234.ts.net";
      }
    ];

    users.users.bht = {
      isSystemUser = true;
      group = "bht";
      home = stateDir;
    };
    users.groups.bht = { };

    systemd.services.bht = {
      description = "Baby Health Tracker server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = {
        NODE_ENV = "production";
        HOST = cfg.host;
        PORT = toString cfg.port;
        DATABASE_PATH = dbPath;
        BHT_WEB_ROOT = "${cfg.webPackage}";
        BHT_ORIGIN = cfg.origin;
        BHT_RP_ID = cfg.rpId;
      };
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        User = "bht";
        Group = "bht";
        StateDirectory = "bht";
        StateDirectoryMode = "0700";
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = 2;

        # Hardening. No MemoryDenyWriteExecute: V8's JIT needs writable code pages.
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        PrivateUsers = true;
        ProtectHostname = true;
        ProtectClock = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        RemoveIPC = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
      };
    };

    systemd.tmpfiles.settings.bht-backup = lib.mkIf cfg.backup.enable {
      ${cfg.backup.directory}.d = {
        user = "bht";
        group = "bht";
        mode = "0700";
      };
    };

    # `sqlite3 .backup` uses SQLite's online backup, so a snapshot is consistent even
    # while the server writes. Copying bht.db (and its -wal) by hand is not.
    systemd.services.bht-backup = lib.mkIf cfg.backup.enable {
      description = "Baby Health Tracker database snapshot";
      startAt = cfg.backup.startAt;
      path = [
        pkgs.sqlite
        pkgs.coreutils
        pkgs.findutils
      ];
      serviceConfig = {
        Type = "oneshot";
        User = "bht";
        Group = "bht";
        StateDirectory = "bht";
        StateDirectoryMode = "0700";
        UMask = "0077";
        ReadWritePaths = [ cfg.backup.directory ];
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        PrivateNetwork = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [ "AF_UNIX" ];
        SystemCallArchitectures = "native";
      };
      script = ''
        set -euo pipefail
        db=${lib.escapeShellArg dbPath}
        dir=${lib.escapeShellArg cfg.backup.directory}
        if [ ! -e "$db" ]; then
          echo "no database at $db yet, nothing to back up"
          exit 0
        fi
        stamp=$(date -u +%Y%m%dT%H%M%SZ)
        partial="$dir/.bht-$stamp.db.partial"
        rm -f "$partial"
        sqlite3 "$db" ".backup '$partial'"
        check=$(sqlite3 "$partial" 'PRAGMA integrity_check')
        if [ "$check" != ok ]; then
          echo "snapshot failed its integrity check: $check" >&2
          rm -f "$partial"
          exit 1
        fi
        mv "$partial" "$dir/bht-$stamp.db"
        echo "wrote $dir/bht-$stamp.db"
        # Names sort by time; drop all but the newest ${toString cfg.backup.keep}.
        find "$dir" -maxdepth 1 -name 'bht-*.db' -printf '%f\n' | sort -r \
          | tail -n +${toString (cfg.backup.keep + 1)} \
          | while read -r old; do rm -f -- "$dir/$old"; done
      '';
    };
  };
}
