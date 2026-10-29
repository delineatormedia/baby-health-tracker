# Baby Health Tracker (working name)

A self-hosted, local-first app for parents to log a baby's feedings, diapers,
pumping and weight, and to get evidence-based health signals from that log.
Your family's data stays on your own server.

Early development. See [docs/PRD.md](docs/PRD.md) for the product and
architecture brief.

Not medical advice. The app points out patterns worth raising with your
pediatrician. It does not diagnose.

## Development

Requires Node 24 and pnpm 11 (`nix develop` provides both).

```sh
pnpm install
pnpm check        # format, lint, typecheck, test, build
pnpm --filter @bht/server dev   # API on http://127.0.0.1:8787
pnpm --filter @bht/web dev      # PWA, proxies /api to the server
```

| Path                | What                                           |
| ------------------- | ---------------------------------------------- |
| `apps/web`          | SvelteKit PWA (static adapter, service worker) |
| `apps/server`       | Hono sync API on Node's built-in SQLite        |
| `apps/site`         | Static marketing page for Vercel               |
| `packages/schema`   | Event types, validation, unit conversion       |
| `packages/insights` | Rules engine and cited threshold tables        |

`nix build .#bht-server` and `nix build .#bht-web` produce the server and the
static web bundle.

## License

MIT
