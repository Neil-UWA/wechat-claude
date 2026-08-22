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
import {
  CONFIG_FILE,
  CURSOR_FILE,
  DAEMON_PID_FILE,
  EXPIRED_FLAG_FILE,
  INBOX_DIR,
  MEDIA_DIR,
  SESSIONS_DIR,
  TYPING_DIR,
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
import { writeToInbox } from "./inbox.js";
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
  formatAgo,
  parseRunFlags,
} from "./utils.js";

function ensureDirs(): void {
  ensureWechatDirs([MEDIA_DIR]);
}

const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UNREAD_WARN_AFTER_MS = 120_000;
const DELIVERY_EXPIRE_MS = 600_000;
const IDLE_MS = 2 * 60 * 60 * 1000;

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
      pending.text = pending.text.replace("[图片]", `[图片: ${saved}]`);
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
    return { ok: false, line: `✗ ${s.name} (pid ${s.pid}) — 进程可能已退出，已从列表移除` };
  }
  return { ok: true, line: `✓ ${s.name} (pid ${s.pid})` };
}

function remainingSummary(closedIds: Set<string>): string {
  const remaining = listSessions().filter((s) => !closedIds.has(s.id));
  const monitored = remaining.filter((s) => isMonitoring(s.id)).length;
  return `剩余 ${remaining.length} 个 session，其中 ${monitored} 个监控中。`;
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
  deliveredAt: number;
  warned: boolean;
};

const deliveries: Delivery[] = [];

function trackDelivery(
  msgId: string,
  sessionId: string,
  targetName: string,
  fromUserId: string
): void {
  deliveries.push({
    msgId,
    sessionId,
    targetName,
    fromUserId,
    deliveredAt: Date.now(),
    warned: false,
  });
  if (deliveries.length > 200) deliveries.shift();
}

