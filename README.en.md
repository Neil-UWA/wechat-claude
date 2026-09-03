[中文](README.md) | English

# wechat-claude

Control Claude Code from your phone via WeChat. Message a task like
`/run fix the login bug` and a Claude Code session runs it on your machine and
sends the result back to your chat. Built on the ilink Bot API — no
third-party dependencies beyond the MCP SDK.

> ⚠️ **This runs code on your computer from chat messages.** Read
> [SECURITY.md](SECURITY.md) before using it. Run it only on a machine you
> control and an account only you can message.

## Prerequisites

- **Node.js 20+** and **[Claude Code](https://claude.com/claude-code)**.
- **WeChat with ClawBot / ilink Bot access.** The bot is bound to *your* WeChat
  account by scanning a QR code at login; it is not publicly discoverable and
  strangers cannot message it. macOS is the first-class platform (launchd
  autostart + native notifications); Linux/Windows run the daemon manually.

## Architecture

```
WeChat User ←→ ilink Bot API ←→ Daemon (polling + routing) ←→ Inbox Files ←→ MCP Server (Claude Code)
```

- **Daemon**: Standalone Node.js process that polls WeChat for messages, handles routing commands, and writes messages to per-session inbox files. Runs independently of Claude Code.
- **MCP Server**: Lightweight tool server registered with Claude Code. Reads from its session's inbox, sends replies via ilink API. No polling.

## Setup

```bash
npm install -g wechat-claude-sessions
wechat-claude setup
```

Install it **globally**, not with a bare `npx` — `setup` registers absolute
paths (MCP server, launchd service) that must survive past the current shell,
and npx's cache is not a stable location. Building from a git checkout works
too: see [CONTRIBUTING.md](CONTRIBUTING.md).

`setup` registers the MCP server, installs the `/wechat` slash command into
`~/.claude/commands/`, and walks you through QR login (it opens the QR image in
your browser — scan it with WeChat). The bot token is saved to
`~/.claude/wechat/session.json` (mode 0600); you won't scan again unless it
expires.

Then start the daemon and enable monitoring:

```bash
wechat-claude daemon install   # macOS: install as a launchd service (auto-start + restart)
# or, without autostart:
wechat-claude daemon           # run it in the foreground / your own supervisor
```

Finally, type `/wechat` in any Claude Code session. That starts a persistent
watcher (`dist/watch-inbox.js`) that reacts to messages instantly via
`fs.watch` and marks the session `[monitoring]`. The daemon also auto-starts on
`/wechat` and after a successful login if it isn't already running (it's a
singleton, guarded by a pid file).

`wechat-claude daemon install` generates the launchd plist for *your* paths
from a packaged template and writes it to
`~/Library/LaunchAgents/com.wechat-claude.daemon.plist` — no manual editing.
Re-run it after a Node version switch or a global upgrade to refresh the paths.
Other CLI commands: `wechat-claude login` (re-auth) and `wechat-claude status`.

