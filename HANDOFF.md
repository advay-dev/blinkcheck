# BlinkCheck — conversation handoff (paste this into a new chat)

Complete state of the BlinkCheck project as of commit `5a26da9`. Written so a fresh AI
assistant (or the user themself, later) can pick this up with zero prior context. This
supersedes an earlier, now-stale version of this same file — a lot changed after it was
first written, most notably a whole pitch-demo feature set and a multi-round bug hunt on
the reaction test's touch handling.

## 1. What this is, and the core constraint

BlinkCheck is a **hackathon prototype**: a browser-based fatigue-screening tool with two
short tests (smooth-pursuit eye tracking, visual reaction time), each giving a Pass /
Borderline / Fail verdict. **Not a medical device** — this is stated in the UI and must
stay true; nothing here has been validated against real data.

**100% client-side, no backend, no build step.** Static HTML/CSS/JS, intended for GitHub
Pages. All camera processing and scoring happens on-device — the UI literally says "Video
never leaves this device," and every design decision this session has protected that claim.
**Not yet deployed** — everything so far has been tested via local servers; the user's
stated plan is to push to GitHub once satisfied.

## 2. File structure

| File | Purpose |
|---|---|
| `index.html` | Desktop page: driver bar, pursuit test, reaction test, byte-size checkers. |
| `mobile.html` | Phone-optimized version, same structure, touch-tuned. Sets `window.BLINKCHECK_MOBILE = true` before loading `app.js` to trigger phone-only sensor recalibration. Shares every element `id` with `index.html`. |
| `app.js` | All application logic — both tests, driver profiles, notifications, audio. One ES module, ~1450 lines, no bundler. |
| `style.css` | Shared styling: colors, stimulus/target shapes, verdict states, buttons. |
| `mobile.css` | Phone-only overrides layered on top (bigger touch targets, safe-area insets). |
| `dashboard.html` / `dashboard.js` | Unlisted admin page — not linked from the main site. |
| `README.md` | Deployment instructions + original measurement-model writeup. **Stale** — predates driver profiles, the reaction test, the dashboard, and the phone page. Needs an update pass. |
| `HANDOFF.md` | This file. |

## 3. Test 1 — Smooth-pursuit eye tracking

- Stimulus: `a(t) = sin(ωt)`, `ω = 2π × 0.25 Hz`. MediaPipe FaceLandmarker (CDN, WASM+GPU)
  gives iris landmarks. Calibration (first `CALIBRATION_S`=3s, demo mode 2s): least-squares
  fit of gain `k`/offset `g0`, accepts **either sign** of `k` (magnitude check only — a
  fixed camera-mirror-sign assumption isn't safe across devices/browsers, this was a real
  bug that got fixed). Scoring (next `TEST_S`=12s, demo mode 4s): RMSE of velocity error,
  **lag-compensated** — the score is computed after aligning eye/target velocity to the
  best-fit cross-correlation lag (search capped at `MAX_LAG_MS`=250ms desktop / 600ms
  mobile), because scoring against zero-latency stimulus velocity previously counted normal
  ~100-200ms human reaction time as tracking error, making the test nearly unpassable.
- **Anti-cheat gates**, in order: (1) void if calibration failed or <70% valid samples
  (`MIN_VALID_FRAC`); (2) correlation gate `MIN_CORR`=0.5 desktop/0.4 mobile — Pearson
  correlation between eye position and lag-shifted target position must clear this or it's
  an automatic Fail, catching erratic/non-tracking movement that would otherwise show
  deceptively low RMSE after smoothing; (3) head-movement rejection — a fast-moving
  EMA-smoothed head-centre point (`HEAD_MOVE_LIMIT`=0.5 interocular-widths/sec) marks
  frames invalid the same way a blink does, because head yaw isn't compensated and an
  untracked head can forge a pursuit signal.
