// Claude Code's user settings (~/.claude/settings.json), which wechat-claude
// only touches to register the hook that lets `/wechat <name>` rename the
// session (see rename-hook.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), ".claude", "settings.json");

// Appended to the hook command as a shell comment, and how our entry is
// recognised on later runs. Not the script name: "rename-hook.js" is generic
// enough that a user's own hook could share it, and we would overwrite it.
// Not the full path either, so an upgrade that moved the install replaces the
// old entry instead of leaving a second hook pointing at nothing.
export const HOOK_TAG = "# wechat-claude:rename-hook";

type HookCommand = { type?: unknown; command?: unknown };
type HookGroup = { matcher?: unknown; hooks?: unknown };

// Entries written before the tag existed, by an npm install of this package:
// the path still says whose script it is.
const LEGACY_PATH = /[\\/]wechat-claude-sessions[\\/]dist[\\/]rename-hook\.js\b/;

function isOurs(h: unknown): boolean {
  if (typeof h !== "object" || h === null) return false;
  const cmd = (h as HookCommand).command;
  return typeof cmd === "string" && (cmd.includes(HOOK_TAG) || LEGACY_PATH.test(cmd));
}

export function renameHookCommand(scriptPath: string): string {
  // JSON.stringify quotes the path for the shell, spaces and all.
  return `node ${JSON.stringify(scriptPath)} ${HOOK_TAG}`;
}

// The settings object and its UserPromptSubmit groups, or null when the file
// is corrupt or shaped unlike Claude Code's — in which case nothing is written.
function load(
  file: string
): { settings: Record<string, unknown>; groups: unknown[] } | null {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return null;
      settings = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const hooks = settings.hooks ?? {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return null;
  const groups = (hooks as Record<string, unknown>).UserPromptSubmit ?? [];
  if (!Array.isArray(groups)) return null;
  settings.hooks = hooks;
  return { settings, groups };
}

function save(file: string, settings: Record<string, unknown>): boolean {
  // Write through a symlink, not over it: dotfile managers (stow, chezmoi,
  // home-manager) link settings.json into a repo, and renaming onto the link
  // would quietly detach it.
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {}
  // Temp file + rename: Claude Code reads this file live, and a partial write
  // would cost the user every other setting in it.
  const tmp = `${target}.wechat-claude.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}

// "already": an identical entry was there. "installed"/"updated": this call
// added it or replaced one pointing at another install. "failed": the file is
// corrupt or unwritable, and was left untouched.
export type HookInstallResult = "already" | "installed" | "updated" | "failed";

export function installRenameHook(
  command: string,
  file = CLAUDE_SETTINGS_FILE
): HookInstallResult {
  const loaded = load(file);
  if (!loaded) return "failed";
  const { settings, groups } = loaded;

  let found = false;
  let replaced = false;
  for (const g of groups as HookGroup[]) {
    if (!Array.isArray(g?.hooks)) continue;
    for (const h of g.hooks as unknown[]) {
      if (!isOurs(h)) continue;
      found = true;
      if ((h as HookCommand).command !== command) {
        (h as HookCommand).command = command;
        replaced = true;
      }
    }
  }
  if (found && !replaced) return "already";
  if (!found) groups.push({ hooks: [{ type: "command", command }] });
  (settings.hooks as Record<string, unknown>).UserPromptSubmit = groups;

  if (!save(file, settings)) return "failed";
  return found ? "updated" : "installed";
}

// Undoes installRenameHook. Once the package is gone the hook points at a
// script that no longer exists, and Claude Code would report it failing on
// every prompt of every session. Groups left empty are dropped with it.
export type HookRemoveResult = "removed" | "absent" | "failed";

export function removeRenameHook(file = CLAUDE_SETTINGS_FILE): HookRemoveResult {
  if (!fs.existsSync(file)) return "absent";
  const loaded = load(file);
  if (!loaded) return "failed";
  const { settings, groups } = loaded;

  let removed = false;
  const kept = (groups as HookGroup[]).filter((g) => {
    if (!Array.isArray(g?.hooks)) return true;
    const rest = (g.hooks as unknown[]).filter((h) => !isOurs(h));
    if (rest.length === g.hooks.length) return true;
    removed = true;
    g.hooks = rest;
    return rest.length > 0;
  });
  if (!removed) return "absent";

  const hooks = settings.hooks as Record<string, unknown>;
  if (kept.length > 0) hooks.UserPromptSubmit = kept;
  else delete hooks.UserPromptSubmit;
  return save(file, settings) ? "removed" : "failed";
}
