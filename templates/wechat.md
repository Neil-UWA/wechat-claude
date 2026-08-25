Start WeChat message monitoring for this session.

1. Call `wechat_status`. It auto-starts the daemon when needed (if logged in), and its output includes this session's id and the exact watcher command to use in step 5.
2. If not logged in — or the status says the login has EXPIRED — call `wechat_login`, show the QR code URL to the user, then poll with `wechat_login_poll` until confirmed. Login success also auto-starts the daemon.
3. If the status says the daemon could not be started, tell the user to check `~/.claude/wechat/daemon.log`.
4. Call `wechat_get_messages` once to process any pending messages.
5. Start a persistent Monitor with the watcher command from the `wechat_status` output:

   The command is printed verbatim by `wechat_status` — copy it from there
   rather than composing it; the install path differs per machine. It looks
   like `node /path/to/wechat-claude-sessions/dist/watch-inbox.js <session id>`.

   Use `persistent: true`. The watcher is event-driven (`fs.watch` on the inbox), prints one line per new delivery, and maintains the heartbeat file that marks this session as `[monitoring]` — the daemon prefers monitored sessions when routing messages without a `/s` prefix.
6. When the Monitor emits an event:
   - Call `wechat_get_messages` to read and clear the inbox
   - Process the message content (answer questions, execute tasks, etc.)
   - Reply via `wechat_send_text` with the result; use `wechat_send_image` for images
7. Confirm to the user that WeChat monitoring is active. Check the `Routing` / `Binding` lines in the `wechat_status` output: if a binding routes plain messages to a **different** session (or the default target is another session), tell the user explicitly — their messages will not arrive here until they send `/use off` (unbind) or `/use <n>` (rebind, see `/ls`) in WeChat.

Fallback: if the Monitor tool is unavailable, use ScheduleWakeup with a 60-second interval and call `wechat_get_messages` on each wakeup (note: without the watcher heartbeat, this session will not show as `[monitoring]`, but messages explicitly routed here with `/s` still arrive).
