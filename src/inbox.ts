import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "./file-lock.js";
import { INBOX_DIR } from "./paths.js";
import type { PendingMessage } from "./types.js";

function inboxFile(sessionId: string): string {
  return path.join(INBOX_DIR, `${sessionId}.json`);
}

// Serialize inbox access so the daemon's append and the MCP server's drain
// can't interleave (which would otherwise lose or duplicate messages).
function withInboxLock<T>(sessionId: string, fn: () => T): T {
  return withFileLock(inboxFile(sessionId), fn);
}

function loadArray(file: string): PendingMessage[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return Array.isArray(parsed) ? (parsed as PendingMessage[]) : [];
  } catch {
    return [];
  }
}

// Append a message to a session's inbox (daemon side, the sole producer).
export function writeToInbox(sessionId: string, msg: PendingMessage): void {
  const file = inboxFile(sessionId);
  withInboxLock(sessionId, () => {
    const inbox = loadArray(file);
    inbox.push(msg);
    fs.writeFileSync(file, JSON.stringify(inbox));
  });
}

// Read and clear a session's inbox (MCP server side, the sole consumer). The
// read-and-empty happens under the same lock as writeToInbox, so a message the
// daemon appends can never be lost by, or duplicated across, a concurrent drain.
export function readInbox(sessionId: string): PendingMessage[] {
  const file = inboxFile(sessionId);
  return withInboxLock(sessionId, () => {
    const msgs = loadArray(file);
    if (msgs.length > 0) fs.writeFileSync(file, "[]");
    return msgs;
  });
}

export function peekInbox(sessionId: string): number {
  return loadArray(inboxFile(sessionId)).length;
}
