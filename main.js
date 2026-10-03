"use strict";

const { app, BrowserWindow, ipcMain, screen } = require("electron");

// Capture (and swallow, so no native error dialog) any main-process throw, with
// full stack, into the launchd stderr log (/tmp/doomy.err.log).
process.on("uncaughtException", (err) => {
  process.stderr.write(`[main:uncaughtException] ${err && err.stack ? err.stack : err}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[main:unhandledRejection] ${reason && reason.stack ? reason.stack : reason}\n`);
});
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { SIGNAL_DIR, SESSIONS_DIR, collectPills, dismissSession, sessionContext } = require("./sessions");
const speech = require("./speech");
const checks = require("./checks");

const { loadCharacter, listCharacters, setActiveCharacter, aiReady, phrase, aiLine } = speech;

// Where the outside world (CLI) drops pings for the pet.
const SIGNAL_FILE = path.join(SIGNAL_DIR, "signal.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");

// The window never changes size: it is a transparent sheet big enough for the
// island fully open, and the island animates inside it. Clicks fall through
// everywhere the island isn't.
const WINDOW_WIDTH = 560;
const WINDOW_HEIGHT = 460;
// A Mac with a camera notch has a taller menu bar than one without.
const NOTCH_MENU_BAR_MIN_PX = 30;
const FALLBACK_BAR_PX = 28; // island bar height where there is no menu bar to match
const DEFAULT_NOTCH_WIDTH_PX = 190; // 14" MacBook Pro; settings.json "notchWidth" overrides

/** @type {BrowserWindow | null} */
let petWindow = null;
let lastSignalTs = 0;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// The island belongs on the built-in display, around its notch. With the lid
// shut there is none, so it becomes a plain pill on the main display.
function islandDisplay() {
  return screen.getAllDisplays().find((display) => display.internal) || screen.getPrimaryDisplay();
}

function islandGeometry() {
  const display = islandDisplay();
  const menuBar = display.workArea.y - display.bounds.y;
  const hasNotch = Boolean(display.internal) && menuBar >= NOTCH_MENU_BAR_MIN_PX;
  const settings = readJson(SETTINGS_FILE) || {};
  return {
    barHeight: menuBar || FALLBACK_BAR_PX,
    notchWidth: hasNotch ? settings.notchWidth || DEFAULT_NOTCH_WIDTH_PX : 0,
  };
}

function placeWindow() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const { bounds } = islandDisplay();
  petWindow.setBounds({
    x: Math.round(bounds.x + (bounds.width - WINDOW_WIDTH) / 2),
    y: bounds.y, // over the menu bar, not below it
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
  });
}

function sendCharacter() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.webContents.send("doomy-character", {
    ...loadCharacter(),
    ...islandGeometry(),
    characters: listCharacters(),
    muted: speech.isMuted(),
  });
}

function createWindow() {
  petWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    type: "panel",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Log a renderer crash so a silent white-out still leaves a trace.
  petWindow.webContents.on("render-process-gone", (_e, details) => {
    process.stderr.write(`[render-process-gone] ${JSON.stringify(details)}\n`);
  });

  // "screen-saver" is the level that sits above the menu bar.
  petWindow.setAlwaysOnTop(true, "screen-saver");
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  placeWindow();
  petWindow.loadFile(path.join(__dirname, "renderer", "island.html"));
  petWindow.webContents.on("did-finish-load", () => {
    sendCharacter();
    pushPills(true);
  });

  petWindow.on("closed", () => {
    petWindow = null;
  });
}

// --- Speaking up -------------------------------------------------------------
// The pet comments when a session starts, finishes or needs input, when an
// alert appears, and again if a session is left waiting or runs long.
const STILL_WAITING_MS = 5 * 60 * 1000; // remind this long after "needs you", and at this interval
const LONG_RUNNING_MS = 20 * 60 * 1000; // remark on a session working this long, and at this interval
const REMIND_CHECK_MS = 60 * 1000;
const THINKING_TEXT = "…"; // shown while the model writes a line
const lastStates = new Map(); // pill id -> state last seen
const reminded = new Map(); // session id -> when it was last nagged about waiting
const workingSince = new Map(); // session id -> when it started working / was last remarked on
const lastSessionStates = new Map(); // session id -> state, to re-run the checks on a change
let lastPills = [];
let pillsSeeded = false; // the first list is a snapshot, not news