If the WeChat login expires, the daemon posts a macOS notification and sets a
flag that `wechat_status` surfaces, so the next `/wechat` prompts a re-login —
see [Troubleshooting](#troubleshooting) since you'll be away from the Mac.

## WeChat Commands

Send these from WeChat to control routing:

| Command | Description |
|---------|-------------|
| `/sessions` or `/ls` | List active Claude Code sessions (`[监控中]` = actively monitoring). Ends with the running wechat-claude version and, when npm has a newer `latest`, an upgrade notice (npm is asked at most every 6 hours; the last answer is reused if it can't be reached) |
| `/s <number> <message>` | Send message to session by its number. Numbers are stable for a session's lifetime — they never shift when other sessions open or close (retired numbers aren't reused; numbering resets once all sessions are gone) |
| `/use <number\|name\|pid>` | Bind your chat to one session: every plain message goes straight to it (survives daemon restarts). `/use off` unbinds; `/use` shows the current binding. Closing the bound session clears the binding automatically |
| `/s <name> <message>` | Send message to session by name (fuzzy match; if ambiguous, prefers the monitored / most recently active one) |
| `/s <pid> <message>` | Send message to session by pid (duplicate names are listed as `name#pid`) |
| `/run [--safe] [dir] <task>` | Start a new Claude session in tmux to run a task. The launched session is instructed to send its result back to WeChat. Runs unattended by default (`--dangerously-skip-permissions`); pass `--safe` for `--permission-mode acceptEdits`, where bash commands wait for confirmation at the computer. The first unattended run accepts skip-permissions mode in `~/.claude.json` on your behalf — a detached session cannot answer Claude Code's one-time dialog — and says so in its reply; see [SECURITY.md](SECURITY.md) |
| `/runs` | List running `/run` task sessions |
| `/stop <name>` | Kill a `/run` task session (names start with `wc-`) |
| `/close <number\|name\|pid>` | Close a Claude session remotely — terminates its Claude process (and MCP server) and removes it from the list. Unsaved work in that session is lost. If a name matches several sessions it lists them instead of guessing; `/close <name> all` closes all matches, `/close idle` cleans up every unmonitored session idle for 2+ hours. Every close reply ends with a remaining-session summary |
| `/usage` | Check whether Claude's usage limit is what's blocking replies. Runs one tiny headless probe (Haiku by default — see below) |
| `/help` | Show command help |
| *(no prefix)* | Send to the most recently active **monitoring** session (falls back to most recently active overall) |

Delivery feedback: if a message lands in a session that isn't monitoring its
inbox, the daemon warns you immediately; if a delivered message is still
unread after 2 minutes, it sends a reminder.

### Usage limits (when every session goes quiet)

When the Claude account hits its usage limit, **every** session goes silent at
once: model calls are rejected, so nothing is read and nothing is answered —
from WeChat that is indistinguishable from a dead daemon. So the daemon works
it out itself:

1. A delivered message with no reply for 90 seconds, **and** a target session
   whose *own* transcript (`~/.claude/projects/….jsonl` — the MCP server records
   the exact path, so a busy neighbour sharing the directory can't mask it)
   hasn't been written for 60 seconds — i.e. it isn't busy, it is stuck —
   triggers one headless probe (`claude -p ok`, with no MCP servers loaded).
2. If the probe confirms a usage limit, the daemon says so on WeChat with the
   expected reset time, and suppresses the misleading "that session may not be
   monitoring" reminder. Messages you send meanwhile are still delivered, with
   a note attached.
3. When the limit lifts, the daemon sends a recovery message and gets the
   unanswered work moving: messages still in an inbox only need their watcher
   poked (the original announcement is long gone and never repeats); messages
   Claude *read* but never got to answer are put back in the inbox first, since
   there is nothing left to announce. Only deliveries with no reply are
   replayed, so nothing is handled twice.

Probes cost a little quota, so: only one runs at a time; at most one every 5
minutes while things look healthy; once a limit is confirmed probes are free
(the request is rejected outright), and a known reset time is waited out.

Optional config (`~/.claude/wechat/config.json`):

```json
{ "probeModel": "claude-haiku-4-5-20251001", "claudeBin": "~/.local/bin/claude" }
```

- `probeModel` — model used for the probe. Haiku by default: cheap, and
  subscription limits are account-wide, so it is rejected by the same limit.
  Set `"default"` to probe with your own default model — needed if the limit you
  care about is an Opus-only weekly cap.
- `claudeBin` — path to the `claude` executable, only needed when launchd's
  minimal PATH can't find it (`~/.local/bin`, `~/.claude/local`, Homebrew and
  `/usr/local/bin` are tried).

Incoming images are downloaded and decrypted automatically to
`~/.claude/wechat/media/` (cleaned up after 7 days); the routed message text
contains the local path (`[图片: /path/to/file.png]`) so the receiving Claude
session can open the file directly.

### /run directory resolution

`/run <name> <task>` resolves `<name>` in this order:

1. An active session whose name (or directory basename) matches
2. An absolute path
3. `<dir>/<name>` for each search directory — the `repoDirs` entries in
   `~/.claude/wechat/config.json` (optional, e.g. `{"repoDirs": ["~/code"]}`;
   entries must be absolute or `~`-prefixed, invalid entries are reported)
   plus the parent directory of every active session's cwd (the home
   directory itself is never used as a search root)

