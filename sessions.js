"use strict";

// Works out what every Claude Code session is doing, from three sources:
//   1. ~/.doomy/sessions/<session_id>.json — written by hooks/doomy-state.sh
//   2. ~/.claude/projects/*/<session_id>.jsonl — transcripts, tailed as a
//      fallback for when a hook never fired
//   3. ~/.doomy/alerts.json — extra alerts any other script may write
// and folds them into one list of pills for the renderer.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SIGNAL_DIR = path.join(os.homedir(), ".doomy");
const SESSIONS_DIR = path.join(SIGNAL_DIR, "sessions");
const ALERTS_FILE = path.join(SIGNAL_DIR, "alerts.json");
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // forget a session nothing has touched for this long
const DONE_TTL_MS = 30 * 60 * 1000; // a "done" pill nobody clicked fades after this
const TRANSCRIPT_WINDOW_MS = 2 * 60 * 60 * 1000; // only tail transcripts written this recently
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_HEAD_BYTES = 16 * 1024;
// Hooks land within seconds of the transcript line they belong to. A hook
// state this much older than the transcript means the hooks missed something.
const HOOK_STALE_MS = 2 * 60 * 1000;
const DONE_QUIET_MS = 15 * 1000; // a finished reply must sit this long before it counts as done
// A tool call with no result for this long is PROBABLY a permission prompt —
// but a slow build looks identical, so the pill says "may need you".
const PENDING_TOOL_MS = 90 * 1000;
const WORKING_QUIET_MS = 5 * 60 * 1000; // a turn silent for this long is no longer "working"

const STATES = new Set(["idle", "working", "waiting", "done"]);
const ALERT_LEVELS = new Set(["info", "warn"]);

const transcriptCache = new Map(); // file path -> { mtimeMs, size, info }
const dismissed = new Map(); // session id -> ts of the state that was dismissed
let latestTranscripts = new Map(); // session id -> transcript info from the last scan
const MAX_TOOL_INPUT_CHARS = 300;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readHookSessions(now) {
  const sessions = new Map();
  let names = [];
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return sessions;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(SESSIONS_DIR, name);
    const data = readJson(file);
    if (!data || typeof data.ts !== "number" || !STATES.has(data.state)) continue;
    if (now - data.ts > SESSION_MAX_AGE_MS) {
      fs.rmSync(file, { force: true });
      continue;
    }
    const id = name.slice(0, -".json".length);
    sessions.set(id, { id, cwd: data.cwd || "", state: data.state, ts: data.ts, permissionMode: data.permission_mode || "" });
  }
  return sessions;
}

function readChunk(file, start, length) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.toString("utf8", 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// The last real message decides the state; bookkeeping lines (titles, file
// snapshots, attachments) and subagent sidechains are skipped.
function parseTranscript(file, size) {
  const tailStart = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
  const lines = readChunk(file, tailStart, size - tailStart).split("\n");
  if (tailStart > 0) lines.shift(); // first line is cut mid-way
  let last = null;
  let title = "";
  let lastText = "";
  for (let i = lines.length - 1; i >= 0 && !(last && title && lastText); i -= 1) {
    if (!lines[i]) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!title && entry.type === "ai-title" && entry.aiTitle) title = entry.aiTitle;
    if (entry.isSidechain || (entry.type !== "user" && entry.type !== "assistant")) continue;
    if (!last) last = entry;
    const blocks = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
    const text = entry.type === "assistant" && blocks.find((block) => block.type === "text" && block.text);
    if (!lastText && text) lastText = text.text;
  }
  if (!last) return null;
  // The opening lines carry the folder the session started in.
  const head = readChunk(file, 0, Math.min(size, TRANSCRIPT_HEAD_BYTES));
  const firstCwd = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  let cwd = last.cwd || "";
  if (firstCwd) {
    try {
      cwd = JSON.parse(`"${firstCwd[1]}"`);
    } catch {
      // keep the last message's cwd
    }
  }
  const content = last.message && Array.isArray(last.message.content) ? last.message.content : [];
  const tool = last.type === "assistant" && content.find((block) => block.type === "tool_use");
  return {
    cwd,
    title,
    lastText,
    toolName: tool ? tool.name : "",
    toolInput: tool ? JSON.stringify(tool.input || {}).slice(0, MAX_TOOL_INPUT_CHARS) : "",
    lastTs: Date.parse(last.timestamp) || 0,
    lastType: last.type,
    stopReason: (last.message && last.message.stop_reason) || "",
    pendingTool: Boolean(tool),
  };
}

