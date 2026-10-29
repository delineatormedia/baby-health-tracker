# services.bht accepts only origin's exact host as rpId. Evaluates the module with each
# case and checks which ones trip the rpId assertion, without building anything.
{ lib, self, system, pkgs }:
let
  origin = "https://bht.example.ts.net:8443";
  rpIdFailures =
    extra:
    let
      inherit
        (lib.nixosSystem {
          inherit system;
          modules = [
            self.nixosModules.default
            {
              services.bht = {
                enable = true;
                inherit origin;
              }
              // extra;
              boot.loader.grub.devices = [ "nodev" ];
              fileSystems."/" = {
                device = "/dev/disk/by-label/nixos";
                fsType = "ext4";
              };
              system.stateVersion = lib.trivial.release;
            }
          ];
        })
        config
        ;
    in
    # Messages only of failed assertions: some (fileSystems) error when read while passing.
    builtins.filter (a: !a.assertion && lib.hasInfix "services.bht.rpId" a.message) config.assertions;
  accepts = name: extra: lib.assertMsg (rpIdFailures extra == [ ]) "rpId check: ${name} should pass";
  rejects =
    rpId: lib.assertMsg (rpIdFailures { inherit rpId; } != [ ]) "rpId check: rpId = \"${rpId}\" should fail";
  results = [
    (accepts "the default" { })
    (accepts "the exact host" { rpId = "bht.example.ts.net"; })
    (rejects "net")
    (rejects "ts.net")
    (rejects "example.ts.net")
    (rejects "other.example.ts.net")
    (rejects "bht.example.ts.net.evil.com")
  ];
in
assert lib.all lib.id results;
pkgs.runCommand "bht-rp-id-check" { } "touch $out"
