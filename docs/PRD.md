# Baby Health Tracker: product and architecture brief

Working name. The project will be renamed when a real name turns up.

## Goal

A fast, self-hosted app that two parents use on their phones to log a baby's
feedings, diapers, pumping and weight, and that turns those logs into
evidence-based health signals ("talk to your pediatrician" flags, never a
diagnosis). The family owns the data.

First users: one family. Breaking changes are fine until that changes.
Long term: possibly a product, possibly with end-to-end encryption. v1 must not
close that door, but must not build for it either.

## Decisions (owner, 2026-10-29)

| Topic | Decision |
|---|---|
| Hosting | Self-hosted on the family NixOS server, reached over Tailscale |
| Repo | `delineatormedia`, public, MIT |
| Client | Progressive web app first; native iOS later on the same API |
| Marketing page | `apps/site`, deployed on Vercel |
| Units | Store mL. Every volume input lets the user pick mL or oz. Display follows a user setting: mL, oz, or both |
| Medical grounding | Every inference cites current (2026) clinical guidance |

## v1 features

**Household.** One household owns babies and events. Both parents are equal
members; each signs in on their own phone. Events record who logged them.
Joining is by invite from an existing member.

**Baby.** Name, birth date and time, sex. Birth weight is the first weight event.

**Events:**

- **Breastfeed:** start/stop timer, side (left, right, both), or manual duration.
- **Bottle:** contents (breast milk, formula), volume.
- **Diaper:** wet, dirty, or mixed. Dirty and mixed add stool color (swatch
  picker that includes the pale/clay/white red-flag colors), consistency, size
  (small, medium, large), and flags (blood, mucus, other).
- **Pump:** volume per side; whether it followed a feed directly.
- **Weight:** grams, source (clinic or home scale).
- **Weighted feed:** weight before and after a breastfeed; the difference
  approximates intake in mL.

Every event has a time that defaults to now and can be backdated, plus optional notes.

**Insights.** Computed from the log and the baby's age:

- Wet and dirty diaper counts against expected counts for the age
- Weight change against birth weight and growth standards
- Bottle intake against expected intake for age and weight
- Mismatches such as frequent breastfeeds with few wet diapers
- Stool-color red flags
- Measured intake: weighted breastfeeds shown as approximate, kept separate from
  bottle and pump volumes. Error bars wait for a measurement contract (scale,
  technique and a validated uncertainty model).
- A 24-hour "milk removed" total, shown only for days when every feed and pump
  was weighed or measured
- The weight trend, as the main sign that intake is adequate

The milk-supply estimate (intake plus post-feed pump residual) is out of v1 (owner
decision, 2026-10-29). The evidence is in
[CLINICAL_REFERENCE.md](CLINICAL_REFERENCE.md#milk-supply-estimate-evidence).

Each insight shows its source when the user asks "why?".

**Later:** a milk-supply estimate, sleep, temperature, medications and vitamin D, length and head
circumference, photos, the native iOS app (widgets, Live Activity feed timer),
and end-to-end encryption.

## Experience requirements

- One-handed use: primary actions in the bottom thumb zone, large targets.
- Logging the common events takes two taps or fewer.
- Undo instead of confirmation dialogs.
- Night mode that is dim and warm.
- Feels instant: no spinner between a tap and the logged event appearing.
- Calm, austere, solid. No security theater.

## Architecture

**Local-first.** The phone writes events to IndexedDB immediately and syncs in
the background. The UI never waits on the network.

**Insights run on the client.** The server stores and syncs. This keeps a
future encrypted-blob server possible without moving the insights.

**Event log.**

- Events are append-only records with client-generated ULIDs.
- An edit writes a new version of the same event id. A delete writes a
  tombstone.
- The server assigns a monotonically increasing sequence number. Clients pull
  everything after their last sequence and push their unsynced records.
- Conflicts on the same event id resolve last-writer-wins by client timestamp,
  with the server sequence as the tiebreak.

**Stack:**

- TypeScript throughout, pnpm workspace.
- Web: SvelteKit (static adapter) and a service worker.
- Server: Node, Hono, SQLite.
- Auth: passkeys (WebAuthn). The relying-party ID is the server's Tailscale
  HTTPS name (`tailscale serve`), so that hostname must stay stable or the
  passkeys break.
- Deploy: a NixOS module in the flake, the same pattern as Tally.

**Layout:**

```
apps/web            PWA
apps/server         sync API + SQLite
apps/site           marketing page (Vercel)
apps/ios            later
packages/schema     event types, validation, unit conversion
packages/insights   rules engine + cited threshold tables
nix/                flake, NixOS module
docs/               this brief, clinical reference
```

**Thresholds as data.** Clinical thresholds live in a versioned data file in
`packages/insights`. Every entry carries its citation. A native app can reuse
the file unchanged.

## Out of scope for v1

End-to-end encryption, multi-household hosting, accounts outside the family,
the native app, and medical-device regulatory work. Insights are framed as
"consider talking to your pediatrician", never as a diagnosis.
