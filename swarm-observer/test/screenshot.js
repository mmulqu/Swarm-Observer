#!/usr/bin/env node

/**
 * screenshot.js — Capture the live Swarm Observer UI
 *
 * Connects to an already-running Swarm Observer instance,
 * takes screenshots, and reports DOM stats. Claude Code
 * can view the PNGs to verify its own UI changes.
 *
 * Usage:
 *   node test/screenshot.js                  # screenshot localhost:3333
 *   node test/screenshot.js --port 8080      # custom port
 *   node test/screenshot.js --click          # also click a node to open context panel
 *   node test/screenshot.js --click --wait 3 # wait 3 extra seconds before capturing
 *
 * Output:
 *   test/screenshots/latest.png              — full graph (always)
 *   test/screenshots/latest-panel.png        — context panel (with --click)
 */

const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const PORT = getArg("--port", "3333");
const CLICK_NODE = args.includes("--click");
const EXTRA_WAIT = parseInt(getArg("--wait", "0"), 10) * 1000;
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");

function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

function log(msg) { console.log(`  ${msg}`); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function run() {
  console.log("");
  console.log(`  📸 Capturing Swarm Observer at localhost:${PORT}`);
  console.log("");

  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch {
    log("⚠ Puppeteer not installed. Run: npm install --save-dev puppeteer");
    process.exit(1);
  }

  // Check server is running
  const http = require("http");
  try {
    await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${PORT}/api/state`, (res) => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`Server returned ${res.statusCode}`));
        res.resume();
      }).on("error", reject);
    });
  } catch {
    log(`✗ No server running at localhost:${PORT}`);
    log("  Start it with: npm start");
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

    log("Loading page...");
    await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: "networkidle2", timeout: 10000 });

    // Wait for WebSocket data to arrive and D3 to settle
    await new Promise(r => setTimeout(r, 2000 + EXTRA_WAIT));

    // DOM stats
    const stats = await page.evaluate(() => {
      const nodes = document.querySelectorAll("g.node");
      const links = document.querySelectorAll("line");
      const sidebar = document.getElementById("event-list");
      const mailbox = document.getElementById("mailbox-list");
      // Collect node labels
      const labels = [];
      nodes.forEach(n => {
        const text = n.querySelector("text");
        if (text) labels.push(text.textContent.trim());
      });
      return {
        nodeCount: nodes.length,
        linkCount: links.length,
        eventCount: sidebar ? sidebar.children.length : 0,
        messageCount: mailbox ? mailbox.children.length : 0,
        nodeLabels: labels,
      };
    });

    log(`Nodes: ${stats.nodeCount} | Links: ${stats.linkCount} | Events: ${stats.eventCount} | Messages: ${stats.messageCount}`);
    if (stats.nodeLabels.length > 0) {
      log(`Agents: ${stats.nodeLabels.join(", ")}`);
    }

    // Screenshot — graph
    ensureDir(SCREENSHOTS_DIR);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const graphPath = path.join(SCREENSHOTS_DIR, `cap-${timestamp}.png`);
    const latestPath = path.join(SCREENSHOTS_DIR, "latest.png");

    await page.screenshot({ path: graphPath, fullPage: false });
    fs.copyFileSync(graphPath, latestPath);
    log(`✓ test/screenshots/latest.png`);

    // Click a node to open context panel
    if (CLICK_NODE && stats.nodeCount > 0) {
      log("Clicking agent node...");

      const clicked = await page.evaluate(() => {
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
            label: node.querySelector("text")?.textContent?.trim() || "unknown",
          };
        }
        return null;
      });

      if (clicked) {
        log(`  Clicked: ${clicked.label}`);
        await page.mouse.click(clicked.x, clicked.y);
        await new Promise(r => setTimeout(r, 1500));

        // Panel stats
        const panelStats = await page.evaluate(() => {
          const panel = document.getElementById("prompt-panel");
          const hidden = panel ? panel.classList.contains("hidden") : true;
          const ctxName = document.getElementById("ctx-name")?.textContent || "";
          const ctxRole = document.getElementById("ctx-role")?.textContent || "";
          const promptText = document.getElementById("ctx-prompt")?.textContent || "";
          const taskCount = document.getElementById("ctx-tasks")?.children?.length || 0;
          const inboxCount = document.getElementById("ctx-inbox")?.children?.length || 0;
          const activeTab = document.querySelector(".panel-tab.active")?.dataset?.tab || "";
          return { hidden, ctxName, ctxRole, promptText: promptText.substring(0, 80),
                   taskCount, inboxCount, activeTab };
        });

        log(`  Panel: ${panelStats.hidden ? "CLOSED" : "open"} | Tab: ${panelStats.activeTab}`);
        log(`  Agent: ${panelStats.ctxName} (${panelStats.ctxRole})`);
        if (panelStats.promptText) log(`  Prompt: ${panelStats.promptText}…`);
        log(`  Tasks: ${panelStats.taskCount} | Inbox: ${panelStats.inboxCount}`);

        const panelPath = path.join(SCREENSHOTS_DIR, `cap-panel-${timestamp}.png`);
        const panelLatest = path.join(SCREENSHOTS_DIR, "latest-panel.png");
        await page.screenshot({ path: panelPath, fullPage: false });
        fs.copyFileSync(panelPath, panelLatest);
        log(`✓ test/screenshots/latest-panel.png`);
      }
    }

  } finally {
    await browser.close();
  }

  console.log("");
  process.exit(0);
}

run().catch(e => {
  log(`✗ ${e.message}`);
  process.exit(1);
});
