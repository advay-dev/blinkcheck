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
  // run becomes that driver's rested baseline (now stored on their profile — see the
  // "driver profiles" section below) and later runs are judged against it.
  WARN_MULT:        1.2,    // RMSE ≥ 1.2 × baseline  → borderline
  FAIL_MULT:        1.3,    // RMSE ≥ 1.3 × baseline  → fail

  // Ceiling on the RMSE actually SAVED as the baseline. Baseline-relative scoring means
  // whoever sets the baseline controls the bar for every later run — a driver could
  // otherwise give a deliberately bad first run and make every future bad run compare
  // fine against it. Capping the saved value bounds how much that's worth doing: the run
  // still gets accepted and the "suspect" warning still fires, but the number it leaves
  // behind can't be inflated past this line.
  BASELINE_RMSE_CAP: 1.25,

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

// Phone-only recalibration. mobile.html sets window.BLINKCHECK_MOBILE = true in a plain
// script before this one loads; index.html never sets it, so IS_MOBILE is false there and
// none of this runs — desktop behaviour is unchanged, on purpose.
//
// On-device face-landmark inference is real work, and phone GPUs (often weaker, sometimes
// thermally throttled) can take meaningfully longer per frame than a laptop's, adding system
// latency on top of ordinary human reaction time. The lag-compensation search below was tuned
// against laptop timing (see MAX_LAG_MS's own comment): if a phone's true combined lag exceeds
// that search window, genuinely correct tracking can't be aligned, reads as uncorrelated, and
// fails the MIN_CORR gate even though the driver is actually tracking the dot. Widen the search
// and give a little more correlation margin to compensate — these are provisional numbers
// (no real phone-hardware measurements behind them yet), same caveat as everything else here.
const IS_MOBILE = typeof window !== "undefined" && window.BLINKCHECK_MOBILE === true;
if (IS_MOBILE) {
  CONFIG.MAX_LAG_MS = 600;
  CONFIG.MIN_CORR = 0.4;
}

// Fast demo mode: ?demo=true shortens both tests for a stage pitch, nothing else changes —
// same scoring logic, same gates, just less time spent per run. Explicit URL flag only, so
// it can never accidentally affect a real test.
const DEMO_MODE = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("demo") === "true";
if (DEMO_MODE) {
  CONFIG.CALIBRATION_S = 2;
  CONFIG.TEST_S = 4;
}

// Dashboard-configurable score thresholds (dashboard.html's "Score thresholds" panel).
// Read once at load; a change made in the dashboard takes effect on this page's next
// load, not live mid-session. Falls back to the CONFIG/REACTION_CONFIG defaults above
// when nothing has been saved, or when a saved value doesn't parse as a finite number.
function loadThresholdOverrides() {
  try {
    const raw = localStorage.getItem("blinkcheck.thresholds.v1");
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
const thresholdOverrides = loadThresholdOverrides();
if (isFinite(thresholdOverrides.pursuitWarnMult)) CONFIG.WARN_MULT = thresholdOverrides.pursuitWarnMult;
if (isFinite(thresholdOverrides.pursuitFailMult)) CONFIG.FAIL_MULT = thresholdOverrides.pursuitFailMult;

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
  video: $("webcam"), overlay: $("overlay"), dot: $("dot"), stage: $("stage"), headWarning: $("headWarning"),
  stageMsg: $("stageMsg"), stageTitle: $("stageTitle"), stageSub: $("stageSub"),
  phaseLabel: $("phaseLabel"), clock: $("clock"), progress: $("progress"),
  btnCamera: $("btnCamera"), btnStart: $("btnStart"), btnAbort: $("btnAbort"),
  btnCsv: $("btnCsv"), btnBaseline: $("btnBaseline"), btnReactionCsv: $("btnReactionCsv"),
  mBase: $("mBase"), mRatio: $("mRatio"), mRatioHint: $("mRatioHint"),
  hint: $("hint"), fps: $("fps"),
  verdict: $("verdict"), verdictText: $("verdictText"), verdictDetail: $("verdictDetail"),
  btnVoidRetry: $("btnVoidRetry"),
  mRmse: $("mRmse"), mGain: $("mGain"), mLag: $("mLag"),
  mSacc: $("mSacc"), mBlink: $("mBlink"), mValid: $("mValid"),
  cfgFreq: $("cfgFreq"), cfgPeak: $("cfgPeak"),
  // --- reaction test ---
  rStage: $("reactionStage"), rTarget: $("reactionTarget"),
  rMsg: $("reactionMsg"), rTitle: $("reactionTitle"), rSub: $("reactionSub"),
  rRoundLabel: $("reactionRoundLabel"), rClock: $("reactionClock"), rProgress: $("reactionProgress"),
  btnReactionStart: $("btnReactionStart"), btnReactionAbort: $("btnReactionAbort"),
  rVerdict: $("reactionVerdict"), rVerdictText: $("reactionVerdictText"), rVerdictDetail: $("reactionVerdictDetail"),
  btnReactionVoidRetry: $("btnReactionVoidRetry"),
  rMedian: $("rMedian"), rWorst: $("rWorst"), rMiss: $("rMiss"), rFalse: $("rFalse"), rMedianHint: $("rMedianHint"),
  // --- driver profiles ---
  driverName: $("driverName"), btnDriverSelect: $("btnDriverSelect"),
  driverProfile: $("driverProfile"), driverProfileName: $("driverProfileName"),
  driverStrikes: $("driverStrikes"), driverBaseline: $("driverBaseline"),
  driverPursuitStats: $("driverPursuitStats"), driverReactionStats: $("driverReactionStats"),
  driverRating: $("driverRating"),
  btnStartTrip: $("btnStartTrip"), btnEndTrip: $("btnEndTrip"), tripStatus: $("tripStatus"),
  btnMarkStopped: $("btnMarkStopped"), stopReasonRow: $("stopReasonRow"),
  stopReasonSelect: $("stopReasonSelect"), btnConfirmStop: $("btnConfirmStop"),
  readinessModal: $("readinessModal"), readinessIcon: $("readinessIcon"),
  readinessTitle: $("readinessTitle"), readinessDetail: $("readinessDetail"),
  btnReadinessRetry: $("btnReadinessRetry"), btnReadinessClose: $("btnReadinessClose"),
  fatigueModal: $("fatigueModal"), fatigueMsg: $("fatigueMsg"), fatigueSnoozeHint: $("fatigueSnoozeHint"),
  btnFatigueNow: $("btnFatigueNow"),
  btnNotify: $("btnNotify"),
  btnCheckBytes: $("btnCheckBytes"), bytesOutput: $("bytesOutput"),
  btnCheckDelta: $("btnCheckDelta"), deltaOutput: $("deltaOutput")
};
const ctx2d = el.overlay.getContext("2d");

el.cfgFreq.textContent = CONFIG.FREQ_HZ.toFixed(2);
el.cfgPeak.textContent = W.toFixed(2);
el.mRatioHint.textContent = `Fail at ${CONFIG.FAIL_MULT}×, borderline from ${CONFIG.WARN_MULT}×`;

/* ----------------------------------------------------------------- state -- */

const PHASE = { IDLE: "idle", READY: "ready", CALIBRATING: "calibrating", TESTING: "testing", DONE: "done" };

const state = {
  phase: PHASE.IDLE,
  landmarker: null,
  stream: null,
  running: false,
  cameraReady: false, // camera + face model loaded; the other half of the start-button gate is an active driver
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
  headWarnTimer: null,
  fpsFrames: 0, fpsT0: 0,
  lastChartT: 0
};

/** Retriggerable transient pill, shown only when the real head-movement detector fires. */
function showHeadWarning() {
  clearTimeout(state.headWarnTimer);
  el.headWarning.classList.remove("hidden");
  void el.headWarning.offsetWidth; // restart the CSS animation if it's already mid-flash
  el.headWarning.querySelector(".head-warn-pill").style.animation = "none";
  el.headWarning.querySelector(".head-warn-pill").offsetWidth;
  el.headWarning.querySelector(".head-warn-pill").style.animation = "";
  // Sustained head movement re-triggers this every qualifying camera frame (many times a
  // second) — fine for the visual flash, but the alert tone needs its own cooldown or
  // continuous movement sounds like an overlapping buzz storm instead of one clean cue.
  const now = performance.now();
  if (now - (state.lastHeadAlertAt || 0) > 1500) {
    state.lastHeadAlertAt = now;
    playHeadAlert();
  }
  state.headWarnTimer = setTimeout(() => el.headWarning.classList.add("hidden"), 1600);
}

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
  state.cameraReady = true;
  state.fpsT0 = performance.now();
  el.btnCamera.textContent = "Camera on";
  updateStartGating();
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
    // Head reference point, for detecting head movement (see HEAD_MOVE_LIMIT).
    // Not yaw-corrected — just "is the head drifting/shaking", not "which way is it turned".
    headCenter: mid(lCentre, rCentre),
    interocular
  };
}

