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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");

export type ClaudeSessionRecord = {
  pid: number;
  name: string;
  sessionId?: string;
  cwd?: string;
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
  };
}

// The cross-session name of the Claude Code process that owns an MCP server
// (its process.ppid), or undefined when it can't be established. When Claude
// Code told us its session id (CLAUDE_CODE_SESSION_ID), a record with a
// different id is rejected — pids get reused, and a stale file must not lend
// us a stranger's name. Callers pass the process values explicitly; defaults
// here would silently kick back in whenever a caller passes undefined.
export function ownClaudeSessionName(
  claudePid: number,
  claudeSessionId: string | undefined,
  sessionsDir: string = CLAUDE_SESSIONS_DIR
): string | undefined {
  const rec = readClaudeSession(claudePid, sessionsDir);
  if (!rec) return undefined;
  if (claudeSessionId && rec.sessionId && rec.sessionId !== claudeSessionId) {
    return undefined;
  }
  return rec.name;
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
