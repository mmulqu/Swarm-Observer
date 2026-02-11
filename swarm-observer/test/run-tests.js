#!/usr/bin/env node

/**
 * run-tests.js — Cross-platform test runner
 *
 * Runs server tests, then optionally smoke test if Puppeteer is available.
 * All Node.js, no bash dependency.
 *
 * Usage: node test/run-tests.js [--smoke] [--all]
 *   (no flags)  → server tests only
 *   --smoke     → smoke test only
 *   --all       → server tests + smoke test
 */

const { execFileSync } = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
const runSmoke = args.includes("--smoke") || args.includes("--all");
const runServer = !args.includes("--smoke") || args.includes("--all");
const noArgs = args.length === 0;

let exitCode = 0;

function run(label, script) {
  console.log(`\n  ═══ ${label} ═══\n`);
  try {
    execFileSync(process.execPath, [script], {
      cwd: path.join(__dirname, ".."),
      stdio: "inherit",
      timeout: 60000,
    });
  } catch (e) {
    exitCode = 1;
    if (e.status !== null) {
      console.log(`\n  ✗ ${label} failed (exit code ${e.status})\n`);
    } else {
      console.log(`\n  ✗ ${label} error: ${e.message}\n`);
    }
  }
}

// Default: just server tests (fast, no browser needed)
if (noArgs || runServer) {
  run("Server Protocol Tests", path.join(__dirname, "server.test.js"));
}

if (runSmoke) {
  // Check if puppeteer is installed
  try {
    require.resolve("puppeteer");
    run("Screenshot Smoke Test", path.join(__dirname, "smoke.js"));
  } catch {
    console.log("\n  ⚠ Skipping smoke test — puppeteer not installed");
    console.log("    Install with: npm install --save-dev puppeteer\n");
  }
}

process.exit(exitCode);
