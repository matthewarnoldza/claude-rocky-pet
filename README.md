# Doomy

A small character that lives in the black bar around your MacBook's camera
notch and keeps an eye on your Claude Code sessions. Collapsed, it is the
character on one side of the camera and a count of sessions on the other. It
drops open to tell you — in its own voice — when a session finishes or needs
you, and on hover it lists every session and alert; click one to jump to that
folder's VS Code window.

Forked from [pitahorn/claude-rocky-pet](https://github.com/pitahorn/claude-rocky-pet),
a floating desktop pet, and rebuilt around the notch and the VS Code extension.

| Trigger | Reaction |
|---|---|
| nothing running | asleep in the bar |
| a session is working | working pose; a grey count |
| a session needs input | opens, says so, raised-arm pose; an amber count that pulses |
| left waiting 5 minutes | worried pose, a reminder every 5 minutes |
| a session finishes | opens, celebrates, comments on what was done |
| an alert appears in `alerts.json` | opens with a heads-up |
| hover | opens the full list, says a hover line |
| click the character | "what's outstanding?" — a one-line summary of everything it is watching |
| click a row | raises that folder's VS Code window and that session's Claude tab |
| a repo has loose ends | rows for files not committed, commits not pushed, commits not deployed, migrations not applied |
| 18:30 → 06:00 while you are still working | tells you to go home every 10 minutes |

Requires **macOS**, Node 18+, and `img2webp` (`brew install webp`) to build
character art.

## Quick start

```sh
npm install
npm start
```

Started from a VS Code terminal, use `env -u ELECTRON_RUN_AS_NODE npm start`:
VS Code sets a variable that makes Electron run as plain Node.

### Run it at login (macOS)

```sh
sed "s|__PET_DIR__|$PWD|g" install/com.doomy.plist.template \
  > ~/Library/LaunchAgents/com.doomy.plist
launchctl load -w ~/Library/LaunchAgents/com.doomy.plist
```

`RunAtLoad` with no `KeepAlive`, so **Quit** (in the open island) really quits
for the session and the pet comes back at the next login. Logs land in
`/tmp/doomy.{out,err}.log`.

```sh
launchctl kickstart -k gui/$(id -u)/com.doomy   # restart after editing code
launchctl unload ~/Library/LaunchAgents/com.doomy.plist   # disable
```

## Poke it

```sh
bin/doomy ping|yay|dance|greet|nag
bin/doomy character [id]        # switch character, or cycle to the next
bin/doomy deployed [dir]        # this repo is deployed at its current commit
bin/doomy applied [dir]         # this repo's migrations are all applied
bin/doomy alert <id> <text> [cwd] [info|warn]
bin/doomy unalert <id>
```

## Wire it to Claude Code

Add to `~/.claude/settings.json` (adjust the path). This works in the VS Code
extension as well as the terminal CLI:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "async": true,
      "command": "$HOME/doomy/hooks/doomy-state.sh idle" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "async": true,
      "command": "$HOME/doomy/hooks/doomy-state.sh working" }] }],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "async": true,
        "command": "$HOME/doomy/hooks/doomy-state.sh working" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "async": true,
        "command": "$HOME/doomy/hooks/doomy-track.sh" }] }
    ],
    "PreToolUse": [{ "matcher": "AskUserQuestion|ExitPlanMode", "hooks": [{ "type": "command", "async": true,
      "command": "$HOME/doomy/hooks/doomy-state.sh waiting" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "async": true,
      "command": "$HOME/doomy/hooks/doomy-state.sh waiting" }] }],
    "Elicitation": [{ "hooks": [{ "type": "command", "async": true,
      "command": "$HOME/doomy/hooks/doomy-state.sh waiting" }] }],
    "ElicitationResult": [{ "hooks": [{ "type": "command", "async": true,
      "command": "$HOME/doomy/hooks/doomy-state.sh working" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "async": true,
      "command": "$HOME/doomy/hooks/doomy-state.sh notify" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "async": true,
      "command": "$HOME/doomy/hooks/doomy-state.sh done" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "async": true,
      "command": "$HOME/doomy/hooks/doomy-state.sh ended" }] }]
  }
}
```

`doomy-state.sh` prints nothing and always exits 0, so it can never block or fail
a Claude turn. Each call rewrites `~/.doomy/sessions/<session_id>.json` with
that session's state; the pet shows one row per file. Sessions are identified
by `session_id` and labelled by the folder they were opened in — a session's
`cwd` follows its shell around, so the first one seen is the one that is kept.
Clicking a row runs `code <folder>`, which brings that folder's VS Code window
to the front, then opens `vscode://anthropic.claude-code/open?session=<id>` —
the Claude Code extension's own link — to select that session's tab. Each row
also shows Claude's title for the session, so two tabs in one folder read
differently.

`notify` only counts `permission_prompt` and `elicitation_dialog` notifications
as "needs you"; every other notification type is ignored.

### Transcript fallback

