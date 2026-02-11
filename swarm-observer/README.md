# 🔮 Swarm Observer

A real-time force-directed graph visualization for Claude Code agent swarms, Ralph sessions, and multi-agent workflows.

Watch your agents think, write, communicate, and coordinate — compressed into a single living visual that updates as they work.

![Architecture: Hooks → Events → WebSocket → Force Graph](https://img.shields.io/badge/architecture-hooks→ws→d3-blue)

## Quick Start

```bash
# 1. Install
cd swarm-observer
bash scripts/install.sh

# 2. Run in demo mode (no Claude Code needed)
npm run demo

# 3. Open browser
open http://localhost:3333
```

For real Claude Code integration:

```bash
# Start the observer
npm start

# In another terminal, use Claude Code normally
# Events flow automatically via hooks
claude
```

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code Sessions (Ralphs, Agent Teams, Subagents)          │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Ralph:API│  │Ralph:UI  │  │Ralph:Test│  │ Subagent │       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘       │
│       │              │              │              │              │
│  PreToolUse     PostToolUse    Stop          SessionStart        │
│  PostToolUse    SendMessage    SubagentStop   TaskCompleted      │
└───────┼──────────────┼──────────────┼──────────────┼────────────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
  ┌──────────────────────────────────────────────────────┐
  │  log-event.sh (hook dispatcher)                       │
  │  Enriches with $CLAUDE_SESSION_ID + timestamp         │
  │  Appends JSON to ~/.claude/swarm-viz/events.jsonl     │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌──────────────────────────────────────────────────────┐
  │  server.js (Node.js)                                  │
  │                                                       │
  │  Watches:                                             │
  │    1. events.jsonl       ← hooks (primary)            │
  │    2. ~/.claude/tasks/   ← agent team state           │
  │    3. ~/.claude/projects/*.jsonl ← transcripts        │
  │                                                       │
  │  Serves: static files + WebSocket                     │
  └───────────────────────┬──────────────────────────────┘
                          │ WebSocket
                          ▼
  ┌──────────────────────────────────────────────────────┐
  │  Browser (public/index.html)                          │
  │                                                       │
  │  D3.js force-directed graph                           │
  │  ● Agent nodes with status-colored rings              │
  │  ● Animated particles for inter-agent messages        │
  │  ● Real-time event stream sidebar                     │
  │  ● Mailbox showing agent communications               │
  │  ● Draggable nodes, tooltips, zoom                    │
  └──────────────────────────────────────────────────────┘
```

## Data Sources

### 1. Hooks (Primary — Real-time)

Claude Code hooks fire on every lifecycle event. The install script adds hooks for:

| Hook Event     | Fires When                          | What We Capture               |
|----------------|-------------------------------------|-------------------------------|
| `PreToolUse`   | Before any tool call                | Tool name, input, file path   |
| `PostToolUse`  | After tool completes                | Tool result, token count      |
| `SessionStart` | New session begins                  | Session ID, working directory |
| `Stop`         | Agent finishes responding           | Completion status             |
| `SubagentStop` | Subagent finishes                   | Subagent session ID           |
| `TaskCompleted`| Agent team task done                | Task metadata                 |

Each hook receives JSON via stdin containing `tool_name`, `tool_input`, `session_id`, `cwd`, etc.
The dispatcher enriches this with `$CLAUDE_SESSION_ID` and a millisecond timestamp.

### 2. Task Files (Agent Teams)

When using agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), Claude Code writes task state to `~/.claude/tasks/{team-name}/`. The server watches these for:
- Task creation, claiming, completion
- Dependency chains between tasks
- Agent assignments

### 3. JSONL Transcripts (Full History)

All Claude Code sessions are logged as JSONL at `~/.claude/projects/**/*.jsonl`. The server optionally tails these for `tool_use` entries — useful as a fallback if hooks aren't firing or for retroactive visualization.

## Visualization Guide

### Node Types

| Visual              | Meaning            |
|---------------------|---------------------|
| Large center node   | Team Lead           |
| Medium nodes        | Workers (Ralphs)    |
| Small nodes         | Subagents           |

### Status Colors

| Color    | Status     | Meaning                                    |
|----------|------------|--------------------------------------------|
| 🟢 Green | `tool_call` | Actively calling a tool                   |
| 🟣 Purple | `writing`  | Writing or editing files                  |
| 🔵 Blue  | `reading`  | Reading files, grepping, globbing          |
| 🟡 Yellow | `thinking` | Between tool calls, reasoning             |
| 🟠 Orange | `delegating` | Spawning subagent or sending message    |
| 🔴 Red   | `blocked`  | Waiting on dependency or error             |
| ⚫ Gray  | `idle/done` | Inactive or completed                     |

### Visual Elements

- **Pulsing rings**: Active agents have animated outer rings
- **Glowing edges**: Links between active agents glow
- **Flying particles**: Messages between agents shown as colored dots traversing edges
- **Dashed rings**: Blocked agents have dashed status rings
- **Edge thickness**: Stronger connections (more communication) have thicker lines

## Configuration

### Environment Variables

```bash
PORT=3333          # Server port (default: 3333)
```

### Hooks Location

Hooks are stored in `~/.claude/settings.json`. You can also use:
- `.claude/settings.json` in a project (project-specific)
- `.claude/settings.local.json` (local overrides, not committed)

### Customizing

To add hooks to a specific project instead of globally:

```bash
# Copy hooks to project settings instead
cp ~/.claude/settings.json ./myproject/.claude/settings.json
```

## Modes

### Live Mode (default)

```bash
npm start
```

Watches real Claude Code hook events. Use this when actively developing with Claude Code.

### Demo Mode

```bash
npm run demo
```

Simulates 7 agents working on a refactor. Great for:
- Testing the visualization without Claude Code
- Showing others what it looks like
- Developing new visual features

## Troubleshooting

### Hooks not firing?

1. **Check Claude Code version**: Hooks require recent versions. Run `claude --version`.
2. **Verify settings**: `cat ~/.claude/settings.json | jq '.hooks'`
3. **Check the log**: `tail -f ~/.claude/swarm-viz/events.jsonl`
4. **Test manually**: `echo '{"tool_name":"test"}' | ~/.claude/swarm-viz/log-event.sh pre_tool`
5. **Known issue**: Some Claude Code versions have [bugs with PreToolUse/PostToolUse](https://github.com/anthropics/claude-code/issues/6305). `Stop` and `SessionStart` are more reliable.

### No agents appearing?

The visualization discovers agents dynamically from events. If no events are flowing:
- Try demo mode first: `npm run demo`
- Check WebSocket connection (look for the green dot in the header)
- Check browser console for errors

### Performance with many agents?

The D3 force simulation handles ~20-30 nodes smoothly. For larger swarms, you may want to:
- Increase `alphaDecay` in the simulation config
- Reduce particle count
- Collapse subagents into their parent agent's node

## Project Structure

```
swarm-observer/
├── server.js              # Node.js — file watcher + WebSocket + static server
├── public/
│   └── index.html         # Self-contained frontend (D3.js, vanilla JS)
├── scripts/
│   ├── log-event.sh       # Hook dispatcher (bash)
│   └── install.sh         # Setup script
├── package.json
└── README.md
```

No build step. No framework. One HTML file. One server file. `npm install && npm start`.

## Extending

### Adding new data sources

In `server.js`, the `processEvent()` function normalizes all events into a common format. Add a new watcher by following the pattern of `watchEventsFile()`:

```javascript
function watchMySource() {
  fs.watch("/path/to/source", (eventType, filename) => {
    // Parse your data
    processEvent({
      session_id: "...",
      hook_event_name: "PostToolUse",
      tool_name: "...",
      tool_input: { file_path: "..." },
    });
  });
}
```

### Custom node types

In `public/index.html`, the `nodeRadius()` and visual rendering functions use `agent.role`. Add new roles like `"reviewer"`, `"planner"`, etc. and customize their appearance.

### Gource integration

You could pipe `git log --format=...` into the events stream to overlay file changes from git alongside agent activity — giving you both "who's doing what" and "what's actually changing" in one view.

## Inspiration

- [Gource](https://gource.io/) — Software version control visualization
- [Jake Simonds on the Ralph Method](https://jakesimonds.leaflet.pub/3mejhoehqjk2y) — "We need a new IDE"
- [Geoffrey Huntley's Ralph Wiggum pattern](https://github.com/ghuntley/how-to-ralph-wiggum)
- The Nathan For You episode where 40 maids clean a house in 15 minutes

## License

MIT
