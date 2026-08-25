import fs from "node:fs";
import path from "node:path";
import { INBOX_DIR } from "./paths.js";
import type { PendingMessage } from "./types.js";

function inboxFile(sessionId: string): string {
  return path.join(INBOX_DIR, `${sessionId}.json`);
}

const LOCK_TIMEOUT_MS = 5000;
const LOCK_SPINS = 100;

// Serialize inbox access with an atomic mkdir lock so the daemon's append and
// the MCP server's drain can't interleave (which would otherwise lose or
// duplicate messages). Critical sections are tiny (one file read + write).
function withInboxLock<T>(sessionId: string, fn: () => T): T {
  const lock = `${inboxFile(sessionId)}.lock`;
  for (let i = 0; i < LOCK_SPINS; i++) {
    try {
      fs.mkdirSync(lock);
    } catch {
      // Lock held — steal it if it's stale, otherwise wait a beat and retry.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_TIMEOUT_MS) {
          fs.rmdirSync(lock);
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        fs.rmdirSync(lock);
      } catch {}
    }
  }
  // Couldn't acquire within the budget — proceed unlocked rather than drop.
  return fn();
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
