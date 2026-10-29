# Sync and server plan (#5, #17, #8)

Mapped on main `b5c1347`, 2026-10-29. Planning only; no code here. Revised the
same day for the Adversarial reads of `9a16afe` and `b1829f5` and the PM's
calls on them.

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
  synced one. Clocks never outrank `version` or `seq`. Two unsynced versions
  with the same number are ordered by their canonical JSON, which includes the
  timestamps, and that order is provisional until the server's seq decides
  (`sync.ts:15–27`).
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
  `pending()` reads every pending row, for every baby (store.ts:93–100), and
  `events(babyId)` filters rows by baby *before* resolving versions
  (store.ts:46–51). Both matter once an event can change baby (step 2).
- `vite.config.ts:18` already proxies `/api` to the dev server on 8787.
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
PRD's and `sync.ts`'s: version wins, then seq, and clocks never outrank either.
The server uses `resolveCurrent`.

## Decisions (PM, 2026-10-29)

1. Rejected versions are never deleted on the phone (step 1).
2. `SCHEMA_VERSION` goes up on every schema change, starting in step 1 to cover
   the additions so far. A test fails if the schema's shape changes but the
   version does not.
3. A second phone that has its own baby is never refused, and its data is
   never dropped silently (step 2, below).
4. #17 is needed for v1 and lands with step 3, not after it (see "Step 3b").
5. Step 1 fixes the `events.ts` comment.
6. **A silent phone is never assumed complete.** While a household phone is
   behind, the windows it could still hold entries for read "Not assessed ·
   Waiting for Sam's phone (last synced …)". A parent can vouch with **Count
   without Sam's phone**, a reversible mark stored like "We missed some". A
   timeout or an offline sign-out never turns checks on. A sign-out barrier
   covers only what the phone uploaded, and removing a phone is an explicit
   parent action that counts as the vouch from `removedAt` on. Late or
   backdated uploads reopen assessment (step 3b). This replaces the 24-hour
   rule proposed at `9a16afe`.

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
- `GET /api/sync?after=&limit=&through=` returns the household's versions in
  seq order, with `next`, `more` and `through`:
  - Each page is read in one SQLite read transaction (WAL gives it a fixed
    snapshot).
  - The first page of a pull has no `through`. The server sets it to the
    household's highest seq in that snapshot and returns it.
  - Later pages pass the same `through` back and return only `seq <= through`,
    so a push that lands mid-pull cannot stretch the pull.
  - `more` is false once the page reaches `through`.
  - Step 3b attaches device watermarks to the first page's snapshot, so this
    contract is what makes them consistent with the data.
