#!/usr/bin/env node
// wechat-claude CLI: one-command setup, login, status, and daemon control.
//
//   wechat-claude setup            register MCP server + slash command, then login
//   wechat-claude login            (re)authenticate by scanning a QR code
//   wechat-claude status           show daemon / login state
//   wechat-claude daemon [cmd]     run or manage the background daemon
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ILinkClient } from "./ilink.js";
import { loginVerification, verificationNote } from "./login-state.js";
import { pkgFile } from "./pkg-root.js";
import { DAEMON_LOG_FILE, WECHAT_DIR } from "./paths.js";
import {
  DAEMON_PATH,
  ensureDaemonRunning,
  isDaemonRunning,
  restartDaemonForNewLogin,
  spawnDaemonDetached,
  stopDaemon,
} from "./daemon-control.js";
import { type McpRegistration, classifyMcpRegistration } from "./utils.js";
import * as launchd from "./launchd.js";

const SERVER_JS = fileURLToPath(new URL("./server.js", import.meta.url));

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

function status(): void {
  const client = new ILinkClient();
  const loggedIn = client.tryRestoreSession();
  out(
    `Logged in:      ${loggedIn ? "yes" : "no"}${loggedIn ? ` ${verificationNote(loginVerification())}` : ""}`
  );
  out(`Daemon running: ${isDaemonRunning() ? "yes" : "no"}`);
  if (launchd.isMac())
    out(`launchd service: ${launchd.isLoaded() ? "installed" : "not installed"}`);
  out(`Data dir:       ${WECHAT_DIR}`);
  if (!loggedIn) out("\nRun `wechat-claude login` to authenticate.");
  else if (!isDaemonRunning())
    out("\nStart the daemon with `wechat-claude daemon` (or it auto-starts via /wechat).");
}

async function daemon(sub: string | undefined): Promise<number> {
  switch (sub) {
    case undefined:
    case "run": {
      // Foreground: replace this process's stdio with the daemon's.
      const r = spawnSync(process.execPath, [DAEMON_PATH], { stdio: "inherit" });
      return r.status ?? 1;
    }
    case "start":
      // `wechat-claude daemon` runs in the foreground and dies with the
      // terminal; "start" is the one people reach for when they mean "run it
      // as a service", and it used to be an unknown command.
      return (await ensureDaemonRunning(out)) ? 0 : 1;
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
      if (await stopDaemon(out)) out("  ✓ daemon stopped");
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
      if (await stopDaemon(out)) out("  ✓ stopped the existing daemon so launchd can own it");
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
      if (await stopDaemon(out)) out("  ✓ stopped the running daemon");
      else out("  • no daemon was running");
      return (await spawnDaemonDetached(out)) ? 0 : 1;
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
      out(`Daemon running:  ${isDaemonRunning() ? "yes" : "no"}`);
      if (launchd.isMac())
        out(`launchd service: ${launchd.isLoaded() ? "loaded" : "not loaded"}`);
      return 0;
    }
    case "log": {
      const r = spawnSync("tail", ["-f", DAEMON_LOG_FILE], { stdio: "inherit" });
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
        const started = await restartDaemonForNewLogin(out);
        out("");
        out("Setup complete. Next step:");
        out("  In a Claude Code session, type: /wechat");
        if (started && !launchd.isInstalled()) {
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
      if (await login()) await restartDaemonForNewLogin(out);
      break;
    case "status":
      status();
      break;
    case "daemon":
      process.exitCode = await daemon(process.argv[3]);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
