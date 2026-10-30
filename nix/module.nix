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
  originHost = builtins.match "https://([^/:]+)(:([0-9]+))?" cfg.origin;
  originName = if originHost == null then "" else builtins.head originHost;
  # The port parents open: 443 unless origin names one.
  originPort =
    if originHost == null || builtins.elemAt originHost 2 == null then
      "443"
    else
      builtins.elemAt originHost 2;
  urlHost = if lib.hasInfix ":" cfg.host then "[${cfg.host}]" else cfg.host;
  # Turns off the HTTPS handler on origin's port only. `off` fails when there is none,
  # which is the state we want; any other failure is reported and fails the caller.
  withdrawServe = ''
    if ! out=$(tailscale serve --yes --https=${originPort} off 2>&1); then
      case "$out" in
        *"handler does not exist"*) ;;
        *)
          echo "Could not withdraw tailscale serve on port ${originPort}: $out" >&2
          exit 1
          ;;
      esac
    fi
  '';
  backupUnits = lib.optionals cfg.backup.enable [
    "bht-backup.timer"
    "bht-backup.service"
  ];

  # See docs/DEPLOY.md, "Restore".
  bht-restore = pkgs.writeShellApplication {
    name = "bht-restore";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
      pkgs.sqlite
      pkgs.util-linux
      config.systemd.package
    ];
    text = ''
      BHT_DB=${lib.escapeShellArg dbPath}
      BHT_STATE_DIR=${lib.escapeShellArg stateDir}
      BHT_BACKUP_DIR=${lib.escapeShellArg cfg.backup.directory}
      BHT_HEALTH_URL=${lib.escapeShellArg "http://${urlHost}:${toString cfg.port}/api/health"}
      BHT_STOP_UNITS=${lib.escapeShellArg (lib.concatStringsSep " " (backupUnits ++ [ "bht.service" ]))}
      BHT_START_UNITS=${
        lib.escapeShellArg (
          lib.concatStringsSep " " ([ "bht.service" ] ++ lib.optional cfg.backup.enable "bht-backup.timer")
        )
      }
    ''
    + builtins.readFile ./bht-restore.sh;
  };
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
      default = originName;
      defaultText = lib.literalMD "the hostname of `origin`";
      description = ''
        The WebAuthn relying-party ID. Must be exactly `origin`'s host: parent domains are
        not supported. Changing it breaks every passkey.
      '';
    };

    registration = lib.mkOption {
      type = lib.types.enum [
        "first"
        "open"
      ];
      default = "first";
      description = ''
        Who may create a household. `first` lets the first parent register one; after
        that, the other parent joins with an invite and no other device on the tailnet can
        start a household. `open` lets any phone that reaches the server register one.
      '';
    };

    tailscaleServe = {
      enable = lib.mkEnableOption ''
        publishing the server with `tailscale serve` at `origin`. At boot it waits for
        Tailscale, checks that this machine's Tailscale name is `origin`'s host, and only
        then serves HTTPS on `origin`'s port. A different name fails the unit and serves
        nothing, because passkeys are bound to the name, and withdraws this unit's handler
        if it published one before. Stopping the unit (or disabling this option) withdraws
        it too. It replaces any other `tailscale serve` handler on that port and leaves
        other ports alone
      '';

      package = lib.mkOption {
        type = lib.types.package;
        default = config.services.tailscale.package;
        defaultText = lib.literalExpression "config.services.tailscale.package";
        description = "The tailscale CLI to call.";
      };
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
      {
        # WebAuthn also allows a registrable parent domain, but telling one from a public
        # suffix (ts.net, net) needs the public suffix list. A tailnet household needs
        # only the exact host, so that is all this module accepts.
        assertion = cfg.rpId == originName;
        message = "services.bht.rpId (${cfg.rpId}) must be exactly the host of services.bht.origin (${originName}); this module supports no other RP ID";
      }
    ];

    warnings = lib.optional (cfg.tailscaleServe.enable && !config.services.tailscale.enable) ''
      services.bht.tailscaleServe needs Tailscale on this machine: set services.tailscale.enable.
    '';

    # sqlite3 for the checks in docs/DEPLOY.md.
    environment.systemPackages = [
      bht-restore
      pkgs.sqlite
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
        BHT_REGISTRATION = cfg.registration;
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

    # `tailscale serve --bg` keeps its config in tailscaled's state until turned off, so
    # this unit owns the handler on origin's port: it withdraws it on a name mismatch and
    # on stop, and never touches other ports. As root: the CLI needs tailscaled's socket.
    systemd.services.bht-tailscale-serve = lib.mkIf cfg.tailscaleServe.enable {
      description = "Publish the Baby Health Tracker at its origin with tailscale serve";
      wantedBy = [ "multi-user.target" ];
      wants = [
        "tailscaled.service"
        "bht.service"
      ];
      after = [
        "tailscaled.service"
        "bht.service"
      ];
      path = [
        cfg.tailscaleServe.package
        pkgs.jq
        pkgs.coreutils
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      # Stopping, or a rebuild that drops this unit, takes the proxy down with it.
      preStop = withdrawServe;
      script = ''
        set -euo pipefail
        want=${lib.escapeShellArg originName}
        # After boot tailscaled may still be connecting; give it two minutes.
        state=
        for _ in $(seq 60); do
          state=$(tailscale status --json 2>/dev/null | jq -r '.BackendState') || state=
          [ "$state" = Running ] && break
          sleep 2
        done
        if [ "$state" != Running ]; then
          echo "Tailscale is not up (state: ''${state:-unknown}). Run 'tailscale up', then 'systemctl restart bht-tailscale-serve'." >&2
          exit 1
        fi
        name=$(tailscale status --json | jq -r '.Self.DNSName')
        name=''${name%.}
        if [ "$name" != "$want" ]; then
          echo "This machine's Tailscale name is $name, but services.bht.origin is https://$want." >&2
          echo "Passkeys are bound to that name. Not publishing: fix origin or the machine's name." >&2
          # A handler from an earlier run under the old name or origin would keep serving.
          ${withdrawServe}
          exit 1
        fi
        tailscale serve --bg --https=${originPort} ${lib.escapeShellArg "http://${urlHost}:${toString cfg.port}"}
        echo "serving https://$want${lib.optionalString (originPort != "443") ":${originPort}"}"
      '';
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
        # A run killed mid-copy leaves its .partial (and SQLite's -journal) behind. Runs never
        # overlap (oneshot), so anything left over now is stale (#45).
        find "$dir" -maxdepth 1 -name '.bht-*.db.partial*' -printf 'removing stale %f\n' -delete
        stamp=$(date -u +%Y%m%dT%H%M%SZ)
        partial="$dir/.bht-$stamp.db.partial"
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