// Camera-style corner-bracket reticle, the shape a viewfinder autofocus box uses to mark
// a tracked point. More legible than a filled dot: it reads as "this is being tracked",
// not just a coloured blob, and scales with interocular distance so it holds its apparent
// size as the driver moves closer to or further from the camera.
function drawReticle(c, x, y, size) {
  const arm = size * 0.55;
  c.beginPath();
  c.moveTo(x - size, y - size + arm); c.lineTo(x - size, y - size); c.lineTo(x - size + arm, y - size);
  c.moveTo(x + size - arm, y - size); c.lineTo(x + size, y - size); c.lineTo(x + size, y - size + arm);
  c.moveTo(x + size, y + size - arm); c.lineTo(x + size, y + size); c.lineTo(x + size - arm, y + size);
  c.moveTo(x - size + arm, y + size); c.lineTo(x - size, y + size); c.lineTo(x - size, y + size - arm);
  c.stroke();
  c.beginPath(); c.arc(x, y, 1.5, 0, Math.PI * 2); c.fill();
}

function drawOverlay(g) {
  const c = ctx2d;
  c.clearRect(0, 0, el.overlay.width, el.overlay.height);
  if (!g || !g.ok) return;
  const size = Math.max(10, g.interocular * 0.18);
  c.strokeStyle = "#38E1C9";
  c.fillStyle = "#38E1C9";
  c.lineWidth = 2;
  for (const p of g.iris) drawReticle(c, p.x, p.y, size);
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
        showHeadWarning();
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
    // A sane pursuit must move the irises with the dot, by a measurable amount.
    // Magnitude, not sign: CAMERA_X_FLIP is a fixed guess at which way a given
    // browser/device hands back the raw (non-CSS-mirrored) camera frame, and that
    // convention isn't guaranteed consistent across devices. Requiring c.k to be
    // positive would silently void a real, working calibration on any device where
    // that guess is backwards — the sign is exactly what this per-session fit is
    // for, so let it be either.
    c.ok = isFinite(c.k) && Math.abs(c.k) > 0.5 && Math.abs(c.k) < 400;
  }
  state.phase = PHASE.TESTING;
  el.phaseLabel.textContent = "2 · Tracking";
  if (!c.ok) {
    el.hint.textContent = "Calibration is weak — the run may come back void. Improve the lighting and keep your head still.";
  }
}

/* ----------------------------------------------------- driver profiles -- */
/* A repository of driver profiles, kept in this browser's localStorage. This is a
   shared-device model (e.g. a depot kiosk) deliberately, not a cloud service: the
   whole app is static files with no backend, so a profile lives on the device it
   was created on and doesn't follow a driver anywhere else. Each profile owns its
   own baseline (previously one global value per device), a strike count, running
   pass/borderline/fail/void stats for both tests, and a capped history log. */

const DRIVERS_KEY = "blinkcheck.drivers.v1";
const DRIVER_HISTORY_CAP = 50; // per driver; oldest entries drop first
const DRIVER_TRIP_CAP = 50;    // per driver; oldest trips drop first
const MEAL_TEST_DEADLINE_MS = 30 * 60000;  // drowsiness onset lags a meal by roughly this long
const SPEED_CHECK_INTERVAL_MS = 10 * 60000; // how often the active trip samples GPS speed
const SPEED_STOPPED_THRESHOLD_MS = 2;       // ~7 km/h — below this counts as "stopped" for a sample
const AUTO_STOP_LOOKAHEAD_MS = 60 * 60000;  // only auto-prompt on a natural stop if a reminder is due soon

// A separate, lightweight event log the dashboard watches (via the same "storage" event
// it already uses for live sync) to fire its own admin-facing notifications. Kept apart
// from DRIVERS_KEY on purpose: it's a stream of things-that-just-happened, not state.
const DASHBOARD_EVENTS_KEY = "blinkcheck.dashboardEvents.v1";
const DASHBOARD_EVENTS_CAP = 30;

function pushDashboardEvent(type, driver, detail) {
  let events = [];
  try {
    const raw = localStorage.getItem(DASHBOARD_EVENTS_KEY);
    events = raw ? JSON.parse(raw) : [];
  } catch { events = []; }
  events.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    t: new Date().toISOString(),
    type, driverId: driver.id, driverName: driver.name, detail
  });
  if (events.length > DASHBOARD_EVENTS_CAP) events.shift();
  try { localStorage.setItem(DASHBOARD_EVENTS_KEY, JSON.stringify(events)); } catch { /* private mode */ }
}

/** Most recent verdict recorded for a given test type, or null if it's never been run. */
function latestVerdict(driver, testType) {
  for (let i = driver.history.length - 1; i >= 0; i--) {
    if (driver.history[i].test === testType) return driver.history[i].verdict;
  }
  return null;
}

/** "can_drive" only for the safest combination — a clean Pass on both checks. Anything
 *  else (borderline, fail, void) on either test is "not_applicable". Returns null if
 *  one or both checks have never been run yet, so there's nothing to judge. */
function computeDriveStatus(driver) {
  const pursuitVerdict = latestVerdict(driver, "pursuit");
  const reactionVerdict = latestVerdict(driver, "reaction");
  if (!pursuitVerdict || !reactionVerdict) return null;
  return (pursuitVerdict === "pass" && reactionVerdict === "pass") ? "can_drive" : "not_applicable";
}

function emptyDriverStats() {
  return { pass: 0, watch: 0, fail: 0, void: 0 };
}

function loadDrivers() {
  try {
    const raw = localStorage.getItem(DRIVERS_KEY);
    const store = raw ? JSON.parse(raw) : null;
    return (store && typeof store.drivers === "object") ? store : { activeId: null, drivers: {} };
  } catch { return { activeId: null, drivers: {} }; }
}

function saveDrivers(store) {
  try { localStorage.setItem(DRIVERS_KEY, JSON.stringify(store)); } catch { /* private mode */ }
}

function getActiveDriver() {
  const store = loadDrivers();
  return store.activeId ? (store.drivers[store.activeId] || null) : null;
}

