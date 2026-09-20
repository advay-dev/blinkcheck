# BlinkCheck — full project handoff

This document is a complete technical summary of the BlinkCheck project as it stands, written
for another AI model (or a new human contributor) with zero prior context. It covers what the
app does, how it's built, every feature, every known limitation, and the reasoning behind
non-obvious design decisions. Nothing here should be assumed to be unstated context — if it
matters, it's written down below.

## 1. What this is

BlinkCheck is a **browser-based fatigue-screening prototype** built for a hackathon. It runs
two short tests — a smooth-pursuit eye-tracking test and a visual reaction-time test — and
gives a Pass / Borderline / Fail verdict for each, intended as a quick pre-shift self-check for
drivers or anyone whose job requires alertness.

**It is explicitly not a medical device.** It does not diagnose concussion, intoxication, or
any condition, and none of its thresholds have been validated against a clinical or
population reference. This is stated in the UI itself and should not be removed or softened.

## 2. Architecture — the one fact that shapes everything else

**100% client-side. No backend. No build step. No server-side code of any kind.** It is a
handful of static HTML/CSS/JS files, intended to be deployed on GitHub Pages (free static
hosting). All computation — camera processing, face-landmark inference, scoring — happens
in the browser, on-device. This is a deliberate privacy feature: the UI literally displays
"Video never leaves this device," and that claim is true and must stay true. Adding a backend
that uploads video/images would break that promise; if a backend is ever added it should only
ever transmit summary numbers (RMSE, reaction times, verdicts), never camera data.

Because there is no backend, all persistence uses **`localStorage`**, which has hard,
unavoidable consequences documented in section 8.

### File structure

| File | Purpose |
|---|---|
| `index.html` | Desktop page. Two-column layout (stage + instruments side by side at `lg` breakpoint, stacks on narrower screens). Contains both tests. |
| `mobile.html` | Phone-optimized page. Single-column, larger touch targets, `touch-action: manipulation` to kill double-tap-zoom delay, safe-area padding for notch devices. Sets `window.BLINKCHECK_MOBILE = true` before loading `app.js`, which triggers phone-only sensor recalibration (see §4). Shares every element `id` with `index.html` so the same script drives both. |
| `app.js` | The entire application logic for both tests, driver profiles, and notifications. ES module, ~1000 lines. Single file, no bundler. |
| `style.css` | Shared styling: colors, `.dot`/`.target` stimulus shapes, `.metric` layout, verdict color states, buttons. |
| `mobile.css` | Phone-only CSS overrides layered on top of `style.css` (bigger touch targets, bigger reaction target, safe-area insets). |
| `dashboard.html` / `dashboard.js` | Unlisted admin page — not linked from the main site. Own lightweight script (no camera/MediaPipe code). See §7. |
| `README.md` | Deployment instructions and the original measurement-model writeup. **Currently stale** — written before driver profiles, the reaction test, the dashboard, and the phone page existed. Needs an update pass. |

No other files are part of the shipped app. (A local HTTPS dev server with a self-signed cert
was created during development for phone testing — see §9 — but that's tooling, not part of
the repo.)

## 3. Test 1 — Smooth-pursuit eye tracking

### Measurement model
- Stimulus: a red dot moves horizontally as `a(t) = sin(ωt)`, `ω = 2π × 0.25 Hz` (one full
  cycle every 4 seconds — chosen to stay inside the range where healthy pursuit doesn't
  substitute saccades for smooth tracking). Amplitude is 42% of stage width.
- Eye position: horizontal iris offset from the eye-corner midpoint, divided by interocular
  distance — dimensionless, invariant to head translation and distance from camera.
- Uses **MediaPipe FaceLandmarker** (loaded from CDN, WASM + GPU delegate) for face landmarks,
  478 points including refined iris landmarks (indices 468/473).
