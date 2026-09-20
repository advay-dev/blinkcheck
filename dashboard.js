/* BlinkCheck — dev dashboard. Reads/writes the same localStorage this browser's
   main site uses. Standalone script (not a module, no camera/MediaPipe code) —
   this page only ever manages data, it never runs a test.

   Not real access control: this is a static site with no server, so there is
   no way to actually authenticate a request. The passphrase gate below is
   visible in this file to anyone who opens dev tools; it only stops casual
   stumbling onto this page, which isn't linked from the main site. */

const PASSPHRASE = "admin"; // change this; still not real security — see note above
const UNLOCK_KEY = "blinkcheck.dashboard.unlocked";

// Must match the keys app.js uses.
const DRIVERS_KEY = "blinkcheck.drivers.v1";
const NOTIFY_KEY = "blinkcheck.notify.v1";
const THRESHOLDS_KEY = "blinkcheck.thresholds.v1";
const DASHBOARD_EVENTS_KEY = "blinkcheck.dashboardEvents.v1";
const ADMIN_NOTIFY_KEY = "blinkcheck.adminNotify.v1";
const ADMIN_MESSAGE_KEY = "blinkcheck.adminMessage.v1";

// Must match CONFIG.WARN_MULT/FAIL_MULT and REACTION_CONFIG.WARN_MEDIAN_MS/FAIL_MEDIAN_MS
// in app.js — this is only what the inputs reset to, app.js owns the real defaults.
const DEFAULT_THRESHOLDS = { pursuitWarnMult: 1.2, pursuitFailMult: 1.3, reactionWarnMs: 600, reactionFailMs: 700 };

const $ = (id) => document.getElementById(id);
const el = {
  gate: $("gate"), gatePass: $("gatePass"), btnUnlock: $("btnUnlock"), gateError: $("gateError"),
  dashBody: $("dashBody"),
  intervalHours: $("intervalHours"), btnSaveInterval: $("btnSaveInterval"),
  btnTestNotify: $("btnTestNotify"), notifyStatus: $("notifyStatus"),
  btnAdminNotify: $("btnAdminNotify"), adminNotifyStatus: $("adminNotifyStatus"),
  thWarnMult: $("thWarnMult"), thFailMult: $("thFailMult"),
  thWarnMs: $("thWarnMs"), thFailMs: $("thFailMs"),
  btnSaveThresholds: $("btnSaveThresholds"), btnResetThresholds: $("btnResetThresholds"),
  statDrivers: $("statDrivers"), statTests: $("statTests"), statStrikes: $("statStrikes"),
  btnExport: $("btnExport"), btnLoadDemo: $("btnLoadDemo"),
  btnImportTrigger: $("btnImportTrigger"), importFile: $("importFile"), importStatus: $("importStatus"),
  driverList: $("driverList"), driverEmpty: $("driverEmpty"),
  tabBtnSettings: $("tabBtnSettings"), tabBtnDrivers: $("tabBtnDrivers"),
  tabSettings: $("tabSettings"), tabDrivers: $("tabDrivers")
};

/* ------------------------------------------------------------------- tabs -- */

function setTab(tab) {
  const onDrivers = tab === "drivers";
  el.tabDrivers.classList.toggle("hidden", !onDrivers);
  el.tabSettings.classList.toggle("hidden", onDrivers);
  el.tabBtnDrivers.style.color = onDrivers ? "var(--ink)" : "var(--muted)";
  el.tabBtnDrivers.style.borderBottom = onDrivers ? "2px solid var(--amber)" : "2px solid transparent";
  el.tabBtnSettings.style.color = onDrivers ? "var(--muted)" : "var(--ink)";
  el.tabBtnSettings.style.borderBottom = onDrivers ? "2px solid transparent" : "2px solid var(--amber)";
}

el.tabBtnSettings.addEventListener("click", () => setTab("settings"));
el.tabBtnDrivers.addEventListener("click", () => setTab("drivers"));
setTab("settings");

/* ------------------------------------------------------------------ gate -- */

function tryUnlock() {
  if (el.gatePass.value === PASSPHRASE) {
    try { sessionStorage.setItem(UNLOCK_KEY, "1"); } catch { /* ignore */ }
    showDashboard();
  } else {
    el.gateError.classList.remove("hidden");
  }
}