// `pose` names the animation that goes with the line (default: talking).
// `kind` marks a line the pet volunteers (done, waiting, alert, sessionStarted,
// reminder, longRunning, nag): muting, or settings.json "autoOpen": { kind:
// false }, silences those. A line you asked for has no kind and always shows.
function say(text, { ms = 0, pose = "", kind = "" } = {}) {
  if (!text || !petWindow || petWindow.isDestroyed()) return;
  if (kind && (speech.isMuted() || loadCharacter().autoOpen[kind] === false)) return;
  petWindow.webContents.send("doomy-say", { text, ms, pose });
}

// A character may ship a sound per event in characters/<id>/sounds/.
function playSound(kind) {
  if (speech.isMuted() || loadCharacter().autoOpen[kind] === false) return;
  const file = speech.soundFile(kind);
  if (file) execFile("afplay", [file], () => {});
}

async function announce(pill, pills) {
  const vars = { folder: pill.label };
  const sessionPills = pills.filter((other) => other.kind === "session");
  const stillBusy = sessionPills.some((other) => other.id !== pill.id && other.state !== "done");
  let pool = pill.state;
  if (pill.state === "done" && !stillBusy && sessionPills.length > 1) pool = "allDone";
  const guessed = pill.state === "waiting" && pill.source === "transcript";
  if (guessed) pool = "waitingGuess";
  const fallback = phrase(pool, vars) || phrase(pill.state, vars);
  // Finishing earns a celebration; "needs you" already has its own resting pose.
  const pose = { done: "small_celebration", allDone: "big_celebration" }[pool] || "";
  // A guess stays a canned line — a model would state it as fact.
  const kind = pill.state;
  playSound(kind);
  if (guessed || !aiReady()) {
    say(fallback, { pose, kind });
    return;
  }
  say(THINKING_TEXT, { ms: loadCharacter().ai.timeoutMs + 500, pose: "thinking", kind });
  say((await aiLine(pill.state, vars, sessionContext(pill.id))) || fallback, { pose, kind });
}

function noticeChanges(pills) {
  const now = Date.now();
  const seen = new Set();
  for (const pill of pills) {
    seen.add(pill.id);
    const previous = lastStates.get(pill.id);
    lastStates.set(pill.id, pill.state);
    if (previous === pill.state) continue;
    if (pill.state === "working") workingSince.set(pill.id, now);
    else workingSince.delete(pill.id);
    if (!pillsSeeded) continue;
    if (pill.kind === "alert") {
      // The routine git reminders (uncommitted, unpushed) appear without a word.
      const worthSaying = !pill.auto || pill.state === "warn";
      if (previous === undefined && worthSaying) {
        say(phrase("alert", { label: pill.label, text: pill.text }), { pose: "alert_heads_up", kind: "alert" });
      }
    } else if (previous === undefined && pill.state === "working") {
      say(phrase("sessionStarted", { folder: pill.label }), { kind: "sessionStarted" });
    } else if (pill.state === "waiting" || pill.state === "done") {
      announce(pill, pills);
    }
  }
  if (pills.some((pill) => pill.kind === "session" && lastSessionStates.get(pill.id) !== pill.state)) setImmediate(refreshChecks);
  lastSessionStates.clear();
  for (const pill of pills) if (pill.kind === "session") lastSessionStates.set(pill.id, pill.state);
  for (const id of lastStates.keys()) {
    if (seen.has(id)) continue;
    lastStates.delete(id);
    reminded.delete(id);
    workingSince.delete(id);
  }
  pillsSeeded = true;
}

function remind() {
  const now = Date.now();
  const sessionPills = lastPills.filter((pill) => pill.kind === "session");
  const waiting = sessionPills.filter((pill) => pill.state === "waiting");
  const due = waiting.filter((pill) => now - (reminded.get(pill.id) || pill.ts) >= STILL_WAITING_MS);
  if (due.length) {
    const oldest = waiting.reduce((a, b) => (a.ts <= b.ts ? a : b));
    const vars = { folder: oldest.label, minutes: Math.round((now - oldest.ts) / 60000), count: waiting.length };
    say(phrase(waiting.length > 1 ? "manyWaiting" : "stillWaiting", vars), { pose: "worried_impatient", kind: "reminder" });
    for (const pill of waiting) reminded.set(pill.id, now);
    return;
  }
  const long = sessionPills.find((pill) => pill.state === "working" && now - (workingSince.get(pill.id) || now) >= LONG_RUNNING_MS);
  if (long) {
    const minutes = Math.round((now - workingSince.get(long.id)) / 60000);
    say(phrase("longRunning", { folder: long.label, minutes }), { kind: "longRunning" });
    workingSince.set(long.id, now);
  }
}