- **Baseline scoring**: first valid run becomes the driver's personal baseline RMSE
  (capped at `BASELINE_RMSE_CAP`=1.25/s regardless of measured value, to bound how much a
  bad-faith first run can inflate the reference). Later runs scored as a ratio:
  **Pass < 1.2× (`WARN_MULT`), Borderline 1.2–1.3×, Fail ≥ 1.3× (`FAIL_MULT`)**.
- **Void verdict is now visually distinct** ("voidwarn" state): pulsing amber card,
  "DATA INTEGRITY COMPROMISED" messaging, a "Recalibrate & Retry" button — separated from
  the quiet neutral "void" styling still used for Running/Baseline-recorded messages. Void
  never increments strikes.
- **Overlay**: camera-viewfinder-style corner-bracket reticle on each iris (not filled
  dots — that was the very first thing fixed this session), color `#38E1C9` (teal, the
  app's "trace" color — was briefly amber, changed back). A real bug was found and fixed
  here: the overlay `<canvas>` lacked `object-fit: cover` while the `<video>` had it,
  causing a systematic offset (reticle landing on eyebrows, not eyes) — found by extracting
  frames from a user-supplied phone screen recording (no ffmpeg available; used a small
  Swift/AVFoundation script instead).
- **Anti-cheat pill**: a transient "⚠️ KEEP HEAD STILL" pill + alert tone (throttled to
  once/1.5s) fires live, wired directly to the real `HEAD_MOVE_LIMIT` detector.
- CSV export of every raw sample exists (`downloadCsv()`).

## 4. Test 2 — Reaction time test

- 10 targets (`ROUNDS`, 4 in demo mode), random position (`MARGIN_PCT` 12-88% x, 15-85% y),
  random delay (600-2200ms). Tap within `TARGET_MS`=2000ms or it's a miss (a lapse).
  Tapping empty space while no target shown is a false start.
- Scored on **median** RT (changed from mean — RT distributions are right-skewed, one slow
  lapse shouldn't dominate; misses are tracked separately anyway).
- Thresholds (fixed, not self-baselined, unlike pursuit): **Pass < 600ms (`WARN_MEDIAN_MS`),
  Borderline 600-700ms, Fail ≥ 700ms (`FAIL_MEDIAN_MS`)**, plus `MAX_MISSES`=1 and
  `MAX_FALSE_STARTS`=2 as hard fail conditions regardless of RT.
- CSV export exists (`downloadReactionCsv()`): per-target latency, spawn coordinates,
  miss/false-start events with position and timestamp.
- No audio cues on this test (see §7 — they were added, then removed after breaking things).

### 4a. The reaction-test bug hunt — READ THIS BEFORE ASSUMING IT WORKS

The user repeatedly reported "reaction test not working" (taps not registering) across
several rounds of fixes. What actually happened, in order:

1. **First real bug**: added Web Audio cues that could throw synchronously in a spot that
   broke the calling code entirely (a target's armed/timeout state never got set up, or a
   test never got scored) — fixed by wrapping all audio in try/catch, but this alone didn't
   resolve the user's report.
2. **Second real bug, found via a full audit**: the stage's bottom "round + progress" bar
   was a full-width `<div>` **without `pointer-events-none`**, overlapping the target's
   spawn zone (y up to 85%). A tap there hit the invisible footer bar instead of the target
   underneath — registered as neither hit nor false start, just silently swallowed.
   Verified conclusively using the browser's own `elementFromPoint` (the real hit-testing
   algorithm), before/after.
3. **Third fix, on top of the second**: switched hit-detection from `click` to
   `pointerdown`, and added `touch-action: manipulation` to the whole stage (previously
   only the target itself had it). Reasoning: a real touch always has slight finger
   movement between contact and release, which is enough for mobile browsers to delay or
   cancel the synthesized `click` event during tap-vs-scroll/zoom gesture disambiguation —
   even when the tap visually landed correctly. `pointerdown` fires immediately on contact,
   before any of that runs.
4. **Sound cues removed from the reaction test entirely** (target chime, false-start buzz,
   its own completion beep) at the user's explicit request, after repeated breakage
   reports — even though the try/catch fix in step 1 tested clean, the user was told to
   just remove them rather than keep debugging blind. The pursuit test's completion beep
   and head-movement alert tone are untouched (different code paths, never implicated).

**Current status: fixes 2 and 3 are committed and verified via the browser's real
hit-testing engine and synthetic `PointerEvent` dispatch, but NOT yet confirmed working by
the user on a real device.** This is the single most important open thread — if a new
session picks this up, the first question should be "did the pointerdown rewrite actually
fix it on a real phone?" If it's still broken, the next things to suspect: (a) the fix
genuinely didn't reach the device (caching — see §8, this has bitten the user multiple
times already), or (b) something about their specific browser/OS's pointer event handling
that hasn't been considered yet.

