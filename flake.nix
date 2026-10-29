{
  description = "Baby Health Tracker: self-hosted, local-first baby log (PWA + sync server)";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forAllSystems = lib.genAttrs systems;
      version = "0.0.0";

      # Only what the JS build reads, so docs or CI edits don't rebuild the packages.
      src = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./package.json
          ./pnpm-lock.yaml
          ./pnpm-workspace.yaml
          ./tsconfig.base.json
          ./apps
          ./packages
        ];
      };

      mkPackages =
        pkgs:
        let
          # pnpm must match packageManager in package.json exactly, or pnpm tries to fetch its own copy.
          pnpm = pkgs.pnpm_11;
          nodejs = pkgs.nodejs_24;

          # One store for the whole workspace, shared by every package below.
          pnpmDeps = pkgs.fetchPnpmDeps {
            pname = "baby-health-tracker";
            inherit version src pnpm;
            fetcherVersion = 5;
            # Changes whenever pnpm-lock.yaml does. Set lib.fakeHash, run nix build, copy the "got:" hash.
            hash = "sha256-hiFJjPigqLgtiJ+20a7NLlhiIgMLv9rayOO04yyM4WY=";
          };

          mkWorkspacePackage =
            {
              pname,
              filter,
              installPhase,
              nativeBuildInputs ? [ ],
              meta ? { },
            }:
            pkgs.stdenv.mkDerivation {
              inherit
                pname
                version
                src
                pnpmDeps
                installPhase
                meta
                ;
              nativeBuildInputs = [
                nodejs
                pnpm
                pkgs.pnpmConfigHook
              ]
              ++ nativeBuildInputs;
              buildPhase = ''
                runHook preBuild
                pnpm --filter ${filter} build
                runHook postBuild
              '';
            };
        in
        rec {
          # Static PWA bundle; serve it with any web server, falling back to index.html.
          bht-web = mkWorkspacePackage {
            pname = "bht-web";
            filter = "@bht/web";
            installPhase = ''
              runHook preInstall
              cp -r apps/web/build $out
              runHook postInstall
            '';
          };

          # Sync API: a single esbuild bundle (no runtime node_modules) run by Node 24.
          bht-server = mkWorkspacePackage {
            pname = "bht-server";
            filter = "@bht/server";
            nativeBuildInputs = [ pkgs.makeWrapper ];
            installPhase = ''
              runHook preInstall
              install -Dm644 apps/server/dist/server.js $out/lib/bht-server/server.js
              makeWrapper ${lib.getExe nodejs} $out/bin/bht-server \
                --add-flags $out/lib/bht-server/server.js
              runHook postInstall
            '';
            meta.mainProgram = "bht-server";
          };

          default = bht-server;
        };
    in
    {
      packages = forAllSystems (system: mkPackages nixpkgs.legacyPackages.${system});

      # services.bht; see docs/DEPLOY.md.
      nixosModules.default = import ./nix/module.nix { inherit self; };

      checks = forAllSystems (
        system:
        {
          inherit (self.packages.${system}) bht-web bht-server;
          restore-faults =
            nixpkgs.legacyPackages.${system}.runCommand "bht-restore-faults"
              { nativeBuildInputs = [ nixpkgs.legacyPackages.${system}.sqlite ]; }
              ''
                bash ${./nix/restore-faults.sh} ${./nix/bht-restore.sh}
                touch $out
              '';
        }
        # The VM test needs a Linux builder with KVM.
        // lib.optionalAttrs (lib.hasSuffix "-linux" system) {
          vm = import ./nix/vm-test.nix {
            inherit self;
            pkgs = nixpkgs.legacyPackages.${system};
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.pnpm_11
            ];
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