// After working hours the pet tells its owner to log off, every 10 minutes.
const WORK_END_MIN = 18 * 60 + 30; // 18:30
const NIGHT_END_MIN = 6 * 60; // 06:00 — after-hours runs 18:30 → 06:00
const NAG_INTERVAL_MS = 10 * 60 * 1000;
let lastNagTs = 0;

function nag(kind = "") {
  say(phrase("nags"), { pose: "go_home", kind });
}

// A 1-minute poll rather than a timer aimed at 18:30, so it self-heals if the
// laptop slept through the boundary.
function nagIfLate() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const afterHours = minutes >= WORK_END_MIN || minutes < NIGHT_END_MIN;
  if (!afterHours || now - lastNagTs < NAG_INTERVAL_MS) return;
  // Only nag someone who is still working.
  if (!lastPills.some((pill) => pill.kind === "session" && pill.state !== "done")) return;
  lastNagTs = now.getTime();
  nag("nag");
}

// --- Session + alert state ----------------------------------------------------
// Transcripts are only polled, and time alone moves a session between states
// (a pending tool call ages into "may need you"), so re-collect on a tick too.
const PILLS_POLL_MS = 5000;
let lastPillsJson = "";

function pushPills(force = false) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const pills = [...collectPills(), ...checks.alerts()];
  lastPills = pills;
  noticeChanges(pills);
  const json = JSON.stringify(pills);
  if (!force && json === lastPillsJson) return;
  lastPillsJson = json;
  petWindow.webContents.send("doomy-pills", pills);
}

// Project checks (uncommitted, unpushed, undeployed, unapplied) for every
// folder with a live session. They shell out to git, so they run on their own
// slower tick and whenever a session changes state.
const CHECKS_MS = 60 * 1000;
let checksRunning = false;

async function refreshChecks() {
  if (checksRunning) return;
  checksRunning = true;
  try {
    const folders = lastPills
      .filter((pill) => pill.kind === "session" && pill.cwd)
      .map((pill) => ({ cwd: pill.cwd, working: pill.state === "working" }));
    if (await checks.refresh(folders)) pushPills();
  } finally {
    checksRunning = false;
  }
}

function watchPills() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.watch(SESSIONS_DIR, () => pushPills());
  fs.watch(SIGNAL_DIR, (_event, filename) => {
    if (!filename || filename === "alerts.json") pushPills();
  });
  setInterval(pushPills, PILLS_POLL_MS);
  setInterval(refreshChecks, CHECKS_MS);
  refreshChecks();
  setInterval(remind, REMIND_CHECK_MS);
  setInterval(nagIfLate, REMIND_CHECK_MS);
}

// --- CLI signals ---------------------------------------------------------------
function switchCharacter(id) {
  const ids = listCharacters();
  // No id (or an unknown one) means "the next one".
  const next = ids.includes(id) ? id : ids[(ids.indexOf(loadCharacter().id) + 1) % ids.length];
  if (!next || !setActiveCharacter(next)) return;
  sendCharacter();
  say(phrase("greetings"));
}

function handleSignal(action, arg) {
  switch (action) {
    case "yay":
      say(phrase("yay"), { pose: "small_celebration" });
      break;
    case "dance":
      say(phrase("dance"), { pose: "big_celebration" });
      break;
    case "jump":
    case "ping":
      say(phrase("ping"), { pose: "needs_you" });
      break;
    case "greet":
      say(phrase("greetings"));
      break;
    case "nag":
      nag();
      break;
    case "character":
      switchCharacter(arg);
      break;
    default:
      break;
  }
}

function readSignal() {
  return readJson(SIGNAL_FILE);
}

function dispatchSignal() {
  const signal = readSignal();
  if (!signal || typeof signal.ts !== "number") return;
  if (signal.ts <= lastSignalTs) return; // already handled
  lastSignalTs = signal.ts;
  handleSignal(signal.action, signal.arg || "");
}

function ensureSignalFile() {
  fs.mkdirSync(SIGNAL_DIR, { recursive: true });
  if (!fs.existsSync(SIGNAL_FILE)) {
    fs.writeFileSync(SIGNAL_FILE, JSON.stringify({ action: "idle", ts: 0 }));
  }
}

