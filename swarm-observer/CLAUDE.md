# CLAUDE.md — Swarm Observer

## What This Is

Real-time force-directed graph visualization and management UI for Claude Code agent swarms and Agent Teams. Single HTML page + Node.js WebSocket server. Zero build step.

## Quick Start

```
npm install
npm run demo        # simulated multi-agent swarm
npm start           # production — watches ~/.claude/ for real agent activity
npm test            # run all tests (syntax + server protocol + screenshot smoke)
```

## Architecture

```
server.js              Node.js server — HTTP static files + WebSocket + file watchers
public/index.html      Entire UI — HTML + CSS + JS + D3 force graph (single file, ~1800 lines)
test/server.test.js    Protocol-level tests (no browser needed)
test/smoke.js          Puppeteer screenshot smoke test (starts demo, captures PNG)
scripts/install.js     Hook installer for Claude Code event hooks
scripts/log-event.js   Event logger called by hooks
```

### server.js (1200 lines)

Three concerns, top to bottom:

1. **HTTP + WebSocket** (lines 1-230) — Static file server, WS connection handling, Claude Code session spawning (`spawn("claude", ["-p", ...])`). New message types: `get_agent_context`, `send_inbox_message`.

2. **State + Event Processing** (lines 230-530) — `knownAgents` Map, `processEvent()` that normalizes hook events into agent status/activity, role inference from file patterns, task delegation tracking.