- **Calibration phase (first 3s of every run)**: least-squares fit of gain `k` and offset `g0`
  such that `k·(g − g0) ≈ a`. This maps eye units to stimulus units without a separate
  calibration ritual. The fit accepts either sign of `k` (magnitude check, not sign check) —
  this was a deliberate fix: the camera's raw left/right mirroring convention isn't guaranteed
  consistent across devices/browsers, and requiring a positive gain would silently reject a
  real, working calibration on a device where that convention is flipped.
- **Scoring phase (next 12s)**: velocity error `e(t) = v̂(t) − ȧ(t)`, RMSE over valid samples.
  Derivatives (`dg/dt`) are computed as a least-squares regression slope over an 11-sample
  sliding window, not two-point differencing — raw frame-to-frame differencing of a noisy
  landmark stream is unusable at 30–60fps.

### Lag compensation (important, non-obvious)
No human visual-motor system has zero latency (normal smooth-pursuit reaction time is
~100–200ms). Early in development, RMSE was scored against the zero-latency stimulus
velocity, which counted every driver's normal reaction time as tracking error — making the
test nearly impossible to pass regardless of skill. Fixed by: computing the best-fit lag via
cross-correlation search (position-based), then aligning the eye/target velocity series to that
lag *before* computing RMSE. The search window is capped (`MAX_LAG_MS = 250` on desktop) so
this can't be abused — genuinely slow/inconsistent tracking still shows up as error, only a
*consistent* lag within the physiological range gets absorbed.

### Anti-cheat / validity gates (in order of evaluation in `finishTest()`)
1. **Void check**: calibration must have succeeded and ≥70% of samples (`MIN_VALID_FRAC`) must
   be usable, or the run is void (not scored as fail).
2. **Correlation gate** (`MIN_CORR = 0.5` desktop / `0.4` mobile): Pearson correlation between
   eye position and the lag-shifted target position. Real pursuit — even noisy, laggy,
   fatigued pursuit — still follows the target's path, so this stays high; random/erratic eye
   movement does not. This exists because EMA smoothing + the derivative window low-pass
   fast jitter down toward zero, which *lowers* velocity RMSE instead of raising it — meaning
   erratic non-tracking could otherwise score deceptively well on RMSE alone. Below this
   threshold → automatic Fail, regardless of RMSE. This also blocks a bad/erratic run from
   ever being accepted as the baseline.
3. **Head-movement rejection**: a fast-moving head reference point (EMA-smoothed midpoint
   between the eyes) is treated as invalid data the same way a blink is (`HEAD_MOVE_LIMIT =
   0.5` interocular-widths/sec). This exists because head yaw is *not* compensated — turning
   the head produces the same iris-offset signal as moving the eyes, so an untracked head could
   otherwise forge a pursuit signal. Enough discarded frames pushes the run below the 70%
   valid-sample threshold → void, not a false pass.
4. **Baseline-relative scoring**: see below.

### Baseline system
The first valid, correlation-passing run for a driver becomes their personal baseline RMSE
(not itself judged pass/fail). All later runs are scored as a ratio against it:
- **Pass**: RMSE < 1.2× baseline (`WARN_MULT`)
- **Borderline**: 1.2×–1.3× baseline
- **Fail**: ≥ 1.3× baseline (`FAIL_MULT`)

Rationale: smooth-pursuit quality varies hugely between healthy people (eye color, glasses,
camera, seating distance) — a fixed absolute line is wrong for someone. The baseline RMSE
saved is capped at **1.25/s** (`BASELINE_RMSE_CAP`) regardless of the actual measured value —
this exists specifically to stop someone deliberately submitting a terrible first run to
inflate the reference and make all future bad runs compare favorably against it. The "suspect
baseline" warning (poor RMSE/gain/lag) still fires off the *raw* measured value even when
capped, to nudge the person to redo it properly.

