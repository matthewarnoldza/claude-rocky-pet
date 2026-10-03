"use strict";

// The pet lives in an island around the camera notch. Collapsed, it is a bar
// in the menu bar: the character one side of the camera, session counts the
// other. It drops open to speak, and on hover to list every session and alert.

const WING_WIDTH = 64; // must match --wing-width in island.css
const OPEN_WIDTH = 440; // must match --open-width
const CLOSE_DELAY_MS = 250; // grace before collapsing after the pointer leaves
const HOVER_LINE_MS = 2600; // how long a hover remark holds the talking pose
const SAY_MIN_MS = 2500;
const SAY_MS_PER_CHAR = 55; // longer lines stay up long enough to read

// One-shot animations and how long each runs; every other pose loops.
const ONE_SHOT_MS = {
  small_celebration: 1680,
  big_celebration: 3200,
  waking_up: 1000,
  alert_heads_up: 1500,
};

const PILL_STATUS = { waiting: "Needs you", working: "Working", done: "Done" };
// The transcript fallback can only guess that a stalled tool call is a prompt.
const GUESSED_WAITING_STATUS = "May need you";
const WORRIED_AFTER_MS = 5 * 60 * 1000; // a session left waiting this long worries the pet
const TICK_MS = 30 * 1000; // waiting ages (minutes shown, mood) with no new pills

const islandEl = document.getElementById("island");
const bodyEl = document.getElementById("body");
const miniEl = document.getElementById("mini");
const fullEl = document.getElementById("full");
const lineEl = document.getElementById("line");
const countsEl = document.getElementById("counts");
const rowsEl = document.getElementById("rows");
const switchEl = document.getElementById("switch");
const quitEl = document.getElementById("quit");
const muteEl = document.getElementById("mute");
const portraitEl = document.getElementById("portrait");

let character = { name: "", sprites: { full: {}, mini: {} }, barHeight: 33, notchWidth: 0, characters: [] };
let pills = [];
let hovering = false;
let speaking = false;
let ambientPose = "idle_base";
let seeded = false; // the first pill list is a snapshot, not news
let sayTimer = null;
let poseTimer = null;
let closeTimer = null;

// --- Sprites -------------------------------------------------------------------
function spriteUrl(set, pose) {
  const { full, mini } = character.sprites;
  const pool = set === "mini" ? { ...full, ...mini } : full;
  return pool[pose] || pool.idle_base || "";
}

function setSprite(el, set, pose, restart = false) {
  const url = spriteUrl(set, pose);
  if (!url) return;
  // An animated image only replays from frame 0 if its src changes.
  const src = restart ? `${url}?t=${Date.now()}` : url;
  if (el.dataset.src !== src) {
    el.dataset.src = src;
    el.src = src;
  }
}

// The large character: a one-shot plays through, then it goes back to talking
// (if a line is still up) or to the resting pose.
function showPose(pose) {
  clearTimeout(poseTimer);
  poseTimer = null;
  if (ONE_SHOT_MS[pose]) {
    setSprite(fullEl, "full", pose, true);
    poseTimer = setTimeout(() => {
      poseTimer = null;
      showPose(speaking ? "talking" : ambientPose);
    }, ONE_SHOT_MS[pose]);
  } else {
    setSprite(fullEl, "full", pose);
  }
}

// --- Mood ----------------------------------------------------------------------
// The pose the pet rests in follows what the sessions are doing.
function moodFor() {
  const live = pills.filter((pill) => pill.kind === "session");
  const waiting = live.filter((pill) => pill.state === "waiting");
  if (waiting.some((pill) => Date.now() - pill.ts >= WORRIED_AFTER_MS)) return "worried_impatient";
  if (waiting.length) return "needs_you";
  if (live.some((pill) => pill.state === "working")) return "working_watching";
  return live.length ? "idle_base" : "sleepy_asleep";
}

function updateMood() {
  const next = moodFor();
  const wokeUp = seeded && ambientPose === "sleepy_asleep" && next !== ambientPose;
  ambientPose = next;
  setSprite(miniEl, "mini", ambientPose);
  if (wokeUp) showPose("waking_up");
  else if (!speaking && !poseTimer) showPose(ambientPose);
}

// --- Layout --------------------------------------------------------------------
// The island's size is set explicitly so it can animate between modes.
function layout() {
  const mode = islandEl.dataset.mode;
  const collapsed = mode === "collapsed";
  const width = collapsed ? character.notchWidth + WING_WIDTH * 2 : OPEN_WIDTH;
  const height = character.barHeight + (collapsed ? 0 : bodyEl.offsetHeight);
  islandEl.style.setProperty("--island-width", `${width}px`);
  islandEl.style.setProperty("--island-height", `${height}px`);
}

function setMode(mode) {
  if (islandEl.dataset.mode !== mode) islandEl.dataset.mode = mode;
  layout();
}

function settle() {
  setMode(hovering ? "open" : speaking ? "speaking" : "collapsed");
}

