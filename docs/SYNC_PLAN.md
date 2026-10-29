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
- **Rule (step 1):**
  - The push body carries `schemaVersion`.
  - A server older than the client answers `409 {upgrade: true}` for the whole
    batch, which the client keeps pending and retries later.
  - `rejected` is reserved for events that are invalid under the server's own
    schema version.
  - Schema changes stay additive (new fields optional), so a newer server
    always accepts older clients.
- **The phone never deletes a rejected version (PM, 2026-10-29).** Even with
  the 409 rule, a server bug alone could trigger the delete. Step 1 keeps the
  version, marks it rejected, leaves it out of uploads, and shows the count in
  Settings.

## Stale spec (fixed)

Issue #5 said "Last-writer-wins per event id by client timestamp". The PM has
posted the correction on #5. The `events.ts` envelope comment still says
"recordedAt decides last-writer-wins", and step 1 rewrites it. The rule is the
PRD's and `sync.ts`'s: version wins, then seq, and clocks never decide. The
server uses `resolveCurrent`.

## Decisions (PM, 2026-10-29)

1. Rejected versions are never deleted on the phone (step 1).
2. `SCHEMA_VERSION` goes up on every schema change, starting in step 1 to cover
   the additions so far. A test fails if the schema's shape changes but the
   version does not.
3. A second phone that has its own baby is never refused, and its data is
   never dropped silently (step 2, below).
4. #17 is needed for v1 and lands with step 3, not after it (see "Step 3b").
5. Step 1 fixes the `events.ts` comment.

## Steps, in dependency order

### Step 1: event log and sync API (#5, part 1). In progress.

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
- Web store: `applyPushResults` keeps a rejected version as a row marked
  `rejected` with its error, and `pending()` skips it. `EventStore` exposes a
  count, which Settings shows ("N entries the server refused"). The
  IndexedDB version goes up to add the index.
- `SCHEMA_VERSION` goes to 2. A test pins a fingerprint of the `BabyEvent`
  shape (types, keys, picklists and bounds, from valibot's introspection)
  next to the version, so changing the shape without bumping the version, or
  the other way round, fails the test.
- Fix the `events.ts` envelope comment.
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
  - A rejected version stays on the phone, is not uploaded again, and is
    counted. A later local edit of the same event is still uploaded.
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
  - If that phone already has its own baby with entries, the join screen says
    "This phone has N entries for <name>" and offers two choices. The join is
    never refused.
    - **Move them into <household baby>** (the default). Each local event is
      re-keyed to the household baby: a new version of the same event id with
      the new `babyId`, so the history stays append-only. Duplicates are
      cleaned up by a parent in History.
    - **Keep them off this household.** The local baby and its events are
      archived on the phone. Nothing is deleted, and nothing is uploaded.
  - Test both paths, plus the count shown and that nothing is lost after a
    reload.
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

### Step 3b: minimal #17, lands with step 3

Readings passes `syncedThrough: now` today
(`routes/readings/+page.svelte:35`). Once sync is on, that is false: the other
phone may hold writes the server has not seen. A null value would make the
count checks go silent. This step makes `syncedThrough` true, and it merges
before or together with step 3, never after.

- **Server watermark per device.** A push request carries `drained: true` when
  the batch is the device's last pending one (or an empty batch with nothing
  pending). The server then sets `devices.synced_at` to its own clock at that
  request. This means every write the device made before `synced_at` is on the
  server.
- **Pull returns** `serverNow` and the household's devices as
  `{deviceId, memberName, syncedAt, lastSeenAt}`.
- **Client:** `syncedThrough` is the minimum of:
  - its own pull time, when it has nothing pending;
  - every *counted* device's `syncedAt`.
  Server times are shifted by `serverNow` minus the local time, so a skewed
  phone clock does not move the line.
- **Proposed rule for idle and lost devices** (for the owner):
  - A device counts while it was last seen within **24 hours**. A phone left
    in a drawer overnight still holds Readings back, which is correct, because
    it may hold entries from the night.
  - After 24 hours of silence it stops counting, and Readings says so in one
    line: "Not waiting for Sam's phone (last synced Tue 9:14 PM)". The
    parent's fully-logged mark remains the vouch for that phone, as in v1
    today.
  - Signing out removes the device. Settings lists the household's devices
    with "Remove", for a lost phone.
  - A removed phone that comes back is a new device on its next sign-in. Its
    pending writes still upload, because nothing on the phone is deleted.
- Tests: two devices where one holds a pending write, so `syncedThrough` stops
  at its watermark; the 24 h cutoff and its Readings line; clock-skew
  correction; removal.

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

#17 is now step 3b, and it is needed for v1.

## Rule for schema changes

1. The schema change and the server change land in the same PR, or the server
   ships first.
2. New fields are optional.
3. Every schema change bumps `SCHEMA_VERSION`. The shape-fingerprint test from
   step 1 enforces it.
