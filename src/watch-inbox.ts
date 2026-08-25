#!/usr/bin/env node
// Persistent inbox watcher for one Claude Code session.
//
// Usage: node dist/watch-inbox.js [sessionId]
//
// Prints one line per new inbox delivery (for the Claude Code Monitor tool)
// and maintains a heartbeat file so the daemon knows this session is
// actively monitored. Exits when the session's MCP server goes away.
import fs from "node:fs";
import path from "node:path";
import { clearHeartbeat, touchHeartbeat } from "./monitoring.js";
import { INBOX_DIR, SESSIONS_DIR } from "./paths.js";
import type { SessionInfo } from "./sessions.js";

function resolveSessionByCwd(): string | undefined {
  let best: SessionInfo | undefined;
  try {
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const info = JSON.parse(
          fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8")
        ) as SessionInfo;
        if (info.cwd !== process.cwd()) continue;
        if (!best || info.lastActive > best.lastActive) best = info;
      } catch {}
    }
  } catch {}
  return best?.id;
}

const sessionId = process.argv[2] ?? resolveSessionByCwd();
if (!sessionId) {
  process.stderr.write(
    "Usage: watch-inbox.js <sessionId> (no session found for this cwd)\n"
  );
  process.exit(1);
}

const inboxFile = path.join(INBOX_DIR, `${sessionId}.json`);
const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);

let lastSig = "";

function checkInbox(): void {
  let msgs: { id?: string; text?: string }[];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(inboxFile, "utf-8"));
    if (!Array.isArray(parsed)) return;
    msgs = parsed as { id?: string; text?: string }[];
  } catch {
    return;
  }
  if (msgs.length === 0) {
    lastSig = "";
    return;
  }
  const sig = msgs.map((m) => m.id ?? "").join(",");
  if (sig === lastSig) return;
  lastSig = sig;
  const preview = msgs
    .map((m) => String(m.text ?? "").replace(/\s+/g, " ").slice(0, 80))
    .join(" | ");
  process.stdout.write(`WECHAT: ${msgs.length} msg(s) - ${preview}\n`);
}

function cleanup(): void {
  clearHeartbeat(sessionId as string);
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

touchHeartbeat(sessionId);
checkInbox();

// Event-driven: react as soon as the daemon writes the inbox file.
// fs.watch on the directory survives the file being replaced.
try {
  fs.watch(INBOX_DIR, (_event, filename) => {
    if (filename === `${sessionId}.json`) checkInbox();
  });
} catch {
  // fall back to the interval below
}

function sessionAlive(): boolean {
  try {
    const info = JSON.parse(
      fs.readFileSync(sessionFile, "utf-8")
    ) as SessionInfo;
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Fallback poll + heartbeat + liveness check.
setInterval(() => {
  if (!sessionAlive()) {
    // MCP server (and thus the Claude session) is gone.
    process.exit(0);
  }
  touchHeartbeat(sessionId);
  checkInbox();
}, 10_000);
