# Sync and server plan (#5, #17, #8)

Mapped on main `b5c1347`, 2026-10-29. Planning only; no code here.

## What exists today

### Server (`apps/server`)

- `src/app.ts`: a Hono app with one route, `GET /api/health`, which returns
  `{ ok, schemaVersion, sqlite }`.
- `src/db.ts`: `openDatabase(path)` opens `node:sqlite` with WAL and foreign keys.
  There are no tables and no migrations.
- `src/main.ts`: serves on `HOST`/`PORT`, with the database at `DATABASE_PATH`.
- `src/app.test.ts`: a single health test.
- `flake.nix`: builds `bht-server` and `bht-web` as packages. There is no
  `nixosModules` output, no service, and no `tailscale serve`.

### Shared (`packages/schema`)

- `events.ts`: `BabyEvent` and `parseEvent()`. Every variant is a `strictObject`,
  so unknown keys are rejected.
- `sync.ts`: `compareVersions`, `resolveCurrent`, `resolveAll` and
  `assertSeqIntegrity`. This is the conflict rule from the PRD: highest
  `version` wins, then lowest server `seq`, and an unsynced version loses to a
  synced one. Clocks never decide.
- `model.ts`: `Household`, `Member` and `Baby` records. No type exists for
  credentials, invites, sessions or devices.

### Web sync client (`apps/web/src/lib/data`, from #13)

- `protocol.ts`: the proposed wire format. `POST /api/sync {events}` returns
  per-version `accepted | duplicate | superseded` with a `seq`, or `rejected`
  with an `error`. `GET /api/sync?after=&limit=` returns
  `{versions:[{seq,event}], next, more}`. The push batch limit is 500. The
  session is a same-origin HttpOnly cookie. Its header says it moves to
  `@bht/schema` once the server agrees.
- `sync.ts`: `SyncClient`. It pushes, then pulls, with single-flight runs,
  exponential backoff with jitter, and a pause on 401 until `resume()`.
- `store.ts`: `EventStore` over IndexedDB, keyed `id:version:seq|local`.
  `applyPushResults` **deletes rejected versions** (store.ts:103–131).
- **Not wired in:** `SyncClient` and `httpTransport` are only imported by tests.
  Home still says "Saved on this phone · not synced" (`routes/+page.svelte:122`).
- Identity is per phone: `Setup.svelte:17` mints the baby id and the
  `householdId` locally and stores them in localStorage (`ui/prefs.ts`).
  `authorId` is a random per-phone ULID (`prefs.ts:63`), not a member.

### Against #5's acceptance

| #5 asks for | State |
|---|---|
| SQLite schema: households, members, passkeys, invites, babies, events, sequence | none |
| `POST /sync` / `GET /sync?after=` | client side only |
| Conflict rule | done in `@bht/schema/sync.ts` (but see "Stale spec" below) |
| Passkey register/login, RP ID from config | none |
| Household creation, invite for second member | none |
| Every query scoped to the caller's household | none |
| Test: two clients converge | client tests against a fake transport only |
| Test: tombstones sync | same |
| Test: household A cannot read B | none |

## Does the server validate the current schema?

There is no event endpoint, so today the server neither accepts nor rejects
anything. Once it exists it should validate with `parseEvent` from
`@bht/schema`. Then `segments`, `pausedSeconds`/`pausedAt`, a stopped pump
(`durationSeconds` set, no volumes) and `missed_logs` are accepted by
construction, because the server is built from the same commit. Fields are
optional, so pre-timer events stay valid too.

The real risk is **version skew**: a client newer than the server.

- An example is a web dev server or a cached bundle that writes a new field
  while the deployed server's `strictObject` still rejects unknown keys.
- The server answers `rejected`, and `applyPushResults` deletes the version
  from the phone. That loses data silently. It is why "server first" matters.
- **Proposed rule (step 1):**
  - The push body carries `schemaVersion`.
  - A server older than the client answers `409 {upgrade: true}` for the whole
    batch, which the client keeps pending and retries later.
  - `rejected` is reserved for events that are invalid under the server's own
    schema version.
  - Schema changes stay additive (new fields optional), so a newer server
    always accepts older clients.

## Stale spec to fix

Issue #5 says "Last-writer-wins per event id by client timestamp". The
`events.ts` envelope comment also says "recordedAt decides last-writer-wins".
Both contradict the PRD and `sync.ts`, where version wins, then seq, and clocks
never decide. The server should use `resolveCurrent`. Step 1 corrects the
comment, and the issue text should be edited.

## Steps, in dependency order

### Step 1: event log and sync API (#5, part 1). Ready to start.