function startDeliveryWatcher(client: ILinkClient): void {
  setInterval(() => {
    const now = Date.now();
    for (let i = deliveries.length - 1; i >= 0; i--) {
      const d = deliveries[i];
      let stillPending = false;
      try {
        const inbox = JSON.parse(
          fs.readFileSync(path.join(INBOX_DIR, `${d.sessionId}.json`), "utf-8")
        ) as PendingMessage[];
        stillPending = inbox.some((m) => m.id === d.msgId);
      } catch {}
      if (!stillPending || now - d.deliveredAt > DELIVERY_EXPIRE_MS) {
        deliveries.splice(i, 1);
        continue;
      }
      if (!d.warned && now - d.deliveredAt > UNREAD_WARN_AFTER_MS) {
        d.warned = true;
        client
          .sendText(
            d.fromUserId,
            `提醒: 发给 "${d.targetName}" 的消息已 2 分钟未被读取。该 session 可能没有在监控消息。\n发送 /sessions 查看状态，或用 /s <编号> <消息> 换一个 session。`
          )
          .catch((err) => log(`Unread warning failed: ${err}`));
      }
    }
  }, 20_000);
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

const HELP_TEXT = [
  "🤖 wechat-claude 用法",
  "",
  "👀 看",
  "/ls — session 列表",
  "/ls all — 展开闲置的",
  "",
  "💬 聊",
  "/use 3 — 绑定 3 号，之后消息都发给它",
  "/use off — 取消绑定",
  "/s 3 你好 — 只发这一条给 3 号",
  "",
  "🚀 跑任务",
  "/run 修复登录bug — 新开 Claude 执行（默认无人值守）",
  "/run myapp 跑测试 — 指定目录",
  "/run --safe <任务> — bash 命令需在电脑确认",
  "/runs — 任务列表",
  "/stop 1 — 按编号终止，/stop all 全部",
  "",
  "🧹 清理",
  "/close 3 — 关闭 3 号",
  "/close idle — 清理全部闲置",
  "/close myapp all — 关闭同名全部",
  "",
  "📌 备注",
  "· 编号固定不变，可用编号/名字/pid 选 session",
  "· 普通消息发给绑定的 session（没绑定就发给最近活跃且监控中的）",
  "· 📷 可以直接发图片，Claude 能看到内容",
  "· 🎤 语音会自动转成文字",
].join("\n");

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
        configError = "config.json 的 repoDirs 必须是字符串数组";
      } else if (Array.isArray(repoDirs)) {
        for (const d of repoDirs) {
          if (typeof d !== "string") {
            configError = "config.json 的 repoDirs 含非字符串项，已跳过";
            continue;
          }
          const expanded = expandTilde(d);
          if (!path.isAbsolute(expanded)) {
            configError = `config.json 的 repoDirs 项 "${d}" 不是绝对路径，已跳过`;
            continue;
          }
          dirs.add(expanded);
        }
      }
    } catch {
      configError = "config.json 不是合法 JSON，repoDirs 配置未生效";
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

const runSessions: RunSession[] = [];

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
      const mins = Math.round((Date.now() - r.startedAt) / 60_000);
      client
        .sendText(
          r.fromUserId,
          `任务 session "${r.name}" 已结束（运行 ${mins} 分钟）。\n任务: ${r.task.slice(0, 80)}\n\n如果没有收到结果消息，任务可能中途失败，可发 /run 重试或回电脑查看。`
        )
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

  const { auto, rest } = parseRunFlags(args);

  if (!rest) {
    sendReply("用法: /run [--safe] [目录] <任务>\n\n默认跳过权限确认（无人值守）。加 --safe 则只自动接受编辑，bash 命令需要在电脑上确认。\n\n例:\n/run 检查最近的 PR\n/run myapp 跑一遍测试并修复失败\n/run --safe /path/to/repo 修复 bug");
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
      sendReply(`找不到目录 "${dirHint}"，已取消（避免任务跑错地方）。\n\n可用的 session 目录:\n${listSessions().map((s) => `  - ${s.name} (${s.cwd})`).join("\n")}\n\n也可以用这些目录下的项目名:\n${search.dirs.map((d) => `  - ${d}`).join("\n") || "  （无，可在 ~/.claude/wechat/config.json 配置 repoDirs）"}\n\n或直接给绝对路径。如果 "${dirHint}" 是任务内容而不是目录，用: /run . ${task}${configNote}`);
    } else {
      sendReply("没有活跃的 session，请指定目录。\n用法: /run <目录> <任务>");
    }
    return;
  }

  if (!hasTmux()) {
    sendReply("tmux 未安装，无法启动交互式 session。请在终端中手动运行。");
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
  // The command string is passed to tmux as a single argv element (no outer
  // shell), so "$task" is expanded by the shell tmux starts — not by us. The
  // task file path uses only our sanitized session name, so single-quoting it
  // is safe.
  const shellCmd = `task=$(cat '${taskFile}'); rm -f '${taskFile}'; exec claude ${permFlag} "$task"`;

  const err = newTmuxSession(sessionName, cwd, shellCmd);
  if (err) {
    try { fs.unlinkSync(taskFile); } catch {}
    log(`Failed to start tmux session: ${err}`);
    sendReply(`启动失败: ${err}`);
    return;
  }

  runSessions.push({
    name: sessionName,
    cwd,
    task,
    fromUserId: msg.fromUserId,
    startedAt: Date.now(),
  });
  log(`Started tmux session "${sessionName}" in ${cwd}: ${task}`);
  sendReply(`已启动 Claude session\n\n目录: ${path.basename(cwd)}\n任务: ${task}\n权限: ${auto ? "跳过确认（默认）" : "仅自动接受编辑 (--safe)"}\ntmux: ${sessionName}\n\n完成后结果会发回微信。\n/runs 查看运行中的任务，/stop ${sessionName} 可终止。\n回到电脑后可运行: tmux attach -t ${sessionName}`);
}

