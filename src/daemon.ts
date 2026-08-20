#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawn } from "node:child_process";
import { ILinkClient } from "./ilink.js";
import type { PendingMessage, WeixinMessage } from "./types.js";
import { extractText as sharedExtractText } from "./utils.js";

const WECHAT_DIR = path.join(os.homedir(), ".claude", "wechat");
const SESSIONS_DIR = path.join(WECHAT_DIR, "sessions");
const INBOX_DIR = path.join(WECHAT_DIR, "inbox");
const CURSOR_FILE = path.join(WECHAT_DIR, "cursor.txt");
const DAEMON_PID_FILE = path.join(WECHAT_DIR, "daemon.pid");
const TYPING_DIR = path.join(WECHAT_DIR, "typing");

type SessionInfo = {
  id: string;
  name: string;
  cwd: string;
  pid: number;
  lastActive: number;
};

function ensureDirs(): void {
  for (const dir of [WECHAT_DIR, SESSIONS_DIR, INBOX_DIR, TYPING_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listSessions(): SessionInfo[] {
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

function findSession(selector: string): SessionInfo | undefined {
  const sessions = listSessions();
  const num = parseInt(selector, 10);
  if (!isNaN(num) && num >= 1 && num <= sessions.length) {
    return sessions[num - 1];
  }
  const lower = selector.toLowerCase();
  return (
    sessions.find((s) => s.name.toLowerCase() === lower) ??
    sessions.find((s) => s.name.toLowerCase().includes(lower))
  );
}

function writeToInbox(sessionId: string, msg: PendingMessage): void {
  const file = path.join(INBOX_DIR, `${sessionId}.json`);
  let inbox: PendingMessage[] = [];
  try {
    inbox = JSON.parse(fs.readFileSync(file, "utf-8")) as PendingMessage[];
  } catch {}
  inbox.push(msg);
  fs.writeFileSync(file, JSON.stringify(inbox));
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

function hasTmux(): boolean {
  try {
    execSync("which tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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

  const reposDir = path.join(os.homedir(), "Documents", "repos");
  const candidate = path.join(reposDir, dirHint);
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {}

  if (path.isAbsolute(dirHint)) {
    try {
      if (fs.statSync(dirHint).isDirectory()) return dirHint;
    } catch {}
  }

  return undefined;
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

  if (!args.trim()) {
    sendReply("用法: /run [目录] <任务>\n\n例:\n/run 检查最近的 PR\n/run fintary 检查代码风格\n/run /path/to/repo 修复 bug");
    return;
  }

  const parts = args.trim().split(/\s+/);
  let dirHint: string | undefined;
  let task: string;

  const firstWordAsDir = resolveRunDir(parts[0]);
  if (parts.length > 1 && firstWordAsDir) {
    dirHint = parts[0];
    task = parts.slice(1).join(" ");
  } else {
    dirHint = undefined;
    task = args.trim();
  }

  const cwd = resolveRunDir(dirHint);
  if (!cwd) {
    if (dirHint) {
      sendReply(`找不到目录 "${dirHint}"。\n\n可用的 session 目录:\n${listSessions().map((s) => `  - ${s.name} (${s.cwd})`).join("\n")}\n\n也可以用 ~/Documents/repos/ 下的目录名，或绝对路径。`);
    } else {
      sendReply("没有活跃的 session，请指定目录。\n用法: /run <目录> <任务>");
    }
    return;
  }

  if (!hasTmux()) {
    sendReply("tmux 未安装，无法启动交互式 session。请在终端中手动运行。");
    return;
  }

  const sessionName = `wc-${Date.now().toString(36)}`;
  const taskFile = path.join(os.tmpdir(), `wechat-run-${sessionName}.txt`);
  fs.writeFileSync(taskFile, task);

  const shellCmd = `task=$(cat ${taskFile}); rm -f ${taskFile}; claude "$task"`;
  const cmd = `tmux new-session -d -s "${sessionName}" -c "${cwd}" "${shellCmd.replace(/"/g, '\\"')}"`;

  try {
    execSync(cmd, { stdio: "ignore" });
    log(`Started tmux session "${sessionName}" in ${cwd}: ${task}`);
    sendReply(`已启动 Claude session\n\n目录: ${path.basename(cwd)}\n任务: ${task}\ntmux: ${sessionName}\n\n回到电脑后运行:\ntmux attach -t ${sessionName}`);
  } catch (err) {
    try { fs.unlinkSync(taskFile); } catch {}
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to start tmux session: ${errMsg}`);
    sendReply(`启动失败: ${errMsg}`);
  }
}

function routeMessage(client: ILinkClient, msg: PendingMessage): void {
  const text = msg.text.trim();

  const sendReply = (reply: string): void => {
    client.sendText(msg.fromUserId, reply).catch((err) => {
      log(`Reply failed: ${err}`);
    });
  };

  const runMatch = text.match(/^\/run\s*([\s\S]*)$/);
  if (runMatch) {
    handleRunCommand(client, msg, runMatch[1]);
    return;
  }

  if (text === "/sessions" || text === "/ls") {
    const sessions = listSessions();
    if (sessions.length === 0) {
      sendReply("当前没有活跃的 Claude session。");
      return;
    }
    const lines = sessions.map((s, i) => {
      const active = Date.now() - s.lastActive < 120_000 ? "●" : "○";
      const cwd = path.basename(s.cwd);
      return `${active} ${i + 1}. ${s.name}\n   目录: ${cwd}`;
    });
    sendReply(
      `活跃 sessions (${sessions.length}):\n\n${lines.join("\n\n")}\n\n用 /s <编号> <消息> 发送到指定 session\n例: /s 1 你好`
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
    markTyping(msg.fromUserId);
    client.startTypingKeepAlive(msg.fromUserId, () => isTypingActive(msg.fromUserId));
    log(`Routed to ${target.name} (${target.id})`);
    return;
  }

  const sessions = listSessions();
  const target = sessions.length > 0
    ? sessions.reduce((a, b) => (a.lastActive > b.lastActive ? a : b))
    : undefined;
  if (!target) {
    sendReply("当前没有活跃的 Claude session，消息无法投递。");
    return;
  }
  writeToInbox(target.id, msg);
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

  startTypingWatcher(client);

  log(`Daemon started (pid ${process.pid}). Polling WeChat...`);

  while (true) {
    try {
      const rawMsgs = await client.getUpdates();
      setCursor(client.getUpdatesCursor());

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

        log(`Message: ${text.slice(0, 60)}`);
        routeMessage(client, pending);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Session expired")) {
        log("Session expired. Exiting.");
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
