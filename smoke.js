#!/usr/bin/env node

/**
 * smoke.js — Visual smoke test via Puppeteer screenshot
 *
 * Two modes:
 *   node test/smoke.js          Demo mode — uses simulated Agent Teams data
 *   node test/smoke.js --real   Real mode — writes temp team files to disk,
 *                               starts server with real file watchers
 *
 * Screenshots saved to test/screenshots/:
 *   latest.png         — full graph view
 *   latest-panel.png   — agent context panel open (inbox, tasks, spawn prompt)
 *
 * Prerequisites: npm install --save-dev puppeteer
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const REAL_MODE = process.argv.includes("--real");
const PORT = 13580;
const SERVER_JS = path.join(__dirname, "..", "server.js");
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
const HOME = process.env.HOME || process.env.USERPROFILE || require("os").homedir();
const TEAMS_DIR = path.join(HOME, ".claude", "teams");
const TASKS_DIR = path.join(HOME, ".claude", "tasks");
const TEMP_TEAM = "smoke-test-team";

// Timing
const SERVER_STARTUP_MS = 5000;
const WAIT_FOR_RENDER_MS = REAL_MODE ? 4000 : 7000; // demo needs more time to spawn agents
const PANEL_WAIT_MS = 1500;
const TIMEOUT_MS = 45000;

let serverProc = null;

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

// ── Create temp team files for --real mode ──────────────────
function createTempTeamFiles() {
  const teamDir = path.join(TEAMS_DIR, TEMP_TEAM);
  const taskDir = path.join(TASKS_DIR, TEMP_TEAM);

  log("Creating temp team files...");

  // Config
  writeJson(path.join(teamDir, "config.json"), {
    teamName: TEMP_TEAM,
    description: "Smoke test team — verifying Swarm Observer UI rendering",
    members: [
      { name: "coordinator", agentId: "coord-001", agentType: "team-lead", color: "#ff6b35",
        prompt: "You are the coordinator for the smoke test team. Verify all UI components render correctly.", cwd: "/tmp/smoke" },
      { name: "frontend", agentId: "front-002", agentType: "teammate", color: "#7b68ee",
        prompt: "Build the dashboard component with real-time status indicators and a task board widget.", cwd: "/tmp/smoke" },
      { name: "backend", agentId: "back-003", agentType: "teammate", color: "#00d4aa",
        prompt: "Implement the WebSocket event handler and REST API for agent status queries.", cwd: "/tmp/smoke" },
    ],
  });

  // Inboxes
  writeJson(path.join(teamDir, "inboxes", "coordinator.json"), [
    { from: "frontend", text: "Dashboard component is rendering. Task board needs the API endpoint.", timestamp: new Date(Date.now() - 60000).toISOString(), read: false },
    { from: "backend", text: "WebSocket handler done. Broadcasting events on agent_join, event, message types.", timestamp: new Date(Date.now() - 30000).toISOString(), read: false },
  ]);
  writeJson(path.join(teamDir, "inboxes", "frontend.json"), [
    { from: "coordinator", text: "Start with the agent node graph. Use D3 force layout. Each node needs a status ring.", timestamp: new Date(Date.now() - 120000).toISOString(), read: true },
    { from: "backend", text: "API is live at /api/state. Returns { agents, recentEvents, recentMessages }.", timestamp: new Date(Date.now() - 45000).toISOString(), read: false },
  ]);
  writeJson(path.join(teamDir, "inboxes", "backend.json"), [
    { from: "coordinator", text: "Set up the WebSocket server. Broadcast all agent events in real-time.", timestamp: new Date(Date.now() - 180000).toISOString(), read: true },
  ]);

  // Tasks
  writeJson(path.join(taskDir, "1.json"), { id: "1", subject: "Set up WebSocket server", status: "completed", owner: "backend" });
  writeJson(path.join(taskDir, "2.json"), { id: "2", subject: "Build agent node graph", status: "in_progress", owner: "frontend", blockedBy: ["1"] });
  writeJson(path.join(taskDir, "3.json"), { id: "3", subject: "Add context panel with inbox", status: "pending", owner: "frontend", blockedBy: ["2"] });
  writeJson(path.join(taskDir, "4.json"), { id: "4", subject: "Integration testing", status: "blocked", owner: "coordinator", blockedBy: ["2", "3"] });

  log(`  Created team: ${teamDir}`);
  log(`  Created tasks: ${taskDir}`);
}

function cleanupTempTeamFiles() {
  rmrf(path.join(TEAMS_DIR, TEMP_TEAM));
  rmrf(path.join(TASKS_DIR, TEMP_TEAM));
  log("Cleaned up temp team files");
}

// ── Server lifecycle ────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(PORT) };
    const args = [SERVER_JS];
    if (!REAL_MODE) args.push("--demo");

    serverProc = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: path.join(__dirname, ".."),
    });

    let stdout = "";
    let stderr = "";
    serverProc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes("Ready")) resolve();
    });
    serverProc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    serverProc.on("error", (err) => reject(err));

    setTimeout(() => {
      if (!stdout.includes("Ready")) {
        reject(new Error(`Server not ready.\nstdout: ${stdout.slice(-300)}\nstderr: ${stderr.slice(-300)}`));
      }
    }, SERVER_STARTUP_MS);
  });
}

function stopServer() {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
}

// ── Main ────────────────────────────────────────────────────
async function run() {
  console.log("");
  console.log("  ┌─────────────────────────────────────┐");
  console.log(`  │  Smoke Test ${REAL_MODE ? "(real file watchers)" : "(demo simulation)   "}  │`);
  console.log("  └─────────────────────────────────────┘");
  console.log("");

  const globalTimer = setTimeout(() => {
    log("✗ TIMEOUT");
    stopServer();
    if (REAL_MODE) cleanupTempTeamFiles();
    process.exit(1);
  }, TIMEOUT_MS);

  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch {
    log("⚠ Puppeteer not installed. Run: npm install --save-dev puppeteer");
    process.exit(1);
  }

  try {
    // 1. Setup
    if (REAL_MODE) createTempTeamFiles();

    // 2. Start server
    log(`Starting server in ${REAL_MODE ? "real" : "demo"} mode...`);
    await startServer();
    log("✓ Server started on port " + PORT);

    // 3. Launch browser
    log("Launching headless browser...");
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

    // 4. Load page and wait for rendering
    log("Loading page...");
    await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: "networkidle2", timeout: 10000 });

    log(`Waiting ${WAIT_FOR_RENDER_MS / 1000}s for agents to spawn and render...`);
    await new Promise(r => setTimeout(r, WAIT_FOR_RENDER_MS));

    // 5. DOM stats
    const stats = await page.evaluate(() => {
      const nodes = document.querySelectorAll("g.node");
      const links = document.querySelectorAll("line");
      const sidebar = document.getElementById("event-list");
      const mailbox = document.getElementById("mailbox-list");
      const panel = document.getElementById("prompt-panel");
      return {
        nodeCount: nodes.length,
        linkCount: links.length,
        eventCount: sidebar ? sidebar.children.length : 0,
        messageCount: mailbox ? mailbox.children.length : 0,
        panelHidden: panel ? panel.classList.contains("hidden") : true,
      };
    });

    log(`  Nodes: ${stats.nodeCount} | Links: ${stats.linkCount} | Events: ${stats.eventCount} | Messages: ${stats.messageCount}`);

    // 6. Screenshot — full graph
    ensureDir(SCREENSHOTS_DIR);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const graphPath = path.join(SCREENSHOTS_DIR, `smoke-${timestamp}.png`);
    const latestPath = path.join(SCREENSHOTS_DIR, "latest.png");

    await page.screenshot({ path: graphPath, fullPage: false });
    fs.copyFileSync(graphPath, latestPath);
    log(`✓ Graph screenshot: test/screenshots/latest.png`);

    // 7. Click a node to open the context panel
    if (stats.nodeCount > 0) {
      log("Clicking agent node to open context panel...");

      const clicked = await page.evaluate(() => {
        // Find first node with a transform
        const nodes = document.querySelectorAll("g.node");
        for (const node of nodes) {
          const transform = node.getAttribute("transform");
          if (!transform) continue;
          const match = transform.match(/translate\(([\d.-]+),\s*([\d.-]+)\)/);
          if (!match) continue;

          const svg = document.querySelector("svg");
          const rect = svg.getBoundingClientRect();
          return {
            x: rect.left + parseFloat(match[1]),
            y: rect.top + parseFloat(match[2]),
          };
        }
        return null;
      });

      if (clicked) {
        await page.mouse.click(clicked.x, clicked.y);
        log(`Waiting ${PANEL_WAIT_MS / 1000}s for panel animation...`);
        await new Promise(r => setTimeout(r, PANEL_WAIT_MS));

        // Check what rendered in the panel
        const panelStats = await page.evaluate(() => {
          const panel = document.getElementById("prompt-panel");
          const hidden = panel ? panel.classList.contains("hidden") : true;
          const ctxName = document.getElementById("ctx-name")?.textContent || "";
          const ctxRole = document.getElementById("ctx-role")?.textContent || "";
          const promptSection = document.getElementById("ctx-prompt-section");
          const promptVisible = promptSection ? promptSection.style.display !== "none" : false;
          const promptText = document.getElementById("ctx-prompt")?.textContent || "";
          const tasksSection = document.getElementById("ctx-tasks-section");
          const tasksVisible = tasksSection ? tasksSection.style.display !== "none" : false;
          const taskCount = document.getElementById("ctx-tasks")?.children?.length || 0;
          const inboxCount = document.getElementById("ctx-inbox")?.children?.length || 0;
          const inboxEmpty = document.querySelector(".inbox-empty") !== null;
          const activeTab = document.querySelector(".panel-tab.active")?.dataset?.tab || "";

          return { hidden, ctxName, ctxRole, promptVisible, promptText: promptText.substring(0, 80),
                   tasksVisible, taskCount, inboxCount, inboxEmpty, activeTab };
        });

        log(`  Panel open: ${!panelStats.hidden} | Tab: ${panelStats.activeTab}`);
        log(`  Agent: ${panelStats.ctxName} (${panelStats.ctxRole})`);
        log(`  Prompt visible: ${panelStats.promptVisible}${panelStats.promptVisible ? " — " + panelStats.promptText + "…" : ""}`);
        log(`  Tasks visible: ${panelStats.tasksVisible} (${panelStats.taskCount} items)`);
        log(`  Inbox messages: ${panelStats.inboxCount}${panelStats.inboxEmpty ? " (empty)" : ""}`);

        // Screenshot with panel open
        const panelPath = path.join(SCREENSHOTS_DIR, `smoke-panel-${timestamp}.png`);
        const panelLatest = path.join(SCREENSHOTS_DIR, "latest-panel.png");

        await page.screenshot({ path: panelPath, fullPage: false });
        fs.copyFileSync(panelPath, panelLatest);
        log(`✓ Panel screenshot: test/screenshots/latest-panel.png`);

        // Validation
        if (panelStats.hidden) {
          log("⚠ Panel did not open after click");
        }
        if (!panelStats.promptVisible && !REAL_MODE) {
          log("⚠ Spawn prompt not visible (expected in demo mode)");
        }
        if (panelStats.inboxEmpty && !REAL_MODE) {
          log("⚠ Inbox is empty (expected messages in demo mode)");
        }
      } else {
        log("  (Could not find clickable node position)");
      }
    } else {
      log("⚠ No nodes rendered — graph may be broken");
    }

    // 8. Cleanup
    await browser.close();
    log("✓ Browser closed");

  } catch (e) {
    log(`✗ Error: ${e.message}`);
    if (e.stack) {
      const lines = e.stack.split("\n").slice(0, 4);
      for (const line of lines) log(`  ${line.trim()}`);
    }
    stopServer();
    if (REAL_MODE) cleanupTempTeamFiles();
    clearTimeout(globalTimer);
    process.exit(1);
  }

  stopServer();
  if (REAL_MODE) cleanupTempTeamFiles();
  clearTimeout(globalTimer);

  log("");
  log("Smoke test passed. Review screenshots in test/screenshots/");
  log("  latest.png       — graph overview");
  log("  latest-panel.png — agent context panel");
  log("");
  process.exit(0);
}

run();
