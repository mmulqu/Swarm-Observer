#!/usr/bin/env node
//
// install.js — Cross-platform installer for Swarm Observer
//
// Run with: node scripts/install.js
//
// Works on Windows (cmd, PowerShell, Git Bash), macOS, Linux
//

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const home = os.homedir();
const isWindows = process.platform === "win32";
const projectDir = path.resolve(__dirname, "..");
const claudeDir = path.join(home, ".claude");
const swarmDir = path.join(claudeDir, "swarm-viz");
const settingsFile = path.join(claudeDir, "settings.json");
const dispatcherSrc = path.join(__dirname, "log-event.js");
const dispatcherDest = path.join(swarmDir, "log-event.js");

// ─── Pretty output ───────────────────────────────────────────────
function log(msg) { console.log("  " + msg); }
function banner(lines) {
  console.log("");
  console.log("  ┌─────────────────────────────────────┐");
  for (const l of lines) console.log("  │ " + l.padEnd(36) + "│");
  console.log("  └─────────────────────────────────────┘");
  console.log("");
}

banner(["🔮 Swarm Observer — Installer", ""]);

log(`📍 Platform: ${process.platform} (${os.arch()})`);
log(`📁 Home: ${home}`);
log(`📁 Claude dir: ${claudeDir}`);
log("");

// ─── 1. Create directories ──────────────────────────────────────
log("→ Creating " + swarmDir);
fs.mkdirSync(swarmDir, { recursive: true });

// ─── 2. Copy dispatcher ─────────────────────────────────────────
log("→ Installing dispatcher: log-event.js");
fs.copyFileSync(dispatcherSrc, dispatcherDest);

// Touch events file
const eventsFile = path.join(swarmDir, "events.jsonl");
if (!fs.existsSync(eventsFile)) {
  fs.writeFileSync(eventsFile, "");
}
log("→ Events file: " + eventsFile);

// ─── 3. Build hook commands with absolute paths ─────────────────
//
// Key insight: Claude Code executes hook commands through the system shell.
// On Windows that's cmd.exe, which doesn't understand ~ or bash syntax.
// So we use absolute paths everywhere.
//
// We quote the path in case there are spaces in the username.
//
const dispatcherPath = dispatcherDest;
function hookCmd(eventType) {
  // Use forward slashes even on Windows — Node handles them fine,
  // and it avoids JSON double-escaping hell with backslashes.
  const normalized = dispatcherPath.replace(/\\/g, "/");
  return `node "${normalized}" ${eventType}`;
}

log("");
log("→ Hook command format:");
log(`  ${hookCmd("pre_tool")}`);
log("");

// ─── 4. Merge hooks into settings.json ──────────────────────────
log("→ Configuring hooks in settings.json");

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  // Backup
  const backupFile = settingsFile + ".bak";
  fs.writeFileSync(backupFile, JSON.stringify(settings, null, 2));
  log("📋 Backed up existing settings to settings.json.bak");
} catch {
  // No existing file or invalid JSON
}

const swarmHooks = {
  PreToolUse: [
    {
      matcher: ".*",
      hooks: [{ type: "command", command: hookCmd("pre_tool") }],
    },
  ],
  PostToolUse: [
    {
      matcher: ".*",
      hooks: [{ type: "command", command: hookCmd("post_tool") }],
    },
  ],
  SessionStart: [
    {
      hooks: [{ type: "command", command: hookCmd("session_start") }],
    },
  ],
  Stop: [
    {
      hooks: [{ type: "command", command: hookCmd("stop") }],
    },
  ],
  SubagentStop: [
    {
      hooks: [{ type: "command", command: hookCmd("subagent_stop") }],
    },
  ],
  TaskCompleted: [
    {
      hooks: [{ type: "command", command: hookCmd("task_done") }],
    },
  ],
};

if (!settings.hooks) settings.hooks = {};

let added = 0;
let skipped = 0;
for (const [event, handlers] of Object.entries(swarmHooks)) {
  if (!settings.hooks[event]) settings.hooks[event] = [];

  // Remove any old swarm-viz hooks (bash or node) so we don't duplicate
  const before = settings.hooks[event].length;
  settings.hooks[event] = settings.hooks[event].filter(
    (h) =>
      !(
        h.hooks &&
        h.hooks.some(
          (hh) => hh.command && hh.command.includes("swarm-viz")
        )
      )
  );

  // Add fresh hooks
  settings.hooks[event].push(...handlers);
  added++;
}

fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
log(`✅ Wrote ${added} hook events to settings.json`);

// ─── 5. Install npm deps ────────────────────────────────────────
log("");
log("→ Installing npm dependencies...");
try {
  execSync("npm install", { cwd: projectDir, stdio: "inherit" });
} catch {
  log("⚠  npm install had issues — you may need to run it manually");
}

// ─── 6. Done ────────────────────────────────────────────────────
banner(["✅ Installation complete", ""]);

log("Files installed:");
log(`  ${dispatcherDest}`);
log(`  ${eventsFile}`);
log(`  ${settingsFile}`);
log("");
log("To start:");
log("");
log(`  cd ${path.basename(projectDir)}`);
log("  npm start            # live mode (watches hooks)");
log("  npm run demo         # demo mode (simulated agents)");
log("");
log("Then open http://localhost:3333");
log("");

// ─── Windows-specific tips ──────────────────────────────────────
if (isWindows) {
  log("─── Windows tips ───────────────────────────────────");
  log("");
  log("To watch events in PowerShell:");
  log(`  Get-Content "${eventsFile}" -Wait`);
  log("");
  log("To test the dispatcher manually:");
  log(`  echo '{"tool_name":"test"}' | node "${dispatcherPath.replace(/\\/g, "/")}" pre_tool`);
  log(`  type "${eventsFile.replace(/\//g, "\\")}"`);
  log("");
  log("If hooks don't fire, verify your settings:");
  log(`  type "${settingsFile.replace(/\//g, "\\")}"`);
  log("");
}
