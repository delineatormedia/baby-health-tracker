# Two-phone acceptance (#5, #17)

A guided pass on two real phones before the family relies on sync. Browser tests cover
the logic; they can't cover passkeys, Home Screen apps, airplane mode or a phone that
sleeps in a pocket. It takes about 25 minutes. Do the checks in order: each one starts
from where the last one ended.

**Phone A** is the owner's iPhone. **Phone B** is the second parent's phone. When a check
says *Expected*, the text in quotes is what the app shows, word for word. If the screen
says something else, that's a failure, even if it seems to mean the same thing.

Checks 8 and 9 need step 3b-2 (Count without, removing a phone). Skip them until it lands.

## Where to run it

There are two setups. Use the Mac rig first: it uses a test baby, and its database is
thrown away afterwards. Check 3 needs a baby whose birth time you choose, so the full pass
runs in one sitting only on the Mac rig. On the family server, run checks 1, 2 and 4–7
with the real baby after [DEPLOY.md](DEPLOY.md) step 6, and check 3 at the baby's next day
boundary.

**Both setups need:** both phones on the tailnet (Tailscale app on), passkeys on both
phones (iOS 16 or later, Android 9 or later, with a screen lock), and MagicDNS + HTTPS
certificates turned on for the tailnet (DEPLOY.md step 1).

### Mac rig (before the family server exists)

The Mac serves the production build through `bht-server` and `tailscale serve`, the same
way the family server does. The server also serves the web bundle, so `vite preview` isn't
needed. Run this from a checkout of the commit under test. Until #55 and #64 merge, that's
the `synth/sync-watermarks` branch.

```sh
nix develop                     # or Node 24 + pnpm 11.27.0
pnpm install --frozen-lockfile
pnpm build

MAC=$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')
echo "$MAC"                     # e.g. stephens-mac.tail1234.ts.net

BHT_RP_ID="$MAC" BHT_ORIGIN="https://$MAC" \
BHT_WEB_ROOT="$PWD/apps/web/build" DATABASE_PATH=/tmp/bht-acceptance.db \
node apps/server/dist/server.js
```

Leave that running. In a second terminal:

```sh
tailscale serve --bg 8787
```

If `tailscale` isn't on your PATH, use `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
The server prints `bht-server listening on http://127.0.0.1:8787` and
`serving the web bundle from …`. If it prints
`BHT_RP_ID and BHT_ORIGIN are not set: sign-in and sync are off`, stop and fix the
variables.

