/* =============================================================================
   BlinkCheck — smooth-pursuit fitness screen
   100% client-side. No build step. ES module, loaded directly by index.html.

   Measurement model
   -----------------
   Stimulus:  a(t) = sin(wt)                     normalised screen amplitude, a ∈ [-1, 1]
              ȧ(t) = w·cos(wt)                   analytic target velocity  [amplitude/s]
              w    = 2πf

   Eye:       g(t) = horizontal iris offset from the eye-corner midpoint,
                     divided by the interocular distance. Dimensionless, so it is
                     invariant to head translation and to distance from the camera.

   Calibration (first 3 s): least-squares fit of the scalar gain k and offset g0
              such that k·(g - g0) ≈ a.  This maps eye units onto stimulus units
              without ever asking the user to do a separate calibration ritual.

   Scoring (next 12 s):
              x̂(t)  = k·(g - g0)                          eye position, stimulus units
              v̂(t)  = k·dg/dt                             eye velocity  [amplitude/s]
              e(t)  = v̂(t) - ȧ(t)                         instantaneous velocity error
              RMSE  = sqrt( (1/N) Σ e² )   over valid samples only

   Derivatives are taken as the least-squares slope over a 7-sample sliding window
   (a Savitzky–Golay first derivative, order 1). Two-point differencing of a noisy
   landmark stream is unusable at 30–60 fps; the regression slope is not.
   ============================================================================= */

import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12";

/* ---------------------------------------------------------------- config -- */

const CONFIG = {
  FREQ_HZ:          0.25,   // stimulus frequency — 4 s per cycle, inside the range where
                            // healthy smooth pursuit runs without saccadic substitution
  AMPLITUDE_PCT:    42,     // half-width of travel, % of the stage width
  CALIBRATION_S:    3,
  TEST_S:           12,

  DERIV_WINDOW:     11,     // samples in the regression-slope window (~180 ms at 60 fps).
                            // Raised from 7: the calibration gain k (typically 8–12) multiplies
                            // landmark jitter as well as signal, and a 7-sample window left a
                            // noise floor of roughly 0.4–0.5 amplitude/s — on top of the warn line.
  EMA_ALPHA:        0.28,   // exponential smoothing on raw gaze (1 = no smoothing)

  EAR_BLINK:        0.21,   // eye-aspect-ratio below this = lid closed
  BLINK_BLANK_MS:   180,    // samples discarded after a blink, while the iris re-settles

  // Head yaw is not compensated (see README) — turning or shaking the head moves the
  // iris estimate exactly like moving the eyes does, so an untracked head can forge a
  // pursuit signal. Rather than estimate yaw, treat a fast-moving head reference point
  // as invalid data, the same way a blink already is: real pursuit happens with the
  // head still, so head speed above this is not a sample to score, it's noncompliance.
  HEAD_MOVE_LIMIT:  0.5,     // head-centre speed, interocular-widths/s, above which a frame is discarded
  HEAD_BLANK_MS:    150,     // samples discarded after a head-movement spike, while it settles
  HEAD_EMA_ALPHA:   0.25,    // smoothing on the head-centre point before its speed is measured

  // --- within-subject scoring (primary) ---
  // Smooth-pursuit quality varies hugely between healthy people: eye colour, glasses,
  // camera, seating distance. Any fixed line is wrong for someone. So the first scored
  // run becomes that person's rested baseline and later runs are judged against it.
  // Bumped to v2: the RMSE formula changed (lag-compensated), so a baseline
  // recorded under v1 is on a different scale and would silently make every
  // later run look better than it is. Versioning the key invalidates it and
  // forces a fresh baseline under the current formula.
  BASELINE_KEY:     "blinkcheck.baseline.v2",
  WARN_MULT:        1.2,    // RMSE ≥ 1.2 × baseline  → borderline
  FAIL_MULT:        1.5,    // RMSE ≥ 1.5 × baseline  → fail

  // --- absolute fallback, used only when no baseline is stored ---
  // Fractions of the peak target speed w. Provisional; the baseline path is the real test.
  FAIL_RATIO:       0.95,
  WARN_RATIO:       0.70,

  SACCADE_ACC:      40,     // |eye acceleration| above this = corrective jump [amplitude/s²]
  SACCADE_REFRACT:  0.12,   // s, minimum gap between counted saccades
  MIN_VALID_FRAC:   0.70,   // below this the run is void, not a fail

  // Pearson correlation between eye position and the lag-shifted target position.
  // Real pursuit — even noisy, laggy, fatigued pursuit — still follows the target's
  // slow back-and-forth path, so this stays high. Random/erratic eye movement does
  // not. Gated independently of the RMSE ratio because RMSE alone can't be trusted
  // here: EMA smoothing + the derivative window low-pass most fast jitter down to
  // near zero, which drags velocity RMSE down too, not up, exactly when the driver
  // isn't tracking at all.
  MIN_CORR:         0.5,

  // Search range for the cross-correlation lag used to compensate RMSE for reaction
  // time. Capped near the upper end of normal smooth-pursuit latency (~100-200 ms) —
  // wide enough to stop a healthy driver's ordinary lag from reading as error, but
  // not so wide that genuinely slow/delayed tracking (the fatigue signal this test
  // exists to catch) gets fully absorbed and disappears from the score.
  MAX_LAG_MS:       250,
  LAG_STEP_MS:      10,

  CHART_MS:         80,     // chart refresh interval
  CHART_POINTS:     220
};

