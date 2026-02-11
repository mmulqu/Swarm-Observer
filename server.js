#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// -------------------------------------------------------------------
// Config
// -------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "3333", 10);
const HOME = process.env.HOME || process.env.USERPROFILE || require("os").homedir();
const EVENTS_DIR = path.join(HOME, ".claude", "swarm-viz");
const EVENTS_FILE = path.join(EVENTS_DIR, "events.jsonl");
const TASKS_DIR = path.join(HOME, ".claude", "tasks");
const TEAMS_DIR = path.join(HOME, ".claude", "teams");
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const DEMO = process.argv.includes("--demo");
const DEV = process.argv.includes("--dev");

// Ensure events dir exists
try { fs.mkdirSync(EVENTS_DIR, { recursive: true }); } catch {}
try { if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, ""); } catch {}

// -------------------------------------------------------------------
// Static file server
// -------------------------------------------------------------------
const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
};

function serveStatic(req, res) {
  // API endpoint: current state snapshot
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      agents: Object.fromEntries(knownAgents),
      recentEvents: recentEvents.slice(-100),
      recentMessages: recentMessages.slice(-50),
    }));
    return;
  }

  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(__dirname, "public", filePath);

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

// -------------------------------------------------------------------
// WebSocket
// -------------------------------------------------------------------
const wss = new WebSocketServer({ server });
const clients = new Set();

// -------------------------------------------------------------------
// Managed Claude Code processes (for interactive prompting)
// -------------------------------------------------------------------
const { spawn } = require("child_process");
const managedProcesses = new Map(); // sessionTag -> { proc, ws, buffer }

wss.on("connection", (ws) => {
  clients.add(ws);

  // Send current state on connect
  ws.send(JSON.stringify({
    type: "snapshot",
    agents: Object.fromEntries(knownAgents),
    recentEvents: recentEvents.slice(-80),
    recentMessages: recentMessages.slice(-30),
    serverCwd: process.cwd(),
    teams: getTeamsSnapshot(),
  }));

  // Handle messages FROM the UI
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "prompt") {
      // Start a new Claude Code session
      spawnClaudeSession(ws, msg);
    } else if (msg.type === "respond") {
      // Send text to a running session's stdin (permission response or follow-up)
      const session = managedProcesses.get(msg.sessionTag);
      if (session?.proc?.stdin?.writable) {
        session.proc.stdin.write(msg.text + "\n");
      }
    } else if (msg.type === "kill") {
      // Kill a managed session
      const session = managedProcesses.get(msg.sessionTag);
      if (session?.proc) {
        session.proc.kill("SIGTERM");
        managedProcesses.delete(msg.sessionTag);
      }
    } else if (msg.type === "send_inbox_message") {
      // Write a message to a teammate's inbox file
      const { teamName, targetAgent, fromName, text } = msg;
      if (teamName && targetAgent && text) {
        const result = writeInboxMessage(teamName, targetAgent, fromName || "observer", text);
        if (result) {
          ws.send(JSON.stringify({
            type: "inbox_message_sent",
            teamName, targetAgent, message: result,
          }));
        }
      }
    } else if (msg.type === "get_agent_context") {
      // Return full context for a specific agent: inbox, tasks, team info
      const agentId = msg.agentId;
      const agent = knownAgents.get(agentId);
      const context = { agentId, agent: agent || null, inbox: [], tasks: [], teamInfo: null, spawnPrompt: null };

      if (agent?.teamName) {
        const team = teamsState.get(agent.teamName);
        if (team) {
          // Find this agent's inbox — try teamMemberName first, then label, then id
          const memberName = agent.teamMemberName || agent.label || agentId.split("@")[0];
          const inbox = team.inboxes.get(memberName)
                     || team.inboxes.get(agent.label)
                     || team.inboxes.get(agentId)
                     || [];
          context.inbox = inbox.slice(-50); // last 50 messages

          // Find tasks owned by this agent
          for (const [, task] of team.tasks) {
            if (task.owner === memberName || task.owner === agent.label || task.owner === agentId || task.assignee === memberName) {
              context.tasks.push(task);
            }
          }

          // Include all tasks for the task board
          context.allTasks = Array.from(team.tasks.values());
          context.teamInfo = {
            name: agent.teamName,
            description: team.config.description,
            memberCount: team.config.members?.length || 0,
            members: (team.config.members || []).map(m => ({
              name: m.name,
              agentId: m.agentId,
              agentType: m.agentType,
              color: m.color,
            })),
          };
          context.spawnPrompt = agent.spawnPrompt || null;
        }
      }

      ws.send(JSON.stringify({ type: "agent_context", ...context }));
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    // Clean up any processes owned by this client
    for (const [tag, session] of managedProcesses) {
      if (session.ws === ws) {
        session.proc?.kill("SIGTERM");
        managedProcesses.delete(tag);
      }
    }
  });
});

function spawnClaudeSession(ws, msg) {
  const tag = "ui-" + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
  const cwd = msg.cwd || process.cwd();
  const prompt = msg.text || "";
  const resumeId = msg.resumeSessionId || null;

  // Build command args
  const args = [];
  if (resumeId) {
    args.push("--resume", resumeId);
  } else {
    args.push("-p", prompt);
  }
  // Don't use --json — it changes the output format too much.
  // Instead we'll just stream the raw terminal output.
  // Don't auto-approve — let the user decide in the UI.

  console.log(`  🚀 Spawning Claude session [${tag}] in ${cwd}`);
  console.log(`     Args: claude ${args.join(" ").substring(0, 80)}...`);

  let proc;
  try {
    proc = spawn("claude", args, {
      cwd,
      shell: true,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    ws.send(JSON.stringify({
      type: "session_error",
      sessionTag: tag,
      error: `Failed to spawn claude: ${e.message}`,
    }));
    return;
  }

  managedProcesses.set(tag, { proc, ws, buffer: "", startTime: Date.now() });

  // Notify UI that session started
  ws.send(JSON.stringify({
    type: "session_started",
    sessionTag: tag,
    cwd,
    prompt: prompt.substring(0, 200),
  }));

  // Stream stdout to the UI
  proc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    const session = managedProcesses.get(tag);
    if (session) session.buffer += text;

    // Detect permission prompts
    const needsPermission = /(?:Allow|Approve|permit).*\?\s*\[([YyNnAa/]+)\]/i.test(text) ||
                            /Do you want to proceed/i.test(text);

    ws.send(JSON.stringify({
      type: "session_output",
      sessionTag: tag,
      text,
      needsPermission,
    }));
  });

  proc.stderr.on("data", (chunk) => {
    ws.send(JSON.stringify({
      type: "session_output",
      sessionTag: tag,
      text: chunk.toString(),
      isError: true,
    }));
  });

  proc.on("close", (code) => {
    console.log(`  ⏹ Claude session [${tag}] exited with code ${code}`);
    managedProcesses.delete(tag);
    ws.send(JSON.stringify({
      type: "session_ended",
      sessionTag: tag,
      exitCode: code,
    }));
  });

  proc.on("error", (err) => {
    console.log(`  ❌ Claude session [${tag}] error: ${err.message}`);
    managedProcesses.delete(tag);
    ws.send(JSON.stringify({
      type: "session_error",
      sessionTag: tag,
      error: err.message,
    }));
  });
}