function showDashboard() {
  el.gate.classList.add("hidden");
  el.dashBody.classList.remove("hidden");
  renderNotifySettings();
  renderAdminNotify();
  renderThresholds();
  renderDrivers();
  processDashboardEvents();
}

el.btnUnlock.addEventListener("click", tryUnlock);
el.gatePass.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });

try {
  if (sessionStorage.getItem(UNLOCK_KEY) === "1") showDashboard();
} catch { /* private mode: gate stays up every load, which is fine */ }

/* ------------------------------------------------------------- storage --- */

function loadDrivers() {
  try {
    const raw = localStorage.getItem(DRIVERS_KEY);
    const store = raw ? JSON.parse(raw) : null;
    return (store && typeof store.drivers === "object") ? store : { activeId: null, drivers: {} };
  } catch { return { activeId: null, drivers: {} }; }
}

function saveDrivers(store) {
  try { localStorage.setItem(DRIVERS_KEY, JSON.stringify(store)); } catch { /* ignore */ }
}

function loadNotifySettings() {
  const defaults = { enabled: false, intervalHours: 8, lastNotified: null };
  try {
    const raw = localStorage.getItem(NOTIFY_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return (s && typeof s === "object") ? Object.assign(defaults, s) : defaults;
  } catch { return defaults; }
}

function saveNotifySettings(s) {
  try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/* --------------------------------------------------------- notifications -- */

function renderNotifySettings() {
  const s = loadNotifySettings();
  el.intervalHours.value = s.intervalHours;
  const support = "Notification" in window;
  const perm = support ? Notification.permission : "unsupported";
  el.notifyStatus.textContent = support
    ? `This browser: permission ${perm}. Reminders ${s.enabled ? "enabled" : "disabled"} site-wide default. ` +
      (s.lastNotified ? `Last sent ${new Date(s.lastNotified).toLocaleString()}.` : "Never sent yet.")
    : "This browser doesn't support notifications.";
}

el.btnSaveInterval.addEventListener("click", () => {
  const hours = Math.max(1, Math.round(Number(el.intervalHours.value) || 8));
  const s = loadNotifySettings();
  s.intervalHours = hours;
  saveNotifySettings(s);
  renderNotifySettings();
});

el.btnTestNotify.addEventListener("click", () => {
  if (!("Notification" in window)) return;
  const fire = () => new Notification("BlinkCheck (test)", { body: "This is a test reminder from the dashboard." });
  if (Notification.permission === "granted") {
    fire();
  } else {
    Notification.requestPermission().then((perm) => { if (perm === "granted") fire(); renderNotifySettings(); });
  }
});

/* --------------------------------------------------- admin notifications -- */
/* Watches DASHBOARD_EVENTS_KEY (app.js pushes to it when a driver completes both checks,
   or when their Can Drive / Not Applicable label changes) and fires a native notification
   for each new one. Same foreground-only limitation as the driver-side reminder: this only
   works while this dashboard tab is open, with permission granted, on this same device. */

function loadAdminNotify() {
  const defaults = { enabled: false, lastSeenEventId: null };
  try {
    const raw = localStorage.getItem(ADMIN_NOTIFY_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return (s && typeof s === "object") ? Object.assign(defaults, s) : defaults;
  } catch { return defaults; }
}

function saveAdminNotify(s) {
  try { localStorage.setItem(ADMIN_NOTIFY_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function renderAdminNotify() {
  if (!("Notification" in window)) {
    el.btnAdminNotify.textContent = "Notifications unsupported";
    el.btnAdminNotify.disabled = true;
    return;
  }
  const s = loadAdminNotify();
  const on = s.enabled && Notification.permission === "granted";
  el.btnAdminNotify.textContent = on ? "Admin notifications on" : "Enable admin notifications";
  el.adminNotifyStatus.textContent = `This browser: permission ${Notification.permission}. ${on ? "Watching for driver activity." : "Off."}`;
}

el.btnAdminNotify.addEventListener("click", () => {
  if (!("Notification" in window)) return;
  const s = loadAdminNotify();
  if (s.enabled && Notification.permission === "granted") {
    s.enabled = false;
    saveAdminNotify(s);
    renderAdminNotify();
    return;
  }
  Notification.requestPermission().then((perm) => {
    if (perm !== "granted") { renderAdminNotify(); return; }
    const cur = loadAdminNotify();
    cur.enabled = true;
    if (!cur.lastSeenEventId) {
      // Don't fire a backlog of notifications for events that happened before this was
      // ever turned on — start watching from whatever's already in the log right now.
      const events = loadDashboardEvents();
      if (events.length) cur.lastSeenEventId = events[events.length - 1].id;
    }
    saveAdminNotify(cur);
    renderAdminNotify();
  });
});

function loadDashboardEvents() {
  try {
    const raw = localStorage.getItem(DASHBOARD_EVENTS_KEY);
    const events = raw ? JSON.parse(raw) : [];
    return Array.isArray(events) ? events : [];
  } catch { return []; }
}

function eventNotificationText(ev) {
  if (ev.type === "completed_both") {
    const ready = ev.detail.pursuitVerdict === "pass" && ev.detail.reactionVerdict === "pass";
    return `${ev.driverName} completed both checks — ${ready ? "Can Drive" : "Not Applicable to Drive"}.`;
  }
  if (ev.type === "drive_status") {
    return `${ev.driverName}'s status changed to ${ev.detail.status === "can_drive" ? "Can Drive" : "Not Applicable to Drive"}.`;
  }
  if (ev.type === "trip_noncompliance_strike") {
    return `${ev.driverName} ended a trip with a check-in still owed — a strike was added.`;
  }
  return `${ev.driverName}: update.`;
}

function processDashboardEvents() {
  const s = loadAdminNotify();
  if (!s.enabled || !("Notification" in window) || Notification.permission !== "granted") return;
  const events = loadDashboardEvents();
  if (!events.length) return;
  const lastSeenIdx = s.lastSeenEventId ? events.findIndex((e) => e.id === s.lastSeenEventId) : -1;
  const unseen = events.slice(lastSeenIdx + 1);
  if (!unseen.length) return;
  for (const ev of unseen) new Notification("BlinkCheck", { body: eventNotificationText(ev) });
  s.lastSeenEventId = events[events.length - 1].id;
  saveAdminNotify(s);
}

/* ----------------------------------------------------------- thresholds -- */

function loadThresholds() {
  try {
    const raw = localStorage.getItem(THRESHOLDS_KEY);
    const t = raw ? JSON.parse(raw) : null;
    return (t && typeof t === "object") ? Object.assign({}, DEFAULT_THRESHOLDS, t) : Object.assign({}, DEFAULT_THRESHOLDS);
  } catch { return Object.assign({}, DEFAULT_THRESHOLDS); }
}

function saveThresholds(t) {
  try { localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

function renderThresholds() {
  const t = loadThresholds();
  el.thWarnMult.value = t.pursuitWarnMult;
  el.thFailMult.value = t.pursuitFailMult;
  el.thWarnMs.value = t.reactionWarnMs;
  el.thFailMs.value = t.reactionFailMs;
}

el.btnSaveThresholds.addEventListener("click", () => {
  saveThresholds({
    pursuitWarnMult: Number(el.thWarnMult.value) || DEFAULT_THRESHOLDS.pursuitWarnMult,
    pursuitFailMult: Number(el.thFailMult.value) || DEFAULT_THRESHOLDS.pursuitFailMult,
    reactionWarnMs: Number(el.thWarnMs.value) || DEFAULT_THRESHOLDS.reactionWarnMs,
    reactionFailMs: Number(el.thFailMs.value) || DEFAULT_THRESHOLDS.reactionFailMs
  });
  renderThresholds();
});

el.btnResetThresholds.addEventListener("click", () => {
  try { localStorage.removeItem(THRESHOLDS_KEY); } catch { /* ignore */ }
  renderThresholds();
});

/* -------------------------------------------------------------- drivers -- */

function renderDrivers() {
  const store = loadDrivers();
  const drivers = Object.values(store.drivers);

  let totalTests = 0, totalStrikes = 0;
  el.driverList.innerHTML = "";
  for (const d of drivers) {
    const p = d.stats.pursuit, r = d.stats.reaction;
    totalTests += p.pass + p.watch + p.fail + p.void + r.pass + r.watch + r.fail + r.void;
    totalStrikes += d.strikes;

    // Older profiles predate rating/trips/driveStatus — default them rather than assume they exist.
    const rating = d.rating || { sum: 0, count: 0 };
    const trips = d.trips || [];
    const avgRating = rating.count ? (rating.sum / rating.count).toFixed(1) : "—";
    const pendingTrips = trips.filter((t) => t.rating === null);
    const canDrive = d.driveStatus && d.driveStatus.value === "can_drive";
    const notApplicable = d.driveStatus && d.driveStatus.value === "not_applicable";

    const entries = d.history.slice().reverse();
    const details = document.createElement("details");
    details.className = "rounded-xl border border-rail bg-panel";
    details.innerHTML = `
      <summary class="px-5 py-3 flex flex-wrap items-center justify-between gap-3 cursor-pointer select-none">
        <span class="flex items-center gap-3">
          <span class="font-cond text-lg" style="font-weight:600">${escapeHtml(d.name)}</span>
          ${canDrive ? `<span class="font-cond text-sm px-2 py-1 rounded" style="font-weight:700; color:#0B131B; background:var(--trace);">CAN DRIVE</span>` : ""}
          ${notApplicable ? `<span class="font-cond text-sm px-2 py-1 rounded" style="font-weight:700; color:#0B131B; background:var(--signal);">NOT APPLICABLE TO DRIVE</span>` : ""}
        </span>
        <span class="flex items-center gap-4 text-xs text-muted">
          <span>${new Date(d.created).toLocaleDateString()}</span>
          <span style="color: var(--amber);">★ ${avgRating}</span>
          <span style="color: var(--signal);">${d.strikes} strike${d.strikes === 1 ? "" : "s"}</span>
          ${pendingTrips.length ? `<span style="color: var(--amber);">${pendingTrips.length} trip${pendingTrips.length === 1 ? "" : "s"} awaiting rating</span>` : ""}
        </span>
      </summary>
      <div class="border-t border-rail p-5">
        <dl class="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
          <div><dt class="text-xs text-muted">Baseline RMSE</dt><dd class="readout mt-1">${d.baseline ? d.baseline.rmse.toFixed(3) : "not set"}</dd></div>
          <div><dt class="text-xs text-muted">Pursuit P/B/F/V</dt><dd class="readout mt-1">${p.pass} / ${p.watch} / ${p.fail} / ${p.void}</dd></div>
          <div><dt class="text-xs text-muted">Reaction P/B/F/V</dt><dd class="readout mt-1">${r.pass} / ${r.watch} / ${r.fail} / ${r.void}</dd></div>
          <div><dt class="text-xs text-muted">Strikes</dt><dd class="readout mt-1" style="color: var(--signal);">${d.strikes}</dd></div>
          <div><dt class="text-xs text-muted">Rating</dt><dd class="readout mt-1" style="color: var(--amber);">${avgRating}${rating.count ? ` <span class="text-muted">(${rating.count})</span>` : ""}</dd></div>
        </dl>

        ${d.activeTrip ? `
        <p class="text-xs text-muted mt-5 mb-2">Trip in progress</p>
        <p class="text-sm rounded-lg border border-rail px-3 py-2">
          Started ${new Date(d.activeTrip.startedAt).toLocaleTimeString()}.
          ${d.activeTrip.stoppedAt ? ` Logged stopped (${escapeHtml(d.activeTrip.stopReason || "other")}) at ${new Date(d.activeTrip.stoppedAt).toLocaleTimeString()}.` : ""}
          ${d.activeTrip.pendingCheckIn
            ? ` <span style="color: var(--amber);">Check-in owed (${escapeHtml(d.activeTrip.pendingCheckIn.reason)})${d.activeTrip.pendingCheckIn.dueAt ? `, due by ${new Date(d.activeTrip.pendingCheckIn.dueAt).toLocaleTimeString()}` : ""} — ending the trip now costs a strike.</span>`
            : ` <span style="color: var(--trace);">No check-in currently owed.</span>`}
        </p>` : ""}

        ${pendingTrips.length ? `
        <p class="text-xs text-muted mt-5 mb-2">Trips awaiting rating</p>
        <ul class="text-sm space-y-2">
          ${pendingTrips.map((t) => `
            <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rail px-3 py-2">
              <span class="text-xs text-muted">${new Date(t.startedAt).toLocaleString()} → ${new Date(t.endedAt).toLocaleTimeString()}</span>
              <span class="flex gap-1" data-driver-id="${d.id}" data-trip-id="${t.id}">
                ${[1, 2, 3, 4, 5].map((n) => `<button data-value="${n}" class="btnRateTrip text-xl leading-none text-muted hover:text-amber" title="Rate ${n} star${n === 1 ? "" : "s"}">☆</button>`).join("")}
              </span>
            </li>`).join("")}
        </ul>` : ""}

        <p class="text-xs text-muted mt-5 mb-2">Result history</p>
        ${entries.length
          ? `<ul class="text-xs text-muted space-y-1 max-h-48 overflow-y-auto">${entries.map((h) => `
              <li>
                <span class="readout" style="color: var(--ink);">${new Date(h.t).toLocaleString()}</span>
                — ${escapeHtml(h.test)} —
                <span style="color: ${h.verdict === "fail" ? "var(--signal)" : h.verdict === "watch" ? "var(--amber)" : h.verdict === "pass" ? "var(--trace)" : "var(--muted)"};">${escapeHtml(h.verdict)}</span>
              </li>`).join("")}</ul>`
          : `<p class="text-xs text-muted">No history recorded yet.</p>`}

        <p class="text-xs text-muted mt-5 mb-2">Send this driver a message</p>
        <p class="text-xs text-muted mb-2">
          Pops up on their screen (with the same snooze-or-do-it-now choice as a reminder) and
          sends a notification, next time their tab is open on this device.
        </p>
        <div class="flex flex-wrap gap-2">
          <input data-id="${d.id}" class="msgText flex-1 min-w-[200px] rounded-lg bg-hull border border-rail px-3 py-2 text-sm text-ink focus:outline-none focus:border-amber" placeholder="e.g. Please take your check-in before your next trip" />
          <button data-id="${d.id}" class="btnSendMessage btn btn-ghost">Send</button>
        </div>

        <div class="mt-5 pt-4 border-t border-rail flex items-center gap-4">
          <button data-id="${d.id}" class="btnResetStrikes text-xs text-muted underline decoration-dotted hover:text-ink">Reset strikes</button>
          <button data-id="${d.id}" class="btnDeleteDriver text-xs text-muted underline decoration-dotted hover:text-ink">Delete driver</button>
        </div>
      </div>
    `;
    el.driverList.appendChild(details);
  }

  el.driverEmpty.classList.toggle("hidden", drivers.length > 0);
  el.statDrivers.textContent = String(drivers.length);
  el.statTests.textContent = String(totalTests);
  el.statStrikes.textContent = String(totalStrikes);

  el.driverList.querySelectorAll(".btnResetStrikes").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.getAttribute("data-id");
      const store2 = loadDrivers();
      const driver = store2.drivers[id];
      if (!driver || !confirm(`Reset strikes for "${driver.name}" to 0? Their baseline, stats and history stay.`)) return;
      driver.strikes = 0;
      saveDrivers(store2);
      renderDrivers();
    });
  });

  el.driverList.querySelectorAll(".btnDeleteDriver").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.getAttribute("data-id");
      const store2 = loadDrivers();
      if (!confirm(`Delete driver "${store2.drivers[id]?.name}"? This removes their baseline, strikes and history.`)) return;
      delete store2.drivers[id];
      if (store2.activeId === id) store2.activeId = null;
      saveDrivers(store2);
      renderDrivers();
    });
  });

  el.driverList.querySelectorAll(".btnRateTrip").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const wrap = btn.closest("[data-trip-id]");
      const driverId = wrap.getAttribute("data-driver-id");
      const tripId = wrap.getAttribute("data-trip-id");
      const value = Number(btn.getAttribute("data-value"));
      const store2 = loadDrivers();
      const driver = store2.drivers[driverId];
      const trip = driver && (driver.trips || []).find((t) => t.id === tripId);
      if (!trip || trip.rating !== null) return; // already rated elsewhere, or driver/trip gone
      trip.rating = value;
      if (!driver.rating) driver.rating = { sum: 0, count: 0 };
      driver.rating.sum += value;
      driver.rating.count += 1;
      saveDrivers(store2);
      renderDrivers();
    });
  });

  el.driverList.querySelectorAll(".btnSendMessage").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.getAttribute("data-id");
      const input = el.driverList.querySelector(`.msgText[data-id="${id}"]`);
      const text = input.value.trim();
      if (!text) return;
      sendAdminMessage(id, text);
      input.value = "";
    });
  });
}

