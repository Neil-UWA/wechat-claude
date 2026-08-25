#!/usr/bin/env node
// wechat-claude CLI: one-command setup, login, and status.
//
//   npx wechat-claude setup    register MCP server + slash command, then login
//   npx wechat-claude login    (re)authenticate by scanning a QR code
//   npx wechat-claude status   show daemon / login state
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ILinkClient } from "./ilink.js";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WECHAT_DIR = path.join(os.homedir(), ".claude", "wechat");
const DAEMON_PID_FILE = path.join(WECHAT_DIR, "daemon.pid");

function out(s: string): void {
  process.stdout.write(s + "\n");
}

function run(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return r.status === 0;
}

function registerMcpServer(): void {
  const serverJs = path.join(repoRoot, "dist", "server.js");
  out(`→ Registering MCP server (claude mcp add wechat)…`);
  const ok = run("claude", [
    "mcp",
    "add",
    "--scope",
    "user",
    "wechat",
    "node",
    serverJs,
  ]);
  out(ok ? "  ✓ registered" : "  ! failed (is the `claude` CLI on your PATH?)");
}

function installSlashCommand(): void {
  const src = path.join(repoRoot, ".claude", "commands", "wechat.md");
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
  out(`Data dir:       ${WECHAT_DIR}`);
  if (!loggedIn) out("\nRun `npx wechat-claude login` to authenticate.");
  else if (!daemonRunning()) out("\nStart the daemon with `npm run daemon` (or it auto-starts via /wechat).");
}

function usage(): void {
  out("wechat-claude — control Claude Code from WeChat\n");
  out("Usage:");
  out("  wechat-claude setup    register MCP server + /wechat command, then log in");
  out("  wechat-claude login    (re)authenticate by scanning a QR code");
  out("  wechat-claude status   show daemon / login state\n");
  out("After setup: start the daemon (`npm run daemon` or `npm run daemon:install`),");
  out("then type /wechat in a Claude Code session.");
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
        out("  1. Start the daemon:   npm run daemon   (or npm run daemon:install for auto-start)");
        out("  2. In a Claude Code session, type: /wechat");
      } else {
        out("Setup finished with login pending — run `npx wechat-claude login` to retry.");
      }
      break;
    }
    case "login":
      await login();
      break;
    case "status":
      status();
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