// --- Counts + rows ---------------------------------------------------------------
function minutesSince(ts) {
  return Math.round((Date.now() - ts) / 60000);
}

function statusText(pill) {
  if (pill.kind === "alert") return pill.text;
  if (pill.state !== "waiting") return PILL_STATUS[pill.state];
  const status = pill.source === "transcript" ? GUESSED_WAITING_STATUS : PILL_STATUS.waiting;
  const minutes = minutesSince(pill.ts);
  return minutes >= 1 ? `${status} · ${minutes} min` : status;
}

function dot(state) {
  const el = document.createElement("span");
  el.className = `dot ${state}`;
  return el;
}

function renderCounts() {
  const tally = { waiting: 0, working: 0, done: 0, alert: 0 };
  for (const pill of pills) tally[pill.kind === "alert" ? "alert" : pill.state] += 1;
  countsEl.replaceChildren();
  for (const [state, count] of Object.entries(tally)) {
    if (!count) continue;
    const el = document.createElement("span");
    el.className = "count";
    el.append(dot(state), String(count));
    countsEl.appendChild(el);
  }
}

function renderRows() {
  rowsEl.replaceChildren();
  if (!pills.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No sessions running.";
    rowsEl.appendChild(empty);
  }
  for (const pill of pills) {
    const row = document.createElement("button");
    row.className = "row";
    row.type = "button";
    row.title = pill.title || "";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = pill.label;
    // Claude's own title for the session tells two tabs in one folder apart.
    const topic = document.createElement("span");
    topic.className = "row-topic";
    topic.textContent = pill.topic || "";
    const status = document.createElement("span");
    status.className = "row-status";
    status.textContent = statusText(pill);
    row.append(dot(pill.state), label, topic, status);
    if (pill.markable) {
      const mark = document.createElement("span");
      mark.className = "row-mark";
      mark.textContent = "✓";
      mark.title = "Mark as done";
      mark.addEventListener("click", (event) => {
        event.stopPropagation();
        window.doomy.markDone(pill.id);
      });
      row.appendChild(mark);
    }
    row.addEventListener("click", () => {
      if (pill.cwd) window.doomy.focusFolder(pill.cwd, pill.kind === "session" ? pill.id : "");
      // A "done" row has said its piece once it is clicked; the rest stay up
      // until the session (or the script that owns the alert) moves on.
      if (pill.kind === "session" && pill.state === "done") window.doomy.dismissSession(pill.id, pill.ts);
    });
    rowsEl.appendChild(row);
  }
}

function render() {
  renderCounts();
  renderRows();
  updateMood();
  layout();
}

// --- Speaking ----------------------------------------------------------------------
function stopSpeaking() {
  speaking = false;
  if (!poseTimer) showPose(ambientPose);
  settle();
}

function say({ text, ms, pose }) {
  clearTimeout(sayTimer);
  speaking = true;
  lineEl.textContent = text;
  showPose(pose || "talking");
  settle();
  sayTimer = setTimeout(stopSpeaking, ms || Math.max(SAY_MIN_MS, 1200 + SAY_MS_PER_CHAR * text.length));
}

// --- Hover ---------------------------------------------------------------------------
islandEl.addEventListener("mouseenter", async () => {
  clearTimeout(closeTimer);
  window.doomy.setInteractive(true);
  hovering = true;
  settle();
  if (speaking) return;
  const text = await window.doomy.hoverLine();
  if (!text || speaking || !hovering) return;
  say({ text, ms: HOVER_LINE_MS });
});

islandEl.addEventListener("mouseleave", () => {
  window.doomy.setInteractive(false);
  closeTimer = setTimeout(() => {
    hovering = false;
    settle();
  }, CLOSE_DELAY_MS);
});

switchEl.addEventListener("click", () => window.doomy.switchCharacter());
muteEl.addEventListener("click", () => window.doomy.toggleMute());
portraitEl.addEventListener("click", () => window.doomy.summary());
quitEl.addEventListener("click", () => window.doomy.quit());

// --- Main-process feeds ------------------------------------------------------------------
window.doomy.onCharacter((next) => {
  character = next;
  const root = document.documentElement.style;
  root.setProperty("--accent", character.accent);
  root.setProperty("--bar-height", `${character.barHeight}px`);
  root.setProperty("--notch-width", `${character.notchWidth}px`);
  switchEl.textContent = character.characters.length > 1 ? `${character.name} ⇄` : "";
  muteEl.textContent = character.muted ? "Unmute" : "Mute";
  miniEl.dataset.src = "";
  fullEl.dataset.src = "";
  setSprite(miniEl, "mini", ambientPose);
  showPose(speaking ? "talking" : ambientPose);
  layout();
});

window.doomy.onPills((next) => {
  pills = next;
  render();
  seeded = true;
});

window.doomy.onSay(say);

setInterval(render, TICK_MS);
layout();
