# Security Policy

## Threat model — read this before running

wechat-claude bridges a **chat channel** to **command execution on your
computer**. A message like `/run <task>` starts a Claude Code session on your
machine, and `/close` / `/stop` terminate processes. Treat the bot as a remote
control for your laptop.

Key facts to understand:

- **Anyone who can message your bot can drive your machine.** There is
  currently no per-sender authorization check — every incoming WeChat message
  is acted on. Only enable the bot for an account that only you can message,
  and never share or publicize the bot.
- **`/run` defaults to `--dangerously-skip-permissions`.** Tasks run
  unattended without per-action confirmation. Use `/run --safe <task>` for
  `--permission-mode acceptEdits` (bash commands then wait for confirmation at
  the computer).
- **The first such `/run` accepts skip-permissions mode on your behalf.**
  Claude Code gates that mode behind a one-time interactive dialog, which a
  detached tmux session can never answer — the task would hang on the prompt
  forever. So the daemon sets `bypassPermissionsModeAccepted` in
  `~/.claude.json` before launching, and says so in its reply the one time it
  does. If you would rather grant that yourself, accept the dialog once by
  running `claude --dangerously-skip-permissions` at the computer, or stay on
  `/run --safe`, which never touches the flag.
- **The bot token is stored at `~/.claude/wechat/session.json`** (mode 0600).
  The whole `~/.claude/wechat/` directory is created 0700. Anyone with read
  access to your home directory can impersonate your bot.
- **Run only on machines you control.** Do not run the daemon on shared or
  multi-user hosts, and do not expose it to untrusted contacts.

## Recommended hardening

- Keep the bot conversation private (a single-user chat).
- Prefer `/run --safe` unless you are actively watching the task.
- Review `~/.claude/wechat/config.json` `repoDirs` — only list directories you
  are comfortable running tasks in.

## Reporting a vulnerability

Please report security issues privately by opening a
[GitHub security advisory](https://github.com/Neil-UWA/wechat-claude/security/advisories/new)
rather than a public issue. We aim to respond within a week.
