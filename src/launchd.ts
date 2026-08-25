// launchd service management (macOS). Generates the daemon plist from the
// packaged template, filling in this machine's node binary, install path, log
// path, and PATH — so it works the same whether the package was installed
// globally from npm or built from a git checkout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pkgFile } from "./pkg-root.js";
import { WECHAT_DIR } from "./paths.js";

export const LABEL = "com.wechat-claude.daemon";
export const PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${LABEL}.plist`
);

// Include the node binary's own directory plus common tool locations so the
// daemon can find `claude`, `tmux`, etc. under launchd's minimal environment.
function daemonPath(): string {
  const pathEntries = [
    path.dirname(process.execPath),
    path.join(os.homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return [...new Set(pathEntries)].join(":");
}

export function writePlist(): string {
  const template = pkgFile("com.wechat-claude.daemon.plist.template");
  const daemonJs = fileURLToPath(new URL("./daemon.js", import.meta.url));
  const logPath = path.join(WECHAT_DIR, "daemon.log");

  const filled = fs
    .readFileSync(template, "utf-8")
    .replaceAll("__NODE__", process.execPath)
    .replaceAll("__DAEMON_JS__", daemonJs)
    .replaceAll("__LOG__", logPath)
    .replaceAll("__PATH__", daemonPath());

  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.writeFileSync(PLIST_PATH, filled);
  return PLIST_PATH;
}

function launchctl(...args: string[]): boolean {
  return spawnSync("launchctl", args, { stdio: "ignore" }).status === 0;
}

export function isMac(): boolean {
  return process.platform === "darwin";
}

export function load(): boolean {
  // Unload first so `install` is idempotent — a reload picks up a plist whose
  // node path changed (nvm switch, npm -g upgrade to a new prefix).
  launchctl("unload", PLIST_PATH);
  return launchctl("load", PLIST_PATH);
}

export function unload(): boolean {
  return launchctl("unload", PLIST_PATH);
}

export function isLoaded(): boolean {
  const r = spawnSync("launchctl", ["list"], { encoding: "utf-8" });
  return (r.stdout ?? "").includes(LABEL);
}
