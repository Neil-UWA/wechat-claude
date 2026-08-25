#!/usr/bin/env node
// Generate com.wechat-claude.daemon.plist from the template, filling in this
// machine's node binary, repo path, log path, and PATH. Prints the path to the
// generated file. Used by `npm run daemon:install`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const templatePath = path.join(repoRoot, "com.wechat-claude.daemon.plist.template");
const outPath = path.join(repoRoot, "com.wechat-claude.daemon.plist");
const daemonJs = path.join(repoRoot, "dist", "daemon.js");
const logPath = path.join(os.homedir(), ".claude", "wechat", "daemon.log");

// Include the node binary's own directory plus common tool locations so the
// daemon can find `claude`, `tmux`, etc. under launchd's minimal environment.
const nodeDir = path.dirname(process.execPath);
const pathEntries = [
  nodeDir,
  path.join(os.homedir(), ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

const filled = fs
  .readFileSync(templatePath, "utf-8")
  .replaceAll("__NODE__", process.execPath)
  .replaceAll("__DAEMON_JS__", daemonJs)
  .replaceAll("__LOG__", logPath)
  .replaceAll("__PATH__", [...new Set(pathEntries)].join(":"));

fs.writeFileSync(outPath, filled);
process.stdout.write(outPath + "\n");