const W           = 2 * Math.PI * CONFIG.FREQ_HZ;   // angular frequency [rad/s]
const FAIL_RMSE   = CONFIG.FAIL_RATIO * W;
const WARN_RMSE   = CONFIG.WARN_RATIO * W;
const TOTAL_S     = CONFIG.CALIBRATION_S + CONFIG.TEST_S;

// A front-facing webcam inverts left/right: looking towards physical screen-right
// moves the iris towards decreasing x in the raw camera image.
const CAMERA_X_FLIP = -1;

// MediaPipe FaceLandmarker returns 478 points; 468–477 are the refined irises.
const LM = {
  IRIS_L: 468, IRIS_R: 473,
  L_OUT: 33,  L_IN: 133,  L_TOP: 159, L_BOT: 145,
  R_IN: 362,  R_OUT: 263, R_TOP: 386, R_BOT: 374
};

/* ------------------------------------------------------------------- dom -- */

const $ = (id) => document.getElementById(id);
const el = {
  video: $("webcam"), overlay: $("overlay"), dot: $("dot"), stage: $("stage"),
  stageMsg: $("stageMsg"), stageTitle: $("stageTitle"), stageSub: $("stageSub"),
  phaseLabel: $("phaseLabel"), clock: $("clock"), progress: $("progress"),
  btnCamera: $("btnCamera"), btnStart: $("btnStart"), btnAbort: $("btnAbort"),
  btnCsv: $("btnCsv"), btnBaseline: $("btnBaseline"),
  mBase: $("mBase"), mRatio: $("mRatio"),
  hint: $("hint"), fps: $("fps"),
  verdict: $("verdict"), verdictText: $("verdictText"), verdictDetail: $("verdictDetail"),
  mRmse: $("mRmse"), mGain: $("mGain"), mLag: $("mLag"),
  mSacc: $("mSacc"), mBlink: $("mBlink"), mValid: $("mValid"),
  cfgFreq: $("cfgFreq"), cfgPeak: $("cfgPeak")
};
const ctx2d = el.overlay.getContext("2d");

el.cfgFreq.textContent = CONFIG.FREQ_HZ.toFixed(2);
el.cfgPeak.textContent = W.toFixed(2);

/* ----------------------------------------------------------------- state -- */

const PHASE = { IDLE: "idle", READY: "ready", CALIBRATING: "calibrating", TESTING: "testing", DONE: "done" };

const state = {
  phase: PHASE.IDLE,
  landmarker: null,
  stream: null,
  running: false,
  lastVideoTime: -1,
  t0: 0,                 // performance.now() at test start
  // rolling buffers
  gaze: [],              // {t, g} smoothed gaze, used for differentiation
  vel:  [],              // {t, v} eye velocity, used for acceleration
  samples: [],           // every frame of the whole run, for scoring + CSV
  // calibration accumulators
  cal: { n: 0, sg: 0, sa: 0, sgg: 0, sga: 0, k: 1, g0: 0, ok: false },
  emaGaze: null,
  emaHead: null,
  blankUntil: 0,
  lastSaccadeT: -1,
  blinks: 0, blinkOpen: true,
  prevHeadCenter: null, prevHeadT: null,
  fpsFrames: 0, fpsT0: 0,
  lastChartT: 0
};

/* ------------------------------------------------------------ math utils -- */

