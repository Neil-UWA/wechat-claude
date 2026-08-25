// Claude Code's own config (~/.claude.json), which wechat-claude only touches
// to keep unattended /run tasks from stalling.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLAUDE_CONFIG_FILE = path.join(os.homedir(), ".claude.json");

const BYPASS_KEY = "bypassPermissionsModeAccepted";

function readConfig(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {}
  return null;
}

export function isBypassAccepted(file = CLAUDE_CONFIG_FILE): boolean {
  return readConfig(file)?.[BYPASS_KEY] === true;
}

// `claude --dangerously-skip-permissions` shows a one-time interactive consent
// dialog until this flag is set. A /run task starts detached in tmux with
// nobody to answer it, so the session would sit on that prompt forever.
// Returns true when this call is what accepted it (worth reporting once).
export function ensureBypassAccepted(file = CLAUDE_CONFIG_FILE): boolean {
  const config = readConfig(file);
  if (config === null || config[BYPASS_KEY] === true) return false;

  config[BYPASS_KEY] = true;

  // Write via a temp file in the same directory and rename: Claude Code writes
  // this file too, and a partial write would cost the user their whole config.
  const tmp = `${file}.wechat-claude.${process.pid}.tmp`;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}
