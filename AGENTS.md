# AGENTS.md

Instructions for AI agents (and humans) working in this repo. Read docs/PRD.md first.

## Commits and merges (owner decision, 2026-10-29)

- Agents commit under their own Buzz identity: the runtime default, signed with
  the agent's Nostr key. Do not override the author.
- Every commit message ends with the trailer
  `Co-authored-by: Stephen DeLorme <stephen@d.elor.me>`.
- PRs are squash-merged only. The repo allows nothing else. The squash message
  keeps the commit messages, so the trailers carry through to main. GitHub signs
  the squash commit, so main shows Verified.
- One PR per issue. Every PR gets a review before merge.

## Working in the repo

- Node 24 and pnpm 11.27.0 (`nix develop` provides both). The pnpm version must
  match nixpkgs `pnpm_11` exactly, or the Nix build tries to download pnpm.
- `pnpm check` runs format, lint, typecheck, test and build. Run it before you push.
- When `pnpm-lock.yaml` changes, the `fetchPnpmDeps` hash in `flake.nix` changes too.
  Set it to `lib.fakeHash`, then run `nix build .#bht-server` (or push and read
  the CI `nix` job) and copy the `got:` hash.
- New packages with install scripts must be listed under `allowBuilds` in
  `pnpm-workspace.yaml`. Keep `esbuild: false`: its postinstall breaks the CLI under pnpm.
- SvelteKit 3: there is no `svelte.config.js`. Config lives in the `sveltekit({...})`
  plugin in `apps/web/vite.config.ts`. The service worker has its own tsconfig.
- Shared packages (`packages/*`) export TypeScript source and have no build step.
- Never commit real baby data in fixtures, seeds or screenshots. The repo is public.
- Insights are "consider talking to your pediatrician", never a diagnosis, and every
  threshold cites its source.