- Move `protocol.ts` types into `@bht/schema`, and point web at them.
- Web store:
  - `applyPushResults` keeps a rejected version as a row marked `rejected`,
    with its error. `pending()` skips it.
  - `EventStore` exposes a count of rejected versions that no later accepted
    version of the same event has replaced. Settings shows it ("N entries the
    server refused").
  - The IndexedDB version goes up to add the index.
  - Step 3b reads that count too: an unresolved rejection blocks the phone's
    watermark.
- `SCHEMA_VERSION` goes to 2 and covers every wire schema: `BabyEvent` and the
  protocol types that move into `@bht/schema` in this step. A test pins a
  fingerprint of them next to the version, so changing a schema without
  bumping the version, or the other way round, fails the test. The
  fingerprint covers:
  - shape, from valibot's introspection: types, keys, picklists, bounds, and
    every pipe action with its requirement;
  - refinements: each `v.check` contributes its message and its function's
    source text (`fn.toString()`). Editing a refinement's logic changes what
    the server accepts without changing a key, so it must change the
    fingerprint too. A whitespace-only edit also trips it; bumping costs
    nothing, so that is acceptable.
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
  - A pull with `limit=1` across several pages, with a push from another
    client landing between pages, stops at the first page's `through`. The
    next pull picks up the push.
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
  - **One atomic boundary.** Both choices are a single dedicated `EventStore`
    operation in one IndexedDB transaction: `moveBaby(from, to)` or
    `archiveBaby(from)`. `EditFields` does not take `babyId`, and it stays that
    way. The join is recorded (household prefs written) only after that
    transaction commits.
    - A reload before commit leaves nothing changed, and the join screen asks
      again.
    - A reload after commit but before the prefs write shows the join screen
      with 0 entries left to move, so running it again does nothing.
  - **Move, per event id.**
    - Resolve the current version across *all* rows of that id, not just the
      old baby's.
    - Write version `current + 1` with the new `babyId`. A tombstone stays a
      tombstone, and an edited entry moves its latest edit.
    - Mark every earlier row of that id `localOnly`. They are the phone's
      pre-join history: kept, never uploaded. The server would refuse them
      anyway, because the old baby id is not in the household.
  - **Archive:** every row of the old baby becomes `localOnly` with
    `archived: true`. History can show them under the archived baby, read-only.
  - **Upload eligibility:** `pending()` returns rows that are pending, not
    rejected and not `localOnly`.
  - **Current-version selection:** `events(babyId)` resolves each event id over
    all its rows first, then keeps the ids whose *current* version has that
    `babyId`. A moved entry can never resurface under the old baby from a stale
    row.
  - Only a phone that has never synced has local ids to move. A phone already
    in a household on the server signs out first (v1). Its synced events stay
    in that household, and its local copies are archived.
  - Tests:
    - both paths, the count shown, and nothing lost after a reload;
    - an edited entry moves its latest edit, and a tombstoned one stays
      deleted;
    - an interrupted migration (abort inside the transaction) changes nothing;
    - after a move, the old baby's view is empty and `pending()` holds only the
      new versions;
    - after an archive, `pending()` is empty;
    - a pushed batch never contains an old-baby or archived row.
- `authorId` stays the per-phone id and is recorded as a `devices` row for the
  member. Who logged an event is decided by the server stamping `member_id`
  from the session, not by trusting `authorId`.
- Tests: the full WebAuthn ceremony with a software authenticator fixture, an
  invite that is single-use and expires, and the cross-household isolation from
  step 1, now through real sessions.

#### As built (step 2)

Request and response bodies are valibot schemas in `@bht/schema` (`account.ts`),
covered by `SCHEMA_VERSION` 3.

| Route | Body | Answer |
|---|---|---|
| `POST /api/auth/register/options` | `{householdId, displayName, deviceId, baby}`, the phone's local ids | `{flowId, options}`; 409 if the household or baby id exists |
| `POST /api/auth/join/options` | `{code, displayName, deviceId}` | `{flowId, options}`; 404 for an unknown, used or expired code |
| `POST /api/auth/login/options` | `{deviceId}` | `{flowId, options}` for a discoverable passkey |
| `POST /api/auth/{register,join,login}/verify` | `{flowId, response}` | `{householdId, memberId}` and the session cookie; 401 if not verified |
| `POST /api/auth/logout` | none | revokes the session, clears the cookie |
| `GET /api/household` | signed in | `{id, members, babies}` |
| `POST /api/invites` | signed in | `{code, expiresAt}` |

- A flow (challenge) is single-use and lives 5 minutes. An invite is single-use
  and lives 24 hours; it is consumed in the same transaction that creates the
  member. A session lives 180 days and dies with sign-out or when its phone's
  `devices` row is removed. A removed phone cannot sign back in under the same
  device id.
- Invite codes and session tokens are stored as SHA-256 hashes.
- `deviceId` is the phone's `authorId`. A phone belongs to whoever last signed
  in on it.
- A push for a `babyId` outside the caller's household is `rejected` with
  `Unknown baby`. Every stored version records the pushing member
  (`event_versions.member_id`).
- `bht-server` reads `BHT_RP_ID` and `BHT_ORIGIN`. Without both, sign-in
  answers 503 and sync stays 401.

### Step 3: web sign-in and sync on (#5, part 3)

- Sign-in, create-household and join-with-code screens.
- Start `SyncClient` in `app.svelte.ts` and call `resume()` after sign-in.
- Replace "Saved on this phone · not synced" with the real status.
- While `status` is `offline`, Settings shows `SyncClient.error` (for example
  "Server rejected upload size" when a proxy caps uploads below ours), with a
  component test that renders it.
- Surface `onRejected`.
- Load the baby from the server.
- The Vite `/api` proxy already exists (`vite.config.ts:18`).
- Browser test: two Chrome profiles against one dev server, each logging and
  seeing the other's events.

### Step 3b: minimal #17, lands with step 3

Readings passes `syncedThrough: now` today
(`routes/readings/+page.svelte:35`). Once sync is on, that is false: another
phone may hold writes the server has not seen. A null value would make the
count checks go silent. This step makes `syncedThrough` true, and it merges
before or together with step 3, never after.

**What a watermark means.** Device D's watermark `W(D)` is a server time such
that every entry D *recorded* before `W(D)` is on the server. A phone's own
entries are already on that phone, so it only waits on the others.

#### Setting a watermark: an acknowledged write barrier

A batch that merely empties the queue proves nothing. A write made while the
request is in flight, or in another tab, would be covered by the server's
receipt time without being on the server. Instead:

1. **Write generation.** IndexedDB `meta` holds a counter `gen`. Every local
   write (log, edit, remove, undo, move) bumps it in the same transaction as
   the row. All tabs share one IndexedDB, so all tabs share the counter.
2. **Time bound.** Every sync response carries `serverNow`. Before a barrier,
   the client must already hold a `serverNow` value `s0` from a response it
   received earlier. That puts `s0` before the next step, in real time.
3. **Snapshot.** In one read transaction the client reads `G = gen` and the
   pending rows. Every write made before `s0` has `gen <= G` and is in this
   snapshot or already acknowledged.
4. **Push** the snapshot, in as many batches as it takes. A rejected version
   is kept and marked (step 1).
5. **Barrier.** When every version in the snapshot is acknowledged
   (accepted, duplicate or superseded), the client sends
   `POST /api/sync/barrier {deviceId, gen: G, at: s0}`. It sends nothing if:
   - any version in the snapshot is still unacknowledged (a timeout, a 409, a
     5xx); or
   - the phone holds an **unresolved rejected version** (step 1's count is
     above 0). A refused entry is an entry the other phones cannot see. It
     stays blocking until a later accepted version of the same event replaces
     it, or a parent vouches for the window (below).
6. **Server.** It sets `W(D) = max(W(D), min(at, now))` and stores `G`. It
   clamps to its own clock and never moves the watermark back, so a delayed
   or replayed barrier is harmless. The device's events were committed in
   earlier requests, so they are on disk before the barrier row is.

Writes after the snapshot have `gen > G` and happened after `s0`, so they are
outside the claim and wait for the next barrier. The watermark trusts the
signed-in device's own claim, as the household already trusts its entries.

#### Reading watermarks: bound to the pulled data

- The **first page** of a pull (step 1's `through` contract) also returns
  `serverNow` and the household's devices as
  `{deviceId, memberName, watermark, lastSeenAt, removedAt}`. All of it is read
  in the same SQLite snapshot as `through`.
- A barrier is written only after its events are committed. So if that
  snapshot shows `W(D)`, every entry it covers has `seq <= through`.
- The client keeps that device list as *pending* and adopts it in the same
  IndexedDB transaction that applies the page reaching `through`. Until then
  it keeps the previous list. An interrupted pull adopts nothing.
- A device with no barrier yet (a new device, or one that just joined with
  moved entries) has watermark null and holds back every window until its
  first barrier. That is normally seconds after it joins.

#### Readings

A window is assessed only if it is fully logged as today (`readings.ts:99–121`,
minus "We missed some" marks) **and**, for every other household device D,
either:

- the window ends at or before `W_local(D)`, the watermark on this phone's
  clock (next section); or
- a **Count without D** mark covers the part of the window after `W_local(D)`.

Otherwise the check reads **"Not assessed · Waiting for Sam's phone (last
synced Tue 9:14 PM)"**, with a **Count without Sam's phone** action.

#### Converting a watermark to this phone's clock

`W(D)` and `serverNow` are server-clock times. Windows are in this phone's
local clock. The conversion must only ever move the line **earlier**: a
conversion that moves it later can pass a window D has not uploaded yet.

A point estimate (`serverNow` minus the local clock when the response
*arrives*) does exactly that, because it counts the network delay as clock
offset. With synchronized clocks, a pull whose `serverNow` is 12:00 and whose
response arrives at 12:02 would move a 12:00 watermark to 12:02, and a window
ending 12:01 would pass while D still holds a write from 12:00:30.

**Contract (PM, 2026-10-29).** It bounds the offset from the instant the
request is *sent*, as NTP does.

1. **Sample.** Immediately before sending the first page request of a pull,
   the client reads `t_send = Date.now()` and `p_send = performance.now()`.
2. **Bound.** The first page carries `serverNow`. The server read it after
   the request left the phone, so with `θ` the true offset (server clock minus
   local clock), `serverNow >= t_send + θ`. Therefore
   `θ <= θ_max = serverNow − t_send`.
3. **Convert.** `W_local(D) = W(D) − θ_max`. Because `θ_max >= θ`, this is at
   or before the local instant that `W(D)` really names, however long the
   request or the response took. Delay only makes the line earlier, so checks
   wait longer; they are never wrong.
4. **Pagination.** The whole pull uses the first page's `t_send` and
   `serverNow`. The device list comes from the first page's snapshot
   ("Reading watermarks"), so later pages never refresh the sample, however
   slowly they arrive. The sample is adopted with the device list, in the same
   transaction as the page that reaches `through`.
5. **Clock jumps.** At every use, the client checks
   `|(Date.now() − t_send) − (performance.now() − p_send)| <= 2 s`. If the
   wall clock and the monotonic clock have drifted further apart (the user or
   the network changed the time, or the phone slept and the monotonic clock
   paused), the sample is discarded and every other device counts as **not
   synced**: its windows wait until the next pull takes a new sample.
6. **Reloads.** `performance.now()` restarts with each page load, so the
   sample lives in memory only. After a reload the adopted device list is
   kept for the "last synced" text, but windows wait until the next pull,
   which runs when the app opens.

Entry timestamps come from D's own clock. If D's clock is behind, an entry
logged just after `W(D)` can carry a time before it and land in a window that
already passed. That is a late, backdated entry, and the window reopens when it
arrives ("A returning phone", below). The watermark bound is about upload
state, not D's clock.

#### Count without Sam's phone

- It is a household event, `type: 'count_without'`,
  `data: {deviceId, start, end}`. Both are epoch ms on the tapping phone's
  clock, like every other entry time. `end` is the tap time. `start` is
  `W_local(D)` when the parent taps. It is `null` when D has no watermark yet
  or this phone holds no valid clock sample, and a `null` start covers every
  window that ends by `end`. This is a schema change, so
  `SCHEMA_VERSION` goes up and the server ships first.
- It is stored, synced, edited and removed like "We missed some": a
  reversible, explicit parent statement, with Undo, listed in History.
- It never hides data. Entries from D that arrive later and fall inside the
  span are counted, and the window is reassessed on arrival.

#### Idle, signed-out and removed phones

A timeout or an offline sign-out never turns checks on. A sign-out barrier
covers what the phone uploaded, and removal counts as a vouch from
`removedAt` on:

- **Idle.** No timeout. A silent phone holds its windows back, however long it
  is silent, until it syncs or a parent vouches.
- **Signing out** first runs a barrier. If it succeeds, `W(D)` is just before
  sign-out, D is marked signed out, and later windows do not wait for it. If
  the phone is offline, the sign-out is local only and D still holds windows
  back from its last watermark.
- **Other tabs during sign-out.** A write in another tab after the barrier's
  snapshot would have `gen > G`: it would sit behind a watermark that no longer
  advances, on a device the household has stopped waiting for. So sign-out
  quiesces first:
  1. One `readwrite` transaction on `meta` sets `signingOut = true`. Every
     local write already runs in a `readwrite` transaction that bumps `gen` in
     `meta`, so IndexedDB orders the two: a write that started first commits
     first and has `gen <= G`, and every later write sees the flag in its own
     transaction and aborts. The tab says "Signing out in another tab" and
     keeps the entry in its form. A `BroadcastChannel` message tells the
     other tabs to show this before anyone taps; the flag, not the message,
     is what guarantees it.
  2. The snapshot `G` is read after the flag commits, so it holds every
     write the phone will ever make as this device. Push and barrier as above.
  3. If the barrier succeeds, the session is cleared and every tab goes to
     sign-in. If it fails (offline) and the parent signs out anyway, the
     pending rows stay in IndexedDB, as for a returning phone. If the parent
     cancels, the flag is cleared and writing resumes.
- **Removing** a lost phone in Settings revokes its sessions and sets
  `removedAt`. Windows before `removedAt` that end after `W(D)` still wait for
  a vouch. Removal is itself an explicit parent action, so it counts as the
  vouch from `removedAt` on: windows after `removedAt` do not depend on D.
  Revoked sessions mean D can no longer upload as that device.
- **A returning phone** has to rejoin, and signs in as a new device. Its kept
  pending writes upload then. Entries backdated into windows that were already assessed or
  vouched reopen them: Readings recomputes, and the window says "Updated:
  entries from Sam's phone arrived late".

Removal is the one place where windows stop depending on a device without a
parent tapping "Count without". **PM call (accepted):** removal is the vouch
from `removedAt` on. Anything the phone recorded after `removedAt` arrives only
after it rejoins, as a late entry, and reopens the windows it touches (see
"A returning phone").

#### Tests

- **Delayed request:** a write lands after the snapshot while the batch is in
  flight. The barrier's `at` is before that write, and the next barrier covers
  it.
- **Another tab:** it writes between the snapshot and the barrier. Its row has
  `gen > G`, and the watermark does not cover it.
- **Rejected only:** the queue is empty but one rejected version remains. No
  barrier is sent, and Readings waits on that phone. A later accepted edit
  clears it.
- **Out of order:** a replayed or late barrier with an older `at` leaves
  `W(D)` where it is.
- **Pull race:** a push and its barrier land between page 1 and page 2. The
  device list from page 1 does not include that watermark, and nothing is
  adopted until the page at `through` is applied.
- **Pagination and interrupts:** `limit=1` over many pages, with an interrupt
  between pages, adopts no watermark.
- **New device:** watermark null holds every window back.
- **Two devices**, one with a pending write: `syncedThrough` stops at its
  watermark.
- **Silent phone:** after 48 h with entries still on it, windows stay "Waiting
  for Sam's phone".
- **Count without:** a vouch assesses the window, Undo restores waiting, and
  it syncs to the other phone.
- **Removal** while the phone holds entries: windows before `removedAt` still
  wait, windows after it are assessed, and the removed device's session is
  refused on push.
- **Remove, rejoin, late upload:** remove D, assess a window after
  `removedAt`, then rejoin D as a new device and upload an entry it logged in
  that window. The window reopens, says "Updated: entries from Sam's phone
  arrived late", and its result changes.
- **Late return:** backdated entries from the returning phone reopen an
  assessed window and change its result.
- **Delayed response:** clocks agree. `W(D)` and `serverNow` are 12:00, the
  request is sent at 12:00 and the response arrives at 12:02, and D holds an
  unsynced write from 12:00:30. A window ending 12:01 is not assessed. The
  same test against an arrival-time estimate must fail (control).
- **Delayed pagination:** page 1 is sent at 12:00 with `serverNow` 12:00, and
  page 2 arrives at 12:05. The bound still uses page 1's sample, and the
  12:01 window with D's pending 12:00:30 write still waits.
- **Clock skew:** this phone's clock is hours ahead or behind, with and
  without delay. `W_local(D)` is never after the true local instant of
  `W(D)`, and a window ending just after it is never assessed. A property
  test over random offsets and delays checks `W_local <= W − θ`.
- **Clock jump:** `Date.now()` jumps an hour between the pull and Readings
  while `performance.now()` moves a second. The sample is discarded and
  windows wait until the next pull. A 1 s jump keeps it.
- **Reload:** after a reload with no pull yet, windows wait; the "last synced"
  text still shows.
- **Count without, no watermark:** D's watermark is null. The mark is stored
  with `start: null`, covers every window ending by the tap, and Undo restores
  waiting.
- **Sign-out with another tab:** tab B starts a write before the flag and
  commits it; tab C tries one after it. B's write is in the snapshot and on
  the server before the barrier, and C's aborts with its form kept. Cancelling
  sign-out lets C write again.

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
3. Every change to a wire schema bumps `SCHEMA_VERSION`. That covers
   `BabyEvent` and the protocol types, and it includes refinements, not only
   keys. The fingerprint test from step 1 enforces it.