Afterwards: `tailscale serve --https=443 off`, stop the server, and
`rm /tmp/bht-acceptance.db*`. The passkeys you made are tied to the Mac's name. Delete
them on each phone (iPhone: Settings → Passwords, search for the Mac's name).

### Family server

Follow DEPLOY.md through step 6, then start at check 1 below. Checks 1 and 2 are the same
as DEPLOY.md steps 7 and 8. Skip check 1's step 3, and do check 3 the slow way described
there.

## Before you start (2 min)

- Note both phones' model and OS version. You'll need them for any report.
- On the Mac rig, work out the test baby's birth time: **yesterday, 15 minutes from now**,
  and write down three clock times. If it's 8:05 PM now:
  - **Birth time:** yesterday at 8:20 PM. The baby's first day of life ends at 8:20 PM
    today. Check 3 needs that.
  - **B silent by:** 8:17 PM, 3 minutes before the day ends.
  - **Readings at:** 8:21 PM, 1 minute after the day ends.
- Keep each phone in the **Home Screen app** for the whole pass, not in a Safari tab. On
  iPhone, the Home Screen app keeps its own logs, separate from Safari's, so a household
  set up in Safari isn't there when you open the icon.

## The checks

### 1. First parent signs up with a passkey (A, 3 min)

1. On A, open `https://<name>` in Safari. Tap Share → Add to Home Screen, then open the app
   from the icon.
2. Set up the baby. On the Mac rig, use a test name and the birth time you worked out above.
   Tap **Add <name>**.
3. Mac rig only: log a wet diaper and use the time row to set it to the birth time exactly
   (yesterday, same minute). Readings then counts logging as starting at birth, so the
   whole first day is judged in check 3.
4. Settings → **Share with the other parent**. Enter your name, tap **Create with a
   passkey**, and save the passkey when the phone asks.

*Expected:*
- While the passkey sheet is up, the button reads "Waiting for passkey…".
- Afterwards, Settings shows "Synced with your household." and the buttons **Invite the
  other parent** and **Sign out**, with "Signing out keeps this phone's logs here." below.
- Home's line under the legend reads "Synced".

### 2. Second parent joins by invite (A + B, 3 min)

1. On A, Settings → **Invite the other parent**.
2. On B, open the URL, add it to the Home Screen and open it from the icon. On the setup
   screen tap **Join the other parent ›**. Don't add a baby.
3. On B, enter the code from A and B's name, then tap **Join with a passkey** and save the
   passkey.

*Expected:*
- A shows "Code XXXXX XXXXX. Enter it on their phone under Join the other parent. Works
  once, until <day> <time>."
- B's join screen says "Make an invite code in Settings on the other parent's phone."
- After the passkey, B shows A's baby, by the same name. B's Settings shows "Synced with
  your household."

### 3. Readings waits for the other phone (A + B, 10 min, Mac rig only)

Readings judges a day of life only once the day is over and every other phone has
uploaded what it logged that day. The test baby's first day ends at the birth time you
wrote down. B goes silent before then, and A looks after.

1. **By your "B silent by" time**, on B, switch away from the app and back. Wait for
   Settings to read "Synced with your household.", then turn on airplane mode. B now
   stays silent: don't open the app on B until step 4. If it's already past your
   "B silent by" time, this check can't show waiting on this baby. Note that in your
   report, go on to check 4, and use the family-server variant below later.
2. While you wait, do check 4 on A. It ends with A online again.
3. **At your "Readings at" time or later**, on A, switch away from the app and back, wait
   for Home to read "Synced", then open Readings. Readings recomputes once a minute.
   *Expected:* the day-1 count checks (wet diapers, stools, feeds) read "Not assessed" with
   "Waiting for <B's name>’s phone (last synced <day> <time>)." The time is when B synced
   in step 1. The intake section ends with "Some logs from the other phones are not
   synced yet."
4. On B, turn airplane mode off, switch away from the app and back, and wait for Settings
   to read "Synced with your household." Then, on A, switch away from the app and back,
   wait for "Synced", and open Readings again.
   *Expected:* the "Waiting for" lines are gone. The day-1 checks now show a result or a
   different reason (with only the backdated wet diaper, "Not enough data"). Any result
   counts, since this is a test baby. The intake line about other phones can stay: it
   shows whenever B has been quiet since its last sync.

**On the family server**, use the real baby's day boundary instead: it's the time of day
the baby was born. Turn on airplane mode on B, after it reads "Synced with your
household.", before that time. After it, foreground A, wait for "Synced" and check
Readings, then bring B back as in step 4.

### 4. Reload from the Home Screen (A, 2 min)

Do this while check 3 waits for the day to end.

1. Force-quit the app on A (swipe it away), then open it from the Home Screen icon.
   *Expected:* the same entries, still signed in, and Home reads "Synced". After a reload,
   Readings waits until the app has pulled once.
2. Turn on airplane mode, force-quit and open it again.
   *Expected:* it still opens, offline, with every entry. Home reads "Saved on this phone ·
   sync paused". Turn airplane mode off afterwards, and go back to check 3.

### 5. Log on A, see it on B (2 min)

1. On A, log a wet diaper and wait for Home to read "Synced".
2. On B, switch to another app and back. The app syncs when you log something, when the
   phone comes back online, and when you return to the app. There is no timer, so an app
   left open on screen won't pick up A's entry by itself.
3. Do the same the other way: log a feed on B, wait for B's Home to read "Synced", then
   switch away from the app on A and back.

*Expected:* each entry shows on the other phone with the same time, and both Home lines
read "Synced".

### 6. Both offline, both log, both back (3 min)

1. Turn on airplane mode on both phones.
2. Log a dirty diaper on A and a wet diaper on B. Use the time row to give B's entry a
   time 10 minutes ago.
3. On both phones, Home reads "Saved on this phone · sync paused". Settings reads
   "Not synced: No connection to the server. Logs stay on this phone and retry on their own."
4. Turn airplane mode off on A and wait for Home to read "Synced". Then turn it off on B,
   switch away from the app and back, and wait for B's Home to read "Synced". Last, switch
   away from the app on A and back.

*Expected:* both phones list both entries, B's at the time you set, not the time it
synced. Both Home lines read "Synced".

### 7. Sign out mid-sync (B, 3 min)

1. **Offline sign-out is refused.** On B, turn on airplane mode, then Settings →
   **Sign out**. *Expected:* "No connection to the server. Try again." in red, and B is
   still signed in.
2. **Sign out with an entry that hasn't synced.** Still in airplane mode, log a wet diaper
   on B. Turn airplane mode off and tap **Sign out** right away, before Settings says
   "Synced with your household."
   *Expected:* Settings reads "Logs are saved on this phone only." and offers **Share with
   the other parent**, **Join the other parent** and **Sign in**. Home reads "Saved on this
   phone · not synced". The wet diaper is still on B. It may or may not be on A yet. Both
   are correct.
3. **Sign back in.** On B, Settings → **Sign in** → **Sign in with a passkey**.
   *Expected:* B shows "Synced with your household." again. Once it does, switch away from
   the app on A and back: A has the wet diaper from step 2, and neither phone shows it
   twice.

While B is signed out, A's Readings wait on B's last sync before the sign-out (check 3
shows waiting). Until 3b-2 lands, that is expected.

### 8. Count without the other phone (after 3b-2)

Repeat check 3 up to step 3 at a later day boundary, so A waits for B. On A, tap
**Count without <B's name>’s phone** on a waiting check.

*Expected:* the check is assessed. History lists the "Count without" entry, and Undo puts
the check back to waiting. When B comes back online and its entries for that day arrive,
the check is assessed again with them and reads "Updated: entries from <B's name>’s phone
arrived late". (Wording from the 3b plan, [SYNC_PLAN.md](SYNC_PLAN.md). Check it against
3b-2 when it lands.)