const px  = (lm, i, w, h) => ({ x: lm[i].x * w, y: lm[i].y * h });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Least-squares slope (dy/dt) over the last n entries of a {t, <key>} buffer.
 *  This is the derivative estimator; a plain two-point difference is far noisier. */
function regressionSlope(buf, key, n) {
  const m = Math.min(n, buf.length);
  if (m < 3) return 0;
  const start = buf.length - m;
  const t0 = buf[start].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = start; i < buf.length; i++) {
    const x = buf[i].t - t0;
    const y = buf[i][key];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const den = m * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return 0;
  return (m * sxy - sx * sy) / den;
}

/** Pearson correlation of two equal-length arrays. */
function pearson(a, b) {
  const n = a.length;
  if (n < 8) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den < 1e-12 ? 0 : num / den;
}

/* ------------------------------------------------------------- stimulus -- */

/** Normalised stimulus position, a(t) = sin(wt). */
const targetPos = (t) => Math.sin(W * t);
/** Analytic stimulus velocity, ȧ(t) = w·cos(wt). This is exact — no differentiation. */
const targetVel = (t) => W * Math.cos(W * t);

function renderDot(t) {
  el.dot.style.left = (50 + CONFIG.AMPLITUDE_PCT * targetPos(t)) + "%";
}

/* --------------------------------------------------------------- camera -- */

async function initCamera() {
  el.btnCamera.disabled = true;
  setStage("Starting camera", "Allow camera access when the browser asks.");
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false
    });
  } catch (err) {
    el.btnCamera.disabled = false;
    setStage("Camera blocked", "The browser refused camera access. Allow it in the address-bar permission menu, then press the button again. The page must be served over HTTPS or from localhost.");
    return;
  }
  el.video.srcObject = state.stream;
  await new Promise((res) => el.video.addEventListener("loadeddata", res, { once: true }));
  await el.video.play();

  el.overlay.width  = el.video.videoWidth;
  el.overlay.height = el.video.videoHeight;

  setStage("Loading face model", "Downloading MediaPipe FaceLandmarker (about 7 MB, cached after the first run).");
  try {
    await initLandmarker();
  } catch (err) {
    console.error(err);
    el.btnCamera.disabled = false;
    setStage("Model failed to load",
      "The face model or its WebAssembly runtime could not be fetched. Check the network connection and reload. On a corporate network, cdn.jsdelivr.net and storage.googleapis.com must be reachable.");
    return;
  }

  state.phase = PHASE.READY;
  state.running = true;
  state.fpsT0 = performance.now();
  el.btnCamera.textContent = "Camera on";
  el.btnStart.disabled = false;
  el.hint.textContent = "Sit an arm's length away. Head still, eyes only.";
  setStage("Ready", "Press start, then follow the red dot with your eyes. Do not turn your head.");
  requestAnimationFrame(loop);
}

async function initLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm"
  );
  state.landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false
  });
}

/* ------------------------------------------------------- gaze extraction -- */

/** Returns {gaze, ear, iris, ok} in a head-translation-invariant, scale-free frame. */
function extractGaze(lm, w, h) {
  const irisL = px(lm, LM.IRIS_L, w, h);
  const irisR = px(lm, LM.IRIS_R, w, h);
  const lOut = px(lm, LM.L_OUT, w, h), lIn = px(lm, LM.L_IN, w, h);
  const rIn  = px(lm, LM.R_IN,  w, h), rOut = px(lm, LM.R_OUT, w, h);

  const lCentre = mid(lOut, lIn);
  const rCentre = mid(rIn, rOut);
  const interocular = dist(lCentre, rCentre);
  if (!isFinite(interocular) || interocular < 1) return { ok: false };

  // Iris displacement from its own eye's corner midpoint, in interocular units.
  const gl = (irisL.x - lCentre.x) / interocular;
  const gr = (irisR.x - rCentre.x) / interocular;

  // Eye aspect ratio — collapses towards 0 during a blink, when the iris estimate is junk.
  const earL = dist(px(lm, LM.L_TOP, w, h), px(lm, LM.L_BOT, w, h)) / dist(lOut, lIn);
  const earR = dist(px(lm, LM.R_TOP, w, h), px(lm, LM.R_BOT, w, h)) / dist(rIn, rOut);

  return {
    ok: true,
    gaze: CAMERA_X_FLIP * (gl + gr) / 2,
    ear: (earL + earR) / 2,
    iris: [irisL, irisR],
    corners: [lOut, lIn, rIn, rOut],
    // Head reference point, for detecting head movement (see HEAD_MOVE_LIMIT).
    // Not yaw-corrected — just "is the head drifting/shaking", not "which way is it turned".
    headCenter: mid(lCentre, rCentre),
    interocular
  };
}