/** Selects an existing driver by name, or creates one. Becomes the active driver. */
function selectDriver(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const id = trimmed.toLowerCase();
  const store = loadDrivers();
  if (!store.drivers[id]) {
    store.drivers[id] = {
      id, name: trimmed, created: new Date().toISOString(),
      baseline: null, strikes: 0,
      stats: { pursuit: emptyDriverStats(), reaction: emptyDriverStats() },
      history: [],
      pendingChanges: [], // delta log since the last "Check transferable size" — see downloadable-size UI
      rating: { sum: 0, count: 0 }, // set by the dashboard, one rating per completed trip
      activeTrip: null,  // { startedAt } while a trip is in progress, else null
      trips: []          // { id, startedAt, endedAt, rating: null until the dashboard rates it }
    };
  }
  store.activeId = id;
  saveDrivers(store);
  return store.drivers[id];
}

/** Records a scored (non-baseline-setting) result against the active driver.
 *  kind is "pass" | "watch" | "fail" | "void" — a "fail" is a strike. */
function recordResult(testType, kind, detail) {
  const store = loadDrivers();
  const driver = store.activeId ? store.drivers[store.activeId] : null;
  if (!driver) return;
  driver.stats[testType][kind] = (driver.stats[testType][kind] || 0) + 1;
  if (kind === "fail") driver.strikes++;
  const entry = { t: new Date().toISOString(), test: testType, verdict: kind, detail };
  driver.history.push(entry);
  if (driver.history.length > DRIVER_HISTORY_CAP) driver.history.shift();
  if (!driver.pendingChanges) driver.pendingChanges = []; // older profiles predate this field
  driver.pendingChanges.push({ field: "result", ...entry });

  // Once both checks have a result on record, the driver has completed today's pre-trip
  // screen — surface it here immediately, and flag it for the dashboard. Re-evaluates
  // (and can re-fire) on every subsequent test too, using whichever verdicts are latest.
  const pursuitVerdict = latestVerdict(driver, "pursuit");
  const reactionVerdict = latestVerdict(driver, "reaction");
  const bothDone = pursuitVerdict && reactionVerdict;
  if (bothDone) {
    pushDashboardEvent("completed_both", driver, { pursuitVerdict, reactionVerdict });
    // Completing both checks is the real resolution of a fatigue-check-in cycle — reset
    // it here rather than leaving that to a blind timer, so the next reminder is a full
    // interval away again instead of nagging again a few minutes later. Also clears any
    // check-in owed on the active trip, resolving it before it can cost a strike at endTrip().
    const notify = loadNotifySettings();
    notify.lastNotified = new Date().toISOString();
    notify.nextCheckAt = new Date(Date.now() + notify.intervalHours * 3600000).toISOString();
    saveNotifySettings(notify);
    if (driver.activeTrip) driver.activeTrip.pendingCheckIn = null;
  }

  saveDrivers(store);
  showDriverProfile();
  if (bothDone) showReadinessPopup(pursuitVerdict, reactionVerdict);
}

let readinessRetryTarget = null; // "pursuit" or "reaction" — which section "Repeat the test" jumps to

/** Shown right after whichever test just made both checks have a recorded result.
 *  "Ready" requires a clean Pass on both — the same safest-combination rule as
 *  computeDriveStatus. Purely advisory: the app has no way to actually stop anyone
 *  from driving, only to tell them clearly that they shouldn't yet. */
function showReadinessPopup(pursuitVerdict, reactionVerdict) {
  const ready = pursuitVerdict === "pass" && reactionVerdict === "pass";
  el.readinessIcon.textContent = ready ? "✅" : "🚫";
  el.readinessTitle.textContent = ready ? "Ready to Drive" : "Not Applicable to Drive";
  if (ready) {
    el.readinessDetail.textContent = "Both checks came back clean. Have a safe trip.";
    el.btnReadinessRetry.classList.add("hidden");
  } else {
    const failed = [];
    if (pursuitVerdict !== "pass") failed.push("pursuit");
    if (reactionVerdict !== "pass") failed.push("reaction");
    const label = failed.map((f) => f[0].toUpperCase() + f.slice(1)).join(" and ");
    el.readinessDetail.textContent =
      `${label} test${failed.length > 1 ? "s" : ""} didn't come back clean. Repeat ` +
      `${failed.length > 1 ? "them" : "it"} — don't drive until both checks pass.`;
    readinessRetryTarget = failed[0];
    el.btnReadinessRetry.classList.remove("hidden");
  }
  el.readinessModal.style.display = "flex";
}

function saveDriverBaseline(r) {
  const store = loadDrivers();
  const driver = store.activeId ? store.drivers[store.activeId] : null;
  if (!driver) return null;
  const rmse = Math.min(r.rmse, CONFIG.BASELINE_RMSE_CAP);
  driver.baseline = { rmse, gain: r.gain, lagMs: r.lagMs, recorded: new Date().toISOString() };
  if (!driver.pendingChanges) driver.pendingChanges = [];
  driver.pendingChanges.push({ field: "baseline", t: driver.baseline.recorded, value: driver.baseline });
  saveDrivers(store);
  return driver.baseline;
}

function clearDriverBaseline() {
  const store = loadDrivers();
  const driver = store.activeId ? store.drivers[store.activeId] : null;
  if (!driver) return;
  driver.baseline = null;
  if (!driver.pendingChanges) driver.pendingChanges = [];
  driver.pendingChanges.push({ field: "baseline_cleared", t: new Date().toISOString() });
  saveDrivers(store);
  showDriverProfile();
  setVerdict("void", "Baseline cleared", "The next scored run becomes this driver's new rested baseline. Record it while they're alert.");
}

/* ----------------------------------------------------------------- trips -- */
/* A trip has no score of its own — it's just a start/end timestamp pair that flags
 * to the dashboard "rate this driver". The actual 1-5 rating is entered on the
 * dashboard, by whoever is watching the driver, not self-reported here. */

function startTrip() {
  const store = loadDrivers();
  const driver = store.activeId ? store.drivers[store.activeId] : null;
  if (!driver || driver.activeTrip) return;
  driver.activeTrip = {
    startedAt: new Date().toISOString(),
    stoppedAt: null, stopReason: null,       // set by markStopped()
    lastSpeedCheckAt: null, recentSpeeds: [], // last couple of 10-min GPS speed samples
    pendingCheckIn: null                      // {reason, requestedAt, dueAt} while a check-in is owed
  };
  if (!driver.pendingChanges) driver.pendingChanges = [];
  driver.pendingChanges.push({ field: "trip_started", t: driver.activeTrip.startedAt });
  saveDrivers(store);
  showDriverProfile();
}

function endTrip() {
  const store = loadDrivers();
  const driver = store.activeId ? store.drivers[store.activeId] : null;
  if (!driver || !driver.activeTrip) return;
  // Ending the trip with an unresolved check-in owed is the actual enforcement point —
  // there's no way to force a stop mid-trip, only a consequence at the end of it.
  const strikeForNoncompliance = !!driver.activeTrip.pendingCheckIn;
  const trip = {
    id: `${driver.id}-${Date.now()}`,
    startedAt: driver.activeTrip.startedAt,
    endedAt: new Date().toISOString(),
    rating: null,
    strikeForNoncompliance
  };
  if (strikeForNoncompliance) driver.strikes++;
  if (!driver.trips) driver.trips = []; // older profiles predate this field
  driver.trips.push(trip);
  if (driver.trips.length > DRIVER_TRIP_CAP) driver.trips.shift();
  driver.activeTrip = null;
  if (!driver.pendingChanges) driver.pendingChanges = [];
  driver.pendingChanges.push({ field: "trip_ended", t: trip.endedAt, value: trip });
  saveDrivers(store);
  if (strikeForNoncompliance) {
    pushDashboardEvent("trip_noncompliance_strike", driver, { tripId: trip.id });
  }
  showDriverProfile();
}

