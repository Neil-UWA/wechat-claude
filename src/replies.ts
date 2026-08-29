// Records when a session last sent something back to a WeChat user. Written by
// the MCP server (the only place replies are sent), read by the daemon, which
// otherwise cannot distinguish "session answered" from "session went silent" —
// the inbox only tells it whether the message was *read*.
//
// Keyed by session *and* user: one user can have messages in flight to several
// sessions at once (`/s 1 …` then `/s 2 …`), and session 1 answering says
// nothing about whether session 2 is stuck.
import fs from "node:fs";
import path from "node:path";
import { REPLIES_DIR } from "./paths.js";

// User ids come from the WeChat API ("xxx@im.wechat"); keep both parts to
// characters that cannot escape the directory.
function replyFile(sessionId: string, userId: string): string {
  const safe = (value: string): string => value.replace(/[^A-Za-z0-9._@-]/g, "_");
  return path.join(REPLIES_DIR, `${safe(sessionId)}--${safe(userId)}`);
}

export function markReplied(
  sessionId: string,
  userId: string,
  at: number = Date.now()
): void {
  try {
    fs.mkdirSync(REPLIES_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(replyFile(sessionId, userId), String(at));
  } catch {}
}

// 0 when this session has never replied to this user.
export function lastReplyAt(sessionId: string, userId: string): number {
  try {
    const ts = parseInt(
      fs.readFileSync(replyFile(sessionId, userId), "utf-8").trim(),
      10
    );
    return Number.isFinite(ts) ? ts : 0;
  } catch {
    return 0;
  }
}

// Reply markers outlive the sessions that wrote them (session ids are pids).
export function pruneReplies(liveSessionIds: string[]): void {
  const live = new Set(liveSessionIds.map((id) => id.replace(/[^A-Za-z0-9._@-]/g, "_")));
  try {
    for (const file of fs.readdirSync(REPLIES_DIR)) {
      const sessionPart = file.split("--")[0];
      if (live.has(sessionPart)) continue;
      try {
        fs.unlinkSync(path.join(REPLIES_DIR, file));
      } catch {}
    }
  } catch {}
}
