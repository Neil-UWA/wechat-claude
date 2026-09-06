import fs from "node:fs";
import { DAEMON_LOG_FILE, DAEMON_PID_FILE, EXPIRED_FLAG_FILE, isProcessAlive } from "./paths.js";

// Whether messages can reach this machine at all. Both failures are silent
// from a watching session's point of view — the inbox simply stays empty, and
// "no messages" looks exactly like "nothing to say" — so the watcher reports
// each transition instead of leaving the agent to infer it from silence.
export type DeliveryHealth = {
  daemonRunning: boolean;
  loginExpired: boolean;
};

export function isDaemonRunning(): boolean {
  try {
    const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
    return isProcessAlive(pid);
  } catch {
    return false;
  }
}

export function readDeliveryHealth(): DeliveryHealth {
  return {
    daemonRunning: isDaemonRunning(),
    loginExpired: fs.existsSync(EXPIRED_FLAG_FILE),
  };
}

export function isHealthy(h: DeliveryHealth): boolean {
  return h.daemonRunning && !h.loginExpired;
}

export const HEALTHY: DeliveryHealth = {
  daemonRunning: true,
  loginExpired: false,
};

// One line for the agent when delivery breaks or comes back, or undefined
// when nothing changed that it hasn't already been told about.
export function healthTransition(
  prev: DeliveryHealth,
  next: DeliveryHealth
): string | undefined {
  if (isHealthy(next)) {
    return isHealthy(prev)
      ? undefined
      : "WECHAT: delivery recovered — the daemon is running and the login is valid again.";
  }
  if (next.loginExpired) {
    return prev.loginExpired
      ? undefined
      : "WECHAT: login EXPIRED — no WeChat message can reach this session until you call wechat_login and the user re-scans the QR code.";
  }
  if (!prev.daemonRunning && !prev.loginExpired) return undefined;
  return `WECHAT: the daemon is NOT running — no messages will be delivered to any session. Call wechat_status (it auto-starts the daemon), or check ${DAEMON_LOG_FILE}.`;
}
