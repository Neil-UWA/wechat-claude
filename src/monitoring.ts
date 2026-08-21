import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HEARTBEAT_DIR = path.join(os.homedir(), ".claude", "wechat", "heartbeat");

// A session counts as "monitoring" if its watcher touched the heartbeat file
// within this window. The watcher touches every 10s.
export const MONITORING_WINDOW_MS = 30_000;

function heartbeatFile(sessionId: string): string {
  return path.join(HEARTBEAT_DIR, sessionId);
}

export function touchHeartbeat(sessionId: string): void {
  try {
    fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });
    fs.writeFileSync(heartbeatFile(sessionId), String(Date.now()));
  } catch {}
}

export function clearHeartbeat(sessionId: string): void {
  try {
    fs.unlinkSync(heartbeatFile(sessionId));
  } catch {}
}

export function isMonitoring(
  sessionId: string,
  windowMs: number = MONITORING_WINDOW_MS
): boolean {
  try {
    const ts = parseInt(
      fs.readFileSync(heartbeatFile(sessionId), "utf-8").trim(),
      10
    );
    return Number.isFinite(ts) && Date.now() - ts < windowMs;
  } catch {
    return false;
  }
}
