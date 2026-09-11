#!/usr/bin/env node
// wechat-claude CLI: one-command setup, login, status, and daemon control.
//
//   wechat-claude setup            register MCP server + slash command, then login
//   wechat-claude login            (re)authenticate by scanning a QR code
//   wechat-claude status           show daemon / login state
//   wechat-claude daemon [cmd]     run or manage the background daemon
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ILinkClient } from "./ilink.js";
import { loginVerification, verificationNote } from "./login-state.js";
import { pkgFile } from "./pkg-root.js";
import { DAEMON_PID_FILE, ensureDirs, WECHAT_DIR } from "./paths.js";
import { type McpRegistration, classifyMcpRegistration } from "./utils.js";
import * as launchd from "./launchd.js";

const DAEMON_JS = fileURLToPath(new URL("./daemon.js", import.meta.url));
const SERVER_JS = fileURLToPath(new URL("./server.js", import.meta.url));
const DAEMON_LOG = path.join(WECHAT_DIR, "daemon.log");

function out(s: string): void {
  process.stdout.write(s + "\n");
}

const MCP_NAME = "wechat";

function mcpAdd(): boolean {
  return (
    spawnSync("claude", ["mcp", "add", "--scope", "user", MCP_NAME, "node", SERVER_JS], {
      stdio: ["ignore", "pipe", "pipe"],
    }).status === 0
  );
}

