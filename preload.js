"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("doomy", {
  // The active character (name, accent, sprites) and the island's geometry.
  // Sent at load and again whenever either changes.
  onCharacter(callback) {
    return subscribe("doomy-character", callback);
  },
  // The full list of session + alert pills, re-sent on any change.
  onPills(callback) {
    return subscribe("doomy-pills", callback);
  },
  // Lines the pet should say: { text, ms, pose }.
  onSay(callback) {
    return subscribe("doomy-say", callback);
  },
  hoverLine() {
    return ipcRenderer.invoke("doomy-hover-line");
  },
  // The window lets clicks through unless the pointer is over the island.
  setInteractive(interactive) {
    ipcRenderer.send("doomy-set-interactive", interactive);
  },
  // Raise the folder's VS Code window and, for a session, its Claude tab.
  focusFolder(cwd, sessionId) {
    ipcRenderer.send("doomy-focus-folder", cwd, sessionId);
  },
  markDone(id) {
    ipcRenderer.send("doomy-mark-done", id);
  },
  toggleMute() {
    ipcRenderer.send("doomy-toggle-mute");
  },
  summary() {
    ipcRenderer.send("doomy-summary");
  },
  dismissSession(id, ts) {
    ipcRenderer.send("doomy-dismiss-session", id, ts);
  },
  switchCharacter() {
    ipcRenderer.send("doomy-switch-character");
  },
  quit() {
    ipcRenderer.send("doomy-quit");
  },
});
