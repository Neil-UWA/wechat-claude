---
description: Start WeChat message monitoring for this session, optionally naming it
argument-hint: [session-name]
---

Start WeChat message monitoring for this session. Optional argument: a WeChat routing name for this session (`/wechat integration`). Argument given: `$ARGUMENTS`

1. Call `wechat_status`. It auto-starts the daemon when needed (if logged in), and its output includes this session's id and the exact watcher command to use in step 6.
2. If an argument was given above (non-empty, not the literal `$ARGUMENTS`), call `wechat_set_session_name` with it now. The tool is idempotent — a session that already has that name is a no-op. If it returns an error (whitespace, purely numeric, or the name is held by another live session, whose pid it reports), tell the user and continue with the current name; do NOT pick a different name on your own.
3. If not logged in — or the status says the login has EXPIRED — call `wechat_login`, show the QR code URL to the user, then poll with `wechat_login_poll` until confirmed. Login success also auto-starts the daemon.
4. If the status says the daemon could not be started, tell the user to check `~/.claude/wechat/daemon.log`.
5. Call `wechat_get_messages` once to process any pending messages.
6. Start a persistent Monitor with the watcher command from the `wechat_status` output:

   The command is printed verbatim by `wechat_status` — copy it from there
   rather than composing it; the install path differs per machine. It looks
   like `node /path/to/wechat-claude-sessions/dist/watch-inbox.js <session id>`.

   Use `persistent: true`. The watcher is event-driven (`fs.watch` on the inbox), prints one line per new delivery, and maintains the heartbeat file that marks this session as `[monitoring]` — the daemon prefers monitored sessions when routing messages without a `/s` prefix.
7. When the Monitor emits an event:
   - Call `wechat_get_messages` to read and clear the inbox
   - Process the message content (answer questions, execute tasks, etc.)
   - Reply via `wechat_send_text` with the result; use `wechat_send_image` for images
8. Confirm to the user that WeChat monitoring is active, echoing this session's actual WeChat routing name (the `Session:` line — it may differ from what was requested if step 2 failed) and how to reach it from WeChat: `/s <name> <msg>`. Then check the `Routing` / `Binding` / `Default target` lines in the `wechat_status` output (call it again once the watcher is up if the first call predated it): if a binding routes plain messages to a **different** session, or the default target is another session, tell the user explicitly — to receive plain messages here they should send `/use <n>` in WeChat to bind this session (see `/ls` for numbers). `/use off` only removes an existing binding; messages then go to the default target (the most recently active monitored session), which is not necessarily this one.

Two namespaces, do not mix them up: the names in `wechat_status`'s `Active sessions` list are **WeChat routing names** (for `/s <name> <msg>` in WeChat and for `wechat_set_session_name`). They are not Claude Code session names. To message another Claude session with `SendMessage`, use the name shown after `SendMessage:` on that row, or `ListAgents`.

Fallback: if the Monitor tool is unavailable, use ScheduleWakeup with a 60-second interval and call `wechat_get_messages` on each wakeup (note: without the watcher heartbeat, this session will not show as `[monitoring]`, but messages explicitly routed here with `/s` still arrive).
