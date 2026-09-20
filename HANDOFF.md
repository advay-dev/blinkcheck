# BlinkCheck — conversation handoff (paste this into a new chat)

Complete state of the BlinkCheck project as of commit `239a73b` on `main`, pushed to
`https://github.com/advay-dev/blinkcheck` and live at
`https://advay-dev.github.io/blinkcheck/`. Written so a fresh AI assistant (or the user
themself, later) can pick this up with zero prior context. This supersedes all earlier
versions of this file.

## 1. What this is, and the core constraint

BlinkCheck is a **hackathon prototype**: a browser-based fatigue-screening tool with two
short tests (smooth-pursuit eye tracking, visual reaction time), each giving a Pass /
Borderline / Fail verdict. **Not a medical device** — stated in the UI, must stay true.

**100% client-side, no backend, no build step.** Static HTML/CSS/JS on GitHub Pages. All
camera processing and scoring happens on-device — "Video never leaves this device" is a
real, protected claim. **A real backend for cross-device sync was explicitly scoped and
explicitly deferred** — the user's own words this session: "the reason we didn't go for a
backend was because we don't have enough time, you said it will take a day." Every
multi-device limitation below is a direct consequence of that decision, not an oversight.

**Now deployed and live** (this is new since the last handoff): public GitHub repo
`advay-dev/blinkcheck`, GitHub Pages enabled from `main` root. Desktop:
`https://advay-dev.github.io/blinkcheck/` — Phone: `.../mobile.html` — Dashboard:
`.../dashboard.html` (unlisted but **publicly reachable if the URL is known** — flagged to
the user that the dashboard passphrase is plaintext in `dashboard.js`'s source, now public;
no decision made yet on whether to pull it from the deployed site).

## 2. File structure

| File | Purpose |
|---|---|
| `index.html` | Desktop page: driver bar, pursuit test, reaction test, trip controls, readiness/fatigue popups. |
| `mobile.html` | Phone-optimized version. Sets `window.BLINKCHECK_MOBILE = true` before `app.js`. Shares every element `id` with `index.html`. |
| `app.js` | All application logic — both tests, driver profiles, trips, ratings, fitness status, reminders, notifications. One ES module, ~1650 lines. |
| `style.css` / `mobile.css` | Shared / phone-only styling. |
| `dashboard.html` / `dashboard.js` | Unlisted admin page: passphrase `"admin"` (cosmetic only, see §1). Drivers list, ratings, messaging, admin notifications, thresholds, demo fleet, export/import. |
| `README.md` | Rewritten this session to match current app state (was badly stale — described a pre-driver-profiles, pre-reaction-test app). |
| `HANDOFF.md` | This file. |

## 3. Test 1 — Smooth-pursuit eye tracking (unchanged this session)

Stimulus `a(t)=sin(ωt)`, ω=2π×0.25Hz. MediaPipe FaceLandmarker iris tracking. 3s calibration
(gain `k`/offset `g0`, either sign accepted), 12s lag-compensated RMSE scoring (lag search
≤250ms desktop/600ms mobile). Anti-cheat: void under 70% valid samples, fail under 0.5/0.4
eye-target correlation, head-movement frames discarded. First valid run becomes the driver's
baseline (capped 1.25/s); later runs scored **Pass <1.2×, Borderline 1.2–1.3×, Fail ≥1.3×**.

## 4. Test 2 — Reaction time (bug fixed this session, otherwise unchanged)

10 targets (4 in `?demo=true` mode), random position/delay, `pointerdown`-based hit
detection. Median RT scored: **Pass <600ms, Borderline 600–700ms, Fail ≥700ms**, plus
>1 miss or >2 false starts fails outright.

**Bug found and fixed this session**: `mobile.html` was missing the `<button
id="btnReactionVoidRetry">` element that `index.html` has. `setReactionVerdict()`
unconditionally calls `.classList.toggle()` on it, so on mobile this threw a `TypeError`
immediately on Start, killing `startReaction()` before it reached the line that schedules
the first `spawnTarget()` — the round counter and "Running" label updated, but no target
ever appeared. This was **not** a touch/pointer issue (the earlier `pointerdown` rewrite
from before this session was already correct and untouched). Fixed by adding the missing
button to `mobile.html`. Confirmed working live.

## 5. Driver profiles — data model (`localStorage` key `blinkcheck.drivers.v1`)

Shared-device model (e.g. a depot kiosk), not a cloud account — a profile lives only on the
device/browser it was created on. Each driver object:

```
{
  id, name, created,
  baseline: {rmse, gain, lagMs, recorded} | null,
  strikes,                                   // +1 per Fail verdict, either test
  stats: {pursuit: {pass,watch,fail,void}, reaction: {...}},
  history: [{t, test, verdict, detail}],     // capped 50, oldest dropped
  pendingChanges: [...],                      // delta log for the "transferable size" demo
  rating: {sum, count},                       // NEW — dashboard-set 1-5 star average
  activeTrip: {startedAt} | null,             // NEW
  trips: [{id, startedAt, endedAt, rating}],  // NEW — capped 50
  driveStatus: {value: "can_drive"|"not_applicable", updatedAt} | null  // NEW
}
```