// What the registration currently points at. `claude mcp get` prints a
// human-readable block; classifyMcpRegistration looks for this install's
// exact path in it (robust to spaces in the path) and treats any successful
// output that lacks it as an existing registration to replace — a get that
// succeeds must never be read as "no registration", or the stale entry
// survives and `claude mcp add` keeps no-opping against it.
function mcpRegistration(): McpRegistration {
  const r = spawnSync("claude", ["mcp", "get", MCP_NAME], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const stdout =
    r.status === 0 && r.stdout ? r.stdout.toString() : undefined;
  return classifyMcpRegistration(stdout, SERVER_JS);
}

function registerMcpServer(): void {
  out(`→ Registering MCP server (claude mcp add ${MCP_NAME})…`);

  // `claude mcp add` refuses a name that already exists — and exits 0 while
  // doing so. Taking that as success left every upgrade pointing at the old
  // install, which breaks as soon as that copy is gone. So replace an existing
  // registration rather than trusting the exit code.
  mcpAdd();
  let registered = mcpRegistration();

  if (registered.kind === "other") {
    out(
      `  • replacing a registration that points at ${registered.target ?? "another install"}`
    );
    spawnSync("claude", ["mcp", "remove", "--scope", "user", MCP_NAME], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    mcpAdd();
    registered = mcpRegistration();
  }

  if (registered.kind === "current") {
    out("  ✓ registered");
  } else if (registered.kind === "none") {
    out("  ! failed — is the `claude` CLI on your PATH?");
    out(`    Register it manually: claude mcp add --scope user ${MCP_NAME} node ${SERVER_JS}`);
  } else {
    out(`  ! still registered to ${registered.target ?? "another install"}, not this install`);
    out(`    Fix it with: claude mcp remove --scope user ${MCP_NAME}`);
  }
}

function installSlashCommand(): void {
  const src = pkgFile("wechat.md");
  const destDir = path.join(os.homedir(), ".claude", "commands");
  const dest = path.join(destDir, "wechat.md");
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
    out(`  ✓ /wechat command installed to ${dest}`);
  } catch (err) {
    out(`  ! could not install /wechat command: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function tryOpen(url: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawnSync(opener, args, { stdio: "ignore" });
}

async function login(): Promise<boolean> {
  const client = new ILinkClient();
  out("→ Requesting a login QR code…");
  try {
    await client.login(
      (url) => {
        out("");
        out("Scan this QR code with WeChat to log in.");
        out("Open this URL in a browser to display the QR image, then scan it:");
        out("");
        out("  " + url);
        out("");
        tryOpen(url);
        out("(waiting for scan — this window will update)…");
      },
      (status) => {
        if (status === "scaned") out("  • scanned, waiting for confirmation…");
      }
    );
    out("  ✓ logged in — session saved to ~/.claude/wechat/session.json");
    return true;
  } catch (err) {
    out(`  ! login failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

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
function readDaemonPid(): number | undefined {
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
    out(`  ! pid file points at pid ${pid}, which is not a wechat-claude daemon — ignoring it`);
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

function daemonRunning(): boolean {
  return readDaemonPid() !== undefined;
}

function status(): void {
  const client = new ILinkClient();
  const loggedIn = client.tryRestoreSession();
  out(
    `Logged in:      ${loggedIn ? "yes" : "no"}${loggedIn ? ` ${verificationNote(loginVerification())}` : ""}`
  );
  out(`Daemon running: ${daemonRunning() ? "yes" : "no"}`);
  if (launchd.isMac())
    out(`launchd service: ${launchd.isLoaded() ? "installed" : "not installed"}`);
  out(`Data dir:       ${WECHAT_DIR}`);
  if (!loggedIn) out("\nRun `wechat-claude login` to authenticate.");
  else if (!daemonRunning())
    out("\nStart the daemon with `wechat-claude daemon` (or it auto-starts via /wechat).");
}

// Stop the running daemon and wait for the pid to actually go away, so the
// replacement does not lose its own singleton race against the old process.
function stopDaemon(): boolean {
  const pid = readDaemonPid();
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
    spawnSync("sleep", ["0.1"]);
  }
  // Re-check identity before escalating: over five seconds the daemon could
  // have exited and its pid been handed to something else. Only a confirmed
  // daemon gets SIGKILL — "unknown" is not good enough to kill on.
  if (identifyProcess(pid) === "daemon") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  } else {
    out(`  ! pid ${pid} did not exit and can no longer be confirmed as the daemon — not forcing it`);
  }
  return true;
}

// Spawning only proves node launched. The daemon exits non-zero when there is
// no saved session, so wait for it to claim the pid file before reporting it up.
function startDaemonDetached(): boolean {
  let child;
  try {
    ensureDirs();
    const logFd = fs.openSync(DAEMON_LOG, "a");
    child = spawn(process.execPath, [DAEMON_JS], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
  } catch (err) {
    out(`  ! could not start the daemon: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  for (let i = 0; i < 50; i++) {
    if (readDaemonPid() === child.pid) {
      out(`  ✓ daemon started (pid ${child.pid}), logging to ${DAEMON_LOG}`);
      return true;
    }
    spawnSync("sleep", ["0.1"]);
  }
  out(`  ! the daemon exited during startup — check ${DAEMON_LOG}`);
  out("    (a missing WeChat login is the usual cause: run `wechat-claude login`)");
  return false;
}

// Make sure something is polling, without disturbing a daemon that already is.
function ensureDaemonRunning(): boolean {
  if (daemonRunning()) {
    out("  • daemon already running");
    return true;
  }
  if (launchd.isMac() && launchd.isLoaded()) {
    const ok = launchd.load();
    out(ok ? "  ✓ launchd service started" : "  ! launchctl load failed");
    return ok;
  }
  return startDaemonDetached();
}

// A login with nothing polling is not a working setup — the daemon is what
// receives messages — and the CLI used to leave that as homework in a "next
// steps" list.
//
// It must be a restart, not a "start if absent": a running daemon holds the
// credential it read at startup and never re-reads session.json. After a
// re-login it would keep polling with the old token, and its own expiry
// handling would then delete the session file this login just wrote.
function restartDaemonForNewLogin(): boolean {
  if (launchd.isMac() && launchd.isLoaded()) {
    // load() unloads first, so this replaces the running job.
    const ok = launchd.load();
    out(
      ok
        ? "  ✓ launchd service restarted with the new login"
        : "  ! launchctl load failed"
    );
    return ok;
  }
  if (stopDaemon()) out("  • stopped the daemon still holding the old login");
  return startDaemonDetached();
}

function daemon(sub: string | undefined): number {
  switch (sub) {
    case undefined:
    case "run": {
      // Foreground: replace this process's stdio with the daemon's.
      const r = spawnSync(process.execPath, [DAEMON_JS], { stdio: "inherit" });
      return r.status ?? 1;
    }
    case "start":
      // `wechat-claude daemon` runs in the foreground and dies with the
      // terminal; "start" is the one people reach for when they mean "run it
      // as a service", and it used to be an unknown command.
      return ensureDaemonRunning() ? 0 : 1;
    case "stop": {
      // Under launchd, killing the process achieves nothing: KeepAlive
      // restarts it. Unload the job instead — the plist stays on disk, so it
      // comes back at the next login, or right away with `daemon start`.
      if (launchd.isMac() && launchd.isLoaded()) {
        const ok = launchd.unload();
        out(
          ok
            ? "  ✓ launchd service stopped (returns at next login, or `wechat-claude daemon start`)"
            : "  ! launchctl unload failed"
        );
        return ok ? 0 : 1;
      }
      if (stopDaemon()) out("  ✓ daemon stopped");
      else out("  • no daemon was running");
      return 0;
    }
    case "install": {
      if (!launchd.isMac()) {
        out("launchd is macOS-only. On Linux/Windows, supervise the daemon");
        out("yourself: `wechat-claude daemon` under systemd, pm2, or similar.");
        return 1;
      }
      const plist = launchd.writePlist();
      out(`→ Wrote ${plist}`);
      // Hand the singleton over to launchd first. Otherwise its child hits the
      // daemon's pid-file guard and exits 0 — and KeepAlive.SuccessfulExit
      // false means launchd never retries, so the job supervises nothing while
      // still reporting success.
      if (stopDaemon()) out("  ✓ stopped the existing daemon so launchd can own it");
      const ok = launchd.load();
      out(ok ? "  ✓ service loaded (starts at login, restarts on crash)" : "  ! launchctl load failed");
      return ok ? 0 : 1;
    }
    case "restart": {
      // A running daemon holds the old code in memory, so an upgrade only
      // takes effect once it is replaced. Under launchd, let it do the
      // restarting; otherwise stop the process and spawn a fresh detached one.
      if (launchd.isMac() && launchd.isLoaded()) {
        const ok = launchd.load();
        out(ok ? "  ✓ launchd service restarted" : "  ! launchctl reload failed");
        return ok ? 0 : 1;
      }
      if (stopDaemon()) out("  ✓ stopped the running daemon");
      else out("  • no daemon was running");
      return startDaemonDetached() ? 0 : 1;
    }
    case "uninstall": {
      if (!launchd.isMac()) {
        out("launchd is macOS-only — nothing to uninstall.");
        return 1;
      }
      launchd.unload();
      try {
        fs.rmSync(launchd.PLIST_PATH);
        out(`  ✓ removed ${launchd.PLIST_PATH}`);
      } catch {
        out("  • no launchd service was installed");
      }
      return 0;
    }
    case "status": {
      out(`Daemon running:  ${daemonRunning() ? "yes" : "no"}`);
      if (launchd.isMac())
        out(`launchd service: ${launchd.isLoaded() ? "loaded" : "not loaded"}`);
      return 0;
    }
    case "log": {
      const r = spawnSync("tail", ["-f", DAEMON_LOG], { stdio: "inherit" });
      return r.status ?? 1;
    }
    default:
      out(`Unknown daemon command: ${sub}`);
      out(
        "Usage: wechat-claude daemon [run|start|stop|restart|install|uninstall|status|log]"
      );
      return 1;
  }
}

function usage(): void {
  out("wechat-claude — control Claude Code from WeChat\n");
  out("Usage:");
  out("  wechat-claude setup              register MCP server + /wechat command, then log in");
  out("  wechat-claude login              (re)authenticate by scanning a QR code");
  out("  wechat-claude status             show daemon / login state");
  out("  wechat-claude daemon             run the daemon in the foreground");
  out("  wechat-claude daemon start       start it in the background");
  out("  wechat-claude daemon stop        stop it (launchd job included)");
  out("  wechat-claude daemon restart     restart it (use after an upgrade)");
  out("  wechat-claude daemon install     install it as a launchd service (macOS)");
  out("  wechat-claude daemon uninstall   remove the launchd service");
  out("  wechat-claude daemon status      check daemon / service state");
  out("  wechat-claude daemon log         tail the daemon log\n");
  out("After setup: start the daemon, then type /wechat in a Claude Code session.");
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "setup": {
      out("Setting up wechat-claude…\n");
      registerMcpServer();
      installSlashCommand();
      out("");
      const ok = await login();
      out("");
      if (ok) {
        const started = restartDaemonForNewLogin();
        out("");
        out("Setup complete. Next step:");
        out("  In a Claude Code session, type: /wechat");
        if (started && !(launchd.isMac() && launchd.isLoaded())) {
          out("");
          out("The daemon is running, but only until this machine restarts.");
          out("To keep it running: wechat-claude daemon install   (macOS)");
        }
      } else {
        out("Setup finished with login pending — run `wechat-claude login` to retry.");
      }
      break;
    }
    case "login":
      // The daemon is the half of the system that receives messages, and it
      // exits when there is no login — so the one moment it is worth starting
      // is right after a login succeeds.
      if (await login()) restartDaemonForNewLogin();
      break;
    case "status":
      status();
      break;
    case "daemon":
      process.exitCode = daemon(process.argv[3]);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