function drawOverlay(g) {
  const c = ctx2d;
  c.clearRect(0, 0, el.overlay.width, el.overlay.height);
  if (!g || !g.ok) return;
  c.fillStyle = "#38E1C9";
  for (const p of g.iris) {
    c.beginPath(); c.arc(p.x, p.y, 4, 0, Math.PI * 2); c.fill();
  }
  c.strokeStyle = "rgba(56,225,201,0.45)";
  c.lineWidth = 2;
  c.beginPath(); c.moveTo(g.corners[0].x, g.corners[0].y); c.lineTo(g.corners[1].x, g.corners[1].y); c.stroke();
  c.beginPath(); c.moveTo(g.corners[2].x, g.corners[2].y); c.lineTo(g.corners[3].x, g.corners[3].y); c.stroke();
}

/* ------------------------------------------------------------- main loop -- */

function loop() {
  if (!state.running) return;
  const now = performance.now();

  // --- FPS ---
  state.fpsFrames++;
  if (now - state.fpsT0 > 500) {
    el.fps.textContent = Math.round(state.fpsFrames * 1000 / (now - state.fpsT0)) + " fps";
    state.fpsFrames = 0; state.fpsT0 = now;
  }

  // --- inference (only when the camera produced a new frame) ---
  let gazeInfo = null;
  if (el.video.currentTime !== state.lastVideoTime && el.video.readyState >= 2) {
    state.lastVideoTime = el.video.currentTime;
    const result = state.landmarker.detectForVideo(el.video, now);
    if (result.faceLandmarks && result.faceLandmarks.length) {
      gazeInfo = extractGaze(result.faceLandmarks[0], el.overlay.width, el.overlay.height);
    }
    drawOverlay(gazeInfo);
  }

  if (state.phase === PHASE.CALIBRATING || state.phase === PHASE.TESTING) {
    const t = (now - state.t0) / 1000;
    renderDot(t);
    processSample(t, now, gazeInfo);
    updateClock(t);
    if (t >= TOTAL_S) finishTest();
  }

  requestAnimationFrame(loop);
}

/* ----------------------------------------------------- kinematics engine -- */

