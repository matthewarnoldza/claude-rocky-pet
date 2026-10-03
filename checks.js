"use strict";

// Things a project still owes you, worked out from the repo itself — no
// hosting account needed:
//   - files changed but not committed, commits not pushed (plain git)
//   - commits made since the last production deploy
//   - migration files added since migrations were last applied
// The last two compare against ~/.doomy/projects.json, which records the commit
// that was last deployed and the migrations last applied for each repo. It is
// written by hooks/doomy-track.sh (which spots a deploy or a migration run
// among a session's commands), by `doomy deployed` / `doomy applied`, and by
// the "mark as done" button in the island.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECTS_FILE = path.join(os.homedir(), ".doomy", "projects.json");
const MIGRATIONS_DIR = path.join("supabase", "migrations");
const GIT_TIMEOUT_MS = 5000;

let current = []; // alerts from the last refresh

function readProjects() {
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeProjects(projects) {
  fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
  const tmp = `${PROJECTS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(projects, null, 2)}\n`);
  fs.renameSync(tmp, PROJECTS_FILE);
}

// Resolves to trimmed stdout, or null if git fails (not a repo, no upstream…).
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

function migrationFiles(root) {
  try {
    return fs.readdirSync(path.join(root, MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
  } catch {
    return [];
  }
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

async function checkRepo(root, projects, quiet) {
  const alerts = [];
  const add = (type, level, text, markable = false) =>
    alerts.push({ id: `check:${type}:${root}`, kind: "alert", auto: true, state: level, label: path.basename(root), text, cwd: root, title: root, markable });
  const record = projects[root] || {};

  // A session mid-task always has loose changes; only mention them once it stops.
  if (!quiet) {
    const status = await git(root, ["status", "--porcelain"]);
    const changed = status ? status.split("\n").length : 0;
    if (changed) add("uncommitted", "info", `${plural(changed, "file", "files")} not committed`);
    const ahead = Number(await git(root, ["rev-list", "--count", "@{upstream}..HEAD"]));
    if (ahead) add("unpushed", "info", `${plural(ahead, "commit", "commits")} not pushed`);
  }

  if (record.deployedSha) {
    const since = Number(await git(root, ["rev-list", "--count", `${record.deployedSha}..HEAD`]));
    if (since) add("undeployed", "warn", `${plural(since, "commit", "commits")} not deployed`, true);
  }

  const migrations = migrationFiles(root);
  if (migrations.length) {
    if (!Array.isArray(record.appliedMigrations)) {
      // First sight of this repo: assume what is already there has been applied.
      projects[root] = { ...record, appliedMigrations: migrations };
      projects.changed = true;
    } else {
      const pending = migrations.filter((name) => !record.appliedMigrations.includes(name));
      if (pending.length) add("migrations", "warn", `${plural(pending.length, "migration", "migrations")} not applied`, true);
    }
  }
  return alerts;
}

// `folders` is [{ cwd, working }] — one per live session.
async function refresh(folders) {
  const roots = new Map(); // repo root -> is a session still working there?
  for (const { cwd, working } of folders) {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    if (root) roots.set(root, roots.get(root) || working);
  }
  const projects = readProjects();
  const alerts = [];
  for (const [root, working] of roots) alerts.push(...(await checkRepo(root, projects, working)));
  if (projects.changed) {
    delete projects.changed;
    writeProjects(projects);
  }
  const changed = JSON.stringify(alerts) !== JSON.stringify(current);
  current = alerts;
  return changed;
}

async function markDeployed(cwd) {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const sha = root && (await git(root, ["rev-parse", "HEAD"]));
  if (!sha) return false;
  const projects = readProjects();
  projects[root] = { ...(projects[root] || {}), deployedSha: sha, deployedAt: Date.now() };
  writeProjects(projects);
  return true;
}

async function markApplied(cwd) {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return false;
  const projects = readProjects();
  projects[root] = { ...(projects[root] || {}), appliedMigrations: migrationFiles(root), appliedAt: Date.now() };
  writeProjects(projects);
  return true;
}

// The island's "mark as done" button, by alert id.
function markDone(id) {
  const [, type, root] = id.match(/^check:(\w+):(.*)$/) || [];
  if (type === "undeployed") return markDeployed(root);
  if (type === "migrations") return markApplied(root);
  return Promise.resolve(false);
}

module.exports = { PROJECTS_FILE, refresh, alerts: () => current, markDeployed, markApplied, markDone };