3. **File Watchers** (lines 530-end) — Three watchers:
   - `watchEventsFile()` — tails `~/.claude/swarm-viz/events.jsonl` (hook events)
   - `watchAgentTeams()` — watches `~/.claude/teams/` (config.json, inboxes/*.json) and `~/.claude/tasks/` (task JSON files). Debounced at 200ms.
   - `watchTranscripts()` — watches `~/.claude/projects/**/*.jsonl` (JSONL transcripts)

Key data structures:
- `knownAgents: Map<sessionId, AgentInfo>` — agent state (id, label, role, color, status, teamName, spawnPrompt, etc.)
- `teamsState: Map<teamName, { config, inboxes: Map, tasks: Map }>` — agent teams file protocol state
- `managedProcesses: Map<sessionTag, { proc, ws, buffer }>` — spawned Claude Code sessions
- `recentEvents[]`, `recentMessages[]` — ring buffers for event/message history

### public/index.html

Single-file SPA. Sections in order:

1. **CSS** (lines 1-460) — Dark theme, JetBrains Mono, panel styles, task badges, inbox messages
2. **HTML** (lines 460-580) — SVG canvas, sidebar (mailbox + events), bottom panel with tabs
3. **JS — D3 Force Graph** (lines 580-1000) — `rebuildGraph()`, node rendering (status rings, pulse animations), link rendering, particle system for messages, drag/zoom
4. **JS — Sidebar** (lines 1000-1160) — `renderMailbox()`, `renderEventStream()`, incremental DOM updates
5. **JS — State Management** (lines 1160-1250) — `handleSnapshot()`, `handleAgentJoin()`, `handleAgentUpdate()`, `handleMessage()`
6. **JS — WebSocket** (lines 1250-1330) — Connection with auto-reconnect, message dispatch
7. **JS — Agent Panel** (lines 1380-end) — Tabbed bottom panel:
   - **Context tab**: agent header, spawn prompt, task board, inbox messages, inbox send
   - **Session tab**: Claude Code spawner with cwd picker, stdout streaming, permission buttons

### Node Interactions

- **Left-click node** → opens Context tab for that agent (requests `get_agent_context` from server)
- **Right-click node** → opens Session tab pre-filled with agent's cwd
- **Double-click node** → releases pin (lets simulation reclaim position)
- **Drag node** → pins it in place
- **"+ New Prompt" button** → opens Session tab with no agent context

### WebSocket Protocol

Client → Server:
- `{ type: "prompt", text, cwd }` — spawn new Claude Code session
- `{ type: "respond", sessionTag, text }` — send stdin to running session
- `{ type: "kill", sessionTag }` — terminate session
- `{ type: "get_agent_context", agentId }` — request agent's inbox/tasks/prompt
- `{ type: "send_inbox_message", teamName, targetAgent, fromName, text }` — write to agent's inbox file

Server → Client:
- `{ type: "snapshot", agents, recentEvents, recentMessages, teams, serverCwd }` — initial state
- `{ type: "agent_join", agent }` — new agent discovered
- `{ type: "event", event, agentUpdate }` — tool use / status change
- `{ type: "message", message }` — inter-agent message
- `{ type: "agent_context", agentId, agent, inbox, tasks, allTasks, teamInfo, spawnPrompt }` — full agent context
- `{ type: "inbox_update", teamName, agentName, newMessages, totalCount }` — live inbox change
- `{ type: "team_update", teamName, config, members }` — team config change
- `{ type: "task_update", teamName, task }` — task status change
- `{ type: "session_started|session_output|session_ended|session_error", sessionTag, ... }` — Claude Code session lifecycle

### Agent Teams File Protocol

The server reads/writes these paths:

```
~/.claude/teams/{teamName}/config.json          Team membership, agent IDs, colors, backend
~/.claude/teams/{teamName}/inboxes/{agent}.json  Messages TO that agent (JSON array)
~/.claude/tasks/{teamName}/{N}.json              Task with id, subject, status, owner, blockedBy
```

`writeInboxMessage()` uses atomic writes (temp file + rename) to avoid corruption.

## Development Workflow (Claude Code)

When Claude Code is developing Swarm Observer, it should be looking at itself in the live UI. Here's the loop:

### Setup (first time)

```bash
npm install                      # installs ws + puppeteer
npm run seed                     # create fake team data on disk
npm start                        # start in real mode — watches ~/.claude/
```

Claude Code's own hook events will make it appear as a node. The seeded team files provide inboxes, tasks, and spawn prompts for testing the context panel.

### Edit → Verify Loop

```bash
# 1. Make code changes to server.js or public/index.html

# 2. If server.js changed, restart:
npm run restart                  # kills old server, starts new one, waits for Ready

# 3. Take a screenshot of the live UI:
npm run screenshot               # captures graph + clicks a node for panel shot
```

This saves two PNGs that Claude Code can view:
- `test/screenshots/latest.png` — full graph showing all nodes
- `test/screenshots/latest-panel.png` — context panel open (inbox, tasks, prompt)

The screenshot script also prints DOM stats and panel contents to stdout:
```
Nodes: 5 | Links: 3 | Events: 12 | Messages: 7
Agents: orchestrator, ui-builder, api-worker, tester, Agent abc123
Clicked: orchestrator
  Panel: open | Tab: context
  Agent: orchestrator (team-lead)
  Prompt: You are the orchestrator. Coordinate the frontend and…
  Tasks: 8 | Inbox: 3
```

### Seed Team Data

The `seed` commands manage fake Agent Teams files on disk for the real file watchers:

```bash
npm run seed                     # create test team (4 agents, 8 tasks, seeded inboxes)
npm run seed:clean               # remove test team files
npm run seed:refresh             # remove + recreate (triggers watchers again)
```

Files are written to `~/.claude/teams/test-swarm-team/` and `~/.claude/tasks/test-swarm-team/`.

### Running Tests

```bash
npm test                         # 32 protocol tests, ~10s, no browser
npm run test:smoke               # full smoke test with screenshots (starts its own server in demo mode)
npm run test:all                 # both
```

### Key Workflow Rules

- **index.html changes don't need a restart** — just take a new screenshot (the browser fetches fresh HTML)
- **server.js changes need `npm run restart`** before screenshotting
- **Always view the PNG** after UI changes — DOM stats alone can't catch layout/visual bugs
- **Don't use `npm run demo`** for development — use real mode so Claude Code sees itself in the graph
- **`npm test` is fast** (no browser) — run it after every change as a sanity check

## Testing

### test/server.test.js (npm test)
Protocol-level tests, no browser needed. Starts server in demo mode, connects raw WebSocket:
- Syntax validation (server.js + index.html structure)
- HTTP serving (static files, /api/state, 404)
- WS snapshot, agent joins, event/message broadcasts
- Agent context with full teams data (verifies lead has spawn prompt, 4+ inbox messages, 10 tasks, teamInfo with 7 members)
- 32 assertions, ~10s

### test/smoke.js (npm run test:smoke)
Puppeteer screenshot smoke test. Starts its own demo server (separate from dev server):
- Waits for 7 agents to spawn and render
- Screenshots the graph
- Clicks a node, verifies context panel opens with inbox/tasks/prompt
- Screenshots the panel
- Reports DOM stats and panel contents
- Two modes: default (demo simulation) and `--real` (writes temp files, tests file watchers)

### test/screenshot.js (npm run screenshot)
Lightweight — connects to an **already-running** server. No server lifecycle management.
Takes screenshots and reports DOM stats. This is what Claude Code uses during development.

### test/seed-teams.js (npm run seed)
Creates/removes fake Agent Teams JSON files on disk. The real file watchers pick them up within ~200ms.

## Common Changes

**Add a new WS message type**: Add handler in server.js ws.on("message") → add case in index.html switch(data.type) → add UI rendering function.

**Change node appearance**: Look in `rebuildGraph()` nodeEnter section. Status colors are in `statusColor()`. Ring animation is the `.ring` circle.

**Change panel layout**: The bottom panel is `#prompt-panel`. Tabs switch between `#tab-context` and `#tab-session`. CSS is in the `/* Panel Tabs */` and `/* Agent Context Tab */` sections.

**Add a new file watcher**: Add to `watchAgentTeams()` or create a new `watchX()` function called from the startup block near line 1200.

## Constraints

- **No build step** — everything runs from source. No webpack, no TypeScript, no bundler.
- **Single HTML file** — all UI code stays in index.html. No framework, no npm UI deps.
- **ws is the only dependency** — keep it minimal.
- **Windows compatible** — use `path.join()` not hardcoded `/`, use `process.env.USERPROFILE` fallback, no bash in scripts.
- **Demo mode** must always work — it's the primary way to test UI changes without real agents.