function processSample(t, nowMs, info) {
  const aPos = targetPos(t);
  const aVel = targetVel(t);

  // Face lost, or lids closed: mark the sample unusable and blank the recovery window.
  if (!info || !info.ok) {
    pushSample(t, aPos, aVel, null, null, null, false, "noface");
    return;
  }
  if (info.ear < CONFIG.EAR_BLINK) {
    if (state.blinkOpen) { state.blinks++; state.blinkOpen = false; }
    state.blankUntil = nowMs + CONFIG.BLINK_BLANK_MS;
    pushSample(t, aPos, aVel, null, null, null, false, "blink");
    return;
  }
  state.blinkOpen = true;

  // Head movement: compare this frame's head-centre position against the last one,
  // in interocular widths per second so it stays comparable across distance from the
  // camera. A fast-moving head is discarded the same way a blink is — it isn't eye
  // tracking data, whatever gaze offset it produces.
  // The head centre is EMA-smoothed first, same reason the gaze signal is: raw
  // landmark jitter, two-point-differenced at 30-60 fps, is noise, not motion, and
  // would otherwise trip this on nearly every frame of an honest run.
  state.emaHead = state.emaHead === null
    ? info.headCenter
    : {
        x: CONFIG.HEAD_EMA_ALPHA * info.headCenter.x + (1 - CONFIG.HEAD_EMA_ALPHA) * state.emaHead.x,
        y: CONFIG.HEAD_EMA_ALPHA * info.headCenter.y + (1 - CONFIG.HEAD_EMA_ALPHA) * state.emaHead.y
      };
  const headNow = state.emaHead;

  if (state.prevHeadCenter !== null && info.interocular > 0) {
    const dtHead = t - state.prevHeadT;
    if (dtHead > 0) {
      const headSpeed = dist(headNow, state.prevHeadCenter) / info.interocular / dtHead;
      if (headSpeed > CONFIG.HEAD_MOVE_LIMIT) {
        state.prevHeadCenter = headNow;
        state.prevHeadT = t;
        state.blankUntil = nowMs + CONFIG.HEAD_BLANK_MS;
        pushSample(t, aPos, aVel, null, null, null, false, "headmove");
        return;
      }
    }
  }
  state.prevHeadCenter = headNow;
  state.prevHeadT = t;

  // Exponential smoothing of the raw gaze signal before differentiation.
  state.emaGaze = state.emaGaze === null
    ? info.gaze
    : CONFIG.EMA_ALPHA * info.gaze + (1 - CONFIG.EMA_ALPHA) * state.emaGaze;
  const g = state.emaGaze;

  state.gaze.push({ t, g });
  if (state.gaze.length > 90) state.gaze.shift();

  const gDot = regressionSlope(state.gaze, "g", CONFIG.DERIV_WINDOW);   // dg/dt, eye units/s

  // --- calibration phase: accumulate the least-squares fit k·(g - g0) ≈ a ---
  if (state.phase === PHASE.CALIBRATING) {
    const c = state.cal;
    c.n++; c.sg += g; c.sa += aPos; c.sgg += g * g; c.sga += g * aPos;
    pushSample(t, aPos, aVel, g, null, null, false, "calib");
    if (t >= CONFIG.CALIBRATION_S) closeCalibration();
    return;
  }

  // --- scoring phase ---
  const k = state.cal.k;
  const eyePos = k * (g - state.cal.g0);
  const eyeVel = k * gDot;

  state.vel.push({ t, v: eyeVel });
  if (state.vel.length > 90) state.vel.shift();
  const eyeAcc = regressionSlope(state.vel, "v", CONFIG.DERIV_WINDOW);

  const valid = nowMs > state.blankUntil && state.cal.ok;

  // Catch-up saccade: a burst of acceleration well outside anything the
  // stimulus demands (peak stimulus acceleration is w² ≈ 2.47 amplitude/s²).
  if (valid && Math.abs(eyeAcc) > CONFIG.SACCADE_ACC && (t - state.lastSaccadeT) > CONFIG.SACCADE_REFRACT) {
    state.lastSaccadeT = t;
    state.saccades = (state.saccades || 0) + 1;
  }

  pushSample(t, aPos, aVel, g, eyePos, eyeVel, valid, "test", eyeAcc);
  maybeUpdateChart(t, eyeVel, aVel, nowMs);
}

function pushSample(t, aPos, aVel, g, eyePos, eyeVel, valid, tag, eyeAcc = null) {
  state.samples.push({ t, aPos, aVel, g, eyePos, eyeVel, eyeAcc, valid, tag });
}

function closeCalibration() {
  const c = state.cal;
  if (c.n < 20) { c.ok = false; }
  else {
    const mg = c.sg / c.n, ma = c.sa / c.n;
    const varG = c.sgg / c.n - mg * mg;
    const covGA = c.sga / c.n - mg * ma;
    c.g0 = mg;
    c.k = varG > 1e-8 ? covGA / varG : 0;
    // A sane pursuit must move the irises in the same direction as the dot,
    // by a measurable amount. Anything else means the face was not tracked.
    c.ok = isFinite(c.k) && c.k > 0.5 && c.k < 400;
  }
  state.phase = PHASE.TESTING;
  el.phaseLabel.textContent = "2 · Tracking";
  if (!c.ok) {
    el.hint.textContent = "Calibration is weak — the run may come back void. Improve the lighting and keep your head still.";
  }
}

/* -------------------------------------------------------------- baseline -- */
/* Stored per browser profile in localStorage. One device per driver is the
   assumption; a real fleet deployment would key this to a driver ID instead. */

function loadBaseline() {
  try {
    const raw = localStorage.getItem(CONFIG.BASELINE_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw);
    return (b && isFinite(b.rmse) && b.rmse > 0) ? b : null;
  } catch { return null; }
}

function saveBaseline(r) {
  const b = { rmse: r.rmse, gain: r.gain, lagMs: r.lagMs, recorded: new Date().toISOString() };
  try { localStorage.setItem(CONFIG.BASELINE_KEY, JSON.stringify(b)); } catch { /* private mode */ }
  return b;
}

function clearBaseline() {
  try { localStorage.removeItem(CONFIG.BASELINE_KEY); } catch { /* ignore */ }
  showBaseline();
  setVerdict("void", "Baseline cleared", "The next scored run becomes the new rested baseline. Record it while the driver is alert.");
}

