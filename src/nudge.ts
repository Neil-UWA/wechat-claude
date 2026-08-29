// A session's watcher announces the inbox once, when it changes. If nobody
// could act on that announcement — the model was rate-limited, so Claude never
// woke up — the message would sit unread forever afterwards. The daemon drops
// a nudge file to make the watcher announce the backlog again.
import fs from "node:fs";
import path from "node:path";
import { NUDGE_DIR } from "./paths.js";

function nudgeFile(sessionId: string): string {
  return path.join(NUDGE_DIR, sessionId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

export function nudgeSession(sessionId: string): void {
  try {
    fs.mkdirSync(NUDGE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(nudgeFile(sessionId), String(Date.now()));
  } catch {}
}

// True once per nudge: the file is consumed so the backlog is re-announced
// exactly one time.
export function consumeNudge(sessionId: string): boolean {
  try {
    fs.unlinkSync(nudgeFile(sessionId));
    return true;
  } catch {
    return false;
  }
}
