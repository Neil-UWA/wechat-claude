// Reading and rewriting JSON files that belong to someone else — Claude Code's
// ~/.claude.json and ~/.claude/settings.json. Claude Code reads and writes
// both while running, and they hold everything else the user has configured,
// so the one rule is: never leave them half-written or quietly displaced.

import fs from "node:fs";
import path from "node:path";

// The file a path finally names, following symlinks even when the last one
// dangles (realpath fails on those). Null on a loop (or an absurdly long
// chain): falling back to the path itself would rename over the link.
function resolveLinks(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {}
  let p = file;
  for (let i = 0; i < 32; i++) {
    let link: string;
    try {
      link = fs.readlinkSync(p);
    } catch {
      return p;
    }
    p = path.resolve(path.dirname(p), link);
  }
  return null;
}

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

// As readJsonObject, but a missing file reads as {} — told apart from a
// corrupt one by the read itself, not by an earlier existsSync that another
// writer could make stale. A dangling symlink is missing too; writing then
// creates its target.
export function readJsonObjectOrEmpty(file: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
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
//   would quietly detach it. That includes a link whose target does not
//   exist yet.
// - The existing permissions are kept exactly (~/.claude.json is 0600); a
//   new file gets 0644.
//
// An object only: JSON.stringify(undefined) is undefined, and the file would
// end up holding the word "undefined" in place of the user's config.
export function writeJsonAtomic(file: string, value: Record<string, unknown>): boolean {
  const target = resolveLinks(file);
  if (target === null) return false;
  const tmp = `${target}.wechat-claude.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644;
    // A temp file left by a crashed run under a reused pid would keep its
    // own mode — writeFileSync's `mode` only applies on creation.
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
    // And on creation the umask narrows it (0664 would come out 0644).
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}