- Migrations: a `schema_migrations` table and a migration runner in `db.ts`.
- Tables:
  - `households`.
  - `event_versions`: `seq INTEGER PRIMARY KEY AUTOINCREMENT`, `household_id`,
    `event_id`, `version`, `baby_id`, `body` as canonical JSON,
    `received_at`, and `member_id` once step 2 lands.
  - `UNIQUE(event_id, version, body)`, so a resent version is idempotent.
- `POST /api/sync`:
  - Batch of at most 500, with a body-size cap.
  - Each version goes through `parseEvent`.
  - An identical body returns `duplicate` with its original seq.
  - A new body gets a new seq. It is `accepted`, or `superseded` when
    `resolveCurrent` over that event's versions does not pick it.
  - Invalid versions are `rejected` with the parse errors.
  - Applies the `schemaVersion` 409 rule above.
- `GET /api/sync?after=&limit=` returns the household's versions in seq order,
  with `next` and `more`.
- Move `protocol.ts` types into `@bht/schema`, and point web at them.
- Household scoping goes through one middleware that sets `c.var.householdId`.
  Until step 2 it only runs in tests (an injected session). No public route is
  unauthenticated in production: without auth configured, sync answers 401.
- Tests:
  - Accepts every event shape the web writes: feeds with segments, a paused
    running feed, running and stopped pumps, `missed_logs`, and edits plus
    tombstones.
  - Two `SyncClient`s over `app.request` converge on edits to the same event.
  - A tombstone syncs.
  - A duplicate push is idempotent.
  - A newer `schemaVersion` gets 409 and nothing is deleted.
  - Household A cannot pull B's versions or push into B's ids.
  - Ids are global ULIDs, so the server checks that an event id is not already
    owned by another household.

### Step 2: passkeys, households, invites, sessions (#5, part 2)

- Uses `@simplewebauthn/server`. The RP ID and origin come from config
  (`BHT_RP_ID`, `BHT_ORIGIN`).
- Tables: `members`, `credentials`, `invites` (single-use, expiring code),
  `sessions` (opaque token, HttpOnly + Secure + SameSite=Strict cookie),
  `babies` and `devices`.
- Registration: the first user creates the household. Its `householdId` and
  baby are **adopted from the phone's local ids**, so events logged before
  sign-in keep their `babyId`.
- Join by invite: the second phone gets the household's baby from
  `GET /api/household`.
  - A baby set up locally on that phone with events already logged needs a
    decision: re-key the local events to the household baby, or refuse to join.
    **PM call.**
- `authorId` stays the per-phone id and is recorded as a `devices` row for the
  member. Who logged an event is decided by the server stamping `member_id`
  from the session, not by trusting `authorId`.
- Tests: the full WebAuthn ceremony with a software authenticator fixture, an
  invite that is single-use and expires, and the cross-household isolation from
  step 1, now through real sessions.

### Step 3: web sign-in and sync on (#5, part 3)

- Sign-in, create-household and join-with-code screens.
- Start `SyncClient` in `app.svelte.ts` and call `resume()` after sign-in.
- Replace "Saved on this phone · not synced" with the real status.
- Surface `onRejected`.
- Load the baby from the server.
- A Vite dev proxy for `/api`.
- Browser test: two Chrome profiles against one dev server, each logging and
  seeing the other's events.

### Step 4: NixOS module (#8, part 1). Can start in parallel after step 1.

- Server: serve the `bht-web` bundle (static files, SPA fallback, `Cache-Control`
  for the service worker) from `BHT_WEB_ROOT`.
- `nixosModules.default` with `services.bht`:
  - `StateDirectory` for the SQLite file and a hardened systemd unit.
  - The RP ID and origin as options.
  - A backup timer that uses `sqlite3 .backup` (a copy taken during a WAL
    write is not a backup).
- Docs: `tailscale serve` setup, the warning that changing the hostname breaks
  every passkey, and backup and restore.
- A NixOS VM test in CI that boots the module, hits `/api/health` and serves
  `index.html`.

### Step 5: family-server deploy (#8, part 2)

- The owner deploys, and both parents register from their phones.
- This is #8's acceptance and needs steps 2–4.

### Step 6: per-device push watermark (#17, not v1)

- `devices.last_push_at`, updated on each successful push. Pull returns the
  household's watermarks.
- The client sets `syncedThrough` to the minimum over active devices.
- Open: the idle or lost device policy. One proposal is to ignore devices
  silent for more than N days, and to let a member remove a device.
- Depends on step 2 (devices) and step 3.

## Rule for tonight's schema changes

1. The schema change and the server change land in the same PR, or the server
   ships first.
2. New fields are optional.
3. Bump `SCHEMA_VERSION` when a new field or event type is added.
4. Until step 1 lands there is no server to break. The rule starts with step 1.