function showBaseline() {
  const b = loadBaseline();
  el.mBase.innerHTML = b ? b.rmse.toFixed(3) + '<small> /s</small>' : "not set";
  el.btnBaseline.disabled = !b;
}

/* --------------------------------------------------------------- scoring -- */

function scoreRun() {
  const test = state.samples.filter((s) => s.tag === "test");
  const good = test.filter((s) => s.valid && s.eyeVel !== null);
  const validFrac = test.length ? good.length / test.length : 0;

  if (!state.cal.ok || good.length < 60 || validFrac < CONFIG.MIN_VALID_FRAC) {
    return { void: true, validFrac, rmse: NaN, gain: NaN, lagMs: NaN, saccRate: NaN };
  }

  // Pursuit gain: projection of eye position onto the stimulus,  Σ(x̂·a)/Σ(a²)
  let sxa = 0, saa = 0;
  for (const s of good) { sxa += s.eyePos * s.aPos; saa += s.aPos * s.aPos; }
  const gain = saa > 1e-9 ? sxa / saa : NaN;

  // Tracking lag: shift the stimulus back in time until it best correlates with the eye.
  // No human visual-motor system has zero latency — normal smooth-pursuit reaction
  // time is on the order of 100-200 ms — so this has to be measured, not assumed away.
  const dt = (good[good.length - 1].t - good[0].t) / (good.length - 1);
  const maxLagN = Math.round((CONFIG.MAX_LAG_MS / 1000) / dt);
  const stepN = Math.max(1, Math.round((CONFIG.LAG_STEP_MS / 1000) / dt));
  const eyeSeries = good.map((s) => s.eyePos);
  let bestR = -2, bestLag = 0;
  for (let L = 0; L <= maxLagN; L += stepN) {
    const a = eyeSeries.slice(L);
    const b = good.slice(0, good.length - L).map((s) => s.aPos);
    const r = pearson(a, b);
    if (r > bestR) { bestR = r; bestLag = L; }
  }
  const lagMs = bestLag * dt * 1000;

  // RMSE of the velocity error e(t) = v̂(t) - ȧ(t), AFTER aligning for that lag.
  // Scoring against the zero-latency stimulus velocity would count a driver's fixed,
  // healthy reaction time as tracking error every time the dot changes direction —
  // exactly the "no human can pass this" failure mode. What should actually cost
  // points is scatter and gain error around the lagged fit, which is what fatigue
  // degrades.
  const eyeVelAligned = good.slice(bestLag).map((s) => s.eyeVel);
  const aVelAligned = good.slice(0, good.length - bestLag).map((s) => s.aVel);
  let sse = 0;
  for (let i = 0; i < eyeVelAligned.length; i++) {
    const e = eyeVelAligned[i] - aVelAligned[i];
    sse += e * e;
  }
  const rmse = Math.sqrt(sse / eyeVelAligned.length);

  const duration = good[good.length - 1].t - good[0].t;
  const saccRate = (state.saccades || 0) / Math.max(duration, 0.001);

  return { void: false, validFrac, rmse, gain, lagMs, saccRate, corr: bestR };
}

/* --------------------------------------------------------- test lifecycle -- */

function startTest() {
  // reset
  state.samples = []; state.gaze = []; state.vel = [];
  state.cal = { n: 0, sg: 0, sa: 0, sgg: 0, sga: 0, k: 1, g0: 0, ok: false };
  state.emaGaze = null; state.emaHead = null; state.blankUntil = 0; state.lastSaccadeT = -1;
  state.saccades = 0; state.blinks = 0; state.blinkOpen = true;
  state.prevHeadCenter = null; state.prevHeadT = null;
  resetChart();
  setMetrics(null);
  setVerdict("void", "Running", "Follow the dot. Keep your head still.");

  state.t0 = performance.now();
  state.phase = PHASE.CALIBRATING;
  el.dot.classList.remove("hidden");
  el.stageMsg.classList.add("hidden");
  el.phaseLabel.textContent = "1 · Calibrating";
  el.btnStart.disabled = true;
  el.btnAbort.classList.remove("hidden");
  el.btnCsv.disabled = true;
}

function abortTest(message) {
  state.phase = PHASE.READY;
  el.dot.classList.add("hidden");
  el.btnStart.disabled = false;
  el.btnAbort.classList.add("hidden");
  el.progress.style.width = "0%";
  el.phaseLabel.textContent = "Standby";
  setStage("Stopped", message || "Test stopped. Press start when you are ready to go again.");
}

