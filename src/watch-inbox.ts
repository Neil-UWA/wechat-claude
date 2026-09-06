#!/usr/bin/env node
// Persistent inbox watcher for one Claude Code session.
//
// Usage: node dist/watch-inbox.js [sessionId]
//
// Prints one line per new inbox delivery (for the Claude Code Monitor tool)
// and maintains a heartbeat file so the daemon knows this session is
// actively monitored. It also reports the two ways delivery breaks without
// anything arriving here — an expired login and a dead daemon — and, when the
// session it watches goes away or is replaced, prints why and exits non-zero:
// a silent exit 0 reads as a clean shutdown, and the session goes deaf with
// neither the agent nor the user any the wiser.
import fs from "node:fs";
import path from "node:path";
import {
  HEALTHY,
  type DeliveryHealth,
  healthTransition,
  readDeliveryHealth,
} from "./health.js";
import { clearHeartbeat, touchHeartbeat } from "./monitoring.js";
import { consumeNudge } from "./nudge.js";
import { INBOX_DIR, NUDGE_DIR, SESSIONS_DIR } from "./paths.js";
import { type SessionInfo, sessionFate } from "./sessions.js";

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

// Re-announce the pending inbox when the daemon nudges us (e.g. after a Claude
// usage limit lifted and the original announcement went unanswered).
function checkNudge(): void {
  if (!consumeNudge(sessionId as string)) return;
  lastSig = "";
  checkInbox();
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

try {
  fs.mkdirSync(NUDGE_DIR, { recursive: true, mode: 0o700 });
  fs.watch(NUDGE_DIR, () => checkNudge());
} catch {
  // fall back to the interval below
}

// Stopping is never routine from the agent's side: this session goes back to
// receiving nothing, and an exit code of 0 with no output is indistinguishable
// from a clean shutdown. Say why, on stdout, and exit non-zero — then the
// Monitor tool surfaces it instead of the session silently going deaf.
function stop(reason: string): void {
  clearInterval(timer);
  const line = `WECHAT: watcher stopping — ${reason}\n`;
  process.stdout.write(line, () => process.exit(1));
  // stdout to a pipe is asynchronous: exiting from the write callback keeps
  // the line from being truncated, and this backstop covers the callback
  // never firing (closed pipe).
  setTimeout(() => process.exit(1), 2000);
}

let health: DeliveryHealth = HEALTHY;

// Delivery can break while the watcher itself is perfectly healthy (the login
// is revoked, the daemon dies). Report the change rather than sitting silent.
function checkHealth(): void {
  const next = readDeliveryHealth();
  const line = healthTransition(health, next);
  health = next;
  if (line) process.stdout.write(`${line}\n`);
}

// Fallback poll + heartbeat + liveness check.
const timer = setInterval(() => {
  const fate = sessionFate(sessionId as string);
  if (fate.state === "gone") {
    stop(
      `session ${sessionId} is gone (its MCP server exited). No message can be delivered here any more — do not report this session as monitoring.`
    );
    return;
  }
  if (fate.state === "superseded") {
    stop(
      `session ${sessionId} was replaced by session ${fate.replacement.id} (the MCP server reconnected — /mcp, a config change, or a reinstall). Messages now route to the new id: call wechat_status and start a watcher for it.`
    );
    return;
  }
  touchHeartbeat(sessionId);
  checkNudge();
  checkInbox();
  checkHealth();
}, 10_000);

// Say so straight away if this session is starting up into a broken setup.
checkHealth();