/** Records that the driver has pulled over, with a reason. A meal specifically comes with
 *  an announced 30-minute deadline (drowsiness onset lags a meal) — everything else just
 *  opens a pending check-in immediately. Speed is a best-effort corroboration, never a hard
 *  block: GPS can be noisy or unavailable, and the point is to nudge honesty, not police it. */
function markStopped(reason) {
  const store = loadDrivers();
  const driver = store.activeId ? store.drivers[store.activeId] : null;
  if (!driver || !driver.activeTrip) return;
  driver.activeTrip.stoppedAt = new Date().toISOString();
  driver.activeTrip.stopReason = reason;
  saveDrivers(store);

  verifyStoppedBySpeed(reason);

  if (reason === "meal") {
    openPendingCheckIn("meal", MEAL_TEST_DEADLINE_MS);
    promptFatigueCheck("You've logged a meal stop. Complete both checks within 30 minutes — "
      + "drowsiness often hits shortly after eating.");
  } else {
    openPendingCheckIn(reason, null);
    promptFatigueCheck("Good time for a quick check-in while you're stopped.");
  }
  showDriverProfile();
}

function verifyStoppedBySpeed(reason) {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    const speed = pos.coords.speed; // m/s, null if unavailable
    if (speed !== null && speed > 2) { // ~7 km/h — clearly still moving
      promptFatigueCheck(`Speed data suggests you might still be moving — if this "${reason}" `
        + `stop wasn't accurate, no problem, just make sure the check-in still happens soon.`);
    }
  }, () => { /* permission denied or unavailable — corroboration is best-effort only */ });
}

/** Opens (or refreshes) the single outstanding check-in requirement for the active trip.
 *  Only one at a time — a new due-reason doesn't stack, it just relabels the same
 *  requirement, since only one strike can be earned per trip for this. */
function openPendingCheckIn(reason, deadlineMs) {
  const store = loadDrivers();
  const driver = store.activeId ? store.drivers[store.activeId] : null;
  if (!driver || !driver.activeTrip) return;
  if (driver.activeTrip.pendingCheckIn) return; // already owed — don't reset its clock
  const requestedAt = new Date();
  driver.activeTrip.pendingCheckIn = {
    reason,
    requestedAt: requestedAt.toISOString(),
    dueAt: deadlineMs ? new Date(requestedAt.getTime() + deadlineMs).toISOString() : null
  };
  saveDrivers(store);
}

function haversineMeters(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Samples GPS speed roughly every 10 minutes during an active trip. Uses elapsed
 *  wall-clock time against a stored timestamp rather than a live long-running timer, so it
 *  self-corrects the moment the tab wakes up even if the phone was locked/backgrounded for
 *  the whole interval (a real risk here — a meal break easily means the screen is off for
 *  30+ minutes). Ties into the reminder schedule: a natural stop only auto-prompts if a
 *  check-in is coming due soon anyway, so it reads as "using a stop you're already taking",
 *  not a random interruption. */
function checkTripSpeed() {
  const store = loadDrivers();
  const driver = store.activeId ? store.drivers[store.activeId] : null;
  if (!driver || !driver.activeTrip || !("geolocation" in navigator)) return;
  const trip = driver.activeTrip;
  const lastCheck = trip.lastSpeedCheckAt ? new Date(trip.lastSpeedCheckAt).getTime() : 0;
  if (Date.now() - lastCheck < SPEED_CHECK_INTERVAL_MS) return;

  navigator.geolocation.getCurrentPosition((pos) => {
    const now = Date.now();
    let speed = pos.coords.speed; // m/s, often null indoors/on some devices
    if (speed === null && trip.lastPosition) {
      const dtS = (now - trip.lastPosition.t) / 1000;
      if (dtS > 0) {
        const meters = haversineMeters(trip.lastPosition, { lat: pos.coords.latitude, lng: pos.coords.longitude });
        speed = meters / dtS;
      }
    }
    const store2 = loadDrivers();
    const driver2 = store2.activeId ? store2.drivers[store2.activeId] : null;
    if (!driver2 || !driver2.activeTrip) return; // trip ended while the GPS fix was in flight
    const t2 = driver2.activeTrip;
    t2.lastSpeedCheckAt = new Date(now).toISOString();
    t2.lastPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: now };
    if (speed !== null) {
      t2.recentSpeeds = [...(t2.recentSpeeds || []), { t: now, speed }].slice(-2);
    }
    saveDrivers(store2);

    const stoppedTwiceRunning = t2.recentSpeeds.length === 2
      && t2.recentSpeeds.every((s) => s.speed <= SPEED_STOPPED_THRESHOLD_MS);
    const notify = loadNotifySettings();
    const dueSoon = notify.nextCheckAt && (new Date(notify.nextCheckAt).getTime() - now) <= AUTO_STOP_LOOKAHEAD_MS;
    if (stoppedTwiceRunning && dueSoon && !t2.pendingCheckIn) {
      openPendingCheckIn("auto_stop", null);
      promptFatigueCheck("Looks like you've stopped and a check-in is coming up soon — good time to get it done now.");
    }
  }, () => { /* permission denied or unavailable — this feature just quietly does nothing */ });
}

function showDriverProfile() {
  const driver = getActiveDriver();
  if (!driver) {
    el.driverProfile.classList.add("hidden");
    el.mBase.innerHTML = "not set";
    el.btnBaseline.disabled = true;
    return;
  }
  el.driverProfile.classList.remove("hidden");
  el.driverProfileName.textContent = driver.name;
  el.driverStrikes.textContent = String(driver.strikes);
  const rating = driver.rating; // older profiles predate this field
  el.driverRating.textContent = (rating && rating.count) ? (rating.sum / rating.count).toFixed(1) : "—";
  const baselineText = driver.baseline ? driver.baseline.rmse.toFixed(3) + '<small> /s</small>' : "not set";
  el.driverBaseline.innerHTML = baselineText;
  el.mBase.innerHTML = baselineText;
  el.btnBaseline.disabled = !driver.baseline;
  const p = driver.stats.pursuit, r = driver.stats.reaction;
  el.driverPursuitStats.textContent = `${p.pass} / ${p.watch} / ${p.fail} / ${p.void}`;
  el.driverReactionStats.textContent = `${r.pass} / ${r.watch} / ${r.fail} / ${r.void}`;
  const tripActive = !!driver.activeTrip;
  const checksComplete = !!(latestVerdict(driver, "pursuit") && latestVerdict(driver, "reaction"));
  el.btnStartTrip.classList.toggle("hidden", tripActive);
  el.btnEndTrip.classList.toggle("hidden", !tripActive);
  el.btnStartTrip.disabled = !checksComplete;

  el.btnMarkStopped.classList.toggle("hidden", !tripActive);
  el.stopReasonRow.classList.add("hidden"); // re-shown by btnMarkStopped's own click handler

  if (tripActive) {
    const pending = driver.activeTrip.pendingCheckIn;
    let msg = `Trip started ${new Date(driver.activeTrip.startedAt).toLocaleTimeString()} — end it to flag this driver for rating.`;
    if (pending) {
      const reasonLabel = pending.reason === "auto_stop" ? "a detected stop" : pending.reason;
      msg += ` ⚠️ Check-in owed (${reasonLabel})`;
      msg += pending.dueAt ? ` — due by ${new Date(pending.dueAt).toLocaleTimeString()}.` : ".";
      msg += " Ending the trip before it's done costs a strike.";
    }
    el.tripStatus.textContent = msg;
  } else {
    el.tripStatus.textContent = checksComplete ? "" : "Complete both the pursuit and reaction checks before starting a trip.";
  }
}

