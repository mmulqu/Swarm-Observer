#!/usr/bin/env bash
#
# log-event.sh — Hook dispatcher for Swarm Observer
#
# Called by Claude Code hooks. Receives event JSON via stdin,
# enriches it with session ID and timestamp, appends to events.jsonl.
#
# Usage (in hooks config):
#   "command": "~/.claude/swarm-viz/log-event.sh <event_type>"
#
# Event types: pre_tool, post_tool, session_start, stop, subagent_stop, task_done

set -euo pipefail

EVENT_TYPE="${1:-unknown}"
EVENTS_DIR="$HOME/.claude/swarm-viz"
EVENTS_FILE="$EVENTS_DIR/events.jsonl"

# Ensure output directory exists
mkdir -p "$EVENTS_DIR"

# Read hook JSON from stdin
HOOK_JSON=$(cat)

# If jq is available, use it for proper JSON merging
if command -v jq &>/dev/null; then
  echo "$HOOK_JSON" | jq -c \
    --arg event "$EVENT_TYPE" \
    --arg session "${CLAUDE_SESSION_ID:-unknown}" \
    --arg ts "$(date +%s%3N)" \
    '. + {event: $event, session_id: $session, ts: ($ts | tonumber)}' \
    >> "$EVENTS_FILE" 2>/dev/null || true
else
  # Fallback: extract key fields with basic text processing
  TOOL_NAME=$(echo "$HOOK_JSON" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*: *"//;s/"//' || echo "")
  FILE_PATH=$(echo "$HOOK_JSON" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*: *"//;s/"//' || echo "")
  CWD=$(echo "$HOOK_JSON" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*: *"//;s/"//' || echo "")

  # Write minimal event record
  echo "{\"event\":\"$EVENT_TYPE\",\"session_id\":\"${CLAUDE_SESSION_ID:-unknown}\",\"tool_name\":\"$TOOL_NAME\",\"tool_input\":{\"file_path\":\"$FILE_PATH\"},\"cwd\":\"$CWD\",\"ts\":$(date +%s%3N)}" \
    >> "$EVENTS_FILE"
fi

# Exit 0 so we never block Claude Code
exit 0
