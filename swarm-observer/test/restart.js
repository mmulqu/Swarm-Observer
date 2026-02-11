#!/usr/bin/env node

/**
 * restart.js — Restart the Swarm Observer server
 *
 * Kills any running instance on the target port, then starts a new one.
 * Waits for "Ready" and exits, leaving the server running in background.
 *
 * Usage:
 *   node test/restart.js                # restart on default port 3333
 *   node test/restart.js --port 8080    # custom port
 *   node test/restart.js --demo         # restart in demo mode
 */

const { spawn, execSync } = require("child_process");
const path = require("path");
const http = require("http");

const args = process.argv.slice(2);
const PORT = getArg("--port", process.env.PORT || "3333");
const DEMO = args.includes("--demo");
const SERVER_JS = path.join(__dirname, "..", "server.js");

function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

function log(msg) { console.log(`  ${msg}`); }

// Kill existing process on the port
function killExisting() {
  try {
    // Cross-platform: try to hit the server and see if it's alive
    return new Promise((resolve) => {
      http.get(`http://127.0.0.1:${PORT}/api/state`, (res) => {
        res.resume();
        // Server is running — try to kill by platform
        try {
          if (process.platform === "win32") {
            execSync(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${PORT} ^| findstr LISTENING') do taskkill /F /PID %a`, { stdio: "ignore", shell: true });
          } else {
            execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null || fuser -k ${PORT}/tcp 2>/dev/null || true`, { stdio: "ignore", shell: true });
          }
          log(`Killed existing server on port ${PORT}`);
        } catch {}
        // Wait a moment for port to free
        setTimeout(resolve, 500);
      }).on("error", () => {
        // No server running
        resolve();
      });
    });
  } catch {
    return Promise.resolve();
  }
}

async function run() {
  console.log("");
  log(`Restarting Swarm Observer on port ${PORT}${DEMO ? " (demo mode)" : ""}...`);

  await killExisting();

  const env = { ...process.env, PORT };
  const serverArgs = [SERVER_JS];
  if (DEMO) serverArgs.push("--demo");

  const proc = spawn(process.execPath, serverArgs, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // Run in background
    cwd: path.join(__dirname, ".."),
  });

  // Don't let this script hang waiting for the child
  proc.unref();

  // Wait for Ready message
  return new Promise((resolve) => {
    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes("Ready")) {
        log(`✓ Server ready at http://localhost:${PORT}`);
        log(`  PID: ${proc.pid}`);
        console.log("");
        resolve();
        process.exit(0);
      }
    });

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    setTimeout(() => {
      log(`✗ Server did not start within 5s`);
      if (stderr) log(`  stderr: ${stderr.slice(-200)}`);
      process.exit(1);
    }, 5000);
  });
}

run();
