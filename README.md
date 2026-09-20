# BlinkCheck

A browser-based fatigue-screening prototype: two short tests — smooth-pursuit eye tracking and
visual reaction time — each giving a Pass / Borderline / Fail verdict. Built for a hackathon,
intended as a quick pre-shift self-check for drivers or anyone whose job requires alertness.

**Not a medical device.** It does not diagnose concussion, intoxication, or any condition, and
none of its thresholds have been validated against a clinical or population reference.

**100% client-side. No backend. No build step.** All camera processing and scoring happen
on-device — video never leaves the browser. Static HTML/CSS/JS only; persistence is
`localStorage`, which is why every profile lives on one browser/device only (see Limits below).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Desktop layout — two-column: stage + instruments side by side. |
| `mobile.html` | Phone layout — single column, larger touch targets, safe-area insets. Sets `window.BLINKCHECK_MOBILE = true` before loading `app.js` to trigger phone-only sensor recalibration. Shares every element `id` with `index.html`, so one script drives both. |
| `app.js` | All application logic — both tests, driver profiles, notifications, audio. One ES module, no bundler. |
| `style.css` | Shared styling: colors, stimulus/target shapes, verdict states, buttons. |
| `mobile.css` | Phone-only overrides layered on top of `style.css`. |
| `dashboard.html` / `dashboard.js` | Unlisted admin page — not linked from the main site. See Dashboard below. |

## Deploy to GitHub Pages

```bash
git init
git add index.html mobile.html style.css mobile.css app.js dashboard.html dashboard.js README.md
git commit -m "BlinkCheck prototype"
git branch -M main
git remote add origin https://github.com/<you>/blinkcheck.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → main / (root)**. Live at
`https://<you>.github.io/blinkcheck/` (desktop) and `https://<you>.github.io/blinkcheck/mobile.html`
(phone). HTTPS is mandatory — `getUserMedia` refuses to run on plain HTTP. For local work use
`python3 -m http.server` and open `http://localhost:8000` (localhost counts as a secure context;
opening `index.html` as a `file://` URL will not work, because ES modules and the camera both
need an origin).

**Testing on an actual phone against a local server**: `http://<your-laptop-IP>:8000` on your
phone is *not* a secure context — only `localhost` itself is exempt from the HTTPS requirement,
so the camera-based pursuit test won't get a permission prompt that way. The reaction test has
no such restriction and works fine over plain HTTP on the LAN. To test the camera on your phone
before deploying, either serve over HTTPS locally (self-signed cert) or use a tunnel (e.g.
`ngrok http 8000`).

**Fast demo mode**: append `?demo=true` to either page's URL to shorten both tests (2 s
calibration / 4 s scoring for pursuit, 4 targets for reaction) for a stage pitch — nothing else
about the scoring or gates changes.

## Test 1 — Smooth-pursuit eye tracking

- Stimulus: a dot moves horizontally as `a(t) = sin(ωt)`, `ω = 2π × 0.25 Hz` (one cycle every
  4 s — inside the range where healthy pursuit doesn't substitute saccades for smooth tracking).
- Eye position `g(t)`: horizontal iris offset from the eye-corner midpoint, divided by
  interocular distance — dimensionless, invariant to head translation and camera distance.
  Uses MediaPipe FaceLandmarker (CDN, WASM + GPU) for iris landmarks.
- **Calibration** (first 3 s): least-squares fit of gain `k` and offset `g0` so that
  `k·(g − g0) ≈ a`. Accepts either sign of `k` — a fixed mirror-sign assumption isn't safe
  across devices/browsers.
- **Scoring** (next 12 s): `RMSE = sqrt(mean((v̂ − ȧ)²))` of velocity error, **lag-compensated**
  by aligning eye/target velocity to the best-fit cross-correlation lag first (search capped at
  250 ms desktop / 600 ms mobile) — scoring against zero-latency stimulus velocity would count
  normal ~100–200 ms human reaction time as tracking error.
- Derivatives are the least-squares slope of an 11-sample sliding window (Savitzky–Golay order
  1), not two-point differencing — at 30–60 fps that noise floor would swamp the signal.
- **Anti-cheat gates**, in order: void if calibration failed or under 70% valid samples; fail
  outright if the eye-position/target correlation is below 0.5 desktop / 0.4 mobile (catches
  erratic movement that would otherwise look like low RMSE after smoothing); frames during fast
  head movement (over 0.5 interocular-widths/s) are discarded like a blink, since head yaw isn't
  compensated and an untracked head can forge a pursuit signal.
- **Baseline scoring**: the first valid run becomes that driver's personal baseline RMSE
  (capped at 1.25/s so a bad-faith first run can't inflate the reference too far). Later runs
  are scored as a ratio to it: **Pass under 1.2×, Borderline 1.2–1.3×, Fail at or above 1.3×**.
- CSV export of every raw sample (`downloadCsv()`), meant as the path to eventually replace
  these guessed thresholds with numbers from real rested/fatigued data.

## Test 2 — Reaction time

- 10 targets, one at a time, random position and random 600–2200 ms delay. Tap within 2000 ms
  or it's a miss; tapping empty space while nothing is shown is a false start.
- Scored on **median** reaction time (not mean — RT distributions are right-skewed, misses are
  tracked separately). Thresholds are fixed, not self-baselined: **Pass under 600 ms, Borderline
  600–700 ms, Fail at or above 700 ms**, plus more than 1 miss or more than 2 false starts fails
  regardless of RT.
- Hit detection uses `pointerdown`, not `click` — a real touch has enough finger movement
  between contact and release that mobile browsers can delay or cancel the synthesized click
  during gesture disambiguation, even when the tap visually landed correctly.
- CSV export of every target (`downloadReactionCsv()`): latency, spawn position, and
  miss/false-start events with position and timestamp.
- No audio cues on this test — they were tried and removed after repeated breakage on real
  devices; the pursuit test's completion beep and head-movement alert tone are unaffected.

## Driver profiles

Stored in `localStorage` under `blinkcheck.drivers.v1` — a **shared-device model** (e.g. a depot
kiosk), not a cloud account: a profile lives only on the browser/device it was created on. Each
profile tracks a baseline, per-test pass/borderline/fail/void counts, a capped history, and
strikes (one per Fail verdict on either test; Borderline doesn't strike). Both tests require an
active driver to be selected before they'll run.

## Dashboard

`dashboard.html` is unlisted and gated by a passphrase (`"admin"`, in `dashboard.js`) that is
**explicitly not real security** — visible in plain source, only stops casual stumbling. It
lets you: adjust score thresholds live (takes effect on the *next* page load of `index.html`/
`mobile.html`, not mid-session); browse/reset/delete driver profiles; seed a demo fleet of 3
fabricated profiles for a stage demo; and export/import the whole driver+settings state as JSON.

## Known limitations

- **Every threshold is a provisional guess**, not derived from real rested/fatigued population
  data. Both tests export CSVs as the intended path to eventually fix this.
- **`localStorage` never crosses devices, browsers, or origins.** Two browsers on the same
  device, an installed home-screen app vs. a regular tab, `localhost` vs. a LAN IP — each is a
  separate, non-shared store. A real backend would be needed for cross-device sync.
- Head yaw isn't compensated — only fast head *movement* is caught, not a held turn.
- Baseline gaming (a deliberately bad first pursuit run) is bounded by `BASELINE_RMSE_CAP` but
  not eliminated.
- Notifications are foreground-only (no backend means no true background push); unsupported on
  iOS Safari (and every iOS browser, since Apple mandates WebKit) outside an installed
  home-screen app.
- No automated test suite — verification has been manual, live-browser testing.
