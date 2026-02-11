#!/usr/bin/env node

/**
 * seed-teams.js — Create/remove fake Agent Teams files for testing
 *
 * Writes team config, inboxes, and tasks to ~/.claude/teams/ and ~/.claude/tasks/
 * so the real file watchers in Swarm Observer pick them up.
 *
 * Usage:
 *   node test/seed-teams.js             # create test team files
 *   node test/seed-teams.js --clean     # remove test team files
 *   node test/seed-teams.js --refresh   # remove then recreate (triggers watchers)
 */

const path = require("path");
const fs = require("fs");

const HOME = process.env.HOME || process.env.USERPROFILE || require("os").homedir();
const TEAMS_DIR = path.join(HOME, ".claude", "teams");
const TASKS_DIR = path.join(HOME, ".claude", "tasks");
const TEAM_NAME = "test-swarm-team";

const args = process.argv.slice(2);
const CLEAN = args.includes("--clean");
const REFRESH = args.includes("--refresh");

function log(msg) { console.log(`  ${msg}`); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function clean() {
  rmrf(path.join(TEAMS_DIR, TEAM_NAME));
  rmrf(path.join(TASKS_DIR, TEAM_NAME));
  log(`✓ Removed ${TEAM_NAME}`);
}

function seed() {
  const teamDir = path.join(TEAMS_DIR, TEAM_NAME);
  const taskDir = path.join(TASKS_DIR, TEAM_NAME);

  // ── Config ──────────────────────────────────────────────
  writeJson(path.join(teamDir, "config.json"), {
    teamName: TEAM_NAME,
    description: "Test team for Swarm Observer development — verifying UI rendering of Agent Teams features",
    members: [
      {
        name: "orchestrator",
        agentId: "orch-001",
        agentType: "team-lead",
        color: "#ff6b35",
        prompt: "You are the orchestrator. Coordinate the frontend and backend workers. Monitor task progress and resolve blockers between team members.",
        cwd: process.cwd(),
      },
      {
        name: "ui-builder",
        agentId: "ui-002",
        agentType: "teammate",
        color: "#7b68ee",
        prompt: "Build the interactive dashboard with D3 force graph, tabbed context panel, and real-time inbox display. Use vanilla JS, no frameworks.",
        cwd: process.cwd(),
      },
      {
        name: "api-worker",
        agentId: "api-003",
        agentType: "teammate",
        color: "#00d4aa",
        prompt: "Implement the Node.js WebSocket server with file watchers for Agent Teams protocol. Handle inbox writes with atomic file operations.",
        cwd: process.cwd(),
      },
      {
        name: "tester",
        agentId: "test-004",
        agentType: "teammate",
        color: "#ffd166",
        prompt: "Write protocol tests and Puppeteer screenshot smoke tests. Verify the full pipeline: file → watcher → WebSocket → UI rendering.",
        cwd: process.cwd(),
      },
    ],
  });

  // ── Inboxes ─────────────────────────────────────────────
  const now = Date.now();

  writeJson(path.join(teamDir, "inboxes", "orchestrator.json"), [
    { from: "api-worker", text: "WebSocket server is up. File watchers are detecting changes in ~/.claude/teams/ with 200ms debounce.", timestamp: new Date(now - 120000).toISOString(), read: true },
    { from: "ui-builder", text: "Context panel renders inbox messages and tasks. Need to verify spawn prompt display — can you check?", timestamp: new Date(now - 60000).toISOString(), read: false },
    { from: "tester", text: "Protocol tests pass (32/32). Smoke test screenshots look good. Panel opens on click.", timestamp: new Date(now - 30000).toISOString(), read: false },
  ]);

  writeJson(path.join(teamDir, "inboxes", "ui-builder.json"), [
    { from: "orchestrator", text: "Start with the node graph. Each agent should have a colored ring matching their team color. Left-click opens context panel.", timestamp: new Date(now - 180000).toISOString(), read: true },
    { from: "api-worker", text: "I've added get_agent_context handler. It returns: agent metadata, inbox (last 50), tasks, allTasks, teamInfo, and spawnPrompt.", timestamp: new Date(now - 90000).toISOString(), read: true },
    { from: "tester", text: "Screenshot shows the panel opening but tasks section is collapsed. The CSS might need min-height on .task-list.", timestamp: new Date(now - 15000).toISOString(), read: false },
  ]);

  writeJson(path.join(teamDir, "inboxes", "api-worker.json"), [
    { from: "orchestrator", text: "Implement atomic inbox writes — use tmp file + rename pattern. The watchers need to not read partial JSON.", timestamp: new Date(now - 200000).toISOString(), read: true },
  ]);

  writeJson(path.join(teamDir, "inboxes", "tester.json"), [
    { from: "orchestrator", text: "Write a screenshot test that clicks a node and verifies the panel shows inbox messages, tasks, and spawn prompt.", timestamp: new Date(now - 150000).toISOString(), read: true },
    { from: "ui-builder", text: "Panel DOM IDs are: ctx-name, ctx-role, ctx-prompt, ctx-tasks, ctx-inbox. The active tab has class .panel-tab.active.", timestamp: new Date(now - 45000).toISOString(), read: false },
  ]);

  // ── Tasks ───────────────────────────────────────────────
  writeJson(path.join(taskDir, "1.json"), {
    id: "1", subject: "WebSocket server with file watchers", status: "completed", owner: "api-worker",
  });
  writeJson(path.join(taskDir, "2.json"), {
    id: "2", subject: "D3 force graph with agent nodes", status: "completed", owner: "ui-builder", blockedBy: ["1"],
  });
  writeJson(path.join(taskDir, "3.json"), {
    id: "3", subject: "Tabbed context panel (inbox + tasks + prompt)", status: "in_progress", owner: "ui-builder", blockedBy: ["2"],
  });
  writeJson(path.join(taskDir, "4.json"), {
    id: "4", subject: "Inbox send functionality", status: "in_progress", owner: "api-worker", blockedBy: ["1"],
  });
  writeJson(path.join(taskDir, "5.json"), {
    id: "5", subject: "Protocol tests (32 assertions)", status: "completed", owner: "tester",
  });
  writeJson(path.join(taskDir, "6.json"), {
    id: "6", subject: "Screenshot smoke test with panel verification", status: "in_progress", owner: "tester", blockedBy: ["3"],
  });
  writeJson(path.join(taskDir, "7.json"), {
    id: "7", subject: "Live inbox update rendering", status: "pending", owner: "ui-builder", blockedBy: ["3", "4"],
  });
  writeJson(path.join(taskDir, "8.json"), {
    id: "8", subject: "Task status transition animations", status: "pending", owner: "ui-builder", blockedBy: ["3"],
  });

  log(`✓ Created team: ${teamDir}`);
  log(`  Config: 4 members (orchestrator, ui-builder, api-worker, tester)`);
  log(`  Inboxes: ${4} agents seeded with messages`);
  log(`  Tasks: 8 (2 completed, 3 in_progress, 2 pending)`);
  log(`✓ Created tasks: ${taskDir}`);
  log("");
  log("  The file watchers should pick these up within ~200ms.");
  log("  Run: node test/screenshot.js --click   to verify.");
}

// ── Main ────────────────────────────────────────────────────
console.log("");

if (CLEAN) {
  clean();
} else if (REFRESH) {
  clean();
  // Small delay so watchers see the deletion before recreation
  setTimeout(() => seed(), 500);
} else {
  seed();
}

console.log("");
