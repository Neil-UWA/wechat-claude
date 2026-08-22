import fs from "node:fs";
import path from "node:path";
import { isMonitoring } from "./monitoring.js";
import { INBOX_DIR, SESSIONS_DIR, isProcessAlive } from "./paths.js";
import { assignSessionNumbers } from "./session-numbers.js";

export type SessionInfo = {
  id: string;
  name: string;
  cwd: string;
  pid: number;
  lastActive: number;
};

// Derive a human-friendly session name from a working directory:
// "repo:branch" for a git repo, "repo/worktree" for a worktree, else basename.
export function detectSessionName(cwd: string): string {
  const worktreeMatch = cwd.match(/\.claude[/\\]worktrees[/\\]([^/\\]+)/);
  if (worktreeMatch) {
    const repoPath = cwd
      .split(/\.claude[/\\]worktrees[/\\]/)[0]
      .replace(/[/\\]$/, "");
    return `${path.basename(repoPath)}/${worktreeMatch[1]}`;
  }
  const repoName = path.basename(cwd);
  try {
    let gitDir = path.join(cwd, ".git");
    const gitStat = fs.statSync(gitDir);
    if (!gitStat.isDirectory()) {
      const content = fs.readFileSync(gitDir, "utf-8").trim();
      const m = content.match(/gitdir:\s*(.+)/);
      if (m) gitDir = path.resolve(cwd, m[1]);
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf-8").trim();
    const branchMatch = head.match(/ref:\s*refs\/heads\/(.+)/);
    if (branchMatch) return `${repoName}:${branchMatch[1]}`;
  } catch {}
  return repoName || "session";
}

export function writeSessionFile(info: SessionInfo): void {
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${info.id}.json`),
    JSON.stringify(info)
  );
}

// Live sessions, cleaning up files for dead processes. Sorted by pid.
export function listSessions(): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  try {
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const info = JSON.parse(
          fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8")
        ) as SessionInfo;
        if (isProcessAlive(info.pid)) {
          sessions.push(info);
        } else {
          fs.unlinkSync(path.join(SESSIONS_DIR, file));
          try {
            fs.unlinkSync(path.join(INBOX_DIR, file));
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return sessions.sort((a, b) => a.pid - b.pid);
}

// Listing/selection order: monitored sessions first, stable pid order within
// each group. /sessions numbering and "/s <number>" both use this order.
export function sortedSessions(): SessionInfo[] {
  return listSessions().sort((a, b) => {
    const ma = isMonitoring(a.id) ? 1 : 0;
    const mb = isMonitoring(b.id) ? 1 : 0;
    if (ma !== mb) return mb - ma;
    return a.pid - b.pid;
  });
}

// Where a plain (non-command) message goes: prefer monitored sessions, then
// the most recently active among them.
export function getDefaultTarget(
  sessions: SessionInfo[]
): SessionInfo | undefined {
  const monitored = sessions.filter((s) => isMonitoring(s.id));
  const pool = monitored.length > 0 ? monitored : sessions;
  if (pool.length === 0) return undefined;
  return pool.reduce((a, b) => (a.lastActive > b.lastActive ? a : b));
}

// Resolve a selector (stable number, pid, exact name, or fuzzy substring) to a
// single session. On an ambiguous name, prefer monitored then most-recent.
export function findSession(selector: string): SessionInfo | undefined {
  const sessions = sortedSessions();
  const num = parseInt(selector, 10);
  if (!isNaN(num) && String(num) === selector) {
    const numbers = assignSessionNumbers(sessions.map((s) => s.id));
    const byNum = sessions.find((s) => numbers[s.id] === num);
    if (byNum) return byNum;
  }
  const byPid = sessions.find((s) => String(s.pid) === selector);
  if (byPid) return byPid;
  const lower = selector.toLowerCase();
  const exact = sessions.filter((s) => s.name.toLowerCase() === lower);
  const pool =
    exact.length > 0
      ? exact
      : sessions.filter((s) => s.name.toLowerCase().includes(lower));
  if (pool.length === 0) return undefined;
  if (pool.length === 1) return pool[0];
  const monitored = pool.filter((s) => isMonitoring(s.id));
  const finalPool = monitored.length > 0 ? monitored : pool;
  return finalPool.reduce((a, b) => (a.lastActive > b.lastActive ? a : b));
}

// All sessions matching a selector (number and pid are unique; a name can
// match several) — used by /close for batch operations.
export function matchSessions(selector: string): SessionInfo[] {
  const sessions = sortedSessions();
  const num = parseInt(selector, 10);
  if (!isNaN(num) && String(num) === selector) {
    const numbers = assignSessionNumbers(sessions.map((s) => s.id));
    const byNum = sessions.filter((s) => numbers[s.id] === num);
    if (byNum.length > 0) return byNum;
  }
  const byPid = sessions.filter((s) => String(s.pid) === selector);
  if (byPid.length > 0) return byPid;
  const lower = selector.toLowerCase();
  const exact = sessions.filter((s) => s.name.toLowerCase() === lower);
  if (exact.length > 0) return exact;
  return sessions.filter((s) => s.name.toLowerCase().includes(lower));
}

// Display label; appends #pid when the name is shared by multiple sessions.
export function sessionLabel(s: SessionInfo, all: SessionInfo[]): string {
  const dup = all.filter((o) => o.name === s.name).length > 1;
  return dup ? `${s.name}#${s.pid}` : s.name;
}
