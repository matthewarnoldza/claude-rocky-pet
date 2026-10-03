#!/bin/bash
# Claude Code hook -> appends one JSON line per hook event to a log.
# Wire it to every event to see what actually fires in a given surface
# (terminal CLI vs the VS Code extension) before trusting any of them.
#
# Designed to NEVER block or fail Claude Code: prints nothing, always exits 0.

LOG_DIR="$HOME/.doomy"
LOG_FILE="$LOG_DIR/hook-events.log"

PAYLOAD=$(cat 2>/dev/null)
mkdir -p "$LOG_DIR" 2>/dev/null

if command -v jq >/dev/null 2>&1; then
  printf '%s' "$PAYLOAD" | jq -c --arg ts "$(date '+%Y-%m-%dT%H:%M:%S')" '{
    ts: $ts,
    hook_event_name,
    session_id,
    cwd,
    notification_type,
    tool_name,
    permission_mode,
    transcript_path
  } | with_entries(select(.value != null))' >> "$LOG_FILE" 2>/dev/null
fi

exit 0
