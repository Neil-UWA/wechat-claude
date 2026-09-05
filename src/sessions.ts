import fs from "node:fs";
import path from "node:path";
import { claudeRecordsForSessions } from "./claude-sessions.js";
import { isMonitoring } from "./monitoring.js";
import { INBOX_DIR, SESSIONS_DIR, isProcessAlive } from "./paths.js";
import { assignSessionNumbers } from "./session-numbers.js";

export type SessionInfo = {
  id: string;
  name: string;
  cwd: string;
  pid: number;
  lastActive: number;
  // Absolute path to this session's Claude Code transcript, when the MCP
  // server could work it out. Lets the daemon tell whether *this* session is
  // still doing anything (see transcripts.ts). Absent for sessions registered
  // by an older build.
  transcript?: string;
  // The name Claude Code itself gives this session — what other Claude
  // sessions must pass to SendMessage (see claude-sessions.ts). Distinct from
  // `name`, which is the WeChat routing name. Absent when unknown.
  claudeName?: string;
};

// A routing name must survive `/s <name> <msg>`: the daemon takes the selector
// as one whitespace-free token, and tries numbers (stable session numbers,
// then pids) before names, so a purely numeric name is unreachable by name.
export type NameValidation =
  | { ok: true; name: string }
  | { ok: false; reason: string; suggestion?: string };

export function validateSessionName(raw: string): NameValidation {
  const name = raw.trim();
  if (name === "") return { ok: false, reason: "Session name is empty." };
  if (/\s/.test(name)) {
    return {
      ok: false,
      reason:
        "Session name must not contain whitespace — `/s <name> <msg>` reads the name as a single word.",
      suggestion: name.replace(/\s+/g, "-"),
    };
  }
  if (/^\d+$/.test(name)) {
    return {
      ok: false,
      reason:
        "Session name must not be purely numeric — `/s <number>` would read it as a session number or pid.",
      suggestion: `s${name}`,
    };
  }
  if (name.startsWith("/")) {
    return {
      ok: false,
      reason: "Session name must not start with '/'.",
      suggestion: name.replace(/^\/+/, ""),
    };
  }
  return { ok: true, name };
}

// Another live session already using this routing name (case-insensitive),
// excluding ourselves. Silent auto-suffixing would make `/s <name>` routing
// unpredictable, so callers refuse and point at the holder instead.
export function findNameConflict(
  name: string,
  selfId: string,
  sessions: SessionInfo[] = listSessions()
): SessionInfo | undefined {
  const lower = name.toLowerCase();
  return sessions.find(
    (s) => s.id !== selfId && s.name.toLowerCase() === lower
  );
}

// Current Claude Code names by WeChat session id, from Claude Code's own
// registry. Selectors resolve against these (what /ls and wechat_status just
// showed), falling back to the name stored in the session file when the
// registry can't be read.
export type LiveClaudeNames = Map<string, { name: string }>;

function claudeNameOf(s: SessionInfo, live: LiveClaudeNames): string | undefined {
  return live.get(s.id)?.name ?? s.claudeName;
}

// Names a selector may match, WeChat routing name first. The Claude Code name
// is accepted as an alias so whichever name the user saw in wechat_status
// works in `/s <name> <msg>`.
function namesOf(s: SessionInfo, live: LiveClaudeNames): string[] {
  const claude = claudeNameOf(s, live);
  return claude ? [s.name, claude] : [s.name];
}

function matchesFuzzy(s: SessionInfo, lower: string, live: LiveClaudeNames): boolean {
  return namesOf(s, live).some((n) => n.toLowerCase().includes(lower));
}

// Sessions whose name equals the selector: routing names first, and only if
// none matches, Claude Code aliases — so an alias can never shadow a session
// that actually goes by that routing name.
function exactMatches(
  sessions: SessionInfo[],
  lower: string,
  live: LiveClaudeNames
): SessionInfo[] {
  const byName = sessions.filter((s) => s.name.toLowerCase() === lower);
  if (byName.length > 0) return byName;
  return sessions.filter((s) => claudeNameOf(s, live)?.toLowerCase() === lower);
}

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

// Short display form of a working directory: "repo/worktree" for a Claude
// worktree, else the directory's basename.
export function cwdLabel(cwd: string): string {
  const worktreeMatch = cwd.match(/\.claude[/\\]worktrees[/\\]([^/\\]+)/);
  if (worktreeMatch) {
    const repoPath = cwd
      .split(/\.claude[/\\]worktrees[/\\]/)[0]
      .replace(/[/\\]$/, "");
    return `${path.basename(repoPath)}/${worktreeMatch[1]}`;
  }
  return path.basename(cwd) || cwd;
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
export function findSession(
  selector: string,
  liveNames?: LiveClaudeNames
): SessionInfo | undefined {
  const sessions = sortedSessions();
  const live = liveNames ?? claudeRecordsForSessions(sessions);
  const num = parseInt(selector, 10);
  if (!isNaN(num) && String(num) === selector) {
    const numbers = assignSessionNumbers(sessions.map((s) => s.id));
    const byNum = sessions.find((s) => numbers[s.id] === num);
    if (byNum) return byNum;
  }
  const byPid = sessions.find((s) => String(s.pid) === selector);
  if (byPid) return byPid;
  const lower = selector.toLowerCase();
  const exact = exactMatches(sessions, lower, live);
  const pool =
    exact.length > 0
      ? exact
      : sessions.filter((s) => matchesFuzzy(s, lower, live));
  if (pool.length === 0) return undefined;
  if (pool.length === 1) return pool[0];
  const monitored = pool.filter((s) => isMonitoring(s.id));
  const finalPool = monitored.length > 0 ? monitored : pool;
  return finalPool.reduce((a, b) => (a.lastActive > b.lastActive ? a : b));
}

// All sessions matching a selector (number and pid are unique; a name can
// match several) — used by /close for batch operations.
export function matchSessions(
  selector: string,
  liveNames?: LiveClaudeNames
): SessionInfo[] {
  const sessions = sortedSessions();
  const live = liveNames ?? claudeRecordsForSessions(sessions);
  const num = parseInt(selector, 10);
  if (!isNaN(num) && String(num) === selector) {
    const numbers = assignSessionNumbers(sessions.map((s) => s.id));
    const byNum = sessions.filter((s) => numbers[s.id] === num);
    if (byNum.length > 0) return byNum;
  }
  const byPid = sessions.filter((s) => String(s.pid) === selector);
  if (byPid.length > 0) return byPid;
  const lower = selector.toLowerCase();
  const exact = exactMatches(sessions, lower, live);
  if (exact.length > 0) return exact;
  return sessions.filter((s) => matchesFuzzy(s, lower, live));
}

// Display label. When several sessions share the name, disambiguate with the
// Claude Code cross-session name in parentheses — a name the user recognises
// from their terminal — falling back to #pid when that name is unknown.
export function sessionLabel(
  s: SessionInfo,
  all: SessionInfo[],
  claudeName: string | undefined = s.claudeName
): string {
  const dup = all.filter((o) => o.name === s.name).length > 1;
  if (!dup) return s.name;
  return claudeName ? `${s.name} (${claudeName})` : `${s.name}#${s.pid}`;
}
