// Claude Code's user settings (~/.claude/settings.json), which wechat-claude
// only touches to register the hook that lets `/wechat <name>` rename the
// session (see rename-hook.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), ".claude", "settings.json");

// How our entry is recognised on later runs — by script name, not full path,
// so an upgrade that moved the install replaces the old entry instead of
// leaving a second hook pointing at a path that no longer exists.
const HOOK_MARKER = "rename-hook.js";

type HookCommand = { type?: unknown; command?: unknown };
type HookGroup = { matcher?: unknown; hooks?: unknown };

function isOurs(h: HookCommand): boolean {
  return typeof h.command === "string" && h.command.includes(HOOK_MARKER);
}

// "already": an identical entry was there. "installed"/"updated": this call
// added it or replaced one pointing at another install. "failed": the file is
// corrupt or unwritable, and was left untouched.
export type HookInstallResult = "already" | "installed" | "updated" | "failed";

export function installRenameHook(
  command: string,
  file = CLAUDE_SETTINGS_FILE
): HookInstallResult {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return "failed";
      settings = parsed as Record<string, unknown>;
    } catch {
      return "failed";
    }
  }

  const hooks = settings.hooks ?? {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return "failed";
  const byEvent = hooks as Record<string, unknown>;
  const groups = byEvent.UserPromptSubmit ?? [];
  if (!Array.isArray(groups)) return "failed";

  let found = false;
  let replaced = false;
  for (const g of groups as HookGroup[]) {
    if (!Array.isArray(g?.hooks)) continue;
    for (const h of g.hooks as HookCommand[]) {
      if (!isOurs(h)) continue;
      found = true;
      if (h.command !== command) {
        h.command = command;
        replaced = true;
      }
    }
  }
  if (found && !replaced) return "already";
  if (!found) groups.push({ hooks: [{ type: "command", command }] });
  byEvent.UserPromptSubmit = groups;
  settings.hooks = byEvent;

  // Temp file + rename: Claude Code reads this file live, and a partial write
  // would cost the user every other setting in it.
  const tmp = `${file}.wechat-claude.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode });
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return "failed";
  }
  return found ? "updated" : "installed";
}
