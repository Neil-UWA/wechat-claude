// Claude Code appends to a per-session transcript on every step it takes, so
// the transcript's mtime is a free "is this session still working?" signal.
// The daemon uses it to tell a busy session (long task, still writing) from a
// stalled one (rate-limited, writing nothing) before spending a probe.
//
// Which file matters: several Claude sessions can share a working directory,
// so the newest transcript in the project directory may belong to a different
// one — busy neighbours would mask a stalled target, and stale neighbours would
// fake a stall. The MCP server records its own transcript path (it knows its
// CLAUDE_CODE_SESSION_ID), and that exact file is used whenever it is
// available; the directory-wide guess is only a fallback for sessions
// registered by an older build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Claude Code's directory naming: every non-alphanumeric character in the
// absolute cwd becomes a dash.
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// Where Claude Code keeps the transcript of one session.
export function transcriptPath(
  cwd: string,
  claudeSessionId: string,
  projectsDir: string = PROJECTS_DIR
): string {
  return path.join(projectsDir, projectDirName(cwd), `${claudeSessionId}.jsonl`);
}

export function fileMtime(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
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
  session: { cwd: string; transcript?: string },
  idleMs: number,
  now: number = Date.now(),
  projectsDir: string = PROJECTS_DIR
): boolean {
  const own = session.transcript ? fileMtime(session.transcript) : undefined;
  // Only fall back to the directory-wide guess when this session's own
  // transcript is unknown — otherwise a neighbour's activity would hide it.
  const mtime = own ?? latestTranscriptMtime(session.cwd, projectsDir);
  if (mtime === undefined) return false;
  return now - mtime >= idleMs;
}
