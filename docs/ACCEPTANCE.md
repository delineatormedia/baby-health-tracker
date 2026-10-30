# Two-phone acceptance (#5, #17)

A guided pass on two real phones before the family relies on sync. Browser tests cover
the logic; they can't cover passkeys, Home Screen apps, airplane mode or a phone that
sleeps in a pocket. It takes about 40 minutes. Do the checks in order: each one starts
from where the last one ended.

**Phone A** is the owner's iPhone. **Phone B** is the second parent's phone. When a check
says *Expected*, the text in quotes is what the app shows, word for word. If the screen
says something else, that's a failure, even if it seems to mean the same thing.

What each check needs on the commit under test:

- The "arrived late" lines in check 3 step 6 and check 8 step 5 need #78 (late uploads).
- Check 7 needs the sign-out barrier, and check 8 needs "Remove" in Settings. Both come in the
  sign-out and remove-phone PR into `synth/sync-vouch`. Their steps follow SYNC_PLAN step 3b,
  and the steps marked **(recheck)** use wording that has to be checked against that PR once it
  lands.
- Check 9 runs at the baby's next day boundary, after checks 7 and 8.
- Check 10 needs #74 (app updates).

Skip a check until what it needs is on the commit under test.

## Where to run it

There are two setups. Use the Mac rig first: it uses a test baby, and its database is
thrown away afterwards. Check 3 needs a baby whose birth time you choose, so the full pass
runs in one sitting only on the Mac rig, except check 9, which waits for the next day. On
the family server, run checks 1, 2 and 4–7 with the real baby after
[DEPLOY.md](DEPLOY.md) step 6, and checks 3 and 9 at the baby's next day boundaries. Check 8
logs a test entry into a past day and runs on the Mac rig only.

**Both setups need:** both phones on the tailnet (Tailscale app on), passkeys on both
phones (iOS 16 or later, Android 9 or later, with a screen lock), and MagicDNS + HTTPS
certificates turned on for the tailnet (DEPLOY.md step 1).

### Mac rig (before the family server exists)

The Mac serves the production build through `bht-server` and `tailscale serve`, the same
way the family server does. The server also serves the web bundle, so `vite preview` isn't
needed. Run this from a checkout of the commit under test. Until #55, #64 and #72 merge,
that's `synth/sync-vouch` with #78 and the sign-out and remove-phone PR merged into it.

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
  - **B's late diaper at:** yesterday at 9:20 PM, 1 hour into the first day. Check 8 needs it.
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

### 3. Readings waits for the other phone (A + B, 12 min, Mac rig only)

Readings judges a day of life only once the day is over and every other phone has
uploaded what it logged that day. The test baby's first day ends at the birth time you
wrote down. B goes silent before then, and A looks after.

1. **By your "B silent by" time**, on B, switch away from the app and back. Wait for
   Settings to read "Synced with your household.", then turn on airplane mode. Log a wet
   diaper on B right away, before the day ends. B now stays silent: don't open the app on
   B again until step 6. If it's already past your "B silent by" time, this check can't
   show waiting on this baby. Note that in your report, go on to check 4, and use the
   family-server variant below later.
2. While you wait, do check 4 on A. It ends with A online again.
3. **At your "Readings at" time or later**, on A, switch away from the app and back, wait
   for Home to read "Synced", then open Readings. Readings recomputes once a minute. Tap a
   check to open it.
   *Expected:* the day-1 count checks (Wet diapers, Stools, Feeds) read "Not assessed" with
   "Waiting for <B's name>’s phone (last synced <day> <time>)." The time is when B synced
   in step 1. Each has a **Count without <B's name>’s phone** button. The intake section
   ends with "Some logs from the other phones are not synced yet."
4. **Count without B.** On A, open Wet diapers and tap **Count without <B's name>’s phone**.
   *Expected:*
   - A toast reads "Counted without <B's name>’s phone · <time>" with Undo.
   - The day-1 count checks no longer wait. They show a result or a different reason (with
     only the backdated wet diaper, "Not enough data"). Each one, opened, reads "Counted
     without a phone that had not synced." with a **Wait for the phone** button.
   - History lists "Counted without a phone".
5. **Take it back, then count without again.** Tap **Wait for the phone**.
   *Expected:* the day-1 checks read "Not assessed" and "Waiting for <B's name>’s phone …"
   again, as in step 3. Tap **Count without <B's name>’s phone** again, so the checks are
   counted without B once more.