function updateStartGating() {
  el.btnStart.disabled = !(state.cameraReady && getActiveDriver());
}

function updateReactionGating() {
  el.btnReactionStart.disabled = !getActiveDriver();
}

/** Locks driver switching while either test is running. Both tests read the active
 *  driver at scoring time, so switching mid-run risks crashing (pursuit dereferences
 *  driver.baseline) or misattributing a result to the wrong driver (reaction). Also
 *  locked mid-trip, for the same reason: ending someone else's trip would flag the
 *  wrong driver for the dashboard's rating. */
function updateDriverLock() {
  const pursuitRunning = state.phase === PHASE.CALIBRATING || state.phase === PHASE.TESTING;
  const driver = getActiveDriver();
  el.btnDriverSelect.disabled = pursuitRunning || reaction.phase === "running" || !!(driver && driver.activeTrip);
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
  clearTimeout(state.headWarnTimer);
  el.headWarning.classList.add("hidden");
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
  updateDriverLock();
}

function abortTest(message) {
  state.phase = PHASE.READY;
  el.dot.classList.add("hidden");
  updateStartGating();
  updateDriverLock();
  el.btnAbort.classList.add("hidden");
  el.progress.style.width = "0%";
  el.phaseLabel.textContent = "Standby";
  setStage("Stopped", message || "Test stopped. Press start when you are ready to go again.");
}