An absolute fallback (`FAIL_RATIO = 0.95`, `WARN_RATIO = 0.70`, fractions of peak target speed)
exists only as the "suspect baseline" sanity check — there is no absolute-threshold scoring
path for a driver who already has a baseline.

### Phone-specific recalibration
`window.BLINKCHECK_MOBILE` (set only by `mobile.html`) widens `MAX_LAG_MS` to 600ms and lowers
`MIN_CORR` to 0.4. Root cause: on-device face-landmark inference is real computational work,
and phone GPUs are often weaker/thermally throttled, adding system latency on top of normal
human reaction time. If a phone's true combined lag exceeded the desktop-tuned 250ms search
window, genuinely correct tracking couldn't be aligned and failed the correlation gate even
though the driver was actually tracking correctly. This was found and fixed by analyzing a
phone screen recording the user provided, mid-session. **These phone numbers are provisional —
no real phone-hardware latency measurements back them, they were chosen to fit one observed
failure case.**

### Visual overlay
A camera-viewfinder-style corner-bracket reticle (not a filled dot) is drawn on each iris,
color `#38E1C9` (the app's "trace" teal, also used for the live velocity chart). Sized
relative to interocular distance so it holds its apparent size regardless of distance from
camera. **Bug fixed mid-session**: the overlay `<canvas>` didn't have `object-fit: cover`
while the `<video>` element did, so the canvas stretched to fill its box non-uniformly while
the video cropped-to-fill preserving aspect ratio — this produced a *constant* offset between
where a landmark was computed and where it rendered, causing the reticle to consistently land
on the eyebrows instead of the iris. Confirmed via extracting frames from a user-supplied
screen recording (no `ffmpeg` available; used a small Swift/AVFoundation script instead).
Fixed by adding `object-cover` to the canvas, matching the video.

### Other pursuit-test details
- Blinks (EAR < 0.21) blank a 180ms recovery window and are excluded from scoring, counted
  separately.
- Catch-up saccades are counted via an acceleration-burst detector (not currently gating
  pass/fail, just reported).
- CSV export of every raw sample (`downloadCsv()`) exists for the pursuit test — this is the
  intended path for eventually collecting the real rested/fatigued dataset needed to replace
  the guessed thresholds. **No equivalent CSV export exists for the reaction test.**

## 4. Test 2 — Reaction time test

Independent of the pursuit test, no camera dependency once a driver is selected.

- 10 targets (`ROUNDS`), one at a time, at a random position (12–88% x, 15–85% y of the stage)
  and after a random delay (600–2200ms) — randomized specifically so timing can't be
  anticipated instead of genuinely reacted to.
- Tap the target within 2000ms (`TARGET_MS`) or it counts as a **miss** (a lapse — the classic
  PVT/psychomotor-vigilance fatigue signal).
- Tapping empty space while no target is shown counts as a **false start**.
- Scored on **median** reaction time, not mean — changed mid-session specifically because RT
  distributions are right-skewed (one slow lapse drags a mean up far more than it should), and
  lapses are already tracked separately via the miss count. "Slowest hit" is still reported
  separately so a lapse isn't hidden, just doesn't distort the primary number.
- Thresholds: **Pass** median < 600ms, ≤1 miss, ≤2 false starts. **Borderline** 600–700ms or
  exactly 1 miss. **Fail** ≥700ms (`FAIL_MEDIAN_MS`), or >1 miss (`MAX_MISSES`), or >2 false
  starts (`MAX_FALSE_STARTS`). These are fixed absolute thresholds, not self-baselined like the
  pursuit test — simple visual-motor RT is a much better-studied quantity in the literature
  than pursuit RMSE, but "well-studied in general" is not the same as "validated for this
  specific point-and-tap task on this specific UI," so these are still provisional guesses.

## 5. Driver profiles

A repository of named driver profiles, stored in `localStorage` (`blinkcheck.drivers.v1`).
**This is a shared-device model (e.g. a depot kiosk), not a cloud account system** — a
profile lives only on the browser/device it was created on.

Each profile has: `name`, `created` timestamp, `baseline` (pursuit RMSE/gain/lag or null),
`strikes` (integer), `stats` (pass/borderline/fail/void counts, separately for pursuit and
reaction), and a capped 50-entry `history` log (timestamp, test type, verdict, detail).

- **A strike = one per Fail verdict**, on either test. Borderline doesn't strike. Strikes never
  auto-expire.
- Both "Start test" buttons are disabled until a driver is selected. The driver-select control
  is locked while either test is running, specifically because switching drivers mid-run would
  either crash the pursuit scoring code (dereferencing a null baseline) or misattribute a
  reaction result to the wrong driver.
- A UI panel on the main pages shows the active driver's name, strike count, baseline, and
  stats — populated by `showDriverProfile()`.

## 6. Notifications

Client-side reminder system using the browser **Notification API**. This is the honest
ceiling of what a backend-less static site can do:
- Fires only while a tab **stays open** (foreground or background) in a browser that has
  granted permission. There is no push server, so there is no true background delivery with
  the browser fully closed.
- The interval (default 8h) and enabled state are a **site-wide setting per origin**
  (`blinkcheck.notify.v1`) — each visitor still has to opt in for themselves via a header
  toggle, since no page can silently grant itself notification permission.
- **Platform gap**: iOS Safari — and *every* browser on iOS, including Chrome, since Apple
  requires all iOS browsers to use the WebKit engine — does not support the Notification API in
  a regular browser tab at all. It only works if the site is added to the Home Screen
  (iOS 16.4+). Android Chrome supports it in a regular tab.
- Once a user denies notification permission for a site, the browser will never show the
  native prompt again from JS — it silently returns "denied" forever until the user manually
  resets it in the browser's own site settings. Not a bug, standard anti-spam browser design.

## 7. Dev dashboard (`dashboard.html` / `dashboard.js`)

Unlisted (not linked from the main site), gated by a **passphrase that is explicitly not real
security** — this is a static site with no server, so the passphrase (`"admin"`, in
`dashboard.js`) is visible in plain text to anyone who opens dev tools. It only stops casual
stumbling onto the page.

Two tabs:
- **Settings**: reminder interval + test-send button; live-editable score thresholds (pursuit
  WARN/FAIL multipliers, reaction WARN/FAIL ms — stored in `blinkcheck.thresholds.v1`, read
  once by `app.js` at load, so a change takes effect on next page load, not live mid-session);
  aggregate overview (driver count, tests recorded, total strikes).
- **Drivers**: a plain list of driver names, each a `<details>` dropdown showing baseline,
  pursuit/reaction stats, strike count, full result history, and Reset-strikes / Delete
  actions. Reset-strikes zeroes the count while keeping baseline/stats/history intact —
  deliberately lighter than full delete.

An "Export JSON" button downloads drivers + notify settings + thresholds as one timestamped
backup file. **No "Import" counterpart has been built yet** — this was scoped as the practical
way to move data between devices manually (export on one device, transfer the file, import on
another) but the import side was explicitly deferred, not built.

**Live cross-tab sync**: the dashboard only read `localStorage` once at load originally; a
`storage` event listener (fires automatically in every *other* open tab of the same
browser/origin the instant one tab writes to storage) plus focus/visibilitychange fallbacks
were added so a driver created in another tab appears without a manual reload. **This only
works within the same browser and the same origin** — it cannot and does not reach a different
browser (even on the same device) or a different device.

## 8. Known limitations — read this before assuming anything works differently

1. **Every threshold in this app is a provisional guess**, picked by hand through iterative
   manual testing across this session, not derived from real rested/fatigued population data.
   This has been stated repeatedly and bluntly throughout development. The CSV export exists
   specifically to start fixing this for the pursuit test.
2. **`localStorage` never crosses devices, browsers, or origins.** This came up repeatedly:
   - Two different browsers on the *same* device (e.g. Safari vs Arc) have completely separate
     storage — not a bug, a hard OS/browser design.
   - A site added to the iOS Home Screen gets a separate storage context from the same site
     opened in a regular tab.
   - `http://localhost:8000` and `https://<lan-ip>:8443` are different origins even though
     they serve the identical files — no sync between them.
   - Two different physical devices visiting the identical URL each get their own,
     never-connected storage, always. There is no client-side trick around this — `localStorage`
     is never transmitted over the network by the browser, period. The only real fix is a
     backend (scoped in detail, not built — see §10).
3. **Head yaw is not compensated.** Turning the head produces the same iris-offset signal as
   moving the eyes, so "keep your head still" is load-bearing instruction, only partially
   backstopped by the head-movement rejection gate (which catches fast movement, not a held
   turned position).
4. **The dashboard passphrase is not real access control** — see §7.
5. **Notifications are foreground-only** and unsupported on iOS outside an installed
   home-screen app — see §6.
6. **Baseline gaming is mitigated, not eliminated.** The RMSE cap (§3) bounds how much a bad-
   faith baseline can be inflated, but doesn't prevent someone from establishing a
   consistently-mediocre-but-passing baseline across all their runs.
7. **Reaction-test lag/latency isn't compensated for anything** — unlike the pursuit test,
   there's no equivalent "is this task inherently harder on certain hardware" adjustment.
8. **No automated test suite.** All verification this session was manual/live browser testing
   (including a headless-script-driven browser pane and a real phone), not unit/integration
   tests.
9. **README.md is stale** relative to the current feature set (see §2 table).

## 9. Local development / testing setup used this session

- `python3 -m http.server 8000` for plain local testing (camera works — `localhost` is a
  secure context even over HTTP).
- A self-signed HTTPS server (Python + a manually generated cert via `openssl`, SAN covering
  `localhost`, `127.0.0.1`, and the current LAN IP) on port 8443, specifically so a real phone
  on the same network could get a secure context for the camera. This was necessary because
  `getUserMedia` requires HTTPS or `localhost`, and a phone can't reach `localhost` on a
  different machine. The LAN IP changes whenever the network changes (moved between a college
  Wi-Fi with client isolation — which blocked phone-to-laptop connections entirely, not fixable
  from software — and a personal hotspot, which worked). This cert/server setup is **local dev
  tooling, not part of the shipped app** — once deployed to GitHub Pages, a real HTTPS URL
  makes all of this unnecessary.

## 10. Explicitly scoped but NOT built

- **A real backend for cross-device sync.** Fully roadmapped (data model, API surface, auth,
  hosting options — BaaS like Supabase recommended over a custom server, given project size)
  with a time estimate (~1 day for a working MVP sync layer, +0.5–1 day for real push
  notifications, open-ended for hardening) but the user said to leave it for now.
- **Dashboard "Import JSON"** (the manual-transfer counterpart to the existing Export).
- **A "declared unfit to drive" feature off a wide-deviation baseline** — discussed at length;
  the user was walked through why baseline noise usually reflects setup problems (lighting,
  unfamiliarity) rather than fitness, asked to confirm severity/threshold specifics via a
  clarifying question, and the user dismissed the question without answering — **not built,
  no decision was made**, do not assume any behavior here.
- **A literal 2D "wave" pursuit path** (moving the stimulus vertically as well as
  horizontally) — discussed, the user was shown the tradeoff (vertical gaze isn't currently
  measured at all, and is inherently noisier to extract than horizontal from a 2D webcam), and
  told to leave it alone.

## 11. Deployment status

**Not yet deployed.** All work has been committed to a local git repository (`main` branch,
no remote configured yet) and tested only via local servers as described in §9. The user's
stated plan from the start of this project: test everything locally, then push to GitHub and
enable Pages when satisfied. That push has not happened yet as of this document.
