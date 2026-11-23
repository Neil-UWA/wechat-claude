// Claude Code keeps its own registry of live sessions at
// ~/.claude/sessions/<claude pid>.json. Among other things it records the
// name other Claude sessions use to reach this one via SendMessage/ListAgents
// (e.g. "fintary-a9"). That name is a different namespace from the WeChat
// routing name in ~/.claude/wechat/sessions — the two look alike, and an agent
// that reads one list will happily use those names against the other tool.
// Surfacing both side by side is the fix; this module reads the Claude side.
//
// An MCP server is spawned by Claude Code, so its parent pid is the Claude
// pid: process.ppid for ourselves, `ps` for other sessions. That link is
// exact. Matching by working directory is not — a Claude session can move into
// a worktree after its MCP server started — so it is deliberately not used.
//
// The file format is Claude Code's, not ours: read defensively and return
// undefined for anything that doesn't look right.
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isProcessAlive } from "./paths.js";

export const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");

export type ClaudeSessionRecord = {
  pid: number;
  name: string;
  sessionId?: string;
  cwd?: string;
  // "<session>:@<window>.%<pane>" when the session runs inside tmux — the one
  // place keystrokes can be delivered to it from outside (see attach.ts).
  tmux?: string;
  // Claude Code's own activity state: "idle" (waiting at the prompt), "busy",
  // "waiting" (a dialog is open), among others.
  status?: string;
  // The socket other sessions' SendMessage delivers to (see relay.ts).
  messagingSocketPath?: string;
};

export function readClaudeSession(
  claudePid: number,
  sessionsDir: string = CLAUDE_SESSIONS_DIR
): ClaudeSessionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(sessionsDir, `${claudePid}.json`), "utf-8")
    );
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.name !== "string" || rec.name.trim() === "") return undefined;
  if (rec.pid !== undefined && rec.pid !== claudePid) return undefined;
  return {
    pid: claudePid,
    name: rec.name,
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : undefined,
    cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
    tmux: typeof rec.tmux === "string" && rec.tmux !== "" ? rec.tmux : undefined,
    status: typeof rec.status === "string" ? rec.status : undefined,
    messagingSocketPath:
      typeof rec.messagingSocketPath === "string" && rec.messagingSocketPath !== ""
        ? rec.messagingSocketPath
        : undefined,
  };
}

// The cross-session name of the Claude Code process that owns an MCP server
// (its process.ppid), or undefined when it can't be established. The record
// is trusted on the strength of the pid alone: the parent is alive and is by
// construction the Claude process. Do NOT cross-check CLAUDE_CODE_SESSION_ID
// against the record's sessionId — on `claude --resume` the MCP server is
// spawned with a fresh id before Claude Code adopts the resumed one, so the
// two legitimately differ and the check reported "unknown" for a live session.
export function ownClaudeSessionName(
  claudePid: number,
  sessionsDir: string = CLAUDE_SESSIONS_DIR
): string | undefined {
  return readClaudeSession(claudePid, sessionsDir)?.name;
}

// Largest pid any supported platform hands out (Linux pid_max ceiling; macOS
// stops at 99999). macOS `ps` rejects the whole request over one oversized pid.
const MAX_PID = 4_194_304;

function psParents(pids: number[], out: Map<number, number>): boolean {
  const res = spawnSync("ps", ["-o", "pid=,ppid=", "-p", pids.join(",")], {
    encoding: "utf-8",
  });
  if (typeof res.stdout !== "string") return false;
  let any = false;
  for (const line of res.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) {
      out.set(Number(m[1]), Number(m[2]));
      any = true;
    }
  }
  return any;
}

// Parent pid of each given pid, normally in one `ps` call (argv array, no
// shell). Pids that are gone, or a failing `ps`, are simply absent from the
// result. If a batch comes back empty (one bad pid can sink the whole call on
// some platforms) the pids are retried one at a time.
export function parentPids(pids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  const wanted = pids.filter(
    (p) => Number.isInteger(p) && p > 0 && p <= MAX_PID
  );
  if (wanted.length === 0) return out;
  if (!psParents(wanted, out) && wanted.length > 1) {
    for (const p of wanted) psParents([p], out);
  }
  return out;
}

// Claude Code's record for each WeChat session, keyed by WeChat session id,
// resolved through the MCP server's parent pid in one `ps` call. Besides the
// cross-session name this carries Claude's *current* working directory — the
// WeChat session file only knows where the MCP server started, which stops
// being true the moment Claude moves into a worktree.
export function claudeRecordsForSessions(
  sessions: { id: string; pid: number }[],
  sessionsDir: string = CLAUDE_SESSIONS_DIR,
  parents: Map<number, number> = parentPids(sessions.map((s) => s.pid))
): Map<string, ClaudeSessionRecord> {
  const out = new Map<string, ClaudeSessionRecord>();
  for (const s of sessions) {
    const claudePid = parents.get(s.pid);
    if (claudePid === undefined) continue;
    const rec = readClaudeSession(claudePid, sessionsDir);
    if (rec) out.set(s.id, rec);
  }
  return out;
}

// Claude Code name of the session whose MCP server has pid `mcpPid`, for
// sessions that did not record it themselves (registered by an older build).
export function claudeNameForMcpPid(
  mcpPid: number,
  parents: Map<number, number>,
  sessionsDir: string = CLAUDE_SESSIONS_DIR
): string | undefined {
  const claudePid = parents.get(mcpPid);
  if (claudePid === undefined) return undefined;
  return readClaudeSession(claudePid, sessionsDir)?.name;
}

// The pid of the live Claude Code process running session `sessionId`, found
// by its own registry record. For callers that know only the session id — a
// hook, whose parent may be a shell rather than Claude itself. A crashed
// Claude leaves its record behind, and `claude --resume` then writes a second
// one with the same session id, so dead pids are skipped.
export function claudePidForSessionId(
  sessionId: string,
  sessionsDir: string = CLAUDE_SESSIONS_DIR
): number | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir);
  } catch {
    return undefined;
  }
  for (const f of files) {
    const m = f.match(/^(\d+)\.json$/);
    if (!m) continue;
    const rec = readClaudeSession(Number(m[1]), sessionsDir);
    if (rec?.sessionId === sessionId && isProcessAlive(rec.pid)) return rec.pid;
  }
  return undefined;
}

// Every process's parent, from one asynchronous `ps -A` (argv array, no
// shell, time-limited): for walking a process's ancestry off the daemon's
// message path without one blocking `ps` per generation. Empty on failure.
export function processParents(timeoutMs: number = 3_000): Promise<Map<number, number>> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout: timeoutMs, encoding: "utf-8" }, (err, stdout) => {
      const out = new Map<number, number>();
      if (!err && typeof stdout === "string") {
        for (const line of stdout.split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(\d+)$/);
          if (m) out.set(Number(m[1]), Number(m[2]));
        }
      }
      resolve(out);
    });
  });
}
