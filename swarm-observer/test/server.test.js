#!/usr/bin/env node

/**
 * server.test.js — Protocol-level tests for Swarm Observer server
 *
 * Runs without a browser. Starts the server in demo mode, connects via WebSocket,
 * and validates the protocol. Exits 0 on pass, 1 on fail.
 *
 * Usage: node test/server.test.js
 */

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

const PORT = 13579; // Use a high port to avoid conflicts
const SERVER_JS = path.join(__dirname, "..", "server.js");
const TIMEOUT_MS = 15000;

let serverProc = null;
let passed = 0;
let failed = 0;
const errors = [];

// ── Helpers ─────────────────────────────────────────────────

function log(icon, msg) {
  console.log(`  ${icon} ${msg}`);
}

function assert(condition, name) {
  if (condition) {
    passed++;
    log("✓", name);
  } else {
    failed++;
    log("✗", name);
    errors.push(name);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(PORT) };
    serverProc = spawn(process.execPath, [SERVER_JS, "--demo"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: path.join(__dirname, ".."),
    });

    let stderr = "";
    serverProc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    // Wait for "Ready" in stdout
    let stdout = "";
    serverProc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes("Ready")) {
        resolve();
      }
    });

    serverProc.on("error", (err) => reject(new Error(`Server failed to start: ${err.message}`)));

    // Timeout
    setTimeout(() => {
      if (!stdout.includes("Ready")) {
        reject(new Error(`Server did not become ready in 5s.\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    }, 5000);
  });
}

function stopServer() {
  if (serverProc) {
    serverProc.kill("SIGTERM");
    serverProc = null;
  }
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${urlPath}`, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout")), 3000);
  });
}

function wsRecv(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS recv timeout")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(raw.toString())); }
      catch { resolve(raw.toString()); }
    });
  });
}

function wsRecvUntil(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wsRecvUntil timeout")), timeoutMs);
    const collected = [];
    function onMsg(raw) {
      try {
        const data = JSON.parse(raw.toString());
        collected.push(data);
        if (predicate(data)) {
          clearTimeout(timer);
          ws.removeListener("message", onMsg);
          resolve({ match: data, collected });
        }
      } catch {}
    }
    ws.on("message", onMsg);
  });
}

// ── Tests ───────────────────────────────────────────────────

async function testHttpServing() {
  log("─", "HTTP serving");

  const res = await httpGet("/");
  assert(res.status === 200, "GET / returns 200");
  assert(res.body.includes("Swarm Observer"), "index.html contains title");

  const api = await httpGet("/api/state");
  assert(api.status === 200, "GET /api/state returns 200");
  const state = JSON.parse(api.body);
  assert(typeof state.agents === "object", "/api/state has agents object");
  assert(Array.isArray(state.recentEvents), "/api/state has recentEvents array");
  assert(Array.isArray(state.recentMessages), "/api/state has recentMessages array");

  const notFound = await httpGet("/nope.xyz");
  assert(notFound.status === 404, "GET /nope returns 404");
}

async function testSnapshotOnConnect() {
  log("─", "WebSocket snapshot on connect");

  const ws = await wsConnect();
  const snapshot = await wsRecv(ws);

  assert(snapshot.type === "snapshot", "First message is snapshot");
  assert(typeof snapshot.agents === "object", "Snapshot has agents");
  assert(typeof snapshot.serverCwd === "string", "Snapshot has serverCwd");
  assert(snapshot.teams !== undefined, "Snapshot has teams field");

  ws.close();
}

async function testDemoAgentsAppear() {
  log("─", "Demo agents appear over time");

  const ws = await wsConnect();
  const snapshot = await wsRecv(ws);

  // In demo mode, agents spawn over several seconds
  // Wait for at least 3 agent_join messages
  let agentJoins = 0;
  try {
    await wsRecvUntil(ws, (data) => {
      if (data.type === "agent_join") agentJoins++;
      return agentJoins >= 3;
    }, 10000);
  } catch {
    // May have already appeared in snapshot
  }

  // Check via API that agents exist
  const api = await httpGet("/api/state");
  const state = JSON.parse(api.body);
  const agentCount = Object.keys(state.agents).length;
  assert(agentCount >= 2, `At least 2 agents exist (got ${agentCount})`);

  ws.close();
}

async function testEventsAndMessagesBroadcast() {
  log("─", "Events and messages broadcast");

  const ws = await wsConnect();
  await wsRecv(ws); // skip snapshot

  // Demo mode generates events continuously — wait for some
  let gotEvent = false;
  let gotMessage = false;

  try {
    await wsRecvUntil(ws, (data) => {
      if (data.type === "event") gotEvent = true;
      if (data.type === "message") gotMessage = true;
      return gotEvent && gotMessage;
    }, 10000);
  } catch {}

  assert(gotEvent, "Received at least one event broadcast");
  assert(gotMessage, "Received at least one message broadcast");

  ws.close();
}

