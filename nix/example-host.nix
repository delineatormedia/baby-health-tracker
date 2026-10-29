# What a family server adds to its NixOS configuration for the app (docs/DEPLOY.md, step 4).
# CI builds a whole system from it, so the options it uses keep evaluating.
{
  services.tailscale.enable = true;

  services.bht = {
    enable = true;
    # This machine's MagicDNS name with HTTPS on. Passkeys are bound to it: choose it before
    # anyone signs in, and never change it.
    origin = "https://family-server.tail1234.ts.net";
    # Publishes origin with `tailscale serve`, after checking the machine's Tailscale name.
    tailscaleServe.enable = true;
    # The defaults, spelled out: the first parent creates the household, the other joins by
    # invite; hourly snapshots in /var/backup/bht, a week of them kept.
    registration = "first";
    backup = {
      enable = true;
      directory = "/var/backup/bht";
      startAt = "hourly";
      keep = 168;
    };
  };
}