function finishTest() {
  state.phase = PHASE.DONE;
  el.dot.classList.add("hidden");
  el.btnStart.disabled = false;
  el.btnStart.textContent = "Run the test again";
  el.btnAbort.classList.add("hidden");
  el.btnCsv.disabled = false;
  el.phaseLabel.textContent = "3 · Scored";
  el.progress.style.width = "100%";

  const r = scoreRun();
  setMetrics(r);

  if (r.void) {
    setVerdict("void", "Void",
      "Not enough usable eye data to score this run. Brighten the room, remove glare from glasses, sit closer, and keep your head still.");
    setStage("Void", "The run could not be scored. Try again with better lighting and a still head.");
    return;
  }

  // Gate on correlation before anything baseline-relative even runs. This catches
  // eye movement that doesn't follow the target's path at all — including a first
  // run bad enough that it would otherwise get accepted as the baseline and make
  // every later equally-bad run look fine by comparison.
  if (r.corr < CONFIG.MIN_CORR) {
    el.mRatio.textContent = "—";
    setVerdict("fail", "Fail",
      `Eye position barely tracks the target's path (correlation ${r.corr.toFixed(2)}, need ${CONFIG.MIN_CORR}). This isn't smooth pursuit. Follow the dot continuously with your eyes only.`);
    setStage("Scored", "Results are on the right. Press start to run it again.");
    return;
  }

  const baseline = loadBaseline();

  // --- first valid run: record the rested baseline, do not judge it ---
  if (!baseline) {
    const b = saveBaseline(r);
    showBaseline();
    el.mRatio.textContent = "—";
    // Absolute thresholds survive only as a sanity check on the baseline itself:
    // a "rested" run this poor usually means bad tracking, not a bad driver.
    const suspect = r.rmse >= FAIL_RMSE || r.gain < 0.6 || r.lagMs > 400;
    setVerdict("void", "Baseline recorded",
      `This run is now the reference for this device: RMSE ${b.rmse.toFixed(3)} /s, gain ${r.gain.toFixed(2)}, lag ${Math.round(r.lagMs)} ms. It only means anything if the driver was alert when it was taken.` +
      (suspect
        ? " These numbers look poor for a rested run — check lighting, glasses glare and head stillness, then reset the baseline and record it again."
        : " Retest later and the result is judged against this number."));
    setStage("Baseline recorded", "Run the test again to compare against it.");
    return;
  }

  // --- later runs: judged against the person's own rested number ---
  const ratio = r.rmse / baseline.rmse;
  el.mRatio.innerHTML = ratio.toFixed(2) + '<small> ×</small>';

  if (ratio >= CONFIG.FAIL_MULT) {
    setVerdict("fail", "Fail",
      `Velocity error is ${ratio.toFixed(2)}× this driver's rested baseline, past the ${CONFIG.FAIL_MULT}× line. Pursuit is breaking into corrective jumps. Do not drive; get a proper assessment.`);
  } else if (ratio >= CONFIG.WARN_MULT) {
    setVerdict("watch", "Borderline",
      `Velocity error is ${ratio.toFixed(2)}× baseline, between the ${CONFIG.WARN_MULT}× and ${CONFIG.FAIL_MULT}× lines. Rest and retest before a long shift.`);
  } else {
    setVerdict("pass", "Pass",
      `Velocity error is ${ratio.toFixed(2)}× baseline, gain ${r.gain.toFixed(2)}, lag ${Math.round(r.lagMs)} ms. Pursuit is holding up.`);
  }
  setStage("Scored", "Results are on the right. Press start to run it again.");
}

/* ------------------------------------------------------------------- ui --- */

function setStage(title, sub) {
  el.stageTitle.textContent = title;
  el.stageSub.textContent = sub;
  el.stageMsg.classList.remove("hidden");
}

function updateClock(t) {
  el.clock.textContent = t.toFixed(1) + " s";
  el.progress.style.width = clamp(t / TOTAL_S * 100, 0, 100) + "%";
}

function setVerdict(kind, text, detail) {
  el.verdict.classList.remove("verdict-pass", "verdict-watch", "verdict-fail", "verdict-void");
  el.verdict.classList.add("verdict-" + kind);
  el.verdictText.textContent = text;
  el.verdictDetail.textContent = detail;
}