If the first word looks like a directory name but resolves nowhere, the run
is cancelled with an explanation instead of silently executing in another
directory. Use `/run . <task>` to force the default directory when the task
text happens to start with a path-like word.

## MCP Tools

| Tool | Description |
|------|-------------|
| `wechat_login` | Generate QR code for WeChat login |
| `wechat_login_poll` | Poll QR code scan status |
| `wechat_get_messages` | Read and clear incoming messages from inbox |
| `wechat_send_text` | Send a text reply to a WeChat user |
| `wechat_send_image` | Send an image file (with optional caption) to a WeChat user |
| `wechat_set_session_name` | Set a custom name for routing |
| `wechat_status` | Check connection, daemon, and session info |
| `wechat_logout` | Disconnect and clear session |

## Session Naming

Sessions are automatically named based on the working directory:

- Git repo: `reponame:branch` (e.g., `myapp:main`)
- Worktree: `reponame/worktree-name` (e.g., `myapp/feature-x`)
- Non-git: directory name

To pick a name, pass it when you start monitoring: `/wechat integration`.
That names the session and starts the watcher in one go; running it again on
a session that already has that name is a no-op. You can also call
`wechat_set_session_name` on its own at any time. A name must be a single word
without whitespace (`/s <name> <msg>` reads one word), must not be purely
numeric (it would be read as a session number or pid), and must not collide
with another live session — a collision is refused with the holder's pid
rather than silently suffixed.

**Two namespaces — don't mix them up.** The names above are **WeChat routing
names**, used only in `/s <name> <msg>`. Claude Code gives every session its
own, separate name (e.g. `myapp-a9`), which is what other Claude sessions must
pass to `SendMessage` (see `ListAgents`). `wechat_status` lists both side by
side in `Active sessions` (the `SendMessage: ...` column), and `/s` accepts the
Claude Code name as an alias, so whichever name you saw will route.

