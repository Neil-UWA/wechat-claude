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
import { pkgFile } from "./pkg-root.js";
import { DAEMON_PID_FILE, WECHAT_DIR } from "./paths.js";
import * as launchd from "./launchd.js";

const DAEMON_JS = fileURLToPath(new URL("./daemon.js", import.meta.url));
const SERVER_JS = fileURLToPath(new URL("./server.js", import.meta.url));
const DAEMON_LOG = path.join(WECHAT_DIR, "daemon.log");

function out(s: string): void {
  process.stdout.write(s + "\n");
}

function run(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return r.status === 0;
}

function registerMcpServer(): void {
  out(`→ Registering MCP server (claude mcp add wechat)…`);
  const ok = run("claude", [
    "mcp",
    "add",
    "--scope",
    "user",
    "wechat",
    "node",
    SERVER_JS,
  ]);
  out(ok ? "  ✓ registered" : "  ! failed (is the `claude` CLI on your PATH?)");
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

function daemonRunning(): boolean {
  try {
    const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function status(): void {
  const client = new ILinkClient();
  const loggedIn = client.tryRestoreSession();
  out(`Logged in:      ${loggedIn ? "yes" : "no"}`);
  out(`Daemon running: ${daemonRunning() ? "yes" : "no"}`);
  if (launchd.isMac())
    out(`launchd service: ${launchd.isLoaded() ? "installed" : "not installed"}`);
  out(`Data dir:       ${WECHAT_DIR}`);
  if (!loggedIn) out("\nRun `wechat-claude login` to authenticate.");
  else if (!daemonRunning())
    out("\nStart the daemon with `wechat-claude daemon` (or it auto-starts via /wechat).");
}

function daemon(sub: string | undefined): number {
  switch (sub) {
    case undefined:
    case "run": {
      // Foreground: replace this process's stdio with the daemon's.
      const r = spawnSync(process.execPath, [DAEMON_JS], { stdio: "inherit" });
      return r.status ?? 1;
    }
    case "install": {
      if (!launchd.isMac()) {
        out("launchd is macOS-only. On Linux/Windows, supervise the daemon");
        out("yourself: `wechat-claude daemon` under systemd, pm2, or similar.");
        return 1;
      }
      const plist = launchd.writePlist();
      out(`→ Wrote ${plist}`);
      const ok = launchd.load();
      out(ok ? "  ✓ service loaded (starts at login, restarts on crash)" : "  ! launchctl load failed");
      return ok ? 0 : 1;
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
      out("Usage: wechat-claude daemon [run|install|uninstall|status|log]");
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
        out("Setup complete. Next steps:");
        out("  1. Start the daemon:   wechat-claude daemon install   (auto-start, macOS)");
        out("                         wechat-claude daemon           (foreground)");
        out("  2. In a Claude Code session, type: /wechat");
      } else {
        out("Setup finished with login pending — run `wechat-claude login` to retry.");
      }
      break;
    }
    case "login":
      await login();
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
