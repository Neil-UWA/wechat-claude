import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Single source of truth for the on-disk layout under ~/.claude/wechat.
export const WECHAT_DIR = path.join(os.homedir(), ".claude", "wechat");
export const SESSIONS_DIR = path.join(WECHAT_DIR, "sessions");
export const INBOX_DIR = path.join(WECHAT_DIR, "inbox");
export const TYPING_DIR = path.join(WECHAT_DIR, "typing");
export const MEDIA_DIR = path.join(WECHAT_DIR, "media");
export const CURSOR_FILE = path.join(WECHAT_DIR, "cursor.txt");
export const DAEMON_PID_FILE = path.join(WECHAT_DIR, "daemon.pid");
export const EXPIRED_FLAG_FILE = path.join(WECHAT_DIR, "expired.flag");
export const CONFIG_FILE = path.join(WECHAT_DIR, "config.json");

// Create the tree owner-only (0700) — it holds the bot token, context tokens,
// and downloaded media. chmod (not just mkdir mode) so directories created
// before this hardening, or with a looser umask, are tightened too.
export function ensureDirs(extra: string[] = []): void {
  for (const dir of [WECHAT_DIR, SESSIONS_DIR, INBOX_DIR, TYPING_DIR, ...extra]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
