// Attaching WeChat to a session a message was sent to, when that session is
// not running a watcher. Without this the message sits in the inbox until
// someone goes to that terminal and types /wechat — which is exactly what the
// user, sending from their phone, cannot do.
//
// Claude Code offers no supported way to hand an interactive session a prompt
// from outside, so there are three routes, tried in this order:
//
// 1. The session runs inside tmux and sits idle at an empty prompt: type
//    `/wechat` into its pane. Free and instant. Only when idle — with a dialog
//    open (a permission prompt), the Enter would answer the dialog — and only
//    when the input box is visibly empty, or the Enter would submit the
//    user's unsent draft with `/wechat` stuck on the end.
// 2. The session has a messaging socket: a headless `claude -p` sends it the
//    instruction with SendMessage (relay.ts). Reaches idle and busy sessions
//    alike, at the cost of one small model call.
// 3. The relay is unavailable or failed: leave an attach request on disk. The
//    hook installed by `wechat-claude setup` (attach-hook.ts) runs in every
//    session on each tool call and at the end of each turn; in the session the
//    request names, it tells Claude to attach. An idle session picks it up the
//    next time it does anything.
import fs from "node:fs";
import path from "node:path";
import {
  type ClaudeSessionRecord,
  processParents,
  readClaudeSession,
} from "./claude-sessions.js";
import { attachInstruction } from "./attach-hook.js";
import { isMonitoring } from "./monitoring.js";
import { ATTACH_DIR, CONFIG_FILE, isProcessAlive } from "./paths.js";
import { isSocketPath, relayMessage } from "./relay.js";
import type { SessionInfo } from "./sessions.js";
import { capturePane, paneIdOf, panePid, promptIsEmpty, typeIntoPane } from "./tmux.js";

export type AttachRequest = {
  sessionId: string;
  claudePid: number;
  // The WeChat MCP server's pid (SessionInfo.pid). It dies with the Claude
  // process, so a request whose MCP server is gone is stale even if a new
  // process has since been handed the same Claude pid.
  mcpPid?: number;
  name: string;
  requestedAt: number;
};

// An idle session may not act for hours, and the request is still wanted when
// it does — but not forever: past this, the message is old news.
export const ATTACH_REQUEST_TTL_MS = 6 * 60 * 60_000;

export type AttachOutcome =
  | { kind: "monitoring" }
  | { kind: "disabled" }
  // Already typed or requested moments ago; the session is still starting up.
  | { kind: "pending"; since: number }
  | { kind: "typed"; pane: string }
  // A relay is on its way; `done` settles with whether it was delivered (a
  // failed relay has already fallen back to an attach request by then).
  | { kind: "relaying"; done: Promise<boolean> }
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
    mcpPid: typeof r.mcpPid === "number" ? r.mcpPid : undefined,
    name: r.name,
    requestedAt: r.requestedAt,
  };
}

export type StaleCheck = {
  now: () => number;
  isAlive: (pid: number) => boolean;
};

const liveCheck: StaleCheck = { now: Date.now, isAlive: isProcessAlive };

// A request nobody will ever take: too old, or its session has exited (the
// terminal was closed before the session made another move). Left on disk it
// would keep every session's hook off its fast path, and could be handed to an
// unrelated process that later gets the same pid.
export function isStale(req: AttachRequest, check: StaleCheck = liveCheck): boolean {
  if (check.now() - req.requestedAt > ATTACH_REQUEST_TTL_MS) return true;
  if (!check.isAlive(req.claudePid)) return true;
  if (req.mcpPid !== undefined && !check.isAlive(req.mcpPid)) return true;
  return false;
}

// Remove stale and unreadable requests; for the daemon's periodic sweep.
export function pruneAttachRequests(
  dir: string = ATTACH_DIR,
  check: StaleCheck = liveCheck
): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
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
    if (!req || isStale(req, check)) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
}

