#!/bin/bash
# Claude Code hook (PostToolUse, matcher "Bash") -> notices when a session
# deploys to production or applies migrations, and records it for the pet's
# "not deployed" / "not applied" checks (see checks.js).
#
# Runs after every Bash command, so it bails out with a cheap pattern match
# first. Prints nothing and always exits 0.

PAYLOAD=$(cat 2>/dev/null)
command -v jq >/dev/null 2>&1 || exit 0
COMMAND=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)

ACTION=""
# `vercel --prod`, `vercel deploy --prod`, `vc --prod …`
if printf '%s' "$COMMAND" | grep -Eq '(^|[^[:alnum:]_/-])(vercel|vc)([[:space:]][^;&|]*)?[[:space:]]--prod([[:space:]]|$)'; then
  ACTION="deployed"
# `supabase db push`, `supabase migration up`
elif printf '%s' "$COMMAND" | grep -Eq 'supabase[[:space:]]+(db[[:space:]]+push|migration[[:space:]]+up)'; then
  ACTION="applied"
fi
[ -z "$ACTION" ] && exit 0

CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)
DOOMY_BIN="$(cd "$(dirname "$0")/.." && pwd)/bin/doomy"
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  # nvm installs don't export node onto the hook's PATH — grab the newest.
  NODE_BIN="$(ls -t "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)"
fi
[ -n "$NODE_BIN" ] && "$NODE_BIN" "$DOOMY_BIN" "$ACTION" "${CWD:-$PWD}" >/dev/null 2>&1

exit 0
