// Claude Code's own config (~/.claude.json), which wechat-claude only touches
// to keep unattended /run tasks from stalling.
import os from "node:os";
import path from "node:path";
import { readJsonObject, writeJsonAtomic } from "./json-file.js";

export const CLAUDE_CONFIG_FILE = path.join(os.homedir(), ".claude.json");

const BYPASS_KEY = "bypassPermissionsModeAccepted";

export function isBypassAccepted(file = CLAUDE_CONFIG_FILE): boolean {
  return readJsonObject(file)?.[BYPASS_KEY] === true;
}

// "already": the flag was set before we looked — nothing to report.
// "accepted": this call set it, which the caller should surface once.
// "failed": the config is missing, corrupt, or unwritable. The caller must NOT
// launch an unattended session: it would stop at the consent dialog forever.
export type BypassResult = "already" | "accepted" | "failed";

// `claude --dangerously-skip-permissions` shows a one-time interactive consent
// dialog until this flag is set. A /run task starts detached in tmux with
// nobody to answer it, so the session would sit on that prompt forever.
export function ensureBypassAccepted(file = CLAUDE_CONFIG_FILE): BypassResult {
  const config = readJsonObject(file);
  if (config === null) return "failed";
  if (config[BYPASS_KEY] === true) return "already";

  config[BYPASS_KEY] = true;
  if (!writeJsonAtomic(file, config)) return "failed";

  // Confirm from disk rather than trusting the write: a concurrent writer may
  // have replaced the file between our read and our rename.
  return isBypassAccepted(file) ? "accepted" : "failed";
}