// The request addressed to the Claude process `claudePid`, removed so it is
// acted on exactly once. Stale requests met along the way are removed too.
export function takeAttachRequest(
  claudePid: number,
  dir: string = ATTACH_DIR,
  check: StaleCheck = liveCheck
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
    if (!req) continue;
    if (isStale(req, check)) {
      try {
        fs.unlinkSync(file);
      } catch {}
      continue;
    }
    if (req.claudePid !== claudePid) continue;
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
  parentOf: (pid: number) => number | undefined
): boolean {
  let cur: number | undefined = pid;
  for (let i = 0; i <= MAX_PANE_DEPTH && cur !== undefined && cur > 1; i++) {
    if (cur === ancestor) return true;
    cur = parentOf(cur);
  }
  return false;
}

export type PaneDeps = {
  panePid: (paneId: string) => Promise<number | undefined>;
  processParents: () => Promise<Map<number, number>>;
  capturePane: (paneId: string) => Promise<string | undefined>;
};

const defaultPaneDeps: PaneDeps = {
  panePid,
  processParents: () => processParents(),
  capturePane,
};

// The pane `/wechat` can safely be typed into, or undefined.
export async function typablePane(
  rec: ClaudeSessionRecord,
  deps: PaneDeps = defaultPaneDeps
): Promise<string | undefined> {
  if (rec.status !== "idle" || !rec.tmux) return undefined;
  const pane = paneIdOf(rec.tmux);
  if (!pane) return undefined;
  const pid = await deps.panePid(pane);
  if (pid === undefined) return undefined;
  const parents = await deps.processParents();
  if (!isAncestor(pid, rec.pid, (p) => parents.get(p))) return undefined;
  const screen = await deps.capturePane(pane);
  if (screen === undefined || !promptIsEmpty(screen)) return undefined;
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
  typablePane: (rec: ClaudeSessionRecord) => Promise<string | undefined>;
  typeIntoPane: (pane: string, text: string) => Promise<string | null>;
  relay: (socketPath: string, message: string) => Promise<boolean>;
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
  relay: (socket, message) => relayMessage(socket, message),
  writeRequest: (req) => writeAttachRequest(req),
  now: Date.now,
  attempts: recentAttempts,
};

// Asynchronous throughout: it runs on the daemon's message path, and the tmux
// and ps calls it may make must not block polling and routing meanwhile.
export async function attachSession(
  session: SessionInfo,
  deps: AttachDeps = defaultDeps
): Promise<AttachOutcome> {
  if (deps.isMonitoring(session.id)) return { kind: "monitoring" };
  if (!deps.enabled()) return { kind: "disabled" };
  const now = deps.now();
  const last = deps.attempts.get(session.id);
  if (last !== undefined && now - last < ATTACH_GRACE_MS) return { kind: "pending", since: last };
  if (session.claudePid === undefined) return { kind: "unreachable" };

  // Claimed before the first await, so a second message arriving meanwhile
  // sees the attempt as pending instead of starting another.
  deps.attempts.set(session.id, now);
  const rec = deps.readRecord(session.claudePid);
  const pane = rec ? await deps.typablePane(rec).catch(() => undefined) : undefined;
  if (pane && (await deps.typeIntoPane(pane, "/wechat").catch((e) => String(e))) === null) {
    return { kind: "typed", pane };
  }
  const request: AttachRequest = {
    sessionId: session.id,
    claudePid: session.claudePid,
    mcpPid: session.pid,
    name: session.name,
    requestedAt: now,
  };
  const socket = rec?.messagingSocketPath;
  if (socket && isSocketPath(socket)) {
    const done = deps
      .relay(socket, attachInstruction(session.name))
      .catch(() => false)
      .then((ok) => {
        if (!ok) deps.writeRequest(request);
        return ok;
      });
    return { kind: "relaying", done };
  }
  deps.writeRequest(request);
  return { kind: "requested" };
}
