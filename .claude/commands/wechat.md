Start WeChat message monitoring for this session.

1. Call `wechat_status` to check if WeChat is connected and the daemon is running.
2. If not logged in, call `wechat_login` to generate a QR code, show it to the user, then poll with `wechat_login_poll`.
3. If the daemon is not running, tell the user to start it: `npm run daemon` (from the wechat-claude directory) or `node <path-to-wechat-claude>/dist/daemon.js &`
4. If connected, call `wechat_get_messages` once to check for pending messages and process them.
5. Start periodic monitoring using ScheduleWakeup with a 30-second interval to call `wechat_get_messages`.
6. When new messages are found:
   - Call `wechat_get_messages` to read and clear the inbox
   - Process the message content (answer questions, execute tasks, etc.)
   - Reply via `wechat_send_text` with the result
   - For image replies, use `wechat_send_image` with a file path
7. Confirm to the user that WeChat monitoring is active.