function finishTest() {
  state.phase = PHASE.DONE;
  el.dot.classList.add("hidden");
  updateStartGating();
  updateDriverLock();
  el.btnStart.textContent = "Run the test again";
  el.btnAbort.classList.add("hidden");
  el.btnCsv.disabled = false;
  el.phaseLabel.textContent = "3 · Scored";
  el.progress.style.width = "100%";
  playCompletionBeep();

  const r = scoreRun();
  setMetrics(r);

  const driver = getActiveDriver();

  if (r.void) {
    if (driver) recordResult("pursuit", "void", { validFrac: r.validFrac });
    setVerdict("voidwarn", "VOID",
      "DATA INTEGRITY COMPROMISED — cabin too dark, glare, or poor tracking. Not a fail; this run doesn't count against the driver. Recalibrate and retry.");
    setStage("Void", "The run could not be scored. Try again with better lighting and a still head.");
    return;
  }

  // Gate on correlation before anything baseline-relative even runs. This catches
  // eye movement that doesn't follow the target's path at all — including a first
  // run bad enough that it would otherwise get accepted as the baseline and make
  // every later equally-bad run look fine by comparison.
  if (r.corr < CONFIG.MIN_CORR) {
    el.mRatio.textContent = "—";
    if (driver) recordResult("pursuit", "fail", { reason: "no-correlation", corr: r.corr });
    setVerdict("fail", "Fail",
      `Eye position barely tracks the target's path (correlation ${r.corr.toFixed(2)}, need ${CONFIG.MIN_CORR}). This isn't smooth pursuit. Follow the dot continuously with your eyes only.`);
    setStage("Scored", "Results are on the right. Press start to run it again.");
    return;
  }

  // --- first valid run for this driver: record the rested baseline, do not judge it ---
  if (driver && !driver.baseline) {
    const b = saveDriverBaseline(r);
    showDriverProfile();
    el.mRatio.textContent = "—";
    // Absolute thresholds survive only as a sanity check on the baseline itself:
    // a "rested" run this poor usually means bad tracking, not a bad driver.
    const suspect = r.rmse >= FAIL_RMSE || r.gain < 0.6 || r.lagMs > 400;
    const capped = r.rmse > CONFIG.BASELINE_RMSE_CAP;
    setVerdict("void", "Baseline recorded",
      `This run is now ${driver.name}'s reference: RMSE ${b.rmse.toFixed(3)} /s${capped ? ` (capped from ${r.rmse.toFixed(3)})` : ""}, gain ${r.gain.toFixed(2)}, lag ${Math.round(r.lagMs)} ms. It only means anything if the driver was alert when it was taken.` +
      (suspect
        ? " These numbers look poor for a rested run — check lighting, glasses glare and head stillness, then reset the baseline and record it again."
        : " Retest later and the result is judged against this number."));
    setStage("Baseline recorded", "Run the test again to compare against it.");
    return;
  }

  // --- later runs: judged against the driver's own rested number ---
  const ratio = r.rmse / driver.baseline.rmse;
  el.mRatio.innerHTML = ratio.toFixed(2) + '<small> ×</small>';

  if (ratio >= CONFIG.FAIL_MULT) {
    recordResult("pursuit", "fail", { rmse: r.rmse, ratio, gain: r.gain, lagMs: r.lagMs });
    setVerdict("fail", "Fail",
      `Velocity error is ${ratio.toFixed(2)}× this driver's rested baseline, past the ${CONFIG.FAIL_MULT}× line. Pursuit is breaking into corrective jumps. Do not drive; get a proper assessment.`);
  } else if (ratio >= CONFIG.WARN_MULT) {
    recordResult("pursuit", "watch", { rmse: r.rmse, ratio, gain: r.gain, lagMs: r.lagMs });
    setVerdict("watch", "Borderline",
      `Velocity error is ${ratio.toFixed(2)}× baseline, between the ${CONFIG.WARN_MULT}× and ${CONFIG.FAIL_MULT}× lines. Rest and retest before a long shift.`);
  } else {
    recordResult("pursuit", "pass", { rmse: r.rmse, ratio, gain: r.gain, lagMs: r.lagMs });
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
  el.verdict.classList.remove("verdict-pass", "verdict-watch", "verdict-fail", "verdict-void", "verdict-voidwarn");
  el.verdict.classList.add("verdict-" + kind);
  el.verdictText.textContent = text;
  el.verdictDetail.textContent = detail;
  el.btnVoidRetry.classList.toggle("hidden", kind !== "voidwarn");
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

function downloadReactionCsv() {
  const rows = [
    ...reaction.results.map((r, i) => ({
      t: r.t, event: r.rt !== null ? "hit" : "miss", round: i + 1,
      x: r.x, y: r.y, latencyMs: r.rt
    })),
    ...reaction.falseStartLog.map((f) => ({
      t: f.t, event: "false_start", round: "", x: f.x, y: f.y, latencyMs: null
    }))
  ].sort((a, b) => a.t - b.t);

  const head = "t_s,event,round,x_pct,y_pct,latency_ms\n";
  const body = rows.map((r) => [
    r.t.toFixed(4),
    r.event,
    r.round,
    r.x.toFixed(2),
    r.y.toFixed(2),
    r.latencyMs === null ? "" : r.latencyMs.toFixed(1)
  ].join(",")).join("\n");

  const blob = new Blob([head + body], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `blinkcheck-reaction-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ audio -- */
/* Zero-dependency synthesized cues via the native Web Audio API — no MP3s, no assets
   to fetch. The AudioContext is created lazily on first use, not at page load.
   Everything in here is wrapped in try/catch and never throws outward — a cue fired
   from outside a direct click handler (a setTimeout callback, a requestAnimationFrame
   loop) is exactly the call pattern strict autoplay-gesture policies (Safari
   especially) can reject, and an uncaught throw here previously broke the calling code
   entirely. Audio is a nice-to-have; it must never be able to break the actual test.
   The reaction test's own cues (target chime, false-start buzz) were removed after
   repeated reports of the test breaking with them on — only the pursuit test's
   completion beep and head-movement alert use this now. */

let audioCtx = null;
function getAudioCtx() {
  try {
    if (!("AudioContext" in window || "webkitAudioContext" in window)) return null;
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch {
    return null;
  }
}

function playTone(freq, durationMs, type, gainPeak) {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(gainPeak, ctx.currentTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000 + 0.02);
  } catch {
    /* audio is a nice-to-have; never let it break the test */
  }
}

const playHeadAlert = () => playTone(300, 220, "triangle", 0.16);
function playCompletionBeep() {
  playTone(880, 90, "square", 0.15);
  setTimeout(() => playTone(880, 90, "square", 0.15), 150);
}

/* ============================================================================
   Reaction test — a second, independent screen. Ten targets appear one at a
   time, at a random position and after a random delay; tap each the instant
   it appears. Unlike pursuit RMSE, simple visual-motor reaction time is a
   well-studied quantity, so this scores against absolute thresholds rather
   than a self-baseline — but "well-studied" is not the same as "validated
   for this exact task": these numbers are still provisional guesses, same
   caveat as everything in CONFIG above.
   ============================================================================ */

const REACTION_CONFIG = {
  ROUNDS:           10,      // targets per run
  MIN_DELAY_MS:     600,     // shortest gap before a target appears
  MAX_DELAY_MS:     2200,    // longest gap before a target appears — randomised so the
                             // timing can't be anticipated instead of actually reacted to
  TARGET_MS:        2000,    // a target left untapped this long counts as a miss
  MARGIN_PCT:       [12, 88, 15, 85], // [minX, maxX, minY, maxY] safe spawn area, %

  WARN_MEDIAN_MS:   600,     // median reaction time at/above this -> borderline
  FAIL_MEDIAN_MS:   700,     // median reaction time at/above this -> fail
  MAX_MISSES:       1,       // more misses than this fails outright; a miss is a lapse
  MAX_FALSE_STARTS: 2        // more taps-on-nothing than this fails outright
};

// Same dashboard-configurable overrides as CONFIG above (see loadThresholdOverrides()).
if (isFinite(thresholdOverrides.reactionWarnMs)) REACTION_CONFIG.WARN_MEDIAN_MS = thresholdOverrides.reactionWarnMs;
if (isFinite(thresholdOverrides.reactionFailMs)) REACTION_CONFIG.FAIL_MEDIAN_MS = thresholdOverrides.reactionFailMs;
if (DEMO_MODE) REACTION_CONFIG.ROUNDS = 4;
el.rMedianHint.textContent = `Fail at ${REACTION_CONFIG.FAIL_MEDIAN_MS} ms, borderline from ${REACTION_CONFIG.WARN_MEDIAN_MS} ms`;

const reaction = {
  phase: "idle",   // idle | running | done
  round: 0,
  results: [],     // {rt, x, y} for a hit, {rt: null, x, y} for a timeout miss — x/y in stage %
  falseStarts: 0,
  falseStartLog: [], // {t, x, y} — t is seconds since test start, x/y the tap position in stage %
  armed: false,
  shownAt: 0,
  shownX: 0, shownY: 0,
  t0: 0,
  spawnTimer: null,
  timeoutId: null
};

function reactionDelay() {
  return REACTION_CONFIG.MIN_DELAY_MS + Math.random() * (REACTION_CONFIG.MAX_DELAY_MS - REACTION_CONFIG.MIN_DELAY_MS);
}

function spawnTarget() {
  const [minX, maxX, minY, maxY] = REACTION_CONFIG.MARGIN_PCT;
  const x = minX + Math.random() * (maxX - minX);
  const y = minY + Math.random() * (maxY - minY);
  el.rTarget.style.left = x + "%";
  el.rTarget.style.top  = y + "%";
  el.rTarget.classList.remove("hidden");
  reaction.shownAt = performance.now();
  reaction.shownX = x;
  reaction.shownY = y;
  reaction.armed = true;
  reaction.timeoutId = setTimeout(onTargetTimeout, REACTION_CONFIG.TARGET_MS);
}

function onTargetTimeout() {
  reaction.armed = false;
  el.rTarget.classList.add("hidden");
  reaction.results.push({ rt: null, x: reaction.shownX, y: reaction.shownY, t: (performance.now() - reaction.t0) / 1000 });
  advanceReactionRound();
}

function onTargetTap() {
  if (!reaction.armed) return;
  const rt = performance.now() - reaction.shownAt;
  clearTimeout(reaction.timeoutId);
  reaction.armed = false;
  el.rTarget.classList.add("hidden");
  reaction.results.push({ rt, x: reaction.shownX, y: reaction.shownY, t: (performance.now() - reaction.t0) / 1000 });
  advanceReactionRound();
}

function advanceReactionRound() {
  reaction.round++;
  updateReactionProgress();
  if (reaction.round >= REACTION_CONFIG.ROUNDS) { finishReaction(); return; }
  reaction.spawnTimer = setTimeout(spawnTarget, reactionDelay());
}

function updateReactionProgress() {
  el.rClock.textContent = `${reaction.round} / ${REACTION_CONFIG.ROUNDS}`;
  el.rProgress.style.width = clamp(reaction.round / REACTION_CONFIG.ROUNDS * 100, 0, 100) + "%";
}

function startReaction() {
  clearTimeout(reaction.spawnTimer);
  clearTimeout(reaction.timeoutId);
  reaction.phase = "running";
  reaction.round = 0;
  reaction.results = [];
  reaction.falseStarts = 0;
  reaction.falseStartLog = [];
  reaction.t0 = performance.now();
  reaction.armed = false;
  el.rTarget.classList.add("hidden");
  el.rMsg.classList.add("hidden");
  el.rRoundLabel.textContent = "Running";
  el.btnReactionStart.disabled = true;
  el.btnReactionAbort.classList.remove("hidden");
  el.btnReactionCsv.disabled = true;
  updateDriverLock();
  setReactionMetrics(null);
  setReactionVerdict("void", "Running", "Tap each target the instant it appears.");
  updateReactionProgress();
  reaction.spawnTimer = setTimeout(spawnTarget, reactionDelay());
}

function abortReaction(message) {
  clearTimeout(reaction.spawnTimer);
  clearTimeout(reaction.timeoutId);
  reaction.phase = "idle";
  reaction.armed = false;
  el.rTarget.classList.add("hidden");
  updateReactionGating();
  updateDriverLock();
  el.btnReactionAbort.classList.add("hidden");
  el.rProgress.style.width = "0%";
  el.rRoundLabel.textContent = "Standby";
  setReactionStage("Stopped", message || "Test stopped. Press start when you are ready to go again.");
}

function finishReaction() {
  reaction.phase = "done";
  el.rTarget.classList.add("hidden");
  updateReactionGating();
  updateDriverLock();
  el.btnReactionStart.textContent = "Run the test again";
  el.btnReactionAbort.classList.add("hidden");
  el.btnReactionCsv.disabled = false;
  el.rRoundLabel.textContent = "Scored";
  el.rProgress.style.width = "100%";

  const r = scoreReaction();
  setReactionMetrics(r);
  const driver = getActiveDriver();

  if (r.void) {
    if (driver) recordResult("reaction", "void", {});
    setReactionVerdict("voidwarn", "VOID",
      "DATA INTEGRITY COMPROMISED — no valid taps recorded. Not a fail; this run doesn't count against the driver. Retry.");
    setReactionStage("Void", "The run could not be scored.");
    return;
  }

  if (r.misses > REACTION_CONFIG.MAX_MISSES || r.falseStarts > REACTION_CONFIG.MAX_FALSE_STARTS || r.medianMs >= REACTION_CONFIG.FAIL_MEDIAN_MS) {
    if (driver) recordResult("reaction", "fail", { medianMs: r.medianMs, misses: r.misses, falseStarts: r.falseStarts });
    setReactionVerdict("fail", "Fail",
      `Median reaction time ${Math.round(r.medianMs)} ms, ${r.misses} miss(es), ${r.falseStarts} false start(s). Reaction speed and attention look degraded.`);
  } else if (r.misses >= REACTION_CONFIG.MAX_MISSES || r.medianMs >= REACTION_CONFIG.WARN_MEDIAN_MS) {
    if (driver) recordResult("reaction", "watch", { medianMs: r.medianMs, misses: r.misses, falseStarts: r.falseStarts });
    setReactionVerdict("watch", "Borderline",
      `Median reaction time ${Math.round(r.medianMs)} ms. Getting slower — rest before a long shift.`);
  } else {
    if (driver) recordResult("reaction", "pass", { medianMs: r.medianMs, misses: r.misses, falseStarts: r.falseStarts });
    setReactionVerdict("pass", "Pass",
      `Median reaction time ${Math.round(r.medianMs)} ms, slowest ${Math.round(r.worstMs)} ms. Reflexes look sharp.`);
  }
  setReactionStage("Scored", "Results are on the right. Press start to run it again.");
}

function scoreReaction() {
  const hits = reaction.results.filter((x) => x.rt !== null);
  const misses = reaction.results.length - hits.length;
  if (hits.length === 0) {
    return { void: true, medianMs: NaN, worstMs: NaN, misses, falseStarts: reaction.falseStarts };
  }
  // Median, not mean: RT distributions are right-skewed by nature (occasional slow
  // lapses drag a mean up a lot more than they should), and lapses are already
  // tracked separately via misses — the median is a better read on typical speed.
  const sorted = hits.map((x) => x.rt).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const worstMs = sorted[sorted.length - 1];
  return { void: false, medianMs, worstMs, misses, falseStarts: reaction.falseStarts };
}

function setReactionStage(title, sub) {
  el.rTitle.textContent = title;
  el.rSub.textContent = sub;
  el.rMsg.classList.remove("hidden");
}

function setReactionVerdict(kind, text, detail) {
  el.rVerdict.classList.remove("verdict-pass", "verdict-watch", "verdict-fail", "verdict-void", "verdict-voidwarn");
  el.rVerdict.classList.add("verdict-" + kind);
  el.rVerdictText.textContent = text;
  el.rVerdictDetail.textContent = detail;
  el.btnReactionVoidRetry.classList.toggle("hidden", kind !== "voidwarn");
}

function setReactionMetrics(r) {
  const dash = "—";
  if (!r) {
    el.rMedian.textContent = dash; el.rWorst.textContent = dash;
    el.rMiss.textContent = dash; el.rFalse.textContent = dash;
    return;
  }
  el.rMiss.textContent = String(r.misses);
  el.rFalse.textContent = String(r.falseStarts);
  if (r.void) {
    el.rMedian.textContent = dash; el.rWorst.textContent = dash;
    return;
  }
  el.rMedian.innerHTML = Math.round(r.medianMs) + '<small> ms</small>';
  el.rWorst.innerHTML = Math.round(r.worstMs) + '<small> ms</small>';
}

/* ------------------------------------------------------------ reminders -- */
/* Periodic "take the test" reminders via the browser Notification API. This is
   the honest limit of what a static, backend-less site can do: notifications
   only fire while this tab stays open somewhere (foreground or background) in
   a browser the user granted permission in. True background push — working
   even with the browser fully closed — needs a push server, which doesn't
   exist here on purpose (see README: no build step, no server-side code).
   The interval is a site-wide setting (adjustable from dashboard.html); each
   visitor still has to opt in for themselves, because no browser lets a page
   grant itself notification permission. */

const NOTIFY_KEY = "blinkcheck.notify.v1";
const NOTIFY_CHECK_MS = 60000; // how often the open tab checks whether a reminder is due
const ADMIN_MESSAGE_KEY = "blinkcheck.adminMessage.v1";
const DO_NOW_GRACE_MS = 5 * 60000; // short buffer after "Do the checks now" before nagging again

function loadNotifySettings() {
  const defaults = { enabled: false, intervalHours: 8, lastNotified: null, nextCheckAt: null };
  try {
    const raw = localStorage.getItem(NOTIFY_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return (s && typeof s === "object") ? Object.assign(defaults, s) : defaults;
  } catch { return defaults; }
}

function saveNotifySettings(s) {
  try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

let fatigueCheckPending = false; // a prompt is already up, waiting on the driver to dismiss it

/** Never assumes a due reminder means "go do it right now" — a driver on the road needs to
 *  find somewhere safe to stop first. Always asks, via promptFatigueCheck's on-screen choice,
 *  rather than the timer itself deciding anything. */
function checkNotifyDue() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (fatigueCheckPending) return;
  const s = loadNotifySettings();
  if (!s.enabled) return;
  const dueAt = s.nextCheckAt ? new Date(s.nextCheckAt).getTime()
    : (s.lastNotified ? new Date(s.lastNotified).getTime() + s.intervalHours * 3600000 : 0);
  if (Date.now() < dueAt) return;
  if (getActiveDriver() && getActiveDriver().activeTrip) openPendingCheckIn("reminder", null);
  promptFatigueCheck("Time for a quick fatigue check-in.");
}

/** Shows the on-screen check-in prompt and, best-effort, a native notification alongside
 *  it. There's no snooze anymore — a driver can't always stop the instant this fires, but
 *  the honest answer to that is "stop as soon as it's safe", not an indefinite delay. While
 *  a trip is active, it's now backed by a real consequence (see endTrip): if the trip ends
 *  with a check-in still owed, that's a strike. */
function promptFatigueCheck(messageText) {
  fatigueCheckPending = true;
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification("BlinkCheck", { body: messageText }); } catch { /* best-effort only */ }
  }
  const driver = getActiveDriver();
  el.fatigueMsg.textContent = messageText;
  el.fatigueSnoozeHint.textContent = (driver && driver.activeTrip)
    ? "Please stop as soon as it's safe. If this trip ends before both checks are done, it counts as a strike."
    : "";
  el.fatigueModal.style.display = "flex";
}

/** Refreshes the active driver's persisted Can Drive / Not Applicable label. Deliberately
 *  tied to the reminder firing rather than recomputed live on every test — it's meant to
 *  read as a periodic check-in snapshot for whoever's watching the dashboard, not a
 *  constantly-flickering readout. Only pushes a dashboard notification when the value
 *  actually changes, not on every refresh. */
function updateDriveStatusLabel() {
  const store = loadDrivers();
  const driver = store.activeId ? store.drivers[store.activeId] : null;
  if (!driver) return;
  const status = computeDriveStatus(driver);
  if (!status) return; // one or both checks never run yet — nothing to show
  const prev = driver.driveStatus ? driver.driveStatus.value : null;
  driver.driveStatus = { value: status, updatedAt: new Date().toISOString() };
  saveDrivers(store);
  if (status !== prev) pushDashboardEvent("drive_status", driver, { status });
}

function updateNotifyUI() {
  if (!("Notification" in window)) {
    el.btnNotify.textContent = "Reminders unsupported";
    el.btnNotify.disabled = true;
    return;
  }
  const s = loadNotifySettings();
  const on = s.enabled && Notification.permission === "granted";
  el.btnNotify.textContent = on ? `Reminders on (every ${s.intervalHours}h)` : "Enable reminders";
}

function toggleReminders() {
  if (!("Notification" in window)) return;
  const s = loadNotifySettings();
  if (s.enabled && Notification.permission === "granted") {
    s.enabled = false;
    saveNotifySettings(s);
    updateNotifyUI();
    return;
  }
  Notification.requestPermission().then((perm) => {
    if (perm !== "granted") { updateNotifyUI(); return; }
    const cur = loadNotifySettings();
    cur.enabled = true;
    if (!cur.lastNotified) cur.lastNotified = new Date().toISOString();
    if (!cur.nextCheckAt) cur.nextCheckAt = new Date(Date.now() + cur.intervalHours * 3600000).toISOString();
    saveNotifySettings(cur);
    updateNotifyUI();
  });
}

/* ---------------------------------------------------------------- wiring -- */

el.btnCamera.addEventListener("click", initCamera);
el.btnStart.addEventListener("click", () => {
  if (state.phase === PHASE.READY || state.phase === PHASE.DONE) startTest();
});
el.btnAbort.addEventListener("click", () => abortTest());
el.btnCsv.addEventListener("click", downloadCsv);
el.btnReactionCsv.addEventListener("click", downloadReactionCsv);
el.btnBaseline.addEventListener("click", clearDriverBaseline);

el.btnDriverSelect.addEventListener("click", () => {
  const driver = selectDriver(el.driverName.value);
  if (!driver) return;
  el.driverName.value = "";
  showDriverProfile();
  updateStartGating();
  updateReactionGating();
});
el.driverName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.btnDriverSelect.click();
});

el.btnStartTrip.addEventListener("click", () => { startTrip(); updateDriverLock(); });
el.btnEndTrip.addEventListener("click", () => { endTrip(); updateDriverLock(); });

el.btnMarkStopped.addEventListener("click", () => { el.stopReasonRow.classList.remove("hidden"); });
el.btnConfirmStop.addEventListener("click", () => {
  markStopped(el.stopReasonSelect.value);
  el.stopReasonRow.classList.add("hidden");
});

el.btnReadinessClose.addEventListener("click", () => { el.readinessModal.style.display = "none"; });
el.btnReadinessRetry.addEventListener("click", () => {
  el.readinessModal.style.display = "none";
  const target = readinessRetryTarget === "reaction" ? el.rStage : el.stage;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
});

el.btnFatigueNow.addEventListener("click", () => {
  const s = loadNotifySettings();
  // Doesn't count as a snooze — just a short grace window in case they get pulled away
  // before actually starting. Real resolution happens once both checks are recorded
  // (see recordResult), which resets this cycle properly.
  s.nextCheckAt = new Date(Date.now() + DO_NOW_GRACE_MS).toISOString();
  saveNotifySettings(s);
  fatigueCheckPending = false;
  el.fatigueModal.style.display = "none";
  el.stage.scrollIntoView({ behavior: "smooth", block: "center" });
});

// A message an admin sends from the dashboard to one specific driver. Only acted on when
// that driver is the one currently active on this device — same shared-device model as
// everything else, this can't reach a different device.
window.addEventListener("storage", (e) => {
  if (e.key !== ADMIN_MESSAGE_KEY || !e.newValue) return;
  let msg;
  try { msg = JSON.parse(e.newValue); } catch { return; }
  const driver = getActiveDriver();
  if (!driver || msg.driverId !== driver.id) return;
  promptFatigueCheck(msg.text || "Message from the dashboard.");
});

showDriverProfile();
updateStartGating();
updateReactionGating();
updateDriverLock();

el.btnNotify.addEventListener("click", toggleReminders);
updateNotifyUI();
if ("Notification" in window) setInterval(checkNotifyDue, NOTIFY_CHECK_MS);
setInterval(checkTripSpeed, NOTIFY_CHECK_MS); // internally only actually samples every ~10 min

// Real measurement of the active driver's actual stored record size, as a concrete stand-in
// for "how much would a future backend sync need to send" — nothing here is transmitted.
el.btnCheckBytes.addEventListener("click", () => {
  const driver = getActiveDriver();
  if (!driver) {
    el.bytesOutput.textContent = "No active driver selected.";
    return;
  }
  const json = JSON.stringify(driver);
  const bytes = new Blob([json]).size;
  el.bytesOutput.textContent = `${driver.name}'s full profile: ${bytes.toLocaleString()} bytes.`;
});

// Real incremental-sync size: only what changed since the last check, not the whole
// profile. saveDriverBaseline()/recordResult()/clearDriverBaseline() append to
// pendingChanges as they happen; this reads it, reports its byte size, then clears
// it — the same lifecycle a real client would use (drop a change once its sync is
// confirmed), simulated here since there's no real backend to confirm delivery.
el.btnCheckDelta.addEventListener("click", () => {
  const store = loadDrivers();
  const driver = store.activeId ? store.drivers[store.activeId] : null;
  if (!driver) {
    el.deltaOutput.textContent = "No active driver selected.";
    return;
  }
  const pending = driver.pendingChanges || [];
  if (pending.length === 0) {
    el.deltaOutput.textContent = "No changes since last sync — 0 bytes.";
    return;
  }
  const bytes = new Blob([JSON.stringify(pending)]).size;
  el.deltaOutput.textContent = `${pending.length} change${pending.length === 1 ? "" : "s"} since last sync: ${bytes.toLocaleString()} bytes. Cleared — next check starts fresh.`;
  driver.pendingChanges = [];
  saveDrivers(store);
});

el.btnReactionStart.addEventListener("click", () => {
  if (reaction.phase === "idle" || reaction.phase === "done") startReaction();
});
el.btnReactionAbort.addEventListener("click", () => abortReaction());
// pointerdown, not click: it fires the instant a finger/mouse makes contact, before the
// browser's tap-vs-scroll/zoom gesture disambiguation and click-synthesis pipeline run.
// A real touch always has a little finger movement between contact and release — enough
// that some mobile browsers can cancel the synthesized click entirely, or delay it, even
// though the tap visually landed on the target. That reads as "I tap and nothing happens",
// and doesn't show up in synthetic testing that dispatches a click event directly. It's
// also the more correct choice for a reaction-time measurement in the first place: the
// moment of contact is the actual response, not the moment the browser finishes deciding
// it wasn't a gesture.
el.rStage.addEventListener("pointerdown", (e) => {
  if (reaction.phase !== "running") return;
  e.preventDefault();
  if (e.target.closest("#reactionTarget")) {
    onTargetTap();
  } else if (!reaction.armed) {
    reaction.falseStarts++;
    const rect = el.rStage.getBoundingClientRect();
    reaction.falseStartLog.push({
      t: (performance.now() - reaction.t0) / 1000,
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100
    });
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && (state.phase === PHASE.CALIBRATING || state.phase === PHASE.TESTING)) {
    abortTest("The tab lost focus, so the run was discarded. Start again with this tab in front.");
  }
  if (document.hidden && reaction.phase === "running") {
    abortReaction("The tab lost focus, so the run was discarded. Start again with this tab in front.");
  }
  // Catches up the 10-minute speed check and the reminder check the moment the tab wakes
  // up, rather than relying on a timer that a locked/backgrounded phone may have paused
  // for the whole interval (a real risk during, say, a 30-minute meal stop).
  if (!document.hidden) { checkNotifyDue(); checkTripSpeed(); }
});
window.addEventListener("focus", () => { checkNotifyDue(); checkTripSpeed(); });

window.addEventListener("beforeunload", () => {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
});
