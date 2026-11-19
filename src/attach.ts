// Attaching WeChat to a session a message was sent to, when that session is
// not running a watcher. Without this the message sits in the inbox until
// someone goes to that terminal and types /wechat — which is exactly what the
// user, sending from their phone, cannot do.
//
// Claude Code offers no supported way to hand an interactive session a prompt
// from outside, so there are two routes, tried in this order:
//
// 1. The session runs inside tmux and sits idle at its prompt: type `/wechat`
//    into its pane. Only when idle — with a dialog open (a permission prompt),
//    the Enter would answer the dialog instead.
// 2. Anything else: leave an attach request on disk. The hook installed by
//    `wechat-claude setup` (attach-hook.ts) runs in every session on each tool
//    call and at the end of each turn; in the session the request names, it
//    tells Claude to start the watcher. A busy session therefore attaches
//    within one tool call. An idle session outside tmux has nothing running,
//    so it attaches when it next does anything.
import fs from "node:fs";
import path from "node:path";
import {
  type ClaudeSessionRecord,
  parentPids,
  readClaudeSession,
} from "./claude-sessions.js";
import { isMonitoring } from "./monitoring.js";
import { ATTACH_DIR, CONFIG_FILE } from "./paths.js";
import type { SessionInfo } from "./sessions.js";
import { hasTmux, paneIdOf, panePid, typeIntoPane } from "./tmux.js";

export type AttachRequest = {
  sessionId: string;
  claudePid: number;
  name: string;
  requestedAt: number;
};

export type AttachOutcome =
  | { kind: "monitoring" }
  | { kind: "disabled" }
  // Already typed or requested moments ago; the session is still starting up.
  | { kind: "pending" }
  | { kind: "typed"; pane: string }
  | { kind: "requested" }
  // Registered by an older build that did not record its Claude pid, so
  // neither route can find the session.
  | { kind: "unreachable" };

// `"autoAttach": false` in ~/.claude/wechat/config.json turns this off.
export function autoAttachEnabled(configFile: string = CONFIG_FILE): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    if (typeof parsed === "object" && parsed !== null) {
      return (parsed as Record<string, unknown>).autoAttach !== false;
    }
  } catch {}
  return true;
}

function requestFile(sessionId: string, dir: string): string {
  return path.join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function writeAttachRequest(req: AttachRequest, dir: string = ATTACH_DIR): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(requestFile(req.sessionId, dir), JSON.stringify(req));
  } catch {}
}

export function clearAttachRequest(sessionId: string, dir: string = ATTACH_DIR): void {
  try {
    fs.unlinkSync(requestFile(sessionId, dir));
  } catch {}
}

function parseRequest(raw: string): AttachRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const r = parsed as Record<string, unknown>;
  if (
    typeof r.sessionId !== "string" ||
    typeof r.claudePid !== "number" ||
    typeof r.name !== "string" ||
    typeof r.requestedAt !== "number"
  ) {
    return undefined;
  }
  return {
    sessionId: r.sessionId,
    claudePid: r.claudePid,
    name: r.name,
    requestedAt: r.requestedAt,
  };
}

// The request addressed to the Claude process `claudePid`, removed so it is
// acted on exactly once.
export function takeAttachRequest(
  claudePid: number,
  dir: string = ATTACH_DIR
): AttachRequest | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const file = path.join(dir, f);
    let req: AttachRequest | undefined;
    try {
      req = parseRequest(fs.readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    if (req?.claudePid !== claudePid) continue;
    try {
      fs.unlinkSync(file);
    } catch {
      // Another hook in the same session got there first.
      continue;
    }
    return req;
  }
  return undefined;
}

export function hasAttachRequests(dir: string = ATTACH_DIR): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

// How many process generations a pane's own pid may sit above Claude: the pane
// runs a shell, which may run a wrapper, which runs claude.
const MAX_PANE_DEPTH = 6;

// True when `ancestor` is `pid` or one of its parents. Guards against typing
// into the wrong pane: pane ids are per tmux server, and the one recorded may
// belong to a server other than the default one this daemon talks to.
export function isAncestor(
  ancestor: number,
  pid: number,
  parentOf: (pid: number) => number | undefined = (p) => parentPids([p]).get(p)
): boolean {
  let cur: number | undefined = pid;
  for (let i = 0; i <= MAX_PANE_DEPTH && cur !== undefined && cur > 1; i++) {
    if (cur === ancestor) return true;
    cur = parentOf(cur);
  }
  return false;
}

// The pane `/wechat` can safely be typed into, or undefined.
export function typablePane(
  rec: ClaudeSessionRecord,
  deps: {
    hasTmux: () => boolean;
    panePid: (paneId: string) => number | undefined;
    isAncestor: (ancestor: number, pid: number) => boolean;
  } = { hasTmux, panePid, isAncestor: (a, p) => isAncestor(a, p) }
): string | undefined {
  if (rec.status !== "idle" || !rec.tmux) return undefined;
  const pane = paneIdOf(rec.tmux);
  if (!pane || !deps.hasTmux()) return undefined;
  const pid = deps.panePid(pane);
  if (pid === undefined || !deps.isAncestor(pid, rec.pid)) return undefined;
  return pane;
}

// A watcher takes a few seconds to start after /wechat runs; within this
// window a second message must not type /wechat again.
export const ATTACH_GRACE_MS = 120_000;

const recentAttempts = new Map<string, number>();

export type AttachDeps = {
  enabled: () => boolean;
  isMonitoring: (sessionId: string) => boolean;
  readRecord: (claudePid: number) => ClaudeSessionRecord | undefined;
  typablePane: (rec: ClaudeSessionRecord) => string | undefined;
  typeIntoPane: (pane: string, text: string) => string | null;
  writeRequest: (req: AttachRequest) => void;
  now: () => number;
  attempts: Map<string, number>;
};

const defaultDeps: AttachDeps = {
  enabled: () => autoAttachEnabled(),
  isMonitoring: (id) => isMonitoring(id),
  readRecord: (pid) => readClaudeSession(pid),
  typablePane: (rec) => typablePane(rec),
  typeIntoPane,
  writeRequest: (req) => writeAttachRequest(req),
  now: Date.now,
  attempts: recentAttempts,
};

export function attachSession(
  session: SessionInfo,
  deps: AttachDeps = defaultDeps
): AttachOutcome {
  if (deps.isMonitoring(session.id)) return { kind: "monitoring" };
  if (!deps.enabled()) return { kind: "disabled" };
  const now = deps.now();
  const last = deps.attempts.get(session.id);
  if (last !== undefined && now - last < ATTACH_GRACE_MS) return { kind: "pending" };
  if (session.claudePid === undefined) return { kind: "unreachable" };

  deps.attempts.set(session.id, now);
  const rec = deps.readRecord(session.claudePid);
  const pane = rec ? deps.typablePane(rec) : undefined;
  if (pane && deps.typeIntoPane(pane, "/wechat") === null) {
    return { kind: "typed", pane };
  }
  deps.writeRequest({
    sessionId: session.id,
    claudePid: session.claudePid,
    name: session.name,
    requestedAt: now,
  });
  return { kind: "requested" };
}