## 5. Driver profiles

`localStorage` key `blinkcheck.drivers.v1`. **Shared-device model** (e.g. a depot kiosk),
not a cloud account system — a profile lives only on the browser/device it was created on,
full stop, no way around this without a real backend (see §9).

Each profile: `name`, `created`, `baseline` (or null), `strikes`, `stats` (pass/borderline/
fail/void counts per test), `history` (capped 50-entry log), and `pendingChanges` (see §6 —
an uncapped delta log cleared on "sync").

- **Strike = one per Fail verdict**, either test. Borderline doesn't strike, strikes don't
  auto-expire.
- Both tests gate on having an active driver selected (pursuit also needs camera on).
  Switching drivers is locked while either test runs — this was a real crash risk
  (`finishTest()` would dereference a null baseline if the active driver changed mid-run).

## 6. Dev dashboard (`dashboard.html`/`dashboard.js`)

Unlisted, gated by a passphrase (`"admin"`, in `dashboard.js`) that is **explicitly not
real security** — visible in plain source, only stops casual stumbling. Two tabs:

- **Settings**: reminder interval + test-send; **live-editable score thresholds**
  (`blinkcheck.thresholds.v1`, read once by `app.js` at load — takes effect next page load,
  not live mid-session); aggregate overview (driver count, tests recorded, total strikes).
- **Drivers**: a plain list of driver names, each a `<details>` dropdown with baseline,
  stats, strikes, full history, and Reset-strikes/Delete actions.

Also: **"Load demo fleet"** button seeds 3 fabricated profiles spanning the verdict range
(Raju Kumar/pass/0 strikes, Vikram Singh/borderline/2 strikes, Amit Sharma/3 strikes) —
additive, not destructive, for stage demos. **Export/Import JSON** — export downloads
drivers+notify+thresholds as one file; import merges a backup file back in and refreshes
the UI live. **Live cross-tab sync** — a `storage` event listener means a driver created in
another tab of the *same browser, same origin* appears without a manual reload (does NOT
and cannot reach a different browser or device — see §8).

## 7. Notifications & audio

**Notifications**: foreground-only (Notification API, no backend = no true background
push). iOS Safari — and every iOS browser, since Apple mandates WebKit — doesn't support
this outside an installed home-screen app. Android Chrome supports it in a regular tab.

**Audio cues** (native `AudioContext`, zero dependencies): pursuit test only now — a
completion beep and a head-movement alert tone (throttled 1/1.5s). Everything in the audio
module is wrapped in try/catch and can never throw outward, after the bug in §4a step 1.
Reaction test has no sound (removed).

## 8. Known limitations — the load-bearing ones

1. **Every threshold is a provisional guess**, hand-tuned through this session's manual
   testing, not real rested/fatigued population data. CSV exports exist for both tests as
   the intended path to eventually fix this.
2. **`localStorage` never crosses devices, browsers, or origins** — hit repeatedly this
   session in different forms: two browsers on the same device (Safari vs Arc) have fully
   separate storage; an iOS home-screen-installed app has separate storage from the same
   site in a regular tab; `http://localhost:8000` and `https://<lan-ip>:8443` are different
   origins; two physical devices visiting the identical URL never share storage, ever, no
   client-side trick around it.
