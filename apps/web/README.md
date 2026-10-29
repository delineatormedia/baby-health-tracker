# @bht/web

The SvelteKit PWA. See the [root README](../../README.md) for setup and `pnpm check`.

## Browser checks

```sh
pnpm --filter @bht/web e2e
```

Runs `e2e/` in Chromium and WebKit against a fresh production build of this worktree. The
port is `E2E_PORT` in `e2e/port.ts`; set `BHT_E2E_PORT` to run two worktrees at once. The run
never reuses a server already on that port: if the port is taken, it stops with "already
used" instead of testing someone else's build.

## Test data (dev only)

To see the app full of data without touching a real family's log, start the dev server
and open it with a `seed` parameter:

```sh
pnpm --filter @bht/web dev
```

| URL                                           | Loads                                             |
| --------------------------------------------- | ------------------------------------------------- |
| `http://localhost:5173/?seed=empty`           | Nothing: first-run Setup                          |
| `http://localhost:5173/?seed=healthy-month`   | About 30 days of normal use, ending now           |
| `http://localhost:5173/?seed=incidents-month` | The same month with incidents that raise insights |

The app asks before it replaces anything. It then clears this browser's entries, baby and
sync cursor, keeps the display settings, and drops the parameter so a reload doesn't seed
again.

- **Fake baby.** Both months are for "Pip Testbaby", born a little over 30 days before the
  load. Nothing comes from real data.
- **Same every load.** Every value comes from a fixed seed relative to now, so a scenario
  loaded at the same time of day looks the same. Each load ends with a feed running on its
  second side, so the clock and Home always have something live.
- **Real write path.** Entries are written through `EventStore` with the clock set to when
  a parent would have logged them: timers started, switched, paused and stopped, details
  added after a diaper, night diapers logged the next morning, a few corrected amounts, an
  undone tap, and repeat-tap bursts. Two phones in the household log them.
- **Marked as test data.** Seeding sets `bht.seeded` in local storage, and a "Test data"
  strip shows at the top of every screen while it is set. Nothing in the app clears it, not
  even seeding `empty`; only clearing the site's data does. Sync must refuse any server but
  localhost while it is set (#55). Until then the seeded entries just wait as pending.
- **Dev builds only.** The seed module is imported only behind `import.meta.env.DEV`.
  `pnpm build` runs `scripts/no-dev-seed.mjs`, which fails if seed data reaches the
  production bundle.

### healthy-month

Feeds 9 to 11 times a day: mostly both breasts on the timer, some paused, one breast-milk
bottle a day from week 2, and a formula bottle on days 17 and 24. Wet and dirty diapers sit
at or above the newborn minimums, with stool colours changing from meconium to yellow. A
pump on the timer most days from day 11. Weight drops about 6.5% by day 4, is back to birth
weight by day 11, then gains about 32 g a day. There's a weighted feed at the day-8 visit.
Readings raises no flag on any day of the month.

### incidents-month

The same month, with these incidents. Days are days of life, as Readings shows them. "Last
full day" moves with the time of day you load at.

| Day                 | Incident                                    | Insight               |
| ------------------- | ------------------------------------------- | --------------------- |
| 4                   | 3030 g, 11.4% below birth weight            | `weight_loss`         |
| 11                  | 3110 g, down from 3160 g on day 8           | `weight_trend`        |
| 16                  | 3350 g, still below the 3420 g birth weight | `birth_weight_regain` |
| 12 days before last | Only 5 feeds                                | `feeds`               |
| 9 days before last  | A stool logged with blood                   | `blood_in_stool`      |
| 29                  | 320 g gained over weeks 0 to 4              | `weight_gain`         |
| 3 days before last  | A pale yellow stool                         | `pale_stool`          |
| Last full day       | Only 3 wet diapers                          | `wet_diapers`         |

On load, Readings shows `pale_stool`, `weight_gain` and `wet_diapers`. The others show in
History and Reports. `src/lib/dev/scenarios.test.ts` checks that each insight fires on its
day, that no other insight fires on any day, and that the healthy month never flags, for
loads at six times of day.

The app has no temperature entry yet, so neither month has a fever reading.
