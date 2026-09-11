// Starting, stopping and replacing the poller — shared by the CLI and the MCP
// server, which both have to do it and must agree on the rules. The one that
// matters most: after a login, whatever is already polling holds the *old*
// credential (the daemon reads session.json once, at startup), so a login has
// to replace it rather than leave it running.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as launchd from "./launchd.js";
import { DAEMON_LOG_FILE, DAEMON_PID_FILE, ensureDirs } from "./paths.js";

export const DAEMON_PATH = fileURLToPath(new URL("./daemon.js", import.meta.url));

// How callers surface progress: the CLI prints these, the MCP server keeps
// them out of its stdio protocol.
export type Notice = (line: string) => void;
const silent: Notice = () => {};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// A pid file can outlive a crash, and the OS reuses pids — so never signal or
// trust a pid without confirming the process is actually one of our daemons.
// "unknown" keeps the two failure modes apart: a probe we could not run must
// not be read as a mismatch, or we would discard a live daemon's pid file.
type Identity = "daemon" | "other" | "unknown";

function identifyProcess(pid: number): Identity {
  if (process.platform === "win32") return "unknown"; // no ps
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  // A missing/broken ps is "unknown"; ps running and finding nothing is a real
  // answer, but the caller only asks about pids it has already seen alive.
  if (r.error) return "unknown";
  if (r.status !== 0) return "other";
  const cmd = (r.stdout ?? "").toString().trim();
  if (cmd === "") return "unknown";
  // Match any install's daemon.js, not just this one: after an upgrade the
  // running daemon legitimately comes from the previous install path.
  return /\bnode\b/.test(cmd) && /daemon\.js(\s|$)/.test(cmd) ? "daemon" : "other";
}

// The daemon's pid, or undefined when the pid file is absent or stale. Removes
// a stale file so the next reader is not misled by it.
export function daemonPid(note: Notice = silent): number | undefined {
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
  } catch {
    return undefined;
  }
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
  } catch {
    try {
      fs.unlinkSync(DAEMON_PID_FILE);
    } catch {}
    return undefined;
  }
  if (identifyProcess(pid) === "other") {
    note(
      `  ! pid file points at pid ${pid}, which is not a wechat-claude daemon — ignoring it`
    );
    try {
      fs.unlinkSync(DAEMON_PID_FILE);
    } catch {}
    return undefined;
  }
  // "unknown" (Windows, or no usable ps) falls through: an unverifiable pid is
  // still the best information we have, and treating it as stale would delete
  // a live daemon's pid file and let a second poller start.
  return pid;
}

export function isDaemonRunning(): boolean {
  return daemonPid() !== undefined;
}

export async function stopDaemon(note: Notice = silent): Promise<boolean> {
  const pid = daemonPid(note);
  if (pid === undefined) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  // Re-check identity before escalating: over five seconds the daemon could
  // have exited and its pid been handed to something else. Only a confirmed
  // daemon gets SIGKILL — "unknown" is not good enough to kill on.
  if (identifyProcess(pid) === "daemon") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  } else {
    note(
      `  ! pid ${pid} did not exit and can no longer be confirmed as the daemon — not forcing it`
    );
  }
  return true;
}

// Spawning only proves node launched. The daemon exits non-zero when there is
// no saved session, so wait for it to claim the pid file before reporting it up.
export async function spawnDaemonDetached(
  note: Notice = silent
): Promise<boolean> {
  let child;
  try {
    ensureDirs();
    const logFd = fs.openSync(DAEMON_LOG_FILE, "a");
    child = spawn(process.execPath, [DAEMON_PATH], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
  } catch (err) {
    note(
      `  ! could not start the daemon: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }

  for (let i = 0; i < 50; i++) {
    if (daemonPid() === child.pid) {
      note(`  ✓ daemon started (pid ${child.pid}), logging to ${DAEMON_LOG_FILE}`);
      return true;
    }
    await sleep(100);
  }
  note(`  ! the daemon exited during startup — check ${DAEMON_LOG_FILE}`);
  note("    (a missing WeChat login is the usual cause: run `wechat-claude login`)");
  return false;
}

// Whether launchd should be the one doing the starting. Keyed on the plist
// being installed, not on the job being loaded: after `daemon stop` the job is
// unloaded but still installed, and starting an unsupervised process then
// would quietly cost the user auto-start and crash-restart. load() handles a
// job that is already loaded as well as one that is not.
function launchdOwnsIt(): boolean {
  return launchd.isMac() && launchd.isInstalled();
}

// Make sure something is polling, without disturbing a daemon that already is.
export async function ensureDaemonRunning(
  note: Notice = silent
): Promise<boolean> {
  if (isDaemonRunning()) {
    note("  • daemon already running");
    return true;
  }
  if (launchdOwnsIt()) {
    const ok = launchd.load();
    note(ok ? "  ✓ launchd service started" : "  ! launchctl load failed");
    return ok;
  }
  return spawnDaemonDetached(note);
}

// Replace whatever is polling, because the credential just changed.
//
// A running daemon read session.json once, at startup, and never re-reads it:
// after a re-login it would keep polling with the old token, and when that is
// rejected it exits — leaving the fresh login with no poller at all.
export async function restartDaemonForNewLogin(
  note: Notice = silent
): Promise<boolean> {
  if (launchdOwnsIt()) {
    // load() unloads first, so this replaces the running job.
    const ok = launchd.load();
    note(
      ok
        ? "  ✓ launchd service restarted with the new login"
        : "  ! launchctl load failed"
    );
    return ok;
  }
  if (await stopDaemon(note)) {
    note("  • stopped the daemon still holding the old login");
  }
  return spawnDaemonDetached(note);
}