## 6. NEW this session — Trip flag + dashboard star rating

- **Start trip** button sits below the baseline/pursuit/reaction stats block on the driver
  card. Clicking it hides itself, shows **End trip**, and locks driver-switching
  (`updateDriverLock()` now also checks `driver.activeTrip`).
- **End trip** closes the trip with no self-scoring — it just appends to `driver.trips` with
  `rating: null`, which is the "flag" the dashboard reacts to.
- Dashboard: any driver with an unrated trip shows a **"N trip(s) awaiting rating"** badge
  and a 5-star click-to-rate control per pending trip. Rating updates `driver.rating.sum/count`
  immediately, visible on both the dashboard and the driver's own page (`el.driverRating`,
  next to Strikes on the driver card).
- Functions: `startTrip()`, `endTrip()` in `app.js`; rating UI + `.btnRateTrip` handler in
  `dashboard.js`'s `renderDrivers()`.

## 7. NEW this session — Fitness status ("Can Drive" / "Not Applicable to Drive")

Shared logic, `app.js`:
```js
function latestVerdict(driver, testType) { /* most recent history entry of that test type, or null */ }
function computeDriveStatus(driver) {
  // null if either test never run. Otherwise: "can_drive" ONLY if both latest
  // verdicts are exactly "pass" (the safest combination, per explicit user instruction —
  // Borderline/Fail/Void on either test = "not_applicable"). No exceptions.
}
```

**Where it shows and how it updates (this was corrected mid-session — read carefully):**
- The **big CAN DRIVE / NOT APPLICABLE TO DRIVE badge lives on the dashboard's driver list**
  (not the driver-facing page), next to each driver's name. Green pill for CAN DRIVE, red for
  NOT APPLICABLE TO DRIVE.
- It is **only recomputed/written when the driver-side periodic reminder actually fires**
  (`checkNotifyDue()` → `updateDriveStatusLabel()`), not live after every test. This was a
  deliberate user instruction: it's meant to read as a periodic check-in snapshot, not a
  constantly-flickering readout.
- **Whenever the stored value changes**, a dashboard notification event is queued
  (`pushDashboardEvent("drive_status", driver, {status})`) — "if there is any update to the
  label then a relevant notification is sent," per the user's exact words.
- **Start Trip is locked until both checks have been completed** — completed, not
  necessarily *passed*. This was a deliberate, literal reading of "lock it till the checks
  have been completed" — a driver who fails both checks can still technically start a trip
  once both have been *run*. Flagged to the user as a possible mismatch with real-world
  safety intent; they confirmed "yes correct" but this is worth re-confirming if it ever
  matters in practice.

## 8. NEW this session — Readiness popup ("Ready to Drive")

The moment `recordResult()` sees **both** pursuit and reaction have a latest verdict (after
recording whichever test just finished), it shows a popup (`showReadinessPopup()`):
- Both latest verdicts `"pass"` → ✅ "Ready to Drive."
- Anything else → 🚫 "Not Applicable to Drive," names which test(s) need a redo, and a
  "Repeat the test" button that scrolls to the relevant section (`el.stage` or `el.rStage`).
- **Explicitly re-triggers on every subsequent test completion**, not just the first time —
  confirmed by the user ("yes it can re-trigger").
- **No baseline concept was added to the reaction test** — explicitly declined by the user.
  "Both checks completed" means "both have a recorded verdict at least once," not "both have
  a self-baseline" (only pursuit has ever had that concept).
- Purely advisory — the app cannot force anyone to retest or stop driving.
- Also pushes a `pushDashboardEvent("completed_both", driver, {pursuitVerdict, reactionVerdict})`
  every time this fires, which is what drives the admin "driver completed both checks"
  notification (see §9) — **this only fires once both are done, never after a single
  individual test**, per explicit user correction.

## 9. NEW this session — Reminders redesigned + admin messaging

**The old reminder system was a bare timer that assumed compliance.** Rebuilt this session
per explicit instruction: *"don't put the recheck on a timer, the driver needs to find a
space to stop as well."*

- `blinkcheck.notify.v1` now holds `{enabled, intervalHours, lastNotified, snoozeCount,
  nextCheckAt}`.
- `checkNotifyDue()` (still polled every 60s) no longer fires a bare notification — it calls
  `promptFatigueCheck(messageText)`, which shows an **on-screen modal** (`#fatigueModal`)
  with two choices, plus a best-effort native `Notification` alongside it:
  - **Snooze 15 minutes** — allowed **at most twice** per cycle (`NOTIFY_MAX_SNOOZES = 2`).
    On the 3rd due-check the snooze button is hidden entirely, forcing "Do the checks now"
    as the only option (still advisory, not enforced).
  - **Do the checks now** — closes the popup, scrolls to the pursuit stage, and (a judgment
    call, not explicitly requested — flag if unwanted) sets a **5-minute grace window**
    (`DO_NOW_GRACE_MS`) before the reminder could fire again, so it doesn't immediately
    re-nag if they get pulled away.
  - The **real reset** of the whole cycle (`snoozeCount → 0`, `nextCheckAt → +intervalHours`)
    happens only when `recordResult()` sees both checks completed — i.e. actual completion
    resolves the reminder, not a timer assuming it did.