function routeMessage(client: ILinkClient, msg: PendingMessage): void {
  const text = msg.text.trim();

  const sendReply = (reply: string): void => {
    client.sendText(msg.fromUserId, reply).catch((err) => {
      log(`Reply failed: ${err}`);
    });
  };

  const runMatch = text.match(/^\/run(?:\s+([\s\S]*))?$/);
  if (runMatch) {
    handleRunCommand(client, msg, runMatch[1] ?? "");
    return;
  }

  if (text === "/runs") {
    const names = listRunTmuxSessions();
    if (names.length === 0) {
      sendReply("当前没有 /run 启动的任务 session。");
      return;
    }
    const lines = names.map((name, i) => {
      const tracked = runSessions.find((r) => r.name === name);
      if (!tracked) return `${i + 1}. ${name}`;
      const mins = Math.round((Date.now() - tracked.startedAt) / 60_000);
      return `${i + 1}. ${name}（${mins} 分钟前启动）\n   任务: ${tracked.task.slice(0, 60)}`;
    });
    sendReply(
      `运行中的任务 (${names.length}):\n\n${lines.join("\n\n")}\n\n/stop <编号|名称> 终止，/stop all 全部终止\n电脑上: tmux attach -t <名称>`
    );
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
      sendReply(
        bound
          ? `当前绑定: "${bound.name}" (pid ${bound.pid})。\n/use off 取消绑定，/use <编号|名字|pid> 换绑。`
          : "当前没有绑定。\n/use <编号|名字|pid> — 绑定后你的所有消息都直接发给该 session\n/use off — 取消绑定"
      );
      return;
    }
    if (selector === "off" || selector === "取消") {
      clearBinding(msg.fromUserId);
      sendReply("已取消绑定，恢复默认路由（最近活跃且监控中的 session）。");
      return;
    }
    const target = findSession(selector);
    if (!target) {
      sendReply(`找不到 "${selector}"。发送 /sessions 查看列表。`);
      return;
    }
    setBinding(msg.fromUserId, target.id);
    const warn = isMonitoring(target.id)
      ? ""
      : "\n注意: 该 session 未在监控消息，回复可能不及时。";
    sendReply(
      `已绑定 "${target.name}" (pid ${target.pid})。之后你的所有消息都会直接发给它。${warn}\n/use off 取消绑定。`
    );
    return;
  }

  const closeMatch = text.match(/^\/close(?:\s+(\S+))?(?:\s+(all|全部))?\s*$/);
  if (closeMatch) {
    const selector = closeMatch[1];
    const closeAll = closeMatch[2] !== undefined;
    if (!selector) {
      sendReply(
        "用法:\n/close <编号|名字|pid> — 关闭指定 session\n/close <名字> all — 关闭全部同名 session\n/close idle — 清理全部闲置 session（未监控且 2 小时以上未活跃）\n\n注意: 关闭会终止进程，session 中未保存的工作会丢失。/run 启动的任务请用 /stop。"
      );
      return;
    }

    let targets: SessionInfo[];
    if (selector === "idle" || selector === "闲置") {
      const now = Date.now();
      targets = sortedSessions().filter(
        (s) => !isMonitoring(s.id) && now - s.lastActive >= IDLE_MS
      );
      if (targets.length === 0) {
        sendReply("没有闲置的 session（未监控且 2 小时以上未活跃）。");
        return;
      }
    } else {
      targets = matchSessions(selector);
      if (targets.length === 0) {
        sendReply(`找不到 "${selector}"。发送 /sessions 查看列表。`);
        return;
      }
      if (targets.length > 1 && !closeAll) {
        const now = Date.now();
        const lines = targets.map((t) => {
          const mon = isMonitoring(t.id) ? "，监控中" : "";
          return `• ${t.name}#${t.pid}（${formatAgo(now - t.lastActive)}活跃${mon}）`;
        });
        sendReply(
          `"${selector}" 匹配到 ${targets.length} 个 session:\n\n${lines.join("\n")}\n\n全部关闭: /close ${selector} all\n单独关闭: /close <pid>`
        );
        return;
      }
    }

    const results = targets.map((t) => closeSession(t));
    const closedIds = new Set(targets.map((t) => t.id));
    for (const t of targets) log(`Closed session ${t.name} (${t.id}) via WeChat`);
    const header =
      targets.length === 1 ? "已关闭 session:" : `已关闭 ${targets.length} 个 session:`;
    sendReply(
      `${header}\n${results.map((r) => r.line).join("\n")}\n\n${remainingSummary(closedIds)}`
    );
    return;
  }

  const stopMatch = text.match(/^\/stop\s+(\S+)\s*$/);
  if (stopMatch) {
    const selector = stopMatch[1];
    const running = listRunTmuxSessions();
    if (running.length === 0) {
      sendReply("当前没有 /run 启动的任务 session。");
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
          sendReply(`编号 ${num} 超出范围。发送 /runs 查看列表。`);
          return;
        }
        targets = [byNum];
      } else if (running.includes(selector)) {
        targets = [selector];
      } else {
        sendReply(`没有找到运行中的 "${selector}"。发送 /runs 查看编号或名称。`);
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
    sendReply(
      stopped.length > 0
        ? `已终止 ${stopped.length} 个任务:\n${stopped.map((n) => `• ${n}`).join("\n")}`
        : "终止失败，可能已退出。发送 /runs 查看。"
    );
    return;
  }

  if (text === "/help" || text === "/h") {
    sendReply(HELP_TEXT);
    return;
  }

  const listMatch = text.match(/^\/(?:sessions|ls)(?:\s+(all|全部))?$/);
  if (listMatch) {
    const showAll = listMatch[1] !== undefined;
    const sessions = sortedSessions();
    if (sessions.length === 0) {
      sendReply("当前没有活跃的 Claude session。");
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
        const monitoring = isMonitoring(s.id) ? " [监控中]" : "";
        const receiver =
          s.id === receiverId ? (bound ? " ← 已绑定" : " ← 默认接收") : "";
        const cwd = path.basename(s.cwd);
        return `${active} ${num}. ${sessionLabel(s, sessions)}${monitoring}${receiver}\n   目录: ${cwd} · ${formatAgo(now - s.lastActive)}活跃`;
      });
    const idleLines = entries
      .filter(({ s }) => isIdle(s))
      .map(({ s, num }) => `○ ${num}. ${sessionLabel(s, sessions)} · ${formatAgo(now - s.lastActive)}`);
    const sections = [
      `活跃 sessions (${sessions.length}):`,
      mainLines.join("\n\n"),
      idleLines.length > 0
        ? `闲置（未监控、2 小时以上未活跃）:\n${idleLines.join("\n")}\n可发 /close idle 一键清理`
        : "",
      [
        bound
          ? "← 已绑定 = 你的消息都发到这里（/use off 取消）"
          : "← 默认接收 = 不带命令的消息会发到这里（/use <编号> 可固定绑定）",
        "编号固定不变 · [监控中] = 正在读取消息",
        "用 /s <编号|名字|pid> <消息> 发送到指定 session，例: /s 1 你好",
      ].join("\n"),
    ].filter(Boolean);
    sendReply(sections.join("\n\n"));
    return;
  }

  const bareRoute = text.match(/^\/s(?:\s+(\S+))?\s*$/);
  if (bareRoute) {
    sendReply(
      "用法: /s <编号|名字> <消息>\n例: /s 1 你好\n发送 /sessions 查看可用列表。"
    );
    return;
  }

  const routeMatch = text.match(/^\/s\s+(\S+)\s+([\s\S]+)$/);
  if (routeMatch) {
    const selector = routeMatch[1];
    const message = routeMatch[2];
    const target = findSession(selector);
    if (!target) {
      sendReply(`找不到 "${selector}"。发送 /sessions 查看列表。`);
      return;
    }
    writeToInbox(target.id, { ...msg, text: message });
    trackDelivery(msg.id, target.id, target.name, msg.fromUserId);
    if (!isMonitoring(target.id)) {
      sendReply(
        `已投递到 "${target.name}"，但该 session 未在监控消息（未运行 /wechat），可能不会及时处理。`
      );
    }
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
    sendReply("绑定的 session 已关闭，已自动解除绑定，本条消息按默认路由投递。");
  }
  target = target ?? getDefaultTarget(sessions);
  if (!target) {
    sendReply("当前没有活跃的 Claude session，消息无法投递。");
    return;
  }
  writeToInbox(target.id, msg);
  trackDelivery(msg.id, target.id, target.name, msg.fromUserId);
  if (!isMonitoring(target.id)) {
    sendReply(
      `已投递到 "${target.name}"，但当前没有任何 session 在监控消息（需要在 Claude Code 中运行 /wechat），可能不会及时处理。`
    );
  }
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

        const text = extractText(msg);
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
        notifyMacOS("WeChat 登录已过期，请在 Claude Code 中重新扫码登录");
        break;
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