function broadcast(data) {
  const json = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(json);
  }
}

// -------------------------------------------------------------------
// State tracking
// -------------------------------------------------------------------
const knownAgents = new Map(); // sessionId -> agent info
const recentEvents = [];       // last N events
const recentMessages = [];     // last N inter-agent messages
const MAX_EVENTS = 500;
const MAX_MESSAGES = 100;

// Color palette for auto-assigning agent colors
const PALETTE = [
  "#ff6b35", "#00d4aa", "#7b68ee", "#ffd166", "#ef476f",
  "#06d6a0", "#118ab2", "#e63946", "#a8dadc", "#f4a261",
  "#2a9d8f", "#e76f51", "#264653", "#d4a373", "#cdb4db",
  "#ffc8dd", "#bde0fe", "#a2d2ff", "#caffbf", "#ffd6ff",
];
let colorIndex = 0;

// -------------------------------------------------------------------
// Agent Teams state (read from ~/.claude/teams/ and ~/.claude/tasks/)
// -------------------------------------------------------------------
const teamsState = new Map(); // teamName -> { config, inboxes: Map<agentId, messages[]>, tasks: Map<taskId, task> }

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function readTeamConfig(teamName) {
  const configPath = path.join(TEAMS_DIR, teamName, "config.json");
  return readJsonSafe(configPath);
}

function readTeamInboxes(teamName) {
  const inboxDir = path.join(TEAMS_DIR, teamName, "inboxes");
  const inboxes = new Map();
  try {
    if (!fs.existsSync(inboxDir)) return inboxes;
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const agentName = path.basename(file, ".json");
      const data = readJsonSafe(path.join(inboxDir, file));
      if (data) {
        // Inbox can be an array of messages or an object with messages array
        const messages = Array.isArray(data) ? data : (data.messages || []);
        inboxes.set(agentName, messages);
      }
    }
  } catch {}
  return inboxes;
}

function readTeamTasks(teamName) {
  const taskDir = path.join(TASKS_DIR, teamName);
  const tasks = new Map();
  try {
    if (!fs.existsSync(taskDir)) return tasks;
    const files = fs.readdirSync(taskDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const task = readJsonSafe(path.join(taskDir, file));
      if (task && task.id) {
        tasks.set(String(task.id), task);
      }
    }
  } catch {}
  return tasks;
}