- **Admin-to-driver messaging (new)**: dashboard has a per-driver text box + Send button
  (`sendAdminMessage(driverId, text)` in `dashboard.js`) that writes to
  `blinkcheck.adminMessage.v1` = `{id, t, driverId, text}`. `app.js` has a new `"storage"`
  event listener that, if the message's `driverId` matches the currently active driver on
  that device, calls the exact same `promptFatigueCheck(msg.text)` — same on-screen popup,
  same snooze budget, same native notification. Per explicit instruction: *"For any message
  sent by the admin, it pops up on the screen as well as a notification being sent."*
- **Admin notifications (dashboard side, new)**: a "Enable admin notifications" toggle in
  the dashboard's Settings tab (same opt-in pattern as the driver's own reminder button).
  Watches `blinkcheck.dashboardEvents.v1` (a capped, append-only event log app.js writes to
  — types `"completed_both"` and `"drive_status"`) via the dashboard's existing `storage`
  listener, and fires a native `Notification` per unseen event
  (`processDashboardEvents()`/`loadAdminNotify()`/`ADMIN_NOTIFY_KEY`).

**All of this is still foreground-only, same-device-only** — the exact same limitation as
every other notification feature in this app. Nothing here reaches a different physical
device.

## 10. Testing status — what's actually been verified vs. not

Verified live, against real `localStorage` state (not just UI), in the session's automated
browser (Notification permission is **"denied"** in that sandbox and cannot be granted
programmatically):
- mobile.html reaction-test fix (target now spawns correctly).
- Rating/trip flow end to end (start → end → dashboard flags it → star-rate it → average
  updates everywhere).
- Readiness popup firing correctly for a real Pass+Fail combination, with correct message
  and working "Repeat the test" scroll-to behavior.
- Start Trip lock/unlock tied correctly to checks-completed state.
- Dashboard CAN DRIVE / NOT APPLICABLE badges rendering correctly (via demo fleet data).
- Fatigue check-in popup: admin message delivery, snooze counting to exactly 2 then hiding
  the snooze option, "Do the checks now" behavior, all via direct state inspection.
- Message composer writes the correct payload to `blinkcheck.adminMessage.v1`.

**NOT verified — because it requires real Notification permission that the sandbox can't
grant**: the actual native OS/browser notification popup firing for (a) the driver's fatigue
reminder, (b) an admin-sent message, (c) the dashboard's admin-notification toggle. The code
path is straightforward and mirrors the pre-existing, already-working driver reminder
button, but **this needs a real check on an actual device/browser with permission granted**.

## 11. Known limitations (carried over, still true)

1. Every threshold is a provisional guess, not from real rested/fatigued data. Both tests
   export CSVs as the intended fix path.
2. `localStorage` never crosses devices/browsers/origins — this is why the dashboard on a
   laptop can't see a driver profile created on a phone, why admin messages/notifications
   only reach the same physical device, and why the whole trip/rating/fitness-status system
   is built around a single shared-kiosk device rather than a phone+laptop pair. The
   Export/Import JSON flow in the dashboard is the only bridge between devices.
3. Head yaw isn't compensated (pursuit test).
4. Baseline gaming is bounded (RMSE cap) but not eliminated.
5. Dashboard passphrase is cosmetic only, and now sits in a **public** repo.
6. No automated test suite — everything verified via manual/live browser testing.

## 12. Immediate next steps, in priority order

1. **Real-device verification of the notification stack** — the one thing this session
   could not test (see §10). On an actual phone/laptop with Notification permission granted:
   confirm the driver's fatigue popup fires a real native notification, confirm an
   admin-sent message reaches the driver's tab, confirm the dashboard's own admin
   notifications fire for `completed_both`/`drive_status` events.
2. **Decide on `dashboard.html`'s public exposure** — flagged, unresolved. The passphrase is
   plaintext in a now-public repo's source. Options: leave as-is (matches the app's own
   stated "not real security" framing), change the passphrase to something less guessable
   (still cosmetic), or exclude it from the deployed Pages site entirely.
3. **Sanity-check the "Start Trip locks on completion, not on passing" behavior** (§7) in
   practice — the user confirmed the literal reading but it's worth a second look once
   there's real usage.
4. **Sanity-check the 5-minute "Do the checks now" grace period** (§9) — an unrequested
   addition made to avoid an annoying re-nag loop; adjust or remove if unwanted.
5. Longer-term, not urgent: real threshold calibration from CSV exports, a real backend if
   cross-device sync ever becomes a hard requirement (explicitly deferred, not because it's
   hard — ~1 day estimate previously given — but because of time).
