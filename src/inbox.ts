import fs from "node:fs";
import path from "node:path";
import { INBOX_DIR } from "./paths.js";
import type { PendingMessage } from "./types.js";

function inboxFile(sessionId: string): string {
  return path.join(INBOX_DIR, `${sessionId}.json`);
}

// Append a message to a session's inbox (daemon side, the sole writer).
export function writeToInbox(sessionId: string, msg: PendingMessage): void {
  const file = inboxFile(sessionId);
  let inbox: PendingMessage[] = [];
  try {
    inbox = JSON.parse(fs.readFileSync(file, "utf-8")) as PendingMessage[];
  } catch {}
  inbox.push(msg);
  fs.writeFileSync(file, JSON.stringify(inbox));
}

// Drain a session's inbox (MCP server side, the sole consumer). Renames the
// file aside first so a message the daemon appends during the read can't be
// truncated away — it lands in a freshly created inbox file and is picked up on
// the next drain instead of being lost.
export function readInbox(sessionId: string): PendingMessage[] {
  const file = inboxFile(sessionId);
  const tmp = `${file}.reading.${process.pid}`;
  try {
    fs.renameSync(file, tmp);
  } catch {
    return []; // nothing to read (file missing)
  }
  try {
    const msgs = JSON.parse(fs.readFileSync(tmp, "utf-8")) as PendingMessage[];
    return Array.isArray(msgs) ? msgs : [];
  } catch {
    return [];
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

export function peekInbox(sessionId: string): number {
  try {
    const msgs = JSON.parse(
      fs.readFileSync(inboxFile(sessionId), "utf-8")
    ) as unknown[];
    return Array.isArray(msgs) ? msgs.length : 0;
  } catch {
    return 0;
  }
}
