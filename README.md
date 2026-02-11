# Swarm Observer

Real-time force-directed graph visualization and management UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent swarms and Agent Teams. Watch your agents think, write, communicate, and coordinate — all in a single live view that updates as they work.

Built with D3.js, vanilla JS, and a Node.js WebSocket server. No build step. No framework. One HTML file. One server file.

## How It Works

```
Claude Code Sessions (Agent Teams, Subagents)
  │  PreToolUse / PostToolUse / Stop / SessionStart / ...
  ▼
log-event.js (hook dispatcher)
  │  Enriches with session ID + timestamp
  │  Appends to ~/.claude/swarm-viz/events.jsonl
  ▼
server.js (Node.js)
  │  Watches: events.jsonl, ~/.claude/teams/, ~/.claude/tasks/, transcripts
  │  Serves: static files + WebSocket
  ▼
Browser (public/index.html)
    D3 force-directed graph
    ● Agent nodes with status-colored rings
    ● Animated particles for inter-agent messages
    ● Real-time event stream + mailbox sidebar
    ● Interactive agent context panel (inbox, tasks, spawn prompt)
    ● Spawn and manage Claude Code sessions from the UI
```

## Quick Start

```bash
cd swarm-observer
npm install

# Demo mode — simulated 7-agent swarm, no Claude Code needed
npm run demo
# Then open http://localhost:3333

# Live mode — watches real Claude Code hook events
npm start
```

### Install Hooks (for live mode)

The installer configures Claude Code hooks to emit events that the observer picks up:

```bash
npm run install-hooks
```

This copies `log-event.js` to `~/.claude/swarm-viz/` and adds hook entries to `~/.claude/settings.json` for `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, `SubagentStop`, and `TaskCompleted`. Works on Windows, macOS, and Linux.

## Data Sources

### 1. Claude Code Hooks (primary, real-time)

| Hook Event      | Fires When                 | Captured                      |
|-----------------|----------------------------|-------------------------------|
| `PreToolUse`    | Before any tool call       | Tool name, input, file path   |
| `PostToolUse`   | After tool completes       | Tool result, token count      |
| `SessionStart`  | New session begins         | Session ID, working directory |
| `Stop`          | Agent finishes responding  | Completion status             |
| `SubagentStop`  | Subagent finishes          | Subagent session ID           |
| `TaskCompleted` | Agent team task done       | Task metadata                 |

### 2. Agent Teams File Protocol

When using Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), the server watches:

```
~/.claude/teams/{teamName}/config.json          Team membership, colors, backend
~/.claude/teams/{teamName}/inboxes/{agent}.json  Messages TO that agent
~/.claude/tasks/{teamName}/{N}.json              Task state (owner, status, blockedBy)
```

### 3. JSONL Transcripts (fallback)

Tails `~/.claude/projects/**/*.jsonl` for `tool_use` entries when hooks aren't available.

## Visualization

### Node Types

| Visual             | Meaning       |
|--------------------|---------------|
| Large center node  | Team Lead     |
| Medium nodes       | Workers       |
| Small nodes        | Subagents     |

### Status Colors

| Color  | Status       | Meaning                          |
|--------|--------------|----------------------------------|
| Green  | `tool_call`  | Actively calling a tool          |
| Purple | `writing`    | Writing or editing files         |
| Blue   | `reading`    | Reading files, grepping, globbing|
| Yellow | `thinking`   | Between tool calls, reasoning    |
| Orange | `delegating` | Spawning subagent or messaging   |
| Red    | `blocked`    | Waiting on dependency or error   |
| Gray   | `idle/done`  | Inactive or completed            |

### Interactions

- **Click node** — opens Context tab (inbox, tasks, spawn prompt)
- **Right-click node** — opens Session tab to spawn Claude Code with that agent's cwd
- **Double-click node** — releases pin (returns node to simulation)
- **Drag node** — pins it in place
- **"+ New Prompt" button** — opens Session tab to spawn a new Claude Code session

## Architecture

```
swarm-observer/
├── server.js              # HTTP + WebSocket + file watchers + Claude Code spawner
├── public/
│   └── index.html         # Entire UI: CSS + HTML + D3 graph + panels (single file)
├── scripts/
│   ├── install.js         # Cross-platform hook installer
│   ├── log-event.js       # Hook dispatcher (appends to events.jsonl)
│   └── log-event.sh       # Bash wrapper for log-event.js
├── test/
│   ├── server.test.js     # Protocol-level tests (no browser)
│   ├── smoke.js           # Puppeteer screenshot smoke test
│   ├── screenshot.js      # Lightweight screenshot against running server
│   ├── seed-teams.js      # Create/remove fake Agent Teams files
│   ├── restart.js         # Kill + restart server helper
│   └── run-tests.js       # Test runner
├── hooks-example.json     # Example hooks configuration
└── package.json
```

### server.js

Three layers:

1. **HTTP + WebSocket** — Static file serving, WS connection handling, Claude Code session spawning via `spawn("claude", ["-p", ...])`
2. **State + Event Processing** — `knownAgents` Map, `processEvent()` normalizes hook events into agent status/activity, role inference from file patterns
3. **File Watchers** — Tails `events.jsonl`, watches `~/.claude/teams/` and `~/.claude/tasks/` (debounced), watches JSONL transcripts

### public/index.html

Single-file SPA (~1800 lines). Dark theme with JetBrains Mono. D3 force simulation with status rings, pulse animations, and message particles. Sidebar with mailbox and event stream. Bottom panel with Context and Session tabs.

## WebSocket Protocol

**Client to Server:**
- `prompt` — spawn new Claude Code session
- `respond` — send stdin to running session
- `kill` — terminate session
- `get_agent_context` — request agent's full context
- `send_inbox_message` — write to an agent's inbox file

**Server to Client:**
- `snapshot` — initial state (agents, events, messages, teams)
- `agent_join` / `event` / `message` — live updates
- `agent_context` — full agent context response
- `inbox_update` / `team_update` / `task_update` — file protocol changes
- `session_started` / `session_output` / `session_ended` / `session_error` — spawned session lifecycle

## Testing

```bash
cd swarm-observer

npm test              # Protocol tests — 32 assertions, ~10s, no browser
npm run test:smoke    # Puppeteer screenshot smoke test (starts its own demo server)
npm run test:all      # Both
```

### Seed Data (for manual testing)

```bash
npm run seed          # Create fake team (4 agents, 8 tasks, seeded inboxes)
npm run seed:clean    # Remove test team files
npm run seed:refresh  # Remove + recreate (re-triggers file watchers)
```

## Configuration

| Variable | Default | Description       |
|----------|---------|-------------------|
| `PORT`   | `3333`  | Server port       |

Hooks are stored in `~/.claude/settings.json`. Project-level overrides go in `.claude/settings.json` within the project directory.

## Requirements

- Node.js 18+
- `ws` (only runtime dependency)
- `puppeteer` (dev dependency, for smoke tests)
- Claude Code (for live mode; demo mode works without it)

## License

MIT