6. **B's diaper arrives late.** On B, turn airplane mode off, switch away from the app and
   back, and wait for Settings to read "Synced with your household." Then, on A, switch away
   from the app and back, wait for "Synced", and open Readings again.
   *Expected:*
   - Each day-1 count check, opened, reads "Updated: entries from <B's name>’s phone arrived
     late." B's wet diaper from step 1 is in A's History, once.
   - The checks were recomputed with B's diaper. On a test baby with this few logs, the
     result can stay "Not enough data". The "Updated" line is what this step checks.
   - B's own Readings has no "Updated" line: the diaper is B's own.
7. **Wait for B, now that it has synced.** On A, open Wet diapers and tap **Wait for the
   phone**.
   *Expected:* no "Waiting for" line comes back, because B has now uploaded day 1. The
   "Updated" line stays. The intake line about other phones can stay: it shows whenever B
   has been quiet since its last sync.

**On the family server**, use the real baby's day boundary instead: it's the time of day
the baby was born. Do steps 1, 3 and 6 without logging the wet diaper on B or tapping
Count without, so the real baby's log stays clean. Turn on airplane mode on B, after it
reads "Synced with your household.", before that time. After it, foreground A, wait for
"Synced" and check Readings for "Waiting for", then bring B back as in step 6.
*Expected* after B is back: the "Waiting for" lines are gone and there is no "Updated" line,
because nothing reached A late.

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

### 7. Sign out (B, 5 min)

Signing out first uploads everything on the phone (the sign-out barrier). If the phone can't
reach the server, the parent chooses: cancel and stay signed in, or sign out anyway and
keep the unsent entries on the phone. Button and message wording in this check is
**(recheck)** against the sign-out PR.

1. **Offline, then cancel.** On B, turn on airplane mode and log a wet diaper. Settings →
   **Sign out**.
   *Expected:* B doesn't sign out. It says it can't reach the server and offers **Sign out
   anyway** and **Cancel** **(recheck)**. Tap **Cancel**. B still reads "Not synced: No
   connection to the server. …" and shows **Sign out**. Log a dirty diaper: it saves, with
   no "Signing out" message.
2. **Offline, sign out anyway.** Still in airplane mode, Settings → **Sign out** →
   **Sign out anyway**.
   *Expected:* Settings reads "Logs are saved on this phone only." and offers **Share with
   the other parent**, **Join the other parent** and **Sign in**. Home reads "Saved on this
   phone · not synced". Both diapers from step 1 are still on B.
3. **Sign back in; the kept entries upload.** Turn airplane mode off. On B, Settings →
   **Sign in** → **Sign in with a passkey**.
   *Expected:* "Synced with your household." Then switch away from the app on A and back:
   A has both diapers from step 1, once each.
4. **Online, with an entry that hasn't synced.** On B, turn on airplane mode, log a wet
   diaper, turn airplane mode off, and tap **Settings → Sign out** right away, before
   Settings says "Synced with your household."
   *Expected:* B signs out without asking: Settings reads "Logs are saved on this phone
   only." Switch away from the app on A and back: A already has this wet diaper. The
   barrier uploads it before the sign-out finishes, so unlike step 2 it is never left
   behind.
5. **Sign back in.** On B, Settings → **Sign in** → **Sign in with a passkey**.
   *Expected:* "Synced with your household." again, and neither phone shows step 4's
   diaper twice.

### 8. Remove a phone, and it comes back (A + B, 5 min, Mac rig)

A parent removes a lost phone in Settings. The removed phone can still sign in again, as
a new phone, and anything it logged meanwhile uploads then. Wording for the Settings rows is
**(recheck)** against the remove-phone PR.

1. **B logs into a day A already judged.** On B, turn on airplane mode. Log a wet diaper and
   use the time row to set it to **B's late diaper at**: yesterday, an hour after the birth
   time. That is inside day 1, which A has judged since check 3.
2. **Remove B on A.** On A, Settings. The household's phones are listed by name, with
   **Remove** on every phone except A's own **(recheck)**. Remove <B's name>’s phone and
   confirm.
   *Expected:* the row shows B as removed, or is gone **(recheck)**. A stays "Synced with
   your household."