function inferState(info, now) {
  const quiet = now - info.lastTs;
  if (info.pendingTool) return quiet >= PENDING_TOOL_MS ? "waiting" : "working";
  if (info.lastType === "assistant" && info.stopReason && info.stopReason !== "tool_use") {
    return quiet >= DONE_QUIET_MS ? "done" : "working";
  }
  return quiet < WORKING_QUIET_MS ? "working" : "idle";
}

function scanTranscripts(now) {
  const found = new Map();
  let projects = [];
  try {
    projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return found;
  }
  const seen = new Set();
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, project.name);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > TRANSCRIPT_WINDOW_MS) continue;
      seen.add(file);
      let cached = transcriptCache.get(file);
      if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
        let info = null;
        try {
          info = parseTranscript(file, stat.size);
        } catch {
          // unreadable mid-write — try again next scan
        }
        cached = { mtimeMs: stat.mtimeMs, size: stat.size, info };
        transcriptCache.set(file, cached);
      }
      if (!cached.info) continue;
      const id = name.slice(0, -".jsonl".length);
      found.set(id, { id, ...cached.info, state: inferState(cached.info, now) });
    }
  }
  for (const file of transcriptCache.keys()) {
    if (!seen.has(file)) transcriptCache.delete(file);
  }
  return found;
}

function readAlerts() {
  const data = readJson(ALERTS_FILE);
  const list = data && Array.isArray(data.alerts) ? data.alerts : [];
  const alerts = [];
  for (const alert of list) {
    if (!alert || typeof alert.id !== "string" || typeof alert.text !== "string") continue;
    const cwd = typeof alert.cwd === "string" ? alert.cwd : "";
    alerts.push({
      id: `alert:${alert.id}`,
      kind: "alert",
      state: ALERT_LEVELS.has(alert.level) ? alert.level : "info",
      label: typeof alert.label === "string" && alert.label ? alert.label : path.basename(cwd) || alert.id,
      text: alert.text,
      cwd,
      title: cwd,
    });
  }
  return alerts;
}

// One pill per live session, then one per alert.
function collectPills(now = Date.now()) {
  const hooks = readHookSessions(now);
  const transcripts = scanTranscripts(now);
  latestTranscripts = transcripts;
  const sessions = [];
  for (const id of new Set([...hooks.keys(), ...transcripts.keys()])) {
    const hook = hooks.get(id);
    const transcript = transcripts.get(id);
    const hookFresh = hook && (!transcript || hook.ts >= transcript.lastTs - HOOK_STALE_MS);
    const source = hookFresh ? "hook" : "transcript";
    const state = hookFresh ? hook.state : transcript.state;
    const ts = hookFresh ? hook.ts : transcript.lastTs;
    if (state === "idle") continue;
    if (state === "done" && now - ts > DONE_TTL_MS) continue;
    if (dismissed.get(id) === ts) continue;
    // The transcript's opening cwd is the truth; a hook file first written
    // mid-session may already have followed the shell somewhere else.
    const cwd = (transcript && transcript.cwd) || (hook && hook.cwd) || "";
    sessions.push({
      id,
      kind: "session",
      state,
      source,
      ts,
      cwd,
      label: path.basename(cwd) || "session",
      topic: (transcript && transcript.title) || "", // Claude's own title for the session
      title: cwd,
      permissionMode: (hook && hook.permissionMode) || "",
    });
  }
  // A fixed order, so a pill keeps its place in the stack as others come and go.
  sessions.sort((a, b) => (a.id < b.id ? -1 : 1));
  const perLabel = new Map();
  for (const session of sessions) {
    const count = (perLabel.get(session.label) || 0) + 1;
    perLabel.set(session.label, count);
    if (count > 1) session.label = `${session.label} ${count}`;
  }
  return [...sessions, ...readAlerts()];
}

// Hide a session's pill until its state next changes.
function dismissSession(id, ts) {
  dismissed.set(id, ts);
}

// What a session was last doing, for the pet to comment on.
function sessionContext(id) {
  const info = latestTranscripts.get(id);
  if (!info) return {};
  return { title: info.title, lastText: info.lastText, toolName: info.toolName, toolInput: info.toolInput };
}

module.exports = { SIGNAL_DIR, SESSIONS_DIR, ALERTS_FILE, collectPills, dismissSession, sessionContext };