3. **Caching has repeatedly masked whether a fix actually landed** — several "still not
   working" reports turned out to be stale cached JS/CSS rather than the code being wrong.
   Always suspect this first: hard refresh (Cmd+Shift+R), or fully close/reopen the tab.
4. Head yaw isn't compensated (only fast head *movement* is caught, not a held turn).
5. Dashboard passphrase is cosmetic only.
6. Baseline gaming is bounded (the RMSE cap) but not eliminated.
7. No automated test suite — all verification this session was manual/live browser testing.

## 9. Explicitly scoped but NOT built

- **Real backend for cross-device sync** — fully roadmapped (data model, API surface, real
  auth, hosting options; Supabase recommended over a custom server) with a time estimate
  (~1 day for a working sync MVP, +0.5-1 day for real push notifications, open-ended for
  hardening). User said to leave it for now.
- **"Declared unfit to drive" off a wide-deviation baseline** — discussed at length (baseline
  noise usually means bad lighting/setup, not fitness), a clarifying question was asked and
  dismissed without an answer. **Not built, no decision made** — don't assume behavior here.
- **A literal 2D "wave" pursuit path** — discussed (vertical gaze isn't measured at all,
  inherently noisier to extract than horizontal), user was told to leave it alone.
- **A fabricated "syncing to broker... 48 bytes" toast** — explicitly refused to build, since
  it would fabricate a network event that doesn't exist, contradicting the app's real
  architecture to an audience evaluating whether the "video never leaves this device" claim
  is true. Built an honest version instead (see next point).

## 10. The "real payload size" features (honest alternative to fake sync)

Two byte-size checkers, both on the main pages (not the dashboard):
- **"Check payload size"**: real byte size (`Blob` size of `JSON.stringify`) of the active
  driver's full profile record.
- **"Check transferable size (since last sync)"**: tracks a `pendingChanges` delta log per
  driver (appended to by `saveDriverBaseline()`/`recordResult()`/`clearDriverBaseline()` as
  they happen), reports its real byte size, then **clears it** — simulating the lifecycle a
  real incremental-sync client would use (drop a change once delivery is confirmed), clearly
  framed as a simulation since there's no real backend to confirm anything.

## 11. Local dev tooling (not part of the shipped app)

- `python3 -m http.server 8000` — plain local testing.
- A self-signed HTTPS server (Python + `openssl`-generated cert, SAN covering `localhost`,
  `127.0.0.1`, and the current LAN IP) on port 8443, needed because `getUserMedia` requires
  HTTPS or `localhost`, and a phone can't reach `localhost` on a different machine. The LAN
  IP changes with network changes — college Wi-Fi had client isolation that blocked
  phone-to-laptop entirely (not fixable from software, had to switch to a personal hotspot).
  Both servers currently running; restart pattern used throughout: `kill $(lsof -ti :8443)`
  then relaunch the script at
  `/private/tmp/claude-501/.../scratchpad/https/serve_https.py <project-dir> 8443`.

## 12. Immediate next steps, in priority order

1. **Confirm whether the pointerdown rewrite (§4a) actually fixed the reaction test on a
   real device.** This is the one open thread that matters most.
2. If confirmed fixed: the user's original stated plan was test-locally-then-push-to-GitHub
   — that's the natural next milestone, and it also resolves most of the HTTPS/caching/
   cross-origin pain from local testing.
3. If still broken: get the exact symptom again (does the round counter advance at all on
   tap? which browser/OS exactly?) rather than guessing at a fourth fix blind.
4. Longer-term, not urgent: real threshold calibration from actual data (CSV exports already
   support this), README update (currently describes a much simpler pre-driver-profiles
   app), and the real-backend path if cross-device sync becomes a hard requirement.
