// Claude Code appends to a per-session transcript on every step it takes, so
// the transcript's mtime is a free "is this session still working?" signal.
// The daemon uses it to tell a busy session (long task, still writing) from a
// stalled one (rate-limited, writing nothing) before spending a probe.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Claude Code's directory naming: every non-alphanumeric character in the
// absolute cwd becomes a dash.
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// Newest transcript mtime for a working directory, or undefined when there is
// no transcript directory (a fresh project, or a layout we don't recognise) —
// callers must treat undefined as "no information", not as "idle".
export function latestTranscriptMtime(
  cwd: string,
  projectsDir: string = PROJECTS_DIR
): number | undefined {
  const dir = path.join(projectsDir, projectDirName(cwd));
  let newest: number | undefined;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const file of entries) {
    if (!file.endsWith(".jsonl")) continue;
    try {
      const { mtimeMs } = fs.statSync(path.join(dir, file));
      if (newest === undefined || mtimeMs > newest) newest = mtimeMs;
    } catch {}
  }
  return newest;
}

// True when the session's transcript has been untouched for `idleMs` — i.e.
// Claude is not doing anything, despite having work waiting. Unknown
// transcripts count as idle-unknown (false) so we don't probe on every message.
export function looksStalled(
  cwd: string,
  idleMs: number,
  now: number = Date.now(),
  projectsDir: string = PROJECTS_DIR
): boolean {
  const mtime = latestTranscriptMtime(cwd, projectsDir);
  if (mtime === undefined) return false;
  return now - mtime >= idleMs;
}