That also makes **relaying** possible: a plain message lands in the default or
bound session, but you may mean another one ("tell integration to run the
tests"). The receiving session works out the target from the `Active sessions`
list (routing name, `SendMessage:` name, or working directory), forwards it
with `SendMessage`, tells you on WeChat which session it went to and how to
`/s` it directly next time, and relays the reply back.

## File Layout

```
~/.claude/wechat/
├── session.json          # ilink bot token (persisted login)
├── config.json           # optional settings (e.g. repoDirs for /run)
├── bindings.json         # /use bindings (WeChat user -> session)
├── session-numbers.json  # stable session number registry
├── media/                # downloaded incoming images (7-day retention)
├── context_tokens.json   # shared context tokens (daemon ↔ MCP server)
├── daemon.pid            # daemon process ID
├── daemon.log            # daemon output
├── cursor.txt            # message polling cursor
├── expired.flag          # present when the WeChat login has expired
├── usage-limit.json      # known Claude usage-limit state (incl. notified users)
├── update-check.json     # last `latest` version seen on npm (for the /ls upgrade notice)
├── replies/              # last time each session replied to each WeChat user
│   └── <pid>--<userId>
├── nudge/                # signal to re-announce a backlog (after a limit lifts)
│   └── <pid>
├── sessions/             # registered Claude Code sessions
│   └── <pid>.json
├── inbox/                # per-session message queues
│   └── <pid>.json
├── heartbeat/            # watcher heartbeats (session is [monitoring])
│   └── <pid>
└── typing/               # typing indicator state
    └── <userId>
```

## CLI

```bash
wechat-claude setup              # Register MCP server + /wechat command, then log in
wechat-claude login              # (Re)authenticate by scanning a QR code
wechat-claude status             # Show login / daemon / service state
wechat-claude daemon             # Run the daemon in the foreground
wechat-claude daemon restart     # Restart it (use after upgrading)
wechat-claude daemon install     # Install as a launchd service (macOS)
wechat-claude daemon uninstall   # Remove the launchd service
wechat-claude daemon status      # Check daemon / service state
wechat-claude daemon log         # Tail the daemon log
```

In a git checkout the same commands are available as npm scripts
(`npm run daemon:install`, …), which just delegate to the CLI.

### Upgrading

```bash
npm install -g wechat-claude-sessions@latest
wechat-claude daemon restart
```

Both long-lived processes keep the old code in memory until they are replaced.
`daemon restart` handles the daemon (reloading the launchd job when one is
installed, otherwise stopping and respawning it). The MCP server belongs to
Claude Code, so reconnect it there — `/mcp` → `wechat` → Reconnect — and run
`/wechat` again to re-attach the inbox watcher, which is bound to the old
server's pid.

## How It Works

1. **Daemon** polls WeChat via the ilink Bot API (`getupdates` long-polling)
2. Incoming messages are parsed and routed:
   - Commands like `/sessions`, `/run`, `/close`, `/use` are handled by the daemon
   - `/s <target> <msg>` routes to a specific session's inbox
   - A plain message goes to your bound session (`/use`), else the most
     recently active session that is `[monitoring]`
3. When a message is routed, the daemon starts a "typing" indicator on WeChat
4. **MCP Server** reads from its inbox when Claude calls `wechat_get_messages`
5. Claude processes the message and replies via `wechat_send_text`
6. The MCP server clears the typing indicator file; the daemon detects this and stops typing
7. If a message goes unread *and* unanswered for too long, the daemon checks
   whether Claude's usage limit is the cause and explains it on WeChat (see
   [Usage limits](#usage-limits-when-every-session-goes-quiet))

## Reply footer

Every reply a session sends to WeChat (`wechat_send_text`, and the caption of
`wechat_send_image`) ends with one line saying which session is speaking and
how to answer it directly:

```
—— from naming (#4) · reply directly: /s 4 <message>
```

The number is the stable one from `/ls`, fixed for the session's lifetime. When
several sessions answer into the same chat you no longer have to `/ls` and guess
who said what. To turn it off, add `"replyFooter": false` to
`~/.claude/wechat/config.json`.

## Language

Bot replies default to Chinese (the WeChat audience). To switch to English, set
`lang` in `~/.claude/wechat/config.json`:

```json
{ "lang": "en" }
```

All user-facing strings live in `src/i18n.ts` (`zh` + `en`); the `WECHAT_LANG`
environment variable overrides the config value.

## Security

wechat-claude executes code on your machine in response to chat messages. Read
[SECURITY.md](SECURITY.md) for the full threat model. In short:

- Only the account that scanned the login QR can message the bot; it is not
  publicly discoverable and (currently) cannot be added to group chats.
- `/run` runs unattended by default (`--dangerously-skip-permissions`); use
  `/run --safe <task>` to require confirmation for bash commands.
- The bot token lives in `~/.claude/wechat/session.json` (0600); the whole
  data directory is 0700. Run only on a machine you control.

## Troubleshooting

- **The bot stopped replying.** The WeChat login likely expired — the daemon
  exits on expiry and can no longer send messages. Back at the Mac, run
  `wechat-claude status`; if logged out, `wechat-claude login` (or
  `/wechat` in a session) to re-scan. Restart the daemon if needed.
- **`/run` says "找不到目录".** The name didn't resolve to a project; add its
  parent to `repoDirs` in `~/.claude/wechat/config.json`, pass an absolute
  path, or use `/run . <task>` to run in the default directory.
- **A message got no response.** Check `wechat-claude daemon status` and
  `wechat-claude daemon log`. If the target session isn't `[monitoring]`, run
  `/wechat` in it or bind with `/use <n>`.
- **`daemon install` did nothing on Linux/Windows.** launchd is macOS-only;
  run the daemon under your own supervisor (`wechat-claude daemon`, systemd,
  pm2…).

## Uninstall

```bash
wechat-claude daemon uninstall  # remove the launchd service (macOS)
claude mcp remove wechat        # unregister the MCP server
rm ~/.claude/commands/wechat.md # remove the slash command
rm -rf ~/.claude/wechat         # remove tokens, inboxes, media, config
npm uninstall -g wechat-claude-sessions
```

## Requirements

- Node.js 20+
- Claude Code
- WeChat with ClawBot / ilink Bot access
- macOS for launchd autostart and native notifications; Linux/Windows work
  with a manually supervised daemon
