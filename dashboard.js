/* BlinkCheck — dev dashboard. Reads/writes the same localStorage this browser's
   main site uses. Standalone script (not a module, no camera/MediaPipe code) —
   this page only ever manages data, it never runs a test.

   Not real access control: this is a static site with no server, so there is
   no way to actually authenticate a request. The passphrase gate below is
   visible in this file to anyone who opens dev tools; it only stops casual
   stumbling onto this page, which isn't linked from the main site. */

const PASSPHRASE = "blinkcheck-admin"; // change this; still not real security — see note above
const UNLOCK_KEY = "blinkcheck.dashboard.unlocked";

// Must match the keys app.js uses.
const DRIVERS_KEY = "blinkcheck.drivers.v1";
const NOTIFY_KEY = "blinkcheck.notify.v1";

const $ = (id) => document.getElementById(id);
const el = {
  gate: $("gate"), gatePass: $("gatePass"), btnUnlock: $("btnUnlock"), gateError: $("gateError"),
  dashBody: $("dashBody"),
  intervalHours: $("intervalHours"), btnSaveInterval: $("btnSaveInterval"),
  btnTestNotify: $("btnTestNotify"), notifyStatus: $("notifyStatus"),
  statDrivers: $("statDrivers"), statTests: $("statTests"), statStrikes: $("statStrikes"),
  driverRows: $("driverRows"), driverEmpty: $("driverEmpty")
};

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
  renderDrivers();
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

/* -------------------------------------------------------------- drivers -- */

function renderDrivers() {
  const store = loadDrivers();
  const drivers = Object.values(store.drivers);

  let totalTests = 0, totalStrikes = 0;
  el.driverRows.innerHTML = "";
  for (const d of drivers) {
    const p = d.stats.pursuit, r = d.stats.reaction;
    totalTests += p.pass + p.watch + p.fail + p.void + r.pass + r.watch + r.fail + r.void;
    totalStrikes += d.strikes;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="px-5 py-2">${escapeHtml(d.name)}</td>
      <td class="px-3 py-2 readout">${d.baseline ? d.baseline.rmse.toFixed(3) : "not set"}</td>
      <td class="px-3 py-2 readout" style="color: var(--signal);">${d.strikes}</td>
      <td class="px-3 py-2 readout">${p.pass} / ${p.watch} / ${p.fail} / ${p.void}</td>
      <td class="px-3 py-2 readout">${r.pass} / ${r.watch} / ${r.fail} / ${r.void}</td>
      <td class="px-3 py-2 text-muted text-xs">${new Date(d.created).toLocaleDateString()}</td>
      <td class="px-5 py-2 text-right"><button data-id="${d.id}" class="btnDeleteDriver text-xs text-muted underline decoration-dotted hover:text-ink">Delete</button></td>
    `;
    el.driverRows.appendChild(tr);
  }

  el.driverEmpty.classList.toggle("hidden", drivers.length > 0);
  el.statDrivers.textContent = String(drivers.length);
  el.statTests.textContent = String(totalTests);
  el.statStrikes.textContent = String(totalStrikes);

  el.driverRows.querySelectorAll(".btnDeleteDriver").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const store2 = loadDrivers();
      if (!confirm(`Delete driver "${store2.drivers[id]?.name}"? This removes their baseline, strikes and history.`)) return;
      delete store2.drivers[id];
      if (store2.activeId === id) store2.activeId = null;
      saveDrivers(store2);
      renderDrivers();
    });
  });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