3. **B finds out.** On B, turn airplane mode off and switch away from the app and back.
   *Expected:* Settings reads "Signed out on this phone. Logs stay here until you sign in
   again." with **Sign in with a passkey**. The wet diaper from step 1 is still on B.
4. **B signs in as a new phone.** Tap **Sign in with a passkey**. The phone may ask for the
   passkey twice: the first answer is refused because this phone was removed, and the app
   starts again as a new phone. That counts as a pass, as long as there's no dead end.
   *Expected:* "Synced with your household." No error is left on screen.
5. **A sees B's diaper arrive late.** On A, switch away from the app and back, wait for
   "Synced", and open Readings. Open Wet diapers.
   *Expected:* "Updated: entries from <B's name>’s phone arrived late." B's backdated diaper
   is in A's History at yesterday's time, once. A's Settings lists B's new phone
   **(recheck)**.

### 9. The next day: what stops the wait (A + B, 5 min)

Do this at the next day boundary, the birth time on the following day. On the Mac rig, that
is 24 hours after check 3, so keep the server and database until then.

1. **Before the day ends**, on B, wait for Settings to read "Synced with your household.",
   then Settings → **Sign out**. B signs out without asking, as in check 7 step 4.
2. **After the day ends**, on A, switch away from the app and back, wait for "Synced", and
   open Readings. Open Wet diapers.
   *Expected on the family server:* no "Waiting for" line. B signed out after uploading
   everything, so A stops waiting for it.
   *Expected on the Mac rig, after check 8:* exactly one line, "Waiting for <B's name>’s
   phone (last synced <time>)", where the time is just before check 8 step 1. That is
   the removed phone: it went quiet in check 8 step 1, and A removed it a minute later.
   Removal stops the wait only from the removal on, so the minute between still waits. B's
   new phone, signed out in step 1, is not waited for. If the time is from today's
   step 1, that's a failure: A is waiting for the phone that signed out.
3. Mac rig only: tap **Count without <B's name>’s phone**.
   *Expected:* the day's count checks no longer wait.
4. Sign B back in with **Sign in with a passkey**.

A **Sign out anyway** (check 7 step 2) doesn't stop the wait. A keeps waiting for that phone
from its last sync until it signs back in or a parent taps Count without.

### 10. App update (after #74, Mac rig, A, 5 min)

The browser tests switch builds on a desktop browser and fake the return to the app. This
check is the real thing: build N is running on A, the Mac starts build N+1, and A comes back
from the background. The app shows no build number, so N+1 gets a small "build N+1" label
in the bottom-left corner.

1. On A, open **Feed**, tap **Left** and leave the timer running on screen. Switch to the
   Home Screen (don't force-quit) and note the timer's time.
2. On the Mac, stop the server (Ctrl-C). Build again and mark the new build:

   ```sh
   pnpm build
   perl -pi -e 's#</head>#<style>body::after{content:"build N+1";position:fixed;left:8px;bottom:4px;font:12px system-ui;opacity:.7}</style></head>#' apps/web/build/index.html
   grep -c 'build N+1' apps/web/build/index.html     # prints 1
   ```

   Start the server again with the same command and the same `DATABASE_PATH`. Leave
   `tailscale serve` as it is.
3. On A, open the app from the app switcher.
   *Expected:* the timer is still running, and its time counted on while the app was in
   the background. If the timer screen is showing, it isn't reloaded and has no label
   yet; that's correct. If iOS closed the app in the background, it opens on Home
   instead, with the feed still running. Swipe back to Home if you're on the timer. No
   label on Home yet is also correct: the new build is still installing.
4. Leave the app open on Home for about 30 seconds while the new build installs. Then
   open **History** and go back to Home.
   *Expected:* "build N+1" in the bottom-left corner within those two screen changes,
   Home reads "Synced", and the feed is still running. Open it: the timer shows the same
   running time, not 0.
5. Stop the timer and save the feed. Force-quit the app and open it from the Home Screen
   icon.
   *Expected:* "build N+1" is there, and the feed is in the log once.

A screen change straight after A comes back can still show build N; that's expected,
not a failure. After the 30-second wait, the label must show within two screen changes
or on the next launch. A launch from the Home Screen icon can also show the old cached
build first; the launch after that shows "build N+1". If the label still isn't there
after the wait, two screen changes and a relaunch, report it as a failure of 10.4. If any
screen reloads while you're entering something, or the feed is lost or logged twice,
report it as a failure of the step where it happened.

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
