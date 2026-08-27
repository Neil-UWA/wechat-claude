// Records when a session last sent something back to a WeChat user. Written by
// the MCP server (the only place replies are sent), read by the daemon, which
// otherwise cannot distinguish "session answered" from "session went silent" —
// the inbox only tells it whether the message was *read*.
import fs from "node:fs";
import path from "node:path";
import { REPLIES_DIR } from "./paths.js";

// User ids come from the WeChat API ("xxx@im.wechat"); keep them to characters
// that cannot escape the directory.
function replyFile(userId: string): string {
  return path.join(REPLIES_DIR, userId.replace(/[^A-Za-z0-9._@-]/g, "_"));
}

export function markReplied(userId: string, at: number = Date.now()): void {
  try {
    fs.mkdirSync(REPLIES_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(replyFile(userId), String(at));
  } catch {}
}

// 0 when this user has never been replied to.
export function lastReplyAt(userId: string): number {
  try {
    const ts = parseInt(fs.readFileSync(replyFile(userId), "utf-8").trim(), 10);
    return Number.isFinite(ts) ? ts : 0;
  } catch {
    return 0;
  }
}