// A restart must not re-fire whatever was last sent: lastSignalTs starts at 0, so
// without this the pet replays the previous action every time it comes back up.
function ignoreSignalsFromBefore() {
  const signal = readSignal();
  if (signal && typeof signal.ts === "number") lastSignalTs = signal.ts;
}

function watchSignal() {
  // Watch the directory rather than the file: atomic replaces (write-temp +
  // rename) drop a direct file watch on some platforms.
  fs.watch(SIGNAL_DIR, (_event, filename) => {
    if (!filename || filename === "signal.json") dispatchSignal();
  });
  // Safety net for editors/platforms where fs.watch misses events.
  setInterval(dispatchSignal, 1000);
}

// --- Renderer requests ---------------------------------------------------------
ipcMain.on("doomy-quit", () => app.quit());

// The window ignores the mouse except while the pointer is over the island.
ipcMain.on("doomy-set-interactive", (_event, interactive) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});

ipcMain.on("doomy-switch-character", () => switchCharacter(""));

// Bring the VS Code window that has this folder open to the front (`code <dir>`
// reuses an open window). The `code` shell command is often not on PATH — and
// never on launchd's — so fall back to the copy inside the app bundle.
const CODE_BIN_CANDIDATES = [
  "/usr/local/bin/code",
  "/opt/homebrew/bin/code",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
];
// The Claude Code extension's own link: opens that session's tab in whichever
// VS Code window is in front — so it is sent just after `code` raises the
// right one.
const SESSION_URL = "vscode://anthropic.claude-code/open?session=";
const FOCUS_TAB_DELAY_MS = 700;

function focusFolder(cwd, sessionId = "") {
  if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) return;
  const codeBin = CODE_BIN_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!codeBin) {
    process.stderr.write("[focusFolder] no `code` binary found\n");
    return;
  }
  execFile(codeBin, [cwd], (err) => {
    if (err) process.stderr.write(`[focusFolder] ${err.message}\n`);
    else if (/^[A-Za-z0-9-]+$/.test(sessionId)) {
      setTimeout(() => execFile("open", [`${SESSION_URL}${sessionId}`], () => {}), FOCUS_TAB_DELAY_MS);
    }
  });
}
ipcMain.on("doomy-focus-folder", (_event, cwd, sessionId) => focusFolder(cwd, sessionId));

// "Mark as done" on a not-deployed / not-applied row.
ipcMain.on("doomy-mark-done", async (_event, id) => {
  if (await checks.markDone(id)) refreshChecks();
});

ipcMain.on("doomy-toggle-mute", () => {
  speech.setMuted(!speech.isMuted());
  sendCharacter();
});

// Clicking the character: "what's outstanding?", answered in its own voice.
ipcMain.on("doomy-summary", async () => {
  const items = lastPills.map((pill) => {
    if (pill.kind === "alert") return `${pill.label}: ${pill.text}`;
    const status = { waiting: "is waiting for an answer", working: "is working", done: "has finished" }[pill.state];
    return `${pill.label}${pill.topic ? ` ("${pill.topic}")` : ""} ${status}`;
  });
  if (!items.length) {
    say(phrase("hover"));
    return;
  }
  const plain = items.join(". ");
  if (!aiReady()) {
    say(plain);
    return;
  }
  say(THINKING_TEXT, { ms: loadCharacter().ai.timeoutMs + 500, pose: "thinking" });
  say((await speech.aiSummary(items)) || plain);
});
ipcMain.on("doomy-dismiss-session", (_event, id, ts) => {
  dismissSession(id, ts);
  pushPills();
});

// A line for the pet to say when hovered, picked from the character's pool.
ipcMain.handle("doomy-hover-line", () => phrase("hover"));

app.setName("Doomy");

app.whenReady().then(() => {
  // A notch dweller has no business in the Dock.
  if (app.dock) app.dock.hide();
  ensureSignalFile();
  ignoreSignalsFromBefore();
  createWindow();
  watchSignal();
  watchPills();

  // Lid opened or closed, monitor plugged in: move to wherever the notch is now.
  for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
    screen.on(event, () => {
      placeWindow();
      sendCharacter();
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Keep running with no windows (it's a pet, not a document app) — but on macOS
// the dock isn't shown anyway. Quit only via the pet's own menu.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