function readAllTeams() {
  try {
    if (!fs.existsSync(TEAMS_DIR)) return;
    const dirs = fs.readdirSync(TEAMS_DIR).filter(d => {
      try { return fs.statSync(path.join(TEAMS_DIR, d)).isDirectory(); } catch { return false; }
    });
    for (const teamName of dirs) {
      const config = readTeamConfig(teamName);
      if (!config) continue;
      const inboxes = readTeamInboxes(teamName);
      const tasks = readTeamTasks(teamName);
      teamsState.set(teamName, { config, inboxes, tasks });

      // Register team members as agents in the graph
      if (config.members) {
        for (const member of config.members) {
          const agentId = member.agentId || `${member.name}@${teamName}`;
          const agent = getOrCreateAgent(agentId, {
            label: member.name || agentId,
            role: member.agentType === "team-lead" ? "lead" : "worker",
            cwd: member.cwd || null,
          });
          // Enrich with team metadata
          agent.teamName = teamName;
          agent.teamAgentId = agentId;
          agent.teamMemberName = member.name || agentId.split("@")[0];
          agent.agentType = member.agentType;
          if (member.color) agent.color = member.color;
          if (member.prompt) agent.spawnPrompt = member.prompt;
          if (member.name && (agent.label.startsWith("Agent ") || !agent._taskLabel)) {
            agent.label = member.name;
          }
        }
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Error reading teams: ${e.message}`);
  }
}

function getTeamsSnapshot() {
  const result = {};
  for (const [teamName, team] of teamsState) {
    result[teamName] = {
      config: team.config,
      inboxes: Object.fromEntries(team.inboxes),
      tasks: Object.fromEntries(team.tasks),
    };
  }
  return result;
}

// Write a message to a specific agent's inbox
function writeInboxMessage(teamName, targetAgent, fromName, messageText) {
  const inboxDir = path.join(TEAMS_DIR, teamName, "inboxes");
  const inboxFile = path.join(inboxDir, `${targetAgent}.json`);

  try {
    // Ensure inbox dir exists
    fs.mkdirSync(inboxDir, { recursive: true });

    // Read existing messages
    let messages = [];
    try {
      const existing = readJsonSafe(inboxFile);
      if (Array.isArray(existing)) messages = existing;
      else if (existing?.messages) messages = existing.messages;
    } catch {}

    // Append new message in the format agent teams expects
    const msg = {
      from: fromName,
      text: messageText,
      timestamp: new Date().toISOString(),
      read: false,
    };
    messages.push(msg);

    // Write atomically (temp file + rename)
    const tmpFile = inboxFile + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(messages, null, 2));
    fs.renameSync(tmpFile, inboxFile);

    console.log(`  💬 Wrote inbox message: ${fromName} → ${targetAgent}@${teamName}`);
    return msg;
  } catch (e) {
    console.log(`  ❌ Failed to write inbox: ${e.message}`);
    return null;
  }
}

function getOrCreateAgent(sessionId, extra = {}) {
  if (!knownAgents.has(sessionId)) {
    const shortId = sessionId.substring(0, 8);
    const color = PALETTE[colorIndex % PALETTE.length];
    colorIndex++;

    knownAgents.set(sessionId, {
      id: sessionId,
      shortId,
      label: extra.label || `Agent ${shortId}`,
      role: extra.role || "worker",
      color,
      status: "idle",
      lastTool: null,
      lastFile: null,
      lastActive: Date.now(),
      tokens: 0,
      toolCalls: 0,
      firstSeen: Date.now(),
      cwd: extra.cwd || null,
    });

    broadcast({ type: "agent_join", agent: knownAgents.get(sessionId) });
  } else {
    // Update label/role if we get better info (e.g. from SessionStart with model)
    const existing = knownAgents.get(sessionId);
    if (extra.label && existing.label.startsWith("Agent ")) {
      existing.label = extra.label;
    }
    if (extra.role && existing.role === "worker") {
      existing.role = extra.role;
    }
  }
  return knownAgents.get(sessionId);
}

function processEvent(evt) {
  // Normalize the event
  const sessionId = evt.session_id || evt.sessionId || "unknown";
  const hookEvent = evt.hook_event_name || evt.event || evt.type || "unknown";
  const toolName = evt.tool_name || evt.tool || null;
  const toolInput = evt.tool_input || {};
  const filePath = toolInput.file_path || toolInput.command || toolInput.path || null;
  const cwd = evt.cwd || evt.working_directory || null;

  const agent = getOrCreateAgent(sessionId, {
    cwd,
    label: evt.model ? `${evt.model.replace("claude-", "").replace(/-\d+$/, "")} ${sessionId.substring(0, 6)}` : undefined,
    role: evt.source === "startup" ? "lead" : undefined,
  });

  // ── Status with hold timer ──────────────────────────────────
  // Active statuses (reading/writing/tool_call/delegating) hold for
  // at least STATUS_HOLD_MS before allowing "thinking" to take over.
  const STATUS_HOLD_MS = 3000;
  let status = "idle";

  if (hookEvent === "pre_tool" || hookEvent === "PreToolUse") {
    status = "tool_call";
    if (toolName === "Read" || toolName === "Grep" || toolName === "Glob" || toolName === "ListDir") {
      status = "reading";
    } else if (toolName === "Write" || toolName === "Edit") {
      status = "writing";
    } else if (toolName === "Task" || toolName === "SendMessage") {
      status = "delegating";
    } else if (toolName === "Bash") {
      status = "tool_call";
    }
    // Active status — record hold timestamp
    agent._statusSetAt = Date.now();
    agent.status = status;
  } else if (hookEvent === "post_tool" || hookEvent === "PostToolUse") {
    // Only go to "thinking" if the hold timer expired
    const elapsed = Date.now() - (agent._statusSetAt || 0);
    if (elapsed >= STATUS_HOLD_MS) {
      agent.status = "thinking";
    }
    // else keep the current active status — it's more informative
  } else if (hookEvent === "stop" || hookEvent === "Stop") {
    agent.status = "done";
  } else if (hookEvent === "session_start" || hookEvent === "SessionStart") {
    agent.status = "starting";
  } else if (hookEvent === "subagent_stop" || hookEvent === "SubagentStop") {
    agent.status = "done";
  } else if (hookEvent === "task_done" || hookEvent === "TaskCompleted") {
    agent.status = "done";
  }

  // ── Activity line (tool → file) ────────────────────────────
  if (toolName && (hookEvent === "pre_tool" || hookEvent === "PreToolUse")) {
    const shortFile = filePath ? filePath.replace(/\\/g, "/").split("/").pop() : "";
    agent.activity = shortFile ? `${toolName} → ${shortFile}` : toolName;
  }

  agent.lastTool = toolName;
  agent.lastFile = filePath;
  agent.lastActive = Date.now();
  agent.toolCalls++;

  // ── File pattern tracking for role inference ────────────────
  if (filePath) {
    if (!agent._filePaths) agent._filePaths = [];
    agent._filePaths.push(filePath.replace(/\\/g, "/"));
    // Keep last 30
    if (agent._filePaths.length > 30) agent._filePaths = agent._filePaths.slice(-30);

    // Infer role from file patterns (only if we don't have a task-based label)
    if (!agent._taskLabel) {
      const inferred = inferRoleFromFiles(agent._filePaths);
      if (inferred && agent.label.startsWith("Agent ")) {
        agent.label = inferred;
      }
    }
  }

  // ── Token estimation ────────────────────────────────────────
  let estimatedTokens = 0;
  if (evt.tool_response) {
    const resp = evt.tool_response;
    if (resp.file?.content) {
      estimatedTokens += Math.ceil(resp.file.content.length / 4);
    } else if (resp.stdout) {
      estimatedTokens += Math.ceil(resp.stdout.length / 4);
    } else if (resp.filenames) {
      estimatedTokens += Math.ceil(JSON.stringify(resp.filenames).length / 4);
    }
  }
  if (toolInput.content) {
    estimatedTokens += Math.ceil(toolInput.content.length / 4);
  }
  if (evt.tokens) estimatedTokens = evt.tokens;
  agent.tokens += estimatedTokens;

  // ── Task delegation → label subagent + create message ──────
  let message = null;
  if (toolName === "Task" && (hookEvent === "pre_tool" || hookEvent === "PreToolUse")) {
    // Extract the task description — this IS what the subagent will work on
    const taskDesc = toolInput.description || toolInput.prompt || toolInput.task ||
                     toolInput.message || toolInput.content || "";

    if (taskDesc) {
      // Create a compact label from the task description
      const taskLabel = summarizeTask(taskDesc);

      // We don't know the subagent's session_id yet — it hasn't started.
      // Store pending task on the delegating agent; when a new agent appears,
      // assign it the most recent pending task from any agent in this cwd.
      if (!pendingTasks) globalThis.pendingTasks = [];
      pendingTasks.push({
        from: sessionId,
        label: taskLabel,
        fullDesc: taskDesc.substring(0, 200),
        cwd: agent.cwd,
        timestamp: Date.now(),
      });

      message = {
        id: Math.random().toString(36).substr(2, 9),
        from: sessionId,
        to: "subagent",
        text: taskLabel,
        timestamp: Date.now(),
      };
    }
  }

  // When a new agent appears, check if there's a pending task for it
  if ((hookEvent === "session_start" || hookEvent === "SessionStart") && pendingTasks?.length) {
    // Find most recent pending task from same cwd or within 10s
    const now = Date.now();
    const pending = pendingTasks.find(t =>
      (now - t.timestamp) < 15000 && t.from !== sessionId
    );
    if (pending) {
      agent._taskLabel = pending.label;
      agent.label = pending.label;
      // Update the message target now that we know the session id
      const msg = recentMessages.find(m =>
        m.from === pending.from && m.to === "subagent" && m.text === pending.label
      );
      if (msg) msg.to = sessionId;

      // Remove consumed task
      const idx = pendingTasks.indexOf(pending);
      if (idx >= 0) pendingTasks.splice(idx, 1);

      broadcast({ type: "agent_join", agent: knownAgents.get(sessionId) });
    }
  }

  // SendMessage (Agent Teams)
  if (toolName === "SendMessage" && toolInput.to) {
    message = {
      id: Math.random().toString(36).substr(2, 9),
      from: sessionId,
      to: toolInput.to,
      text: toolInput.message || toolInput.content || "message",
      timestamp: Date.now(),
    };
  }

  if (message) {
    recentMessages.push(message);
    if (recentMessages.length > MAX_MESSAGES) recentMessages.shift();
  }

  // Build event record
  const record = {
    id: Math.random().toString(36).substr(2, 9),
    agentId: sessionId,
    event: hookEvent,
    tool: toolName,
    file: filePath,
    status: agent.status,
    activity: agent.activity || null,
    timestamp: Date.now(),
    tokens: estimatedTokens,
  };

  recentEvents.push(record);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();

  // Broadcast
  broadcast({ type: "event", event: record, agentUpdate: knownAgents.get(sessionId) });
  if (message) broadcast({ type: "message", message });
}

// ── Pending tasks queue (for labeling subagents) ──────────────
let pendingTasks = [];

// ── Task summarizer — extract a short label from task description ──
function summarizeTask(text) {
  // Truncate long descriptions to first sentence or clause
  const cleaned = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

  // Try to find the core action verb + object
  // "Research the best testing frameworks" → "Research testing frameworks"
  // "Refactor the API layer to use async/await" → "Refactor API layer"
  const first = cleaned.split(/[.!?\n]/)[0].trim();

  if (first.length <= 32) return first;

  // Take first ~30 chars at a word boundary
  const truncated = first.substring(0, 40);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 15 ? truncated.substring(0, lastSpace) : truncated) + "…";
}

// ── Role inference from file patterns ─────────────────────────
function inferRoleFromFiles(paths) {
  const joined = paths.join("\n").toLowerCase();

  // Count pattern hits
  const patterns = [
    { label: "Tests",      re: /test|spec|__test__|\.test\.|\.spec\./g },
    { label: "API",        re: /api|route|endpoint|controller|handler/g },
    { label: "Frontend",   re: /component|page|view|layout|\.tsx|\.jsx|\.vue|\.svelte/g },
    { label: "Database",   re: /migration|schema|model|seed|\.sql|prisma|drizzle/g },
    { label: "Config",     re: /config|\.env|package\.json|tsconfig|webpack|vite/g },
    { label: "Docs",       re: /readme|doc|\.md|guide|spec\//g },
    { label: "DevOps",     re: /docker|ci|deploy|\.yml|\.yaml|terraform|k8s/g },
    { label: "Styles",     re: /\.css|\.scss|tailwind|theme|style/g },
  ];

  let best = null;
  let bestCount = 0;
  for (const p of patterns) {
    const matches = joined.match(p.re);
    const count = matches ? matches.length : 0;
    if (count > bestCount) {
      bestCount = count;
      best = p.label;
    }
  }

  return bestCount >= 2 ? best : null;
}

// -------------------------------------------------------------------
// File watchers
// -------------------------------------------------------------------

// 1. Watch events.jsonl (primary data source from hooks)
let eventsFileSize = 0;
try { eventsFileSize = fs.statSync(EVENTS_FILE).size; } catch {}

function watchEventsFile() {
  try {
    fs.watch(EVENTS_FILE, (eventType) => {
      if (eventType !== "change") return;
      try {
        const stat = fs.statSync(EVENTS_FILE);
        if (stat.size <= eventsFileSize) {
          eventsFileSize = stat.size;
          return;
        }

        // Read new bytes
        const stream = fs.createReadStream(EVENTS_FILE, {
          start: eventsFileSize,
          encoding: "utf8",
        });

        let buffer = "";
        stream.on("data", (chunk) => { buffer += chunk; });
        stream.on("end", () => {
          eventsFileSize = stat.size;
          const lines = buffer.split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const evt = JSON.parse(line);
              processEvent(evt);
            } catch (e) {
              // Skip malformed lines
            }
          }
        });
      } catch {}
    });
    console.log(`  📡 Watching ${EVENTS_FILE}`);
  } catch (e) {
    console.log(`  ⚠️  Could not watch events file: ${e.message}`);
  }
}

// 2. Watch Agent Teams files (config, inboxes, tasks)
function watchAgentTeams() {
  // Initial read
  readAllTeams();

  const teamsCount = teamsState.size;
  if (teamsCount > 0) {
    console.log(`  🤖 Found ${teamsCount} agent team(s): ${[...teamsState.keys()].join(", ")}`);
  }

  // Watch teams directory for config and inbox changes
  if (fs.existsSync(TEAMS_DIR)) {
    try {
      fs.watch(TEAMS_DIR, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Debounce: wait for writes to settle
        const debounceKey = `teams-${filename}`;
        if (watchAgentTeams._debounce?.[debounceKey]) clearTimeout(watchAgentTeams._debounce[debounceKey]);
        if (!watchAgentTeams._debounce) watchAgentTeams._debounce = {};
        watchAgentTeams._debounce[debounceKey] = setTimeout(() => {
          const parts = filename.replace(/\\/g, "/").split("/");
          const teamName = parts[0];
          if (!teamName) return;

          // Re-read this team's state
          const config = readTeamConfig(teamName);
          if (!config) return;

          const inboxes = readTeamInboxes(teamName);
          const tasks = readTeamTasks(teamName);
          const prevTeam = teamsState.get(teamName);
          teamsState.set(teamName, { config, inboxes, tasks });

          // Register any new team members as agents
          if (config.members) {
            for (const member of config.members) {
              const agentId = member.agentId || `${member.name}@${teamName}`;
              const agent = getOrCreateAgent(agentId, {
                label: member.name || agentId,
                role: member.agentType === "team-lead" ? "lead" : "worker",
                cwd: member.cwd || null,
              });
              agent.teamName = teamName;
              agent.teamAgentId = agentId;
              agent.teamMemberName = member.name || agentId.split("@")[0];
              agent.agentType = member.agentType;
              if (member.color) agent.color = member.color;
              if (member.prompt) agent.spawnPrompt = member.prompt;
              if (member.name && (agent.label.startsWith("Agent ") || !agent._taskLabel)) {
                agent.label = member.name;
              }
            }
          }

          // Determine what changed and broadcast
          if (parts[1] === "config.json") {
            broadcast({
              type: "team_update",
              teamName,
              config,
              members: config.members || [],
            });
          } else if (parts[1] === "inboxes" && parts[2]) {
            const agentName = path.basename(parts[2], ".json");
            const messages = inboxes.get(agentName) || [];
            const prevMessages = prevTeam?.inboxes?.get(agentName) || [];
            // Only broadcast new messages (compare by length — simple but effective)
            const newMessages = messages.slice(prevMessages.length);
            if (newMessages.length > 0) {
              broadcast({
                type: "inbox_update",
                teamName,
                agentName,
                newMessages,
                totalCount: messages.length,
              });
              // Also create visual message edges for the graph
              for (const msg of newMessages) {
                if (msg.from) {
                  const fromId = `${msg.from}@${teamName}`;
                  const toId = `${agentName}@${teamName}`;
                  const visualMsg = {
                    id: Math.random().toString(36).substr(2, 9),
                    from: knownAgents.has(fromId) ? fromId : msg.from,
                    to: knownAgents.has(toId) ? toId : agentName,
                    text: (typeof msg.text === "string" ? msg.text : JSON.stringify(msg.text)).substring(0, 100),
                    timestamp: Date.now(),
                  };
                  recentMessages.push(visualMsg);
                  if (recentMessages.length > MAX_MESSAGES) recentMessages.shift();
                  broadcast({ type: "message", message: visualMsg });
                }
              }
            }
          }
        }, 200); // 200ms debounce
      });
      console.log(`  👥 Watching ${TEAMS_DIR}`);
    } catch (e) {
      console.log(`  ⚠️  Could not watch teams dir: ${e.message}`);
    }
  } else {
    console.log(`  ℹ️  No teams dir at ${TEAMS_DIR} (agent teams not active yet)`);
    // Watch parent dir for creation
    const claudeDir = path.join(HOME, ".claude");
    try {
      fs.watch(claudeDir, (eventType, filename) => {
        if (filename === "teams" && fs.existsSync(TEAMS_DIR)) {
          console.log(`  👥 Teams directory appeared — starting watcher`);
          watchAgentTeams(); // Re-run now that directory exists
        }
      });
    } catch {}
  }

  // Also watch task files (separate directory)
  if (fs.existsSync(TASKS_DIR)) {
    try {
      fs.watch(TASKS_DIR, { recursive: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith(".json")) return;

        const debounceKey = `task-${filename}`;
        if (!watchAgentTeams._debounce) watchAgentTeams._debounce = {};
        if (watchAgentTeams._debounce[debounceKey]) clearTimeout(watchAgentTeams._debounce[debounceKey]);
        watchAgentTeams._debounce[debounceKey] = setTimeout(() => {
          const parts = filename.replace(/\\/g, "/").split("/");
          const teamName = parts[0];
          if (!teamName) return;

          // Re-read this team's tasks
          const tasks = readTeamTasks(teamName);
          const team = teamsState.get(teamName);
          if (team) {
            team.tasks = tasks;
          }

          // Read the specific task that changed
          const taskFile = path.join(TASKS_DIR, filename);
          const task = readJsonSafe(taskFile);
          if (task) {
            broadcast({
              type: "task_update",
              teamName,
              task: {
                id: task.id || path.basename(filename, ".json"),
                subject: task.subject || task.title || filename,
                description: task.description || "",
                status: task.status || "pending",
                owner: task.owner || task.assignee || null,
                blockedBy: task.blockedBy || task.dependencies || [],
                blocks: task.blocks || [],
                activeForm: task.activeForm || null,
              },
            });
          }
        }, 200);
      });
      console.log(`  📋 Watching ${TASKS_DIR}`);
    } catch (e) {
      console.log(`  ⚠️  Could not watch tasks dir: ${e.message}`);
    }
  } else {
    console.log(`  ℹ️  No tasks dir at ${TASKS_DIR}`);
  }
}

// 3. Watch JSONL transcripts (optional, heavier)
function watchTranscripts() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.log(`  ℹ️  No projects dir at ${PROJECTS_DIR}`);
    return;
  }

  // Track file sizes for each jsonl
  const fileSizes = new Map();

  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return;
      const fullPath = path.join(PROJECTS_DIR, filename);

      try {
        const stat = fs.statSync(fullPath);
        const prevSize = fileSizes.get(fullPath) || stat.size;

        if (stat.size <= prevSize) {
          fileSizes.set(fullPath, stat.size);
          return;
        }

        const stream = fs.createReadStream(fullPath, {
          start: prevSize,
          encoding: "utf8",
        });

        let buffer = "";
        stream.on("data", (chunk) => { buffer += chunk; });
        stream.on("end", () => {
          fileSizes.set(fullPath, stat.size);
          const lines = buffer.split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              // Extract tool_use entries from transcript
              if (entry.type === "assistant" && entry.message?.content) {
                const contents = Array.isArray(entry.message.content) ? entry.message.content : [entry.message.content];
                for (const block of contents) {
                  if (block.type === "tool_use") {
                    processEvent({
                      session_id: entry.session_id || path.basename(fullPath, ".jsonl"),
                      hook_event_name: "PostToolUse",
                      tool_name: block.name,
                      tool_input: block.input || {},
                      cwd: entry.cwd,
                    });
                  }
                }
              }
            } catch {}
          }
        });
      } catch {}
    });
    console.log(`  📝 Watching ${PROJECTS_DIR}/**/*.jsonl`);
  } catch (e) {
    console.log(`  ⚠️  Could not watch transcripts: ${e.message}`);
  }
}

// -------------------------------------------------------------------
// Demo mode - simulates a multi-agent refactor
// -------------------------------------------------------------------
function runDemo() {
  // Define the agent roster with associated file patterns
  const TEAM_NAME = "demo-auth-refactor";
  const AGENT_DEFS = [
    { id: "lead-001", name: "team-lead", label: "Team Lead", role: "lead",
      agentType: "team-lead", color: "#ff6b35",
      prompt: "You are the team lead coordinating an OAuth2 implementation. Delegate tasks to specialists, track progress, and resolve blockers.",
      files: ["IMPLEMENTATION_PLAN.md", "specs/auth-flow.md", "README.md", "package.json"],
      tools: ["Read", "Task", "Bash", "Write"] },
    { id: "ralph-api-002", name: "api-worker", taskLabel: "Refactor API auth layer", role: "worker",
      agentType: "teammate", color: "#00d4aa",
      prompt: "Refactor the API authentication layer to use OAuth2 with JWT tokens. Update routes, middleware, and type definitions. Coordinate with the DB worker for schema changes.",
      files: ["src/api/routes.ts", "src/api/auth.ts", "src/api/middleware.ts", "src/api/types.ts"],
      tools: ["Read", "Write", "Edit", "Bash", "Grep"] },
    { id: "ralph-ui-003", name: "ui-worker", taskLabel: "Build auth frontend", role: "worker",
      agentType: "teammate", color: "#7b68ee",
      prompt: "Build the authentication frontend: login form, OAuth callback handler, token refresh UI, and user profile page. Use React with TypeScript.",
      files: ["src/components/AuthForm.tsx", "src/components/Dashboard.tsx", "src/components/UserProfile.tsx"],
      tools: ["Read", "Write", "Edit", "Bash"] },
    { id: "ralph-tests-004", name: "test-worker", taskLabel: "Write test coverage", role: "worker",
      agentType: "teammate", color: "#ffd166",
      prompt: "Write comprehensive test coverage for the OAuth2 implementation. Cover unit tests for auth logic, integration tests for API endpoints, and E2E tests for the login flow.",
      files: ["tests/api.test.ts", "tests/e2e/login.spec.ts", "tests/unit/auth.test.ts"],
      tools: ["Read", "Write", "Bash", "Grep"] },
    { id: "ralph-db-005", name: "db-worker", taskLabel: "Run DB migration for users", role: "worker",
      agentType: "teammate", color: "#ef476f",
      prompt: "Create and run database migrations for the users table, session tokens, and OAuth provider links. Update the Prisma schema and verify on staging.",
      files: ["src/db/migrations/001_add_users.sql", "src/db/schema.ts", "prisma/schema.prisma"],
      tools: ["Read", "Write", "Bash", "Edit"] },
    { id: "sub-research-006", name: "researcher", taskLabel: "Research JWT best practices", role: "subagent",
      agentType: "teammate", color: "#06d6a0",
      prompt: "Research current JWT and OAuth2 best practices. Focus on token expiry, refresh strategies, PKCE flow, and security considerations. Summarize findings.",
      files: ["specs/glossary.md", "IMPLEMENTATION_PLAN.md"],
      tools: ["Read", "WebSearch", "Write"] },
    { id: "sub-lint-007", name: "linter", taskLabel: "Lint and format codebase", role: "subagent",
      agentType: "teammate", color: "#a2d2ff",
      prompt: "Lint and format the entire codebase after changes. Fix ESLint errors, run Prettier, ensure TypeScript strict mode passes. Report any issues.",
      files: ["src/api/routes.ts", "src/components/AuthForm.tsx", ".eslintrc.json", "tsconfig.json"],
      tools: ["Bash", "Read", "Write"] },
  ];

  const MESSAGES = [
    "API types defined — ready for frontend",
    "Missing index on users table, fixing",
    "Tests at 94%, need JWT refresh edges",
    "Blocked: need token schema from DB",
    "Schema updated, run migrations",
    "Frontend needs updated API contract",
    "JWT expiry set to 15min, looks solid",
    "PR #47 ready — all checks green",
    "Race condition in session cleanup",
    "E2E flaky on CI — investigating",
    "Migration verified on staging",
  ];

  // ── Populate Agent Teams state (so context panel works) ─────
  const demoConfig = {
    teamName: TEAM_NAME,
    description: "OAuth2 authentication implementation with JWT tokens",
    members: AGENT_DEFS.map(d => ({
      name: d.name,
      agentId: d.id,
      agentType: d.agentType,
      color: d.color,
      prompt: d.prompt,
      cwd: "/project",
    })),
  };

  // Seed inbox messages for each agent
  const demoInboxes = new Map();
  const inboxSeed = [
    { agent: "api-worker", msgs: [
      { from: "team-lead", text: "Start with the JWT middleware — api/auth.ts is the entry point. DB worker will have the schema ready in ~10min.", timestamp: new Date(Date.now() - 300000).toISOString(), read: true },
      { from: "db-worker", text: "Schema is live. Users table has: id, email, password_hash, oauth_provider, oauth_id, refresh_token, created_at. Run `prisma generate` to pick it up.", timestamp: new Date(Date.now() - 120000).toISOString(), read: true },
      { from: "researcher", text: "Heads up: use RS256 not HS256 for JWT signing. Access tokens 15min, refresh tokens 7d. I've written the full spec in specs/glossary.md.", timestamp: new Date(Date.now() - 60000).toISOString(), read: false },
    ]},
    { agent: "ui-worker", msgs: [
      { from: "team-lead", text: "Build the login page first — AuthForm.tsx. The API worker is setting up POST /api/auth/login, expect { email, password } → { accessToken, refreshToken }.", timestamp: new Date(Date.now() - 240000).toISOString(), read: true },
      { from: "api-worker", text: "API contract is ready. Login returns 200 with tokens, 401 on bad creds. Refresh is POST /api/auth/refresh with { refreshToken } in body.", timestamp: new Date(Date.now() - 90000).toISOString(), read: false },
    ]},
    { agent: "test-worker", msgs: [
      { from: "team-lead", text: "Hold off on E2E until both API and UI are working. Start with unit tests for the JWT validation functions.", timestamp: new Date(Date.now() - 280000).toISOString(), read: true },
      { from: "api-worker", text: "JWT middleware is done. The validateToken() function is exported from src/api/auth.ts — you can unit test it directly.", timestamp: new Date(Date.now() - 40000).toISOString(), read: false },
    ]},
    { agent: "db-worker", msgs: [
      { from: "team-lead", text: "Start with the users table migration. We need: id (uuid), email (unique), password_hash, created_at. OAuth columns can come in migration 002.", timestamp: new Date(Date.now() - 350000).toISOString(), read: true },
    ]},
    { agent: "team-lead", msgs: [
      { from: "api-worker", text: "JWT middleware is done and tested. Moving to OAuth2 callback handler next. Need the researcher's PKCE findings before I start.", timestamp: new Date(Date.now() - 30000).toISOString(), read: false },
      { from: "test-worker", text: "Unit test coverage at 94%. Missing: JWT refresh token rotation edge case and expired token cleanup. Working on it.", timestamp: new Date(Date.now() - 15000).toISOString(), read: false },
      { from: "db-worker", text: "Migration 001 verified on staging. Starting migration 002 for OAuth provider links table.", timestamp: new Date(Date.now() - 10000).toISOString(), read: false },
    ]},
    { agent: "researcher", msgs: [
      { from: "team-lead", text: "Focus on PKCE flow for OAuth2. The API worker needs to know: do we use S256 or plain? What's the code_verifier length?", timestamp: new Date(Date.now() - 200000).toISOString(), read: true },
    ]},
    { agent: "linter", msgs: [
      { from: "team-lead", text: "Run a lint pass after the API worker finishes the middleware changes. Focus on the src/api/ directory first.", timestamp: new Date(Date.now() - 180000).toISOString(), read: true },
    ]},
  ];
  for (const seed of inboxSeed) {
    demoInboxes.set(seed.agent, seed.msgs);
  }

  // Seed tasks
  const demoTasks = new Map();
  const taskSeed = [
    { id: "1", subject: "Research JWT/OAuth2 best practices", status: "completed", owner: "researcher" },
    { id: "2", subject: "Create users table migration", status: "completed", owner: "db-worker" },
    { id: "3", subject: "Build JWT middleware", status: "completed", owner: "api-worker", blockedBy: ["2"] },
    { id: "4", subject: "Build login page (AuthForm.tsx)", status: "in_progress", owner: "ui-worker", blockedBy: ["3"] },
    { id: "5", subject: "OAuth2 callback handler", status: "in_progress", owner: "api-worker", blockedBy: ["1"] },
    { id: "6", subject: "Unit tests for auth logic", status: "in_progress", owner: "test-worker", blockedBy: ["3"] },
    { id: "7", subject: "OAuth provider links migration", status: "in_progress", owner: "db-worker", blockedBy: ["2"] },
    { id: "8", subject: "E2E login flow tests", status: "blocked", owner: "test-worker", blockedBy: ["4", "5"] },
    { id: "9", subject: "Lint and format codebase", status: "pending", owner: "linter", blockedBy: ["4", "5", "7"] },
    { id: "10", subject: "Token refresh UI component", status: "pending", owner: "ui-worker", blockedBy: ["5"] },
  ];
  for (const task of taskSeed) {
    demoTasks.set(task.id, task);
  }

  teamsState.set(TEAM_NAME, {
    config: demoConfig,
    inboxes: demoInboxes,
    tasks: demoTasks,
  });

  // ── Phase 1: Start the lead agent ──────────────────────────
  processEvent({
    session_id: "lead-001",
    hook_event_name: "SessionStart",
    model: "claude-opus-4-6",
    source: "startup",
    cwd: "/project",
  });

  // Enrich all agents with team metadata
  function enrichAgent(def) {
    const agent = knownAgents.get(def.id);
    if (agent) {
      agent.teamName = TEAM_NAME;
      agent.teamAgentId = def.id;
      agent.teamMemberName = def.name; // the name used in inbox/task keys
      agent.agentType = def.agentType;
      agent.spawnPrompt = def.prompt;
      if (def.color) agent.color = def.color;
      if (def.name) agent.label = def.name;
      if (def.taskLabel) {
        agent._taskLabel = def.taskLabel;
        agent.label = def.taskLabel;
      }
    }
  }

  enrichAgent(AGENT_DEFS[0]); // enrich lead immediately

  // Phase 2: Lead delegates tasks → spawns workers over time
  let spawnIdx = 1; // skip lead
  function spawnNextAgent() {
    if (spawnIdx >= AGENT_DEFS.length) return;
    const def = AGENT_DEFS[spawnIdx];

    // Lead uses Task tool to delegate
    processEvent({
      session_id: "lead-001",
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { description: def.taskLabel },
    });

    // Subagent starts after a short delay (simulating spawn)
    setTimeout(() => {
      processEvent({
        session_id: def.id,
        hook_event_name: "SessionStart",
        model: "claude-sonnet-4-5",
        cwd: "/project",
      });

      // Enrich with team metadata (role, color, spawn prompt, team name)
      enrichAgent(def);
    }, 800 + Math.random() * 400);

    spawnIdx++;
    // Stagger spawns
    setTimeout(spawnNextAgent, 2000 + Math.random() * 3000);
  }

  setTimeout(spawnNextAgent, 1500);

  // Phase 3: Ongoing activity simulation
  function pickActiveAgent() {
    const active = AGENT_DEFS.filter(d => knownAgents.has(d.id));
    if (active.length === 0) return null;
    // Workers more active
    const weights = active.map(a => a.role === "worker" ? 4 : a.role === "lead" ? 1.5 : 2);
    const total = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    for (let i = 0; i < active.length; i++) {
      r -= weights[i];
      if (r <= 0) return active[i];
    }
    return active[0];
  }

  function activityTick() {
    const def = pickActiveAgent();
    if (!def) return;

    const tool = def.tools[Math.floor(Math.random() * def.tools.length)];
    const file = def.files[Math.floor(Math.random() * def.files.length)];

    // Skip Task tool for non-leads in activity ticks
    if (tool === "Task" && def.role !== "lead") {
      activityTick();
      return;
    }

    processEvent({
      session_id: def.id,
      hook_event_name: "PreToolUse",
      tool_name: tool,
      tool_input: {
        file_path: file,
        command: tool === "Bash" ? `npm test -- --grep "${file}"` : undefined,
      },
    });

    setTimeout(() => {
      processEvent({
        session_id: def.id,
        hook_event_name: "PostToolUse",
        tool_name: tool,
        tool_input: { file_path: file },
        tool_response: {
          file: tool === "Read" ? { content: "x".repeat(200 + Math.floor(Math.random() * 2000)) } : undefined,
          stdout: tool === "Bash" ? "PASS: 12 tests passed\n" : undefined,
        },
      });
    }, 500 + Math.random() * 1500);

    // Inter-agent messages (also inject into team inboxes for context panel)
    if (Math.random() > 0.65) {
      const others = AGENT_DEFS.filter(a => a.id !== def.id && knownAgents.has(a.id));
      if (others.length > 0) {
        const target = others[Math.floor(Math.random() * others.length)];
        const msg = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];

        setTimeout(() => {
          const message = {
            id: Math.random().toString(36).substr(2, 9),
            from: def.id,
            to: target.id,
            text: msg,
            timestamp: Date.now(),
          };
          recentMessages.push(message);
          if (recentMessages.length > MAX_MESSAGES) recentMessages.shift();
          broadcast({ type: "message", message });

          // Also inject into team inbox state so context panel shows it
          const team = teamsState.get(TEAM_NAME);
          if (team) {
            const targetName = target.name;
            if (!team.inboxes.has(targetName)) team.inboxes.set(targetName, []);
            const inboxMsg = {
              from: def.name,
              text: msg,
              timestamp: new Date().toISOString(),
              read: false,
            };
            team.inboxes.get(targetName).push(inboxMsg);

            // Broadcast inbox update so open panels update live
            broadcast({
              type: "inbox_update",
              teamName: TEAM_NAME,
              agentName: targetName,
              newMessages: [inboxMsg],
              totalCount: team.inboxes.get(targetName).length,
            });
          }
        }, 300 + Math.random() * 500);
      }
    }

    // Occasionally advance task statuses
    if (Math.random() > 0.88) {
      const team = teamsState.get(TEAM_NAME);
      if (team) {
        // Find a task that can advance
        const progressable = [...team.tasks.values()].filter(t =>
          (t.status === "pending" || t.status === "blocked") &&
          (t.blockedBy || []).every(dep => {
            const depTask = team.tasks.get(dep);
            return depTask && depTask.status === "completed";
          })
        );
        if (progressable.length > 0) {
          const task = progressable[Math.floor(Math.random() * progressable.length)];
          task.status = "in_progress";
          broadcast({ type: "task_update", teamName: TEAM_NAME, task });
        }

        // Occasionally complete an in_progress task
        if (Math.random() > 0.5) {
          const inProgress = [...team.tasks.values()].filter(t => t.status === "in_progress");
          if (inProgress.length > 0) {
            const task = inProgress[Math.floor(Math.random() * inProgress.length)];
            task.status = "completed";
            broadcast({ type: "task_update", teamName: TEAM_NAME, task });
          }
        }
      }
    }

    // Occasionally block/complete agents
    if (Math.random() > 0.92) {
      setTimeout(() => {
        const a = knownAgents.get(def.id);
        if (a && def.role !== "lead") {
          a.status = Math.random() > 0.4 ? "blocked" : "done";
          a.activity = a.status === "blocked" ? "waiting on dependency" : "task complete";
          broadcast({
            type: "event",
            event: { id: "s" + Date.now(), agentId: def.id, status: a.status, activity: a.activity, timestamp: Date.now() },
            agentUpdate: a,
          });
        }
      }, 2000);
    }
  }

  // Variable tick rate, start after initial spawns
  function scheduleActivity() {
    const delay = 500 + Math.random() * 1500;
    setTimeout(() => {
      activityTick();
      scheduleActivity();
    }, delay);
  }

  // Start activity streams after a few agents have spawned
  setTimeout(scheduleActivity, 4000);
  setTimeout(scheduleActivity, 5000);
  setTimeout(scheduleActivity, 6500);

  console.log(`  🎭 Demo mode: simulating ${AGENT_DEFS.length} agents (spawning over time)`);
}

// -------------------------------------------------------------------
// Start
// -------------------------------------------------------------------
server.listen(PORT, () => {
  console.log("");
  console.log("  ┌─────────────────────────────────────┐");
  console.log("  │       🔮 Swarm Observer v0.1         │");
  console.log("  └─────────────────────────────────────┘");
  console.log("");
  console.log(`  → http://localhost:${PORT}`);
  console.log("");

  if (DEMO) {
    runDemo();
  } else {
    watchEventsFile();
    watchAgentTeams();
    watchTranscripts();
  }

  console.log("");
  console.log("  Ready. Open the URL above in your browser.");
  console.log("");
});