Hooks can miss — a session started before they were installed, a surface that
does not fire one. So the pet also tails the session transcripts in
`~/.claude/projects/*/*.jsonl` every 5 seconds and infers a state from the last
message: a finished reply is **Done**, a tool call with no result for 90 seconds
is **May need you** (a guess: a slow build looks the same as a permission
prompt), anything recent is **Working**. A hook state is trusted unless it is
more than two minutes older than the transcript. The thresholds are named
constants at the top of `sessions.js`.

### Alerts: a state file any script can write

`~/.doomy/alerts.json` is for everything the hooks cannot know — commits not
deployed, migrations not applied, a failing CI run. The pet shows one row per
entry for as long as the entry is in the file, and re-reads it on every change.

```json
{
  "alerts": [
    {
      "id": "social-migrations",
      "text": "2 migrations not applied",
      "cwd": "/Users/you/code/social-app",
      "label": "social-app",
      "level": "warn"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | unique key; writing the same `id` again replaces the alert |
| `text` | yes | what the pill says after the label |
| `cwd` | no | absolute folder; clicking the pill focuses its VS Code window |
| `label` | no | pill prefix; defaults to the folder name of `cwd`, then to `id` |
| `level` | no | `info` (purple, default) or `warn` (amber) |

Write the file atomically (temp file + rename), or let the CLI do it:

```sh
bin/doomy alert social-migrations "2 migrations not applied" ~/code/social-app warn
bin/doomy unalert social-migrations
```

### Project checks

For every folder with a live session the pet looks at the repo once a minute
(`checks.js`) and adds a row for each loose end:

| Row | How it knows | Level |
|---|---|---|
| files not committed | `git status` | info, shown once no session is working there |
| commits not pushed | commits ahead of the upstream branch | info, likewise |
| commits not deployed | commits since the one recorded at the last production deploy | warn, spoken |
| migrations not applied | files in `supabase/migrations` added since migrations were last applied | warn, spoken |

No hosting account is involved. The last two compare against
`~/.doomy/projects.json`, which is updated three ways:

- `hooks/doomy-track.sh` sees a session run `vercel --prod` or
  `supabase db push` / `supabase migration up` and records it;
- `bin/doomy deployed [dir]` and `bin/doomy applied [dir]` record it by hand;
- the **✓** on a row in the island marks it done.

A repo with no recorded deploy shows no "not deployed" row, and the first time
the pet sees a repo it assumes the migrations already there are applied.

### Quiet controls

**Mute** in the open island stops the pet opening by itself; the counts keep
updating and hover still works. To silence one kind of event, add to
`settings.json`:

```json
"autoOpen": { "done": false, "sessionStarted": false }
```

Kinds: `done`, `waiting`, `alert`, `sessionStarted`, `reminder`, `longRunning`,
`nag`.

### Sounds

Drop `waiting.mp3` and/or `done.mp3` (or `.wav`, `.aiff`) into
`characters/<id>/sounds/` and the pet plays them on those events. None ship by
default. Muting silences them too.

### Giving it a voice

Everything the pet says comes from the active character's `character.json`:

| Pool in `phrases` | Said when | Placeholders |
|---|---|---|
| `done` | a session finishes its turn | `{folder}` |
| `allDone` | the last busy session finishes | `{folder}` |
| `waiting` | a session needs input | `{folder}` |
| `waitingGuess` | the transcript fallback thinks a session may need input | `{folder}` |
| `stillWaiting` | one session has been left waiting 5 minutes (and every 5 after) | `{folder}` `{minutes}` |
| `manyWaiting` | the same, with several waiting; `{folder}` is the longest-waiting | `{count}` `{folder}` `{minutes}` |
| `alert` | a new alert appears in `alerts.json` | `{label}` `{text}` |
| `sessionStarted` | a new session starts working | `{folder}` |
| `longRunning` | a session has worked 20 minutes without stopping | `{folder}` `{minutes}` |
| `hover`, `greetings`, `nags`, `yay`, `dance`, `ping` | hover / `doomy greet` / after hours / the matching CLI action | — |

`{owner}` and `{name}` work in every pool. A line is picked at random, never the
same one twice running; a missing pool means the pet stays quiet for that event.
Lines are re-read from the file each time, so edits apply at once.

**Model-written lines.** With an [OpenRouter](https://openrouter.ai) key, `done`
and `waiting` events get a line written for the occasion instead: the pet sends
the model your `persona`, a sample of your phrases as a guide to the voice, and
the last thing Claude said in that session (up to 1,500 characters), and asks
for one line. It shows `…` while it waits and falls back to the phrase pool if
the model fails or takes longer than `ai.timeoutMs`. Put the key in
`~/.doomy/config.json`, outside the repo:

```sh
echo '{ "openrouterApiKey": "sk-or-..." }' > ~/.doomy/config.json
chmod 600 ~/.doomy/config.json
```

The `ai` block in `settings.json` sets `enabled`, `model`, `timeoutMs`,
`maxChars` and `baseUrl` — any OpenAI-compatible
chat-completions endpoint works. No key, or `"enabled": false`, means phrase
pools only.

### Seeing which hooks fire

`hooks/debug-log.sh` appends one JSON line per event (`hook_event_name`,
`session_id`, `cwd`) to `~/.doomy/hook-events.log`. Wire it to any event the
same way to check what a given surface really fires.

### Skills

`skills/` holds two Claude Code skills for driving the pet from a session —
`/wake-doomy` (restart it after the × button) and `/doomy-celebrate` (make it
dance when something lands). Install them by copying or symlinking:

```sh
ln -s "$PWD/skills/wake-doomy" ~/.claude/skills/wake-doomy
ln -s "$PWD/skills/doomy-celebrate" ~/.claude/skills/doomy-celebrate
```

## Characters

Each character is a folder in `characters/`:

```
characters/doomy/
  character.json     name, accent colour, persona, phrase pools
  full/NN_state.webp the large animations, shown when the island is open
  mini/NN_state.webp simplified small ones for the bar (falls back to full/)