function setMetrics(r) {
  const dash = "—";
  if (!r) {
    el.mRmse.textContent = dash; el.mGain.textContent = dash; el.mLag.textContent = dash;
    el.mSacc.textContent = dash; el.mBlink.textContent = dash; el.mValid.textContent = dash;
    el.mRatio.textContent = dash;
    return;
  }
  el.mBlink.textContent = String(state.blinks);
  el.mValid.textContent = (r.validFrac * 100).toFixed(0) + "%";
  if (r.void) {
    el.mRmse.textContent = dash; el.mGain.textContent = dash;
    el.mLag.textContent = dash;  el.mSacc.textContent = dash;
    el.mRatio.textContent = dash;
    return;
  }
  el.mRmse.innerHTML = r.rmse.toFixed(3) + '<small> /s</small>';
  el.mGain.textContent = r.gain.toFixed(2);
  el.mLag.innerHTML = Math.round(r.lagMs) + '<small> ms</small>';
  el.mSacc.innerHTML = r.saccRate.toFixed(2) + '<small> /s</small>';
}

/* ---------------------------------------------------------------- chart --- */

const chart = new Chart($("velChart").getContext("2d"), {
  type: "line",
  data: {
    labels: [],
    datasets: [
      { label: "Eye", data: [], borderColor: "#38E1C9", borderWidth: 2, pointRadius: 0, tension: 0.2 },
      { label: "Target", data: [], borderColor: "#FF3B30", borderWidth: 2, pointRadius: 0, tension: 0.2, borderDash: [6, 4] }
    ]
  },
  options: {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: "index" },
    scales: {
      x: {
        ticks: { color: "#7E97A9", maxTicksLimit: 8 },
        grid: { color: "rgba(28,46,61,0.7)" },
        title: { display: true, text: "time (s)", color: "#7E97A9" }
      },
      y: {
        suggestedMin: -2.5, suggestedMax: 2.5,
        ticks: { color: "#7E97A9" },
        grid: { color: "rgba(28,46,61,0.7)" },
        title: { display: true, text: "velocity (amplitude/s)", color: "#7E97A9" }
      }
    },
    plugins: { legend: { labels: { color: "#E7EEF4", boxWidth: 14 } } }
  }
});

function maybeUpdateChart(t, eyeVel, aVel, nowMs) {
  if (nowMs - state.lastChartT < CONFIG.CHART_MS) return;
  state.lastChartT = nowMs;
  chart.data.labels.push(t.toFixed(1));
  chart.data.datasets[0].data.push(eyeVel);
  chart.data.datasets[1].data.push(aVel);
  if (chart.data.labels.length > CONFIG.CHART_POINTS) {
    chart.data.labels.shift();
    chart.data.datasets.forEach((d) => d.data.shift());
  }
  chart.update("none");
}

function resetChart() {
  chart.data.labels = [];
  chart.data.datasets.forEach((d) => (d.data = []));
  chart.update("none");
}

/* ------------------------------------------------------------------ csv --- */

function downloadCsv() {
  const head = "t_s,target_pos,target_vel,gaze_raw_units,eye_pos,eye_vel,eye_acc,valid,phase\n";
  const body = state.samples.map((s) => [
    s.t.toFixed(4),
    s.aPos.toFixed(5),
    s.aVel.toFixed(5),
    s.g === null ? "" : s.g.toFixed(6),
    s.eyePos === null ? "" : s.eyePos.toFixed(5),
    s.eyeVel === null ? "" : s.eyeVel.toFixed(5),
    s.eyeAcc === null ? "" : s.eyeAcc.toFixed(5),
    s.valid ? 1 : 0,
    s.tag
  ].join(",")).join("\n");

  const blob = new Blob([head + body], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `blinkcheck-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------- wiring -- */

el.btnCamera.addEventListener("click", initCamera);
el.btnStart.addEventListener("click", () => {
  if (state.phase === PHASE.READY || state.phase === PHASE.DONE) startTest();
});
el.btnAbort.addEventListener("click", () => abortTest());
el.btnCsv.addEventListener("click", downloadCsv);
el.btnBaseline.addEventListener("click", clearBaseline);

showBaseline();

document.addEventListener("visibilitychange", () => {
  if (document.hidden && (state.phase === PHASE.CALIBRATING || state.phase === PHASE.TESTING)) {
    abortTest("The tab lost focus, so the run was discarded. Start again with this tab in front.");
  }
});

window.addEventListener("beforeunload", () => {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
});