async function testAgentContextRequest() {
  log("─", "Agent context request");

  const ws = await wsConnect();
  await wsRecv(ws); // skip snapshot

  // Wait for agents to appear and be enriched
  await new Promise(r => setTimeout(r, 3000));

  // Get an agent ID from the API
  const api = await httpGet("/api/state");
  const state = JSON.parse(api.body);
  const agentIds = Object.keys(state.agents);

  if (agentIds.length === 0) {
    assert(false, "No agents to test context for");
    ws.close();
    return;
  }

  const testId = agentIds[0];
  ws.send(JSON.stringify({ type: "get_agent_context", agentId: testId }));

  const response = await wsRecvUntil(ws, (data) => data.type === "agent_context", 3000);
  const ctx = response.match;

  assert(ctx.type === "agent_context", "Response type is agent_context");
  assert(ctx.agentId === testId, "Response has correct agentId");
  assert(Array.isArray(ctx.inbox), "Context has inbox array");
  assert(Array.isArray(ctx.tasks), "Context has tasks array");

  ws.close();
}

async function testDemoTeamsEnrichment() {
  log("─", "Demo teams enrichment (inbox, tasks, spawn prompt)");

  const ws = await wsConnect();
  await wsRecv(ws); // skip snapshot

  // Wait for lead agent to be enriched
  await new Promise(r => setTimeout(r, 2000));

  // Specifically request the lead agent which is guaranteed to have team data
  ws.send(JSON.stringify({ type: "get_agent_context", agentId: "lead-001" }));

  let ctx;
  try {
    const response = await wsRecvUntil(ws, (data) => data.type === "agent_context", 3000);
    ctx = response.match;
  } catch {
    assert(false, "Failed to get agent_context for lead-001");
    ws.close();
    return;
  }

  assert(ctx.spawnPrompt && ctx.spawnPrompt.length > 10, `Lead has spawn prompt (${(ctx.spawnPrompt || "").substring(0, 40)}…)`);
  assert(ctx.inbox.length > 0, `Lead has inbox messages (${ctx.inbox.length})`);
  assert(ctx.allTasks && ctx.allTasks.length > 0, `Context has tasks (${(ctx.allTasks || []).length})`);
  assert(ctx.teamInfo !== null, "Context has teamInfo");
  assert(ctx.teamInfo?.name === "demo-auth-refactor", `Team name is correct (${ctx.teamInfo?.name})`);
  assert(ctx.teamInfo?.members?.length === 7, `Team has 7 members (${ctx.teamInfo?.members?.length})`);

  ws.close();
}

async function testSyntaxCheck() {
  log("─", "Syntax validation");

  // Check server.js parses
  try {
    require(SERVER_JS);
    // It will try to start listening but we catch that
  } catch (e) {
    if (e.code === "EADDRINUSE" || e.message?.includes("listen")) {
      // Expected — the module starts a server
    } else if (e instanceof SyntaxError) {
      assert(false, `server.js has syntax error: ${e.message}`);
      return;
    }
  }
  assert(true, "server.js parses without syntax errors");

  // Check index.html exists and has basic structure
  const fs = require("fs");
  const htmlPath = path.join(__dirname, "..", "public", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert(html.includes("<!DOCTYPE html>"), "index.html has doctype");
  assert(html.includes("<script>"), "index.html has script tag");
  assert(html.includes("WebSocket"), "index.html has WebSocket code");
  assert(html.includes("d3.forceSimulation"), "index.html has D3 force simulation");
  assert(html.includes("panel-tab"), "index.html has panel tabs");
  assert(html.includes("agent-context"), "index.html has agent context elements");
  assert(html.includes("inbox-send"), "index.html has inbox send elements");
}

// ── Runner ──────────────────────────────────────────────────

async function run() {
  console.log("");
  console.log("  ┌─────────────────────────────────────┐");
  console.log("  │    Swarm Observer — Test Suite        │");
  console.log("  └─────────────────────────────────────┘");
  console.log("");

  const timer = setTimeout(() => {
    log("✗", `TIMEOUT — tests took longer than ${TIMEOUT_MS / 1000}s`);
    stopServer();
    process.exit(1);
  }, TIMEOUT_MS);

  try {
    // Syntax checks first (no server needed)
    await testSyntaxCheck();

    // Start server for protocol tests
    log("─", "Starting server in demo mode...");
    await startServer();
    log("✓", "Server started");

    await testHttpServing();
    await testSnapshotOnConnect();
    await testDemoAgentsAppear();
    await testEventsAndMessagesBroadcast();
    await testAgentContextRequest();
    await testDemoTeamsEnrichment();

  } catch (e) {
    failed++;
    log("✗", `Unexpected error: ${e.message}`);
    errors.push(e.message);
  } finally {
    clearTimeout(timer);
    stopServer();
  }

  // Summary
  console.log("");
  console.log(`  ────────────────────────────────`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log(`  Failures:`);
    for (const e of errors) console.log(`    • ${e}`);
  }
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

run();