```

Switch with `bin/doomy character <id>`, or the `Name ⇄` button in the open
island (shown when there is more than one). The choice is remembered in
`~/.doomy/prefs.json`; `settings.json` names the default.

**States** (the file name after its number): `idle_base`, `small_celebration`,
`big_celebration`, `needs_you`, `worried_impatient`, `working_watching`,
`thinking`, `talking`, `sleepy_asleep`, `waking_up`, `alert_heads_up`,
`go_home`. A missing state falls back to `idle_base`.

**Adding one.** Art arrives as PNG frame sequences on a square canvas with the
character's base 13.3% up from the bottom edge (y=444 of 512):

```sh
scripts/build-character.sh path/to/art-pack jarling   # frames -> characters/jarling/*.webp
```

then add `characters/jarling/character.json`. The island is black, so a dark
character needs a rim light; the renderer adds a thin glow in the character's
`accent` colour as a safety net.

`settings.json` holds what is not per-character: `owner` (the name the pet
uses for you), `character` (the default), `notchWidth` (190 suits a 14-inch
MacBook Pro; Electron cannot measure it) and the `ai` block.

## How it works

```
CLI ─────────writes──▶ ~/.doomy/signal.json {action, ts} ──────┐
Claude hooks ─writes──▶ ~/.doomy/sessions/<session_id>.json ───┤ fs.watch
your scripts ─write───▶ ~/.doomy/alerts.json ──────────────────┤ (+ poll)
Claude Code ──writes──▶ ~/.claude/projects/*/*.jsonl (fallback) ───┘
                                     ▼
                        Electron main (main.js) ──IPC──▶ renderer
                                     ▼
                  a transparent window over the menu bar draws the island
```

| File | Owns |
|---|---|
| `main.js` | the window, where it sits, when the pet speaks, VS Code focus |
| `sessions.js` | per-session state: hook files, transcript fallback, alerts → pills |
| `checks.js` | project checks: uncommitted, unpushed, undeployed, unapplied |
| `speech.js` | characters, phrase pools and model-written lines |
| `preload.js` | the only main↔renderer bridge (`contextIsolation: true`) |
| `renderer/island.*` | the island: bar, speech, session rows, poses |
| `characters/` | one folder per character |
| `settings.json` | owner, default character, notch width, model settings |
| `bin/doomy` | the CLI |
| `hooks/doomy-state.sh` | Claude Code hook → per-session state file |
| `hooks/doomy-track.sh` | Claude Code hook → records deploys and migration runs |
| `hooks/debug-log.sh` | Claude Code hook → log of every event that fires |
| `scripts/build-character.sh` | PNG frames → animated WebP |

State lives in `~/.doomy/`: `signal.json` (the CLI inbox), `sessions/` (one
file per Claude session), `alerts.json` (extra alerts), `projects.json` (last
deploy and applied migrations per repo), `prefs.json` (the chosen character,
mute), `config.json` (the API key).

## Things that will bite you

1. **The window never resizes.** It is a fixed transparent sheet large enough
   for the open island; the island animates inside it. Resizing a window under
   the pointer makes hover flicker.
2. **Clicks pass through the sheet.** `setIgnoreMouseEvents(true, { forward:
   true })` is on except while the pointer is over the island, so the menu bar
   and whatever is beneath stay clickable. If the island ever swallows clicks it
   should not, look at the `mouseenter` / `mouseleave` pair in `island.js`.
3. **The window level is `screen-saver`.** Anything lower sits under the menu
   bar.
4. **`ts` in the signal file must strictly increase** (`Date.now()`), and the
   app records the last `ts` at boot — otherwise every restart replays whatever
   action was last sent.
5. **An animated image only replays from frame 0 if its `src` changes**, hence
   the cache-busting query string on one-shot poses.
6. **`ELECTRON_RUN_AS_NODE`** is set inside VS Code terminals and makes
   `require("electron")` return a path instead of the API. Unset it to launch.

## License

GPL-3.0 — see [LICENSE](LICENSE). The character art in `characters/` and
`assets/` is not covered by that licence; it belongs to its author.
