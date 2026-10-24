// Reading and rewriting JSON files that belong to someone else — Claude Code's
// ~/.claude.json and ~/.claude/settings.json. Claude Code reads and writes
// both while running, and they hold everything else the user has configured,
// so the one rule is: never leave them half-written or quietly displaced.

import fs from "node:fs";
import path from "node:path";

// The file's top-level object, or null when it is missing, unreadable, not
// JSON, or not an object. Callers that must tell "missing" from "corrupt"
// check existence first: writing over a corrupt file loses whatever it held.
export function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {}
  return null;
}

// Replace `file` with `value`, all at once or not at all. Returns false, with
// the file untouched, when anything fails.
//
// - Temp file + rename, so a reader never sees a partial write.
// - Through a symlink, not over it: dotfile managers (stow, chezmoi,
//   home-manager) link these files into a repo, and renaming onto the link
//   would quietly detach it.
// - The existing permissions are kept; a new file gets 0644.
export function writeJsonAtomic(file: string, value: unknown): boolean {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {}
  const tmp = `${target}.wechat-claude.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}