### 9. Signing out and removing a phone (after 3b-2)

1. **Sign-out stops the wait.** B signs out while online. *Expected:* A's checks for later
   days no longer wait for B.
2. **Remove a lost phone.** With B in airplane mode, remove B in A's Settings.
   *Expected:* days after the removal are assessed without B. Days before it still wait
   for B, or for a Count without.
3. **The removed phone comes back.** Turn airplane mode off on B, log an entry, and sign in
   again. *Expected:* B signs in as a new phone without any dead end. Its kept entries
   upload, and any day they land in on A reads "Updated: entries from <B's name>’s phone
   arrived late".

## What to send back

For each failed check, open a GitHub issue titled `Acceptance <check>.<step>: <what went
wrong>` (for example `Acceptance 6.4: B's entry missing on A`) with:

- **Phone**: A or B, model, OS version, and whether you were in the Home Screen app or a
  Safari tab.
- **Network**: airplane mode on or off, Wi-Fi or cellular, and whether the Tailscale app
  showed Connected.
- **What you did**, from the start of the check.
- **What the screen said**, word for word, and a screenshot. Include Settings' sync line,
  even if the problem is elsewhere.
- **When**, to the minute, with the time zone.
- **Server log** around that minute. On the Mac rig, copy it from the server's terminal.
  On the family server, run `journalctl -u bht --since "<time>"`.

If a check passed but something felt wrong, such as a slow sync, a confusing line or a
second passkey prompt, report it the same way, with "passed, but" in the title.
Never put the real baby's name or data in an issue; the repository is public.
