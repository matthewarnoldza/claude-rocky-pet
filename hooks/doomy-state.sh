#!/bin/bash
# Claude Code hook -> records this session's state for the floating pet.
# Usage: doomy-state.sh <idle|working|waiting|done|notify|ended>
#
# Writes ~/.doomy/sessions/<session_id>.json; the pet watches that folder
# and shows one pill per session. One file per session, replaced atomically, so
# several sessions firing at once never clobber each other.
#
# Designed to NEVER block or fail Claude Code: prints nothing, always exits 0,
# even if jq isn't found.

STATE="${1:-working}"
SESSIONS_DIR="$HOME/.doomy/sessions"

PAYLOAD=$(cat 2>/dev/null)
command -v jq >/dev/null 2>&1 || exit 0

field() {
  printf '%s' "$PAYLOAD" | jq -r "$1 // empty" 2>/dev/null
}

SESSION_ID=$(field '.session_id')
[ -z "$SESSION_ID" ] && exit 0
# The id becomes a filename — refuse anything that isn't a plain token.
case "$SESSION_ID" in
  *[!A-Za-z0-9_-]*) exit 0 ;;
esac
FILE="$SESSIONS_DIR/$SESSION_ID.json"

if [ "$STATE" = "ended" ]; then
  rm -f "$FILE" 2>/dev/null
  exit 0
fi

# Notification covers many things; only a prompt the session is blocked on
# counts as "needs you". idle_prompt arrives after Stop, so "done" already
# covers it.
if [ "$STATE" = "notify" ]; then
  case "$(field '.notification_type')" in
    permission_prompt | elicitation_dialog) STATE="waiting" ;;
    *) exit 0 ;;
  esac
fi

# cwd follows the session's shell around, so the FIRST one seen is the folder
# the session was opened in — keep it as the stable label + focus target.
CWD=""
[ -f "$FILE" ] && CWD=$(jq -r '.cwd // empty' "$FILE" 2>/dev/null)
CWD="${CWD:-$(field '.cwd')}"
CWD="${CWD:-$PWD}"

mkdir -p "$SESSIONS_DIR" 2>/dev/null
TMP="$FILE.$$.tmp"
jq -n \
  --arg session_id "$SESSION_ID" \
  --arg cwd "$CWD" \
  --arg state "$STATE" \
  --arg event "$(field '.hook_event_name')" \
  --arg permission_mode "$(field '.permission_mode')" \
  --arg transcript_path "$(field '.transcript_path')" \
  --argjson ts "$(date +%s)000" \
  '{session_id: $session_id, cwd: $cwd, state: $state, ts: $ts, event: $event,
    permission_mode: $permission_mode, transcript_path: $transcript_path}' \
  > "$TMP" 2>/dev/null && mv -f "$TMP" "$FILE" 2>/dev/null
rm -f "$TMP" 2>/dev/null

exit 0
