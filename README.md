# BlinkCheck

Browser-based smooth-pursuit and reaction-time screen for driver fatigue. Static files, no
build step, no server-side code.

- `index.html` — desktop layout (two-column: stage + instruments side by side).
- `mobile.html` — phone layout (single column, larger touch targets). Same `app.js` and
  `style.css`, plus `mobile.css` for the touch-specific overrides — the two pages share every
  element id, so the one script drives both.

## Deploy to GitHub Pages

```bash
git init
git add index.html mobile.html style.css mobile.css app.js README.md
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
before deploying, either serve over HTTPS locally or use a tunnel (e.g. `ngrok http 8000`).

## What it measures

| Symbol | Meaning |
| --- | --- |
| `a(t) = sin(ωt)` | stimulus position, normalised amplitude, ω = 2πf, f = 0.25 Hz |
| `ȧ(t) = ω·cos(ωt)` | stimulus velocity, analytic — never differentiated numerically |
| `g(t)` | iris x-offset from the eye-corner midpoint ÷ interocular distance |
| `k, g₀` | least-squares fit over the first 3 s so that `k(g − g₀) ≈ a` |
| `v̂ = k·dg/dt` | eye velocity, same units as `ȧ` |
| `RMSE` | `sqrt(mean((v̂ − ȧ)²))` over valid samples of the 12 s scoring window |

Derivatives use the least-squares slope of a 7-sample sliding window (Savitzky–Golay order 1),
not two-point differencing — at 60 fps the landmark noise floor would otherwise swamp the signal.

## Knobs worth turning during the hackathon

All in `CONFIG` at the top of `app.js`:

- `FAIL_RATIO` / `WARN_RATIO` — thresholds as a fraction of peak target speed ω. Currently
  0.55 and 0.35. These are guesses. Record five rested people, look at the RMSE distribution,
  and set the fail line a couple of standard deviations above the rested mean.
- `FREQ_HZ` — raise towards 0.5 Hz to make the task harder and widen the gap between rested
  and fatigued subjects. Above ~0.7 Hz even rested people substitute saccades.
- `SACCADE_ACC` — acceleration threshold for counting catch-up jumps. Check it against the
  `eye_acc` column of an exported CSV before you trust the number on screen.
- `EMA_ALPHA`, `DERIV_WINDOW` — the noise/latency trade-off. More smoothing lowers RMSE for
  everyone, so retune the thresholds if you touch these.

## Known limits (say these before a judge asks)

- Head **yaw** is not compensated. Turning the head produces the same iris offset as moving the
  eyes, so the instruction "head still" is load-bearing. Next step: use
  `outputFacialTransformationMatrixes: true` and subtract the yaw component.
- The gain `k` is fitted on the subject's own calibration window, so a subject who tracks badly
  from the first second gets a gain that partly absorbs their error. A fixed
  screen-geometry calibration would be stricter.
- Glasses glare and low light are the main causes of a void run.
- Not a medical device. It does not diagnose concussion or intoxication, and nothing here has
  been validated against a clinical reference.
