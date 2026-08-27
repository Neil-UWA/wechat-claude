#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { ILinkClient } from "./ilink.js";
import {
  clearBinding,
  clearBindingsToSession,
  getBinding,
  setBinding,
} from "./bindings.js";
import { clearHeartbeat, isMonitoring } from "./monitoring.js";
import { nudgeSession } from "./nudge.js";
import { lastReplyAt } from "./replies.js";
import { looksStalled } from "./transcripts.js";
import {
  type LimitProbe,
  type UsageState,
  probeUsageLimit,
  readUsageState,
  resetHint,
  shouldProbe,
  writeUsageState,
} from "./usage.js";
import {
  CONFIG_FILE,
  CURSOR_FILE,
  DAEMON_PID_FILE,
  EXPIRED_FLAG_FILE,
  INBOX_DIR,
  MEDIA_DIR,
  SESSIONS_DIR,
  TYPING_DIR,
  WECHAT_DIR,
  ensureDirs as ensureWechatDirs,
  isProcessAlive,
} from "./paths.js";
import { assignSessionNumbers } from "./session-numbers.js";
import {
  type SessionInfo,
  findSession,
  getDefaultTarget,
  listSessions,
  matchSessions,
  sessionLabel,
  sortedSessions,
} from "./sessions.js";
import { peekInbox, writeToInbox } from "./inbox.js";
import { CLAUDE_CONFIG_FILE, ensureBypassAccepted } from "./claude-config.js";
import { type Lang, formatAgo, getLang, marker, t } from "./i18n.js";
import {
  hasTmux,
  isSafeSessionName,
  killTmuxSession,
  listTmuxSessions,
  newTmuxSession,
  sanitizeForSessionName,
  tmuxSessionExists,
} from "./tmux.js";
import type { PendingMessage, WeixinMessage } from "./types.js";
import {
  buildRunPrompt,
  extractText as sharedExtractText,
  parseRunFlags,
} from "./utils.js";

function ensureDirs(): void {
  ensureWechatDirs([MEDIA_DIR]);
}

const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UNREAD_WARN_AFTER_MS = 120_000;
const DELIVERY_EXPIRE_MS = 600_000;
const IDLE_MS = 2 * 60 * 60 * 1000;
// A delivery with no answer for this long is a candidate for a usage-limit
// check — but only if the session also looks stalled (see sessionStalled).
const SILENT_PROBE_AFTER_MS = 90_000;
// A session that is genuinely working writes to its transcript constantly; one
// whose model calls are being rejected writes nothing at all.
const TRANSCRIPT_IDLE_MS = 60_000;

function cleanOldMedia(): void {
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(MEDIA_DIR)) {
      const full = path.join(MEDIA_DIR, file);
      try {
        if (now - fs.statSync(full).mtimeMs > MEDIA_MAX_AGE_MS) {
          fs.unlinkSync(full);
        }
      } catch {}
    }
  } catch {}
}