/** Writes a message for one specific driver to ADMIN_MESSAGE_KEY. app.js watches this key
 *  (storage event) and, if that driver is the one active on this device, shows it exactly
 *  like a fatigue-check prompt — on-screen popup plus a notification. Same foreground-only,
 *  same-device limitation as everything else here: this never reaches a different device. */
function sendAdminMessage(driverId, text) {
  const msg = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, t: new Date().toISOString(), driverId, text };
  try { localStorage.setItem(ADMIN_MESSAGE_KEY, JSON.stringify(msg)); } catch { /* ignore */ }
}

el.btnExport.addEventListener("click", () => {
  const payload = {
    exported: new Date().toISOString(),
    drivers: loadDrivers(),
    notify: loadNotifySettings(),
    thresholds: loadThresholds()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `blinkcheck-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ------------------------------------------------------------- demo fleet -- */
/* For a stage pitch: three realistic-looking profiles spanning the verdict range, so a demo
   doesn't depend on someone having actually driven real test runs beforehand. Fabricated
   demo data, clearly presented as such (button says "demo") — additive, not destructive: it
   merges into whatever's already in the repository rather than wiping real profiles, though a
   real driver who happens to share one of these exact names would get overwritten. */

function demoDriver(name, { rmse, gain, lagMs, strikes, pursuit, reaction, history, rating, trips, driveStatus }) {
  const now = Date.now();
  return {
    id: name.trim().toLowerCase(),
    name,
    created: new Date(now - 6 * 86400000).toISOString(),
    baseline: { rmse, gain, lagMs, recorded: new Date(now - 6 * 86400000).toISOString() },
    strikes,
    stats: { pursuit, reaction },
    history: history.map((h, i) => ({
      t: new Date(now - (history.length - i) * 3600000).toISOString(),
      test: h.test, verdict: h.verdict, detail: {}
    })),
    rating: rating || { sum: 0, count: 0 },
    activeTrip: null,
    trips: (trips || []).map((tr, i) => ({
      id: `${name.trim().toLowerCase()}-demo-trip-${i}`,
      startedAt: new Date(now - (i + 2) * 3600000).toISOString(),
      endedAt: new Date(now - (i + 2) * 3600000 + 25 * 60000).toISOString(),
      rating: tr
    })),
    driveStatus: driveStatus ? { value: driveStatus, updatedAt: new Date(now - 30 * 60000).toISOString() } : null
  };
}

const DEMO_FLEET = [
  demoDriver("Raju Kumar", {
    rmse: 0.32, gain: 0.95, lagMs: 140, strikes: 0,
    pursuit: { pass: 5, watch: 1, fail: 0, void: 0 },
    reaction: { pass: 4, watch: 1, fail: 0, void: 0 },
    history: [
      { test: "pursuit", verdict: "pass" }, { test: "reaction", verdict: "pass" },
      { test: "pursuit", verdict: "pass" }, { test: "reaction", verdict: "watch" },
      { test: "pursuit", verdict: "pass" }, { test: "reaction", verdict: "pass" }
    ],
    rating: { sum: 14, count: 3 }, trips: [5, 5, 4], driveStatus: "can_drive"
  }),
  demoDriver("Vikram Singh", {
    rmse: 0.55, gain: 0.82, lagMs: 210, strikes: 2,
    pursuit: { pass: 2, watch: 3, fail: 1, void: 0 },
    reaction: { pass: 1, watch: 2, fail: 1, void: 0 },
    history: [
      { test: "pursuit", verdict: "watch" }, { test: "reaction", verdict: "watch" },
      { test: "pursuit", verdict: "fail" }, { test: "reaction", verdict: "pass" },
      { test: "pursuit", verdict: "watch" }, { test: "reaction", verdict: "fail" }
    ],
    rating: { sum: 3, count: 1 }, trips: [3, null], driveStatus: "not_applicable"
  }),
  demoDriver("Amit Sharma", {
    rmse: 0.61, gain: 0.70, lagMs: 260, strikes: 3,
    pursuit: { pass: 0, watch: 1, fail: 3, void: 1 },
    reaction: { pass: 0, watch: 0, fail: 3, void: 0 },
    history: [
      { test: "pursuit", verdict: "fail" }, { test: "reaction", verdict: "fail" },
      { test: "pursuit", verdict: "void" }, { test: "pursuit", verdict: "fail" },
      { test: "reaction", verdict: "fail" }, { test: "pursuit", verdict: "watch" }
    ],
    rating: { sum: 2, count: 1 }, trips: [2], driveStatus: "not_applicable"
  })
];

el.btnLoadDemo.addEventListener("click", () => {
  if (!confirm("Load 3 demo drivers (Raju Kumar, Vikram Singh, Amit Sharma)? This adds to the existing repository — it only overwrites a real profile if it happens to share one of those exact names.")) return;
  const store = loadDrivers();
  for (const d of DEMO_FLEET) store.drivers[d.id] = d;
  saveDrivers(store);
  renderDrivers();
});

/* ---------------------------------------------------------------- import -- */

el.btnImportTrigger.addEventListener("click", () => el.importFile.click());

el.importFile.addEventListener("change", () => {
  const file = el.importFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    el.importFile.value = "";
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      el.importStatus.textContent = "That file isn't valid JSON.";
      el.importStatus.style.color = "var(--signal)";
      el.importStatus.classList.remove("hidden");
      return;
    }
    if (!parsed.drivers || typeof parsed.drivers.drivers !== "object") {
      el.importStatus.textContent = "Doesn't look like a BlinkCheck backup file (missing drivers.drivers).";
      el.importStatus.style.color = "var(--signal)";
      el.importStatus.classList.remove("hidden");
      return;
    }
    const store = loadDrivers();
    const importedCount = Object.keys(parsed.drivers.drivers).length;
    for (const [id, driver] of Object.entries(parsed.drivers.drivers)) store.drivers[id] = driver;
    saveDrivers(store);
    if (parsed.notify && typeof parsed.notify === "object") saveNotifySettings(parsed.notify);
    if (parsed.thresholds && typeof parsed.thresholds === "object") saveThresholds(parsed.thresholds);
    el.importStatus.textContent = `Imported ${importedCount} driver${importedCount === 1 ? "" : "s"}.`;
    el.importStatus.style.color = "var(--trace)";
    el.importStatus.classList.remove("hidden");
    refreshAll();
  };
  reader.readAsText(file);
});

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/* ------------------------------------------------------------- live sync -- */
/* The dashboard only reads localStorage when it loads, so a driver created in
   another tab afterward wouldn't show up until a manual reload. The storage
   event fires automatically in every OTHER open tab of the same browser/origin
   the instant one tab writes to localStorage (never in the tab that wrote it,
   by design) - same-browser, same-origin only, this doesn't reach a different
   browser or device. Focus/visibility listeners are a fallback in case a
   storage event gets missed (some browsers throttle it in a backgrounded tab). */

function refreshAll() {
  renderNotifySettings();
  renderAdminNotify();
  renderThresholds();
  renderDrivers();
  processDashboardEvents();
}

window.addEventListener("storage", (e) => {
  if (e.key === DRIVERS_KEY || e.key === NOTIFY_KEY || e.key === THRESHOLDS_KEY
      || e.key === DASHBOARD_EVENTS_KEY || e.key === ADMIN_NOTIFY_KEY || e.key === null) refreshAll();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });
window.addEventListener("focus", refreshAll);
