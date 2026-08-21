# wechat-claude

Control Claude Code via WeChat. Built from scratch using the ilink Bot API — no third-party dependencies beyond the MCP SDK.

## Architecture

```
WeChat User ←→ ilink Bot API ←→ Daemon (polling + routing) ←→ Inbox Files ←→ MCP Server (Claude Code)
```

- **Daemon**: Standalone Node.js process that polls WeChat for messages, handles routing commands, and writes messages to per-session inbox files. Runs independently of Claude Code.
- **MCP Server**: Lightweight tool server registered with Claude Code. Reads from its session's inbox, sends replies via ilink API. No polling.

## Setup

### 1. Install

```bash
git clone <repo-url>
cd wechat-claude
npm install
npm run build
```

### 2. Register MCP Server

```bash
claude mcp add --scope user wechat node /path/to/wechat-claude/dist/server.js
```

### 3. First Login

In any Claude Code session, ask Claude to log in to WeChat:

```
> Login to WeChat
```

Claude will generate a QR code URL. Scan it with WeChat to authenticate. The session token is saved to `~/.claude/wechat/session.json` — you won't need to scan again unless the token expires.

### 4. Daemon

The daemon starts automatically: `wechat_status` (called by `/wechat`) and a
successful login both spawn it if it isn't running. To also survive reboots,
install it as a macOS launchd service:

```bash
# Edit com.wechat-claude.daemon.plist first if your node/script paths differ
npm run daemon:install
```

Manual start still works too: `node /path/to/wechat-claude/dist/daemon.js &`.
The daemon is a singleton (pid-file guard) — extra starts exit immediately.

If the WeChat login expires, the daemon posts a macOS notification and sets a
flag that `wechat_status` surfaces, so the next `/wechat` prompts a re-login.

### 5. Enable Monitoring in a Session

Type `/wechat` in any Claude Code session. This starts a persistent watcher
(`dist/watch-inbox.js`) that reacts to new messages instantly via `fs.watch`
and maintains a heartbeat marking the session as `[monitoring]`.

## WeChat Commands

Send these from WeChat to control routing:

| Command | Description |
|---------|-------------|
| `/sessions` or `/ls` | List active Claude Code sessions (`[监控中]` = actively monitoring) |
| `/s <number> <message>` | Send message to session by list number |
| `/s <name> <message>` | Send message to session by name (fuzzy match; if ambiguous, prefers the monitored / most recently active one) |
| `/s <pid> <message>` | Send message to session by pid (duplicate names are listed as `name#pid`) |
| `/run [dir] <task>` | Start a new Claude session in tmux to run a task |
| `/help` | Show command help |
| *(no prefix)* | Send to the most recently active **monitoring** session (falls back to most recently active overall) |

Delivery feedback: if a message lands in a session that isn't monitoring its
inbox, the daemon warns you immediately; if a delivered message is still
unread after 2 minutes, it sends a reminder.

## MCP Tools

| Tool | Description |
|------|-------------|
| `wechat_login` | Generate QR code for WeChat login |
| `wechat_login_poll` | Poll QR code scan status |
| `wechat_get_messages` | Read and clear incoming messages from inbox |
| `wechat_send_text` | Send a text reply to a WeChat user |
| `wechat_set_session_name` | Set a custom name for routing |
| `wechat_status` | Check connection, daemon, and session info |
| `wechat_logout` | Disconnect and clear session |

## Session Naming

Sessions are automatically named based on the working directory:

- Git repo: `reponame:branch` (e.g., `fintary:main`)
- Worktree: `reponame/worktree-name` (e.g., `fintary/agency-bill`)
- Non-git: directory name

Use `wechat_set_session_name` to set a custom name.

## File Layout

```
~/.claude/wechat/
├── session.json          # ilink bot token (persisted login)
├── context_tokens.json   # shared context tokens (daemon ↔ MCP server)
├── daemon.pid            # daemon process ID
├── daemon.log            # daemon output
├── cursor.txt            # message polling cursor
├── expired.flag          # present when the WeChat login has expired
├── sessions/             # registered Claude Code sessions
│   └── <pid>.json
├── inbox/                # per-session message queues
│   └── <pid>.json
├── heartbeat/            # watcher heartbeats (session is [monitoring])
│   └── <pid>
└── typing/               # typing indicator state
    └── <userId>
```

## npm Scripts

```bash
npm run build              # Compile TypeScript
npm run start              # Start MCP server (used by Claude Code)
npm run daemon             # Start daemon manually
npm run daemon:install     # Install launchd service (macOS)
npm run daemon:uninstall   # Remove launchd service
npm run daemon:status      # Check launchd status
npm run daemon:log         # Tail daemon log
```

## How It Works

1. **Daemon** polls WeChat via the ilink Bot API (`getupdates` long-polling)
2. Incoming messages are parsed and routed:
   - `/sessions` commands are handled directly by the daemon
   - `/s <target> <msg>` routes to a specific session's inbox
   - Other messages go to the most recently active session
3. When a message is routed, the daemon starts a "typing" indicator on WeChat
4. **MCP Server** reads from its inbox when Claude calls `wechat_get_messages`
5. Claude processes the message and replies via `wechat_send_text`
6. The MCP server clears the typing indicator file; the daemon detects this and stops typing

## Requirements

- Node.js 20+
- Claude Code
- WeChat (iOS with ClawBot support)