// Download incoming images so any Claude session can Read them from disk;
// replaces each "[图片]" placeholder in the text with the local file path.
async function enrichImages(
  client: ILinkClient,
  pending: PendingMessage
): Promise<void> {
  const items = pending.rawItems ?? [];
  let index = 0;
  for (const item of items) {
    if (item.type !== 2) continue;
    index += 1;
    try {
      const outBase = path.join(MEDIA_DIR, `${pending.id}-${index}`);
      const saved = await client.downloadMedia(item.image_item.media, outBase);
      const lang = getLang();
      pending.text = pending.text.replace(
        marker("image", lang),
        `${marker("image", lang).replace(/\]$/, "")}: ${saved}]`
      );
      log(`Image saved: ${saved}`);
    } catch (err) {
      log(`Image download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function getParentPid(pid: number): number | undefined {
  const r = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0 || !r.stdout) return undefined;
  const ppid = parseInt(r.stdout.toString().trim(), 10);
  return Number.isFinite(ppid) && ppid > 1 ? ppid : undefined;
}

function commandOf(pid: number): string {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0 || !r.stdout) return "";
  return r.stdout.toString().trim();
}

// Terminate a session: its MCP server process and — when it is identifiably a
// claude process — the parent Claude Code process, then clean up the registry.
function closeSession(s: SessionInfo): { ok: boolean; line: string } {
  const parent = getParentPid(s.pid);
  const parentIsClaude = parent !== undefined && /claude/i.test(commandOf(parent));
  let killedParent = false;
  if (parent !== undefined && parentIsClaude) {
    try {
      process.kill(parent, "SIGTERM");
      killedParent = true;
    } catch {}
  }
  let killedServer = false;
  try {
    process.kill(s.pid, "SIGTERM");
    killedServer = true;
  } catch {}
  try {
    fs.unlinkSync(path.join(SESSIONS_DIR, `${s.id}.json`));
  } catch {}
  try {
    fs.unlinkSync(path.join(INBOX_DIR, `${s.id}.json`));
  } catch {}
  clearHeartbeat(s.id);
  clearBindingsToSession(s.id);
  if (!killedServer && !killedParent) {
    return { ok: false, line: t().closeFailedLine(s.name, s.pid) };
  }
  return { ok: true, line: t().closeOkLine(s.name, s.pid) };
}

function remainingSummary(closedIds: Set<string>): string {
  const remaining = listSessions().filter((s) => !closedIds.has(s.id));
  const monitored = remaining.filter((s) => isMonitoring(s.id)).length;
  return t().remainingSummary(remaining.length, monitored);
}

function getCursor(): string {
  try {
    return fs.readFileSync(CURSOR_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

function setCursor(cursor: string): void {
  fs.writeFileSync(CURSOR_FILE, cursor);
}

function markTyping(userId: string): void {
  fs.writeFileSync(path.join(TYPING_DIR, userId), String(Date.now()));
}

function isTypingActive(userId: string): boolean {
  try {
    const file = path.join(TYPING_DIR, userId);
    if (!fs.existsSync(file)) return false;
    const ts = parseInt(fs.readFileSync(file, "utf-8").trim(), 10);
    return Date.now() - ts < 60_000;
  } catch {
    return false;
  }
}

const extractText = sharedExtractText;

type Delivery = {
  msgId: string;
  sessionId: string;
  targetName: string;
  fromUserId: string;
  text: string;
  deliveredAt: number;
  warned: boolean;
  probed: boolean;
};

const deliveries: Delivery[] = [];

function trackDelivery(
  msgId: string,
  sessionId: string,
  targetName: string,
  fromUserId: string,
  text: string
): void {
  deliveries.push({
    msgId,
    sessionId,
    targetName,
    fromUserId,
    text,
    deliveredAt: Date.now(),
    warned: false,
    probed: false,
  });
  if (deliveries.length > 200) deliveries.shift();
}

function inboxHas(sessionId: string, msgId: string): boolean {
  try {
    const inbox = JSON.parse(
      fs.readFileSync(path.join(INBOX_DIR, `${sessionId}.json`), "utf-8")
    ) as PendingMessage[];
    return inbox.some((m) => m.id === msgId);
  } catch {
    return false;
  }
}

// Has the session gone quiet, or is it just busy? Claude Code appends to its
// transcript on every step, so a still-working session is never "stalled" —
// which keeps long tasks from triggering (and paying for) usage probes.
function sessionStalled(sessionId: string): boolean {
  const session = listSessions().find((s) => s.id === sessionId);
  if (!session) return false;
  return looksStalled(session.cwd, TRANSCRIPT_IDLE_MS);
}

// Deliveries this user is still waiting on an answer for.
function pendingFor(userId: string): Delivery[] {
  return deliveries.filter((d) => d.fromUserId === userId);
}

function startDeliveryWatcher(client: ILinkClient): void {
  setInterval(() => {
    const now = Date.now();
    for (let i = deliveries.length - 1; i >= 0; i--) {
      const d = deliveries[i];
      // The session answered this user after the delivery — done watching.
      if (lastReplyAt(d.fromUserId) > d.deliveredAt) {
        deliveries.splice(i, 1);
        continue;
      }
      if (now - d.deliveredAt > DELIVERY_EXPIRE_MS) {
        deliveries.splice(i, 1);
        continue;
      }
      const stillPending = inboxHas(d.sessionId, d.msgId);

      // Silence can mean "unread" (never picked up) or "read but no reply"
      // (the model call was rejected mid-turn). Both look like a usage limit,
      // so check it before blaming the session.
      if (
        !d.probed &&
        now - d.deliveredAt > SILENT_PROBE_AFTER_MS &&
        sessionStalled(d.sessionId)
      ) {
        d.probed = true;
        void checkUsage(client);
      }

      if (!d.warned && stillPending && now - d.deliveredAt > UNREAD_WARN_AFTER_MS) {
        d.warned = true;
        // A confirmed usage limit already explains the silence, and does it
        // better than "that session may not be monitoring".
        if (isLimitedNow()) continue;
        client
          .sendText(d.fromUserId, t().unreadWarn(d.targetName))
          .catch((err) => log(`Unread warning failed: ${err}`));
      }
    }
  }, 20_000);
}

// ---------------------------------------------------------------------------
// Claude usage limit
//
// When the account's limit is reached every session stops answering at once,
// which from WeChat is indistinguishable from a dead daemon. The daemon probes
// for it, says so, and follows up when the limit lifts.
// ---------------------------------------------------------------------------

let usageState: UsageState = readUsageState();

function saveUsageState(): void {
  writeUsageState(usageState);
}

// Limited, as far as we know right now. Once the reported reset time has
// passed the state is stale — the watcher re-probes rather than keep claiming
// a limit that may already be over.
function isLimitedNow(now: number = Date.now()): boolean {
  if (!usageState.limited) return false;
  return usageState.resetAt === undefined || now < usageState.resetAt;
}

function hintFor(now: number = Date.now()): string {
  return resetHint(usageState, now) ?? t().usageResetUnknown;
}

function waitingSummary(userId: string): string {
  const pending = pendingFor(userId);
  if (pending.length === 0) return "";
  const body = pending
    .map((d) => `• ${d.targetName}: ${d.text.replace(/\s+/g, " ").slice(0, 40)}`)
    .join("\n");
  return t().usageWaitingList(body);
}

function notifyLimited(client: ILinkClient, userId: string): void {
  if (usageState.notified.includes(userId)) return;
  usageState.notified.push(userId);
  saveUsageState();
  client
    .sendText(userId, t().usageLimited(hintFor(), waitingSummary(userId)))
    .catch((err) => log(`Usage-limit notice failed: ${err}`));
}

// Tell everyone who is currently waiting on a session, not just the user whose
// message triggered the probe.
function announceLimited(client: ILinkClient): void {
  for (const userId of new Set(deliveries.map((d) => d.fromUserId))) {
    notifyLimited(client, userId);
  }
}

// Sessions still holding undelivered messages need a second poke: their
// watcher announced the inbox while Claude was unable to react, and would not
// announce it again on its own.
function nudgePendingSessions(): number {
  let nudged = 0;
  for (const session of listSessions()) {
    if (peekInbox(session.id) === 0) continue;
    nudgeSession(session.id);
    nudged += 1;
  }
  return nudged;
}

function applyProbe(client: ILinkClient, probe: LimitProbe): void {
  const now = Date.now();

  if (probe.state === "limited") {
    if (!usageState.limited) {
      log(`Claude usage limit detected: ${probe.detail}`);
      usageState = {
        limited: true,
        since: now,
        resetAt: probe.resetAt,
        resetText: probe.resetText,
        lastProbeAt: now,
        notified: [],
      };
      notifyMacOS(t().usageMacNotice(hintFor(now)));
    } else {
      usageState.lastProbeAt = now;
      usageState.resetAt = probe.resetAt ?? usageState.resetAt;
      usageState.resetText = probe.resetText ?? usageState.resetText;
    }
    saveUsageState();
    announceLimited(client);
    return;
  }

  if (probe.state === "unknown") {
    // Some other failure (CLI missing, network, timeout). Don't invent a limit
    // — just record the attempt so probes stay throttled.
    log(`Usage probe inconclusive: ${probe.detail}`);
    usageState.lastProbeAt = now;
    saveUsageState();
    return;
  }

  if (!usageState.limited) {
    usageState.lastProbeAt = now;
    saveUsageState();
    return;
  }

  const mins = Math.round((now - (usageState.since ?? now)) / 60_000);
  const audience = new Set([
    ...usageState.notified,
    ...deliveries.map((d) => d.fromUserId),
  ]);
  usageState = { limited: false, lastProbeAt: now, notified: [] };
  saveUsageState();
  const nudged = nudgePendingSessions();
  log(`Claude usage limit lifted after ${mins}m; nudged ${nudged} session(s)`);
  const tail = nudged > 0 ? t().usagePendingNudged(nudged) : t().usagePendingNone;
  for (const userId of audience) {
    client
      .sendText(userId, t().usageRecovered(mins, tail))
      .catch((err) => log(`Usage-recovery notice failed: ${err}`));
  }
}

// One probe at a time, throttled unless forced (the /usage command).
let probeInFlight: Promise<LimitProbe> | undefined;

async function checkUsage(
  client: ILinkClient,
  force = false
): Promise<LimitProbe | undefined> {
  if (probeInFlight) return probeInFlight;
  if (!force && !shouldProbe(usageState, Date.now())) return undefined;
  probeInFlight = probeUsageLimit();
  try {
    const probe = await probeInFlight;
    applyProbe(client, probe);
    return probe;
  } finally {
    probeInFlight = undefined;
  }
}

// While limited, keep checking so recovery is announced without the user
// having to poke it — rejected probes are instant and cost nothing.
function startUsageWatcher(client: ILinkClient): void {
  setInterval(() => {
    if (!usageState.limited) return;
    void checkUsage(client);
  }, 30_000);
}

function notifyMacOS(message: string): void {
  if (process.platform !== "darwin") return;
  // Pass text as an argv element, never interpolated into the -e script.
  const script = "display notification (system attribute \"WC_MSG\") with title \"wechat-claude\"";
  spawnSync("osascript", ["-e", script], {
    stdio: "ignore",
    env: { ...process.env, WC_MSG: message },
  });
}


function resolveRunDir(dirHint: string | undefined): string | undefined {
  if (!dirHint) {
    const sessions = listSessions();
    if (sessions.length === 0) return undefined;
    const mostActive = sessions.reduce((a, b) => (a.lastActive > b.lastActive ? a : b));
    return mostActive.cwd;
  }

  const sessions = listSessions();
  const match = sessions.find(
    (s) =>
      s.name.toLowerCase() === dirHint.toLowerCase() ||
      s.name.toLowerCase().includes(dirHint.toLowerCase()) ||
      path.basename(s.cwd).toLowerCase() === dirHint.toLowerCase()
  );
  if (match) return match.cwd;

  if (path.isAbsolute(dirHint)) {
    try {
      if (fs.statSync(dirHint).isDirectory()) return dirHint;
    } catch {}
    return undefined;
  }

  for (const dir of getRepoSearchDirs().dirs) {
    const candidate = path.join(dir, dirHint);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }

  return undefined;
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Directories to search when "/run <name> ..." names a project that has no
// active session: user-configured repoDirs from ~/.claude/wechat/config.json,
// plus the parent directories of every active session's cwd (so once you've
// opened a project near your other repos, its siblings resolve by name too).
// The home directory itself is never used as a search root — too broad.
function getRepoSearchDirs(): { dirs: string[]; configError?: string } {
  const dirs = new Set<string>();
  let configError: string | undefined;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      const repoDirs =
        typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>).repoDirs
          : undefined;
      if (repoDirs !== undefined && !Array.isArray(repoDirs)) {
        configError = t().cfgNotArray;
      } else if (Array.isArray(repoDirs)) {
        for (const d of repoDirs) {
          if (typeof d !== "string") {
            configError = t().cfgNonString;
            continue;
          }
          const expanded = expandTilde(d);
          if (!path.isAbsolute(expanded)) {
            configError = t().cfgNotAbsolute(d);
            continue;
          }
          dirs.add(expanded);
        }
      }
    } catch {
      configError = t().cfgBadJson;
    }
  }
  const home = os.homedir();
  for (const s of listSessions()) {
    const parent = path.dirname(s.cwd);
    if (parent !== home && parent !== path.sep) dirs.add(parent);
  }
  if (configError) log(`Config warning: ${configError}`);
  return { dirs: [...dirs], configError };
}

type RunSession = {
  name: string;
  cwd: string;
  task: string;
  fromUserId: string;
  startedAt: number;
};

// Persisted so /runs and end-of-run notifications survive daemon restarts
// (launchd KeepAlive makes restarts routine).
const RUNS_FILE = path.join(WECHAT_DIR, "runs.json");

function loadRunSessions(): RunSession[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(RUNS_FILE, "utf-8"));
    return Array.isArray(parsed) ? (parsed as RunSession[]) : [];
  } catch {
    return [];
  }
}

function saveRunSessions(): void {
  try {
    fs.writeFileSync(RUNS_FILE, JSON.stringify(runSessions));
  } catch {}
}

const runSessions: RunSession[] = loadRunSessions();

function listRunTmuxSessions(): string[] {
  return listTmuxSessions().filter((name) => name.startsWith("wc-"));
}

// Notify the WeChat user when a /run tmux session ends, so a crashed or
// finished task never disappears silently.
function startRunWatcher(client: ILinkClient): void {
  setInterval(() => {
    for (let i = runSessions.length - 1; i >= 0; i--) {
      const r = runSessions[i];
      if (tmuxSessionExists(r.name)) continue;
      runSessions.splice(i, 1);
      saveRunSessions();
      const mins = Math.round((Date.now() - r.startedAt) / 60_000);
      client
        .sendText(r.fromUserId, t().runEnded(r.name, mins, r.task.slice(0, 80)))
        .catch((err) => log(`Run-end notify failed: ${err}`));
    }
  }, 30_000);
}

function handleRunCommand(
  client: ILinkClient,
  msg: PendingMessage,
  args: string
): void {
  const sendReply = (reply: string): void => {
    client.sendText(msg.fromUserId, reply).catch((err) => {
      log(`Reply failed: ${err}`);
    });
  };

  const m = t();
  const { auto, rest } = parseRunFlags(args);

  if (!rest) {
    sendReply(m.runUsage);
    return;
  }

  const parts = rest.split(/\s+/);
  let dirHint: string | undefined;
  let task: string;
  let cwd: string | undefined;

  // "/run . <任务>" runs in the default (most recently active session's) dir
  // even when the first task word happens to look like a directory name.
  if (parts[0] === "." && parts.length > 1) {
    task = parts.slice(1).join(" ");
    cwd = resolveRunDir(undefined);
  } else {
    const firstWordAsDir = parts.length > 1 ? resolveRunDir(parts[0]) : undefined;
    if (firstWordAsDir) {
      dirHint = parts[0];
      task = parts.slice(1).join(" ");
      cwd = firstWordAsDir;
    } else if (parts.length > 1 && /^[A-Za-z0-9_./\\-]+$/.test(parts[0])) {
      // Looks like a directory/repo name (e.g. "myrepo", "my-app", a path)
      // but resolves nowhere. Running the whole text as a task in some other
      // directory — unattended — is the worst outcome, so ask instead.
      dirHint = parts[0];
      task = rest;
      cwd = undefined;
    } else {
      task = rest;
      cwd = resolveRunDir(undefined);
    }
  }

  if (!cwd) {
    if (dirHint) {
      const search = getRepoSearchDirs();
      const configNote = search.configError ? `\n\n⚠️ ${search.configError}` : "";
      const sessDirs = listSessions()
        .map((s) => `  - ${s.name} (${s.cwd})`)
        .join("\n");
      const searchDirs =
        search.dirs.map((d) => `  - ${d}`).join("\n") || m.noRepoDirs;
      sendReply(m.runDirNotFound(dirHint, sessDirs, searchDirs, task, configNote));
    } else {
      sendReply(m.runNoSession);
    }
    return;
  }

  if (!hasTmux()) {
    sendReply(m.tmuxMissing);
    return;
  }

  const sessionName = `wc-${sanitizeForSessionName(path.basename(cwd))}-${Date.now().toString(36)}`;
  const taskFile = path.join(os.tmpdir(), `wechat-run-${sessionName}.txt`);
  fs.writeFileSync(taskFile, buildRunPrompt(task, msg.fromUserId));

  // acceptEdits keeps unattended tasks moving without opening up bash; -y
  // opts into full skip-permissions for tasks that need to run commands.
  const permFlag = auto
    ? "--dangerously-skip-permissions"
    : "--permission-mode acceptEdits";

  // Skip-permissions mode has a one-time consent dialog. The session starts
  // detached with nobody to answer it, so accept it up front or the task hangs
  // on the prompt forever while /runs reports it as running. If we cannot
  // confirm the acceptance, refuse to launch rather than create that hang.
  const bypass = auto ? ensureBypassAccepted() : "already";
  if (bypass === "accepted")
    log("Accepted bypassPermissionsModeAccepted in ~/.claude.json");
  if (bypass === "failed") {
    log(`Could not accept skip-permissions mode in ${CLAUDE_CONFIG_FILE}`);
    sendReply(m.bypassUnavailable(CLAUDE_CONFIG_FILE));
    try { fs.unlinkSync(taskFile); } catch {}
    return;
  }
  // The command string is passed to tmux as a single argv element (no outer
  // shell), so "$task" is expanded by the shell tmux starts — not by us. The
  // task file path uses only our sanitized session name, so single-quoting it
  // is safe.
  const shellCmd = `task=$(cat '${taskFile}'); rm -f '${taskFile}'; exec claude ${permFlag} "$task"`;

  const startErr = newTmuxSession(sessionName, cwd, shellCmd);
  if (startErr) {
    try { fs.unlinkSync(taskFile); } catch {}
    log(`Failed to start tmux session: ${startErr}`);
    sendReply(m.runStartFailed(startErr));
    return;
  }

  runSessions.push({
    name: sessionName,
    cwd,
    task,
    fromUserId: msg.fromUserId,
    startedAt: Date.now(),
  });
  saveRunSessions();
  log(`Started tmux session "${sessionName}" in ${cwd}: ${task}`);
  sendReply(
    m.runStarted(
      path.basename(cwd),
      task,
      auto ? m.permSkip : m.permSafe,
      sessionName
    ) + (bypass === "accepted" ? `\n\n${m.bypassAutoAccepted}` : "")
  );
}

// A message delivered during a known limit episode would otherwise vanish into
// silence, so say so immediately instead of waiting for the watchdog.
function noteUsageLimit(client: ILinkClient, userId: string): void {
  if (!isLimitedNow()) return;
  if (!usageState.notified.includes(userId)) usageState.notified.push(userId);
  saveUsageState();
  client
    .sendText(userId, t().usageNoteOnSend(hintFor()))
    .catch((err) => log(`Usage-limit note failed: ${err}`));
}

function routeMessage(client: ILinkClient, msg: PendingMessage): void {
  const text = msg.text.trim();
  const lang = getLang();
  const m = t(lang);

  const sendReply = (reply: string): void => {
    client.sendText(msg.fromUserId, reply).catch((err) => {
      log(`Reply failed: ${err}`);
    });
  };

  if (text === "/usage" || text === "/limit" || text === "/用量") {
    sendReply(m.usageChecking);
    void (async () => {
      const probe = await checkUsage(client, true);
      if (!probe) return;
      if (probe.state === "limited") {
        const now = Date.now();
        const mins = Math.round((now - (usageState.since ?? now)) / 60_000);
        // Answering here counts as telling this user about the episode, so the
        // watcher does not send them the same news a second time.
        if (!usageState.notified.includes(msg.fromUserId)) {
          usageState.notified.push(msg.fromUserId);
          saveUsageState();
        }
        sendReply(m.usageStatusLimited(hintFor(now), mins));
        return;
      }
      sendReply(probe.state === "ok" ? m.usageOk : m.usageUnknown(probe.detail));
    })();
    return;
  }

  const runMatch = text.match(/^\/run(?:\s+([\s\S]*))?$/);
  if (runMatch) {
    handleRunCommand(client, msg, runMatch[1] ?? "");
    return;
  }

  if (text === "/runs") {
    const names = listRunTmuxSessions();
    if (names.length === 0) {
      sendReply(m.runsNone);
      return;
    }
    const lines = names.map((name, i) => {
      const tracked = runSessions.find((r) => r.name === name);
      if (!tracked) return m.runsEntryBare(i + 1, name);
      const mins = Math.round((Date.now() - tracked.startedAt) / 60_000);
      return m.runsEntry(i + 1, name, mins, tracked.task.slice(0, 60));
    });
    sendReply(m.runsList(names.length, lines.join("\n\n")));
    return;
  }

  const useMatch = text.match(/^\/use(?:\s+(\S+))?\s*$/);
  if (useMatch) {
    const selector = useMatch[1];
    if (!selector) {
      const boundId = getBinding(msg.fromUserId);
      const bound = boundId
        ? listSessions().find((s) => s.id === boundId)
        : undefined;
      sendReply(bound ? m.useCurrent(bound.name, bound.pid) : m.useNone);
      return;
    }
    if (selector === "off" || selector === "取消") {
      clearBinding(msg.fromUserId);
      sendReply(m.useUnbound);
      return;
    }
    const target = findSession(selector);
    if (!target) {
      sendReply(m.notFound(selector));
      return;
    }
    setBinding(msg.fromUserId, target.id);
    const warn = isMonitoring(target.id) ? "" : m.useNotMonitoredWarn;
    sendReply(m.useBound(target.name, target.pid, warn));
    return;
  }

  const closeMatch = text.match(/^\/close(?:\s+(\S+))?(?:\s+(all|全部))?\s*$/);
  if (closeMatch) {
    const selector = closeMatch[1];
    const closeAll = closeMatch[2] !== undefined;
    if (!selector) {
      sendReply(m.closeUsage);
      return;
    }

    let targets: SessionInfo[];
    if (selector === "idle" || selector === "闲置") {
      const now = Date.now();
      targets = sortedSessions().filter(
        (s) => !isMonitoring(s.id) && now - s.lastActive >= IDLE_MS
      );
      if (targets.length === 0) {
        sendReply(m.closeNoIdle);
        return;
      }
    } else {
      targets = matchSessions(selector);
      if (targets.length === 0) {
        sendReply(m.notFound(selector));
        return;
      }
      if (targets.length > 1 && !closeAll) {
        const now = Date.now();
        const lines = targets.map((s) => {
          const mon = isMonitoring(s.id) ? m.monitoringSuffix : "";
          return m.closeAmbiguousEntry(
            s.name,
            s.pid,
            formatAgo(now - s.lastActive, lang),
            mon
          );
        });
        sendReply(m.closeAmbiguous(selector, targets.length, lines.join("\n")));
        return;
      }
    }

    const results = targets.map((s) => closeSession(s));
    const closedIds = new Set(targets.map((s) => s.id));
    for (const s of targets) log(`Closed session ${s.name} (${s.id}) via WeChat`);
    sendReply(
      m.closed(
        targets.length,
        results.map((r) => r.line).join("\n"),
        remainingSummary(closedIds)
      )
    );
    return;
  }

  const stopMatch = text.match(/^\/stop\s+(\S+)\s*$/);
  if (stopMatch) {
    const selector = stopMatch[1];
    const running = listRunTmuxSessions();
    if (running.length === 0) {
      sendReply(m.runsNone);
      return;
    }

    let targets: string[];
    if (selector === "all" || selector === "全部") {
      targets = running;
    } else {
      const num = parseInt(selector, 10);
      if (!isNaN(num) && String(num) === selector) {
        const byNum = running[num - 1];
        if (!byNum) {
          sendReply(m.stopNumOutOfRange(num));
          return;
        }
        targets = [byNum];
      } else if (running.includes(selector)) {
        targets = [selector];
      } else {
        sendReply(m.stopNotFound(selector));
        return;
      }
    }

    // Guard: only ever kill our own wc- sessions, whatever the selector.
    targets = targets.filter((n) => n.startsWith("wc-") && isSafeSessionName(n));
    const stopped: string[] = [];
    for (const name of targets) {
      if (killTmuxSession(name)) {
        stopped.push(name);
        const idx = runSessions.findIndex((r) => r.name === name);
        if (idx >= 0) runSessions.splice(idx, 1);
        log(`Stopped tmux session "${name}" via WeChat`);
      }
    }
    saveRunSessions();
    sendReply(
      stopped.length > 0
        ? m.stopped(stopped.length, stopped.map((n) => `• ${n}`).join("\n"))
        : m.stopFailed
    );
    return;
  }

  if (text === "/help" || text === "/h") {
    sendReply(m.help);
    return;
  }

  const listMatch = text.match(/^\/(?:sessions|ls)(?:\s+(all|全部))?$/);
  if (listMatch) {
    const showAll = listMatch[1] !== undefined;
    const sessions = sortedSessions();
    if (sessions.length === 0) {
      sendReply(m.noSessions);
      return;
    }
    const defaultTarget = getDefaultTarget(sessions);
    const boundId = getBinding(msg.fromUserId);
    const bound = sessions.find((s) => s.id === boundId);
    const receiverId = bound?.id ?? defaultTarget?.id;
    const numbers = assignSessionNumbers(sessions.map((s) => s.id));
    const now = Date.now();
    const isIdle = (s: SessionInfo): boolean =>
      !showAll &&
      !isMonitoring(s.id) &&
      s.id !== receiverId &&
      now - s.lastActive >= IDLE_MS;
    const entries = sessions.map((s) => ({ s, num: numbers[s.id] }));
    const mainLines = entries
      .filter(({ s }) => !isIdle(s))
      .map(({ s, num }) => {
        const active = now - s.lastActive < 120_000 ? "●" : "○";
        const tags =
          (isMonitoring(s.id) ? m.monitoringTag : "") +
          (s.id === receiverId ? (bound ? m.boundTag : m.defaultTag) : "");
        return m.sessionEntry(
          active,
          num,
          sessionLabel(s, sessions),
          tags,
          path.basename(s.cwd),
          formatAgo(now - s.lastActive, lang)
        );
      });
    const idleLines = entries
      .filter(({ s }) => isIdle(s))
      .map(({ s, num }) =>
        m.idleEntry(num, sessionLabel(s, sessions), formatAgo(now - s.lastActive, lang))
      );
    const sections = [
      m.sessionsHeader(sessions.length),
      mainLines.join("\n\n"),
      idleLines.length > 0 ? m.idleSection(idleLines.join("\n")) : "",
      [
        bound ? m.legendBound : m.legendDefault,
        m.legendNumbers,
        m.legendRoute,
      ].join("\n"),
    ].filter(Boolean);
    sendReply(sections.join("\n\n"));
    return;
  }

  const bareRoute = text.match(/^\/s(?:\s+(\S+))?\s*$/);
  if (bareRoute) {
    sendReply(m.sListUsage);
    return;
  }

  const routeMatch = text.match(/^\/s\s+(\S+)\s+([\s\S]+)$/);
  if (routeMatch) {
    const selector = routeMatch[1];
    const message = routeMatch[2];
    const target = findSession(selector);
    if (!target) {
      sendReply(m.notFound(selector));
      return;
    }
    writeToInbox(target.id, { ...msg, text: message });
    trackDelivery(msg.id, target.id, target.name, msg.fromUserId, message);
    if (!isMonitoring(target.id)) {
      sendReply(m.deliveredUnmonitored(target.name));
    }
    noteUsageLimit(client, msg.fromUserId);
    markTyping(msg.fromUserId);
    client.startTypingKeepAlive(msg.fromUserId, () => isTypingActive(msg.fromUserId));
    log(`Routed to ${target.name} (${target.id})`);
    return;
  }

  const sessions = listSessions();
  // A bound session wins; otherwise prefer sessions that are actively
  // monitoring their inbox and, among those, the most recently active one.
  const boundId = getBinding(msg.fromUserId);
  let target = boundId
    ? sessions.find((s) => s.id === boundId)
    : undefined;
  if (boundId && !target) {
    clearBinding(msg.fromUserId);
    sendReply(m.bindingCleared);
  }
  target = target ?? getDefaultTarget(sessions);
  if (!target) {
    sendReply(m.noSessionsDeliver);
    return;
  }
  writeToInbox(target.id, msg);
  trackDelivery(msg.id, target.id, target.name, msg.fromUserId, msg.text);
  if (!isMonitoring(target.id)) {
    sendReply(m.deliveredNoneMonitored(target.name));
  }
  noteUsageLimit(client, msg.fromUserId);
  markTyping(msg.fromUserId);
  client.startTypingKeepAlive(msg.fromUserId);
  log(`Routed to ${target.name} (${target.id})`);
}

function log(msg: string): void {
  const time = new Date().toLocaleString("zh-CN");
  process.stdout.write(`[${time}] ${msg}\n`);
}

function startTypingWatcher(client: ILinkClient): void {
  setInterval(() => {
    try {
      for (const file of fs.readdirSync(TYPING_DIR)) {
        if (!isTypingActive(file)) {
          client.stopTypingKeepAlive(file);
          try {
            fs.unlinkSync(path.join(TYPING_DIR, file));
          } catch {}
        }
      }
    } catch {}
  }, 5000);
}

async function main(): Promise<void> {
  ensureDirs();

  try {
    const existingPid = parseInt(
      fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim(),
      10
    );
    if (isProcessAlive(existingPid) && existingPid !== process.pid) {
      log(`Daemon already running (pid ${existingPid}). Exiting.`);
      process.exit(0);
    }
  } catch {}

  fs.writeFileSync(DAEMON_PID_FILE, String(process.pid));
  const cleanup = (): void => {
    try {
      fs.unlinkSync(DAEMON_PID_FILE);
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  const client = new ILinkClient();

  if (!client.tryRestoreSession()) {
    log("No session found. Login via Claude Code first, then restart daemon.");
    process.exit(1);
  }

  const cursor = getCursor();
  if (cursor) client.setUpdatesCursor(cursor);

  cleanOldMedia();
  startTypingWatcher(client);
  startDeliveryWatcher(client);
  startRunWatcher(client);
  startUsageWatcher(client);

  log(`Daemon started (pid ${process.pid}). Polling WeChat...`);

  let clearedExpiredFlag = false;

  while (true) {
    try {
      const rawMsgs = await client.getUpdates();
      setCursor(client.getUpdatesCursor());

      if (!clearedExpiredFlag) {
        // Polling works, so the login is valid — clear any stale expiry flag.
        try {
          fs.unlinkSync(EXPIRED_FLAG_FILE);
        } catch {}
        clearedExpiredFlag = true;
      }

      for (const msg of rawMsgs) {
        if (msg.message_type !== 1 || msg.message_state !== 2) continue;
        client.trackContextToken(msg.from_user_id, msg.context_token);

        const text = extractText(msg, getLang());
        if (!text) continue;

        const pending: PendingMessage = {
          id: msg.message_id,
          fromUserId: msg.from_user_id,
          text,
          contextToken: msg.context_token,
          timestamp: msg.create_time_ms,
          rawItems: msg.item_list,
        };

        await enrichImages(client, pending);

        log(`Message: ${pending.text.slice(0, 60)}`);
        routeMessage(client, pending);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Session expired")) {
        log("Session expired. Exiting.");
        try {
          fs.writeFileSync(EXPIRED_FLAG_FILE, String(Date.now()));
        } catch {}
        // The cursor belongs to the dead login session; a fresh login must
        // start from a fresh cursor or getupdates may keep rejecting it.
        try {
          fs.unlinkSync(CURSOR_FILE);
        } catch {}
        notifyMacOS(t().loginExpired);
        // The watcher setIntervals keep the event loop alive, so breaking out
        // of the loop is not enough — without an explicit exit the process
        // lingers, holds the pid file, and blocks launchd from restarting.
        process.exit(1);
      }
      log(`Poll error: ${errMsg}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
