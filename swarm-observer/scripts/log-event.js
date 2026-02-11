#!/usr/bin/env node
//
// log-event.js — Cross-platform hook dispatcher for Swarm Observer
//
// Called by Claude Code hooks. Receives event JSON via stdin,
// enriches it with session ID and timestamp, appends to events.jsonl.
//
// Usage (in hooks config):
//   "command": "node ~/.claude/swarm-viz/log-event.js pre_tool"
//
// On Windows the hooks config should use the full path:
//   "command": "node \"C:\\Users\\YOU\\.claude\\swarm-viz\\log-event.js\" pre_tool"
//

const fs = require("fs");
const path = require("path");
const os = require("os");

const eventType = process.argv[2] || "unknown";
const home = os.homedir();
const eventsDir = path.join(home, ".claude", "swarm-viz");
const eventsFile = path.join(eventsDir, "events.jsonl");

// Ensure directory exists
try { fs.mkdirSync(eventsDir, { recursive: true }); } catch {}

// Read stdin (hook JSON)
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let hookData = {};
  try { hookData = JSON.parse(input); } catch {}

  const record = {
    ...hookData,
    event: eventType,
    session_id: hookData.session_id || process.env.CLAUDE_SESSION_ID || "unknown",
    ts: Date.now(),
  };

  try {
    fs.appendFileSync(eventsFile, JSON.stringify(record) + "\n");
  } catch (e) {
    // Never block Claude Code — silently fail
  }

  process.exit(0);
});

// Safety: if stdin closes immediately or is empty, still write something
setTimeout(() => {
  if (!input) {
    const record = {
      event: eventType,
      session_id: process.env.CLAUDE_SESSION_ID || "unknown",
      ts: Date.now(),
    };
    try {
      fs.appendFileSync(eventsFile, JSON.stringify(record) + "\n");
    } catch {}
    process.exit(0);
  }
}, 2000);
