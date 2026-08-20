import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PendingMessage } from "./types.js";

const WECHAT_DIR = path.join(os.homedir(), ".claude", "wechat");
const SESSIONS_DIR = path.join(WECHAT_DIR, "sessions");
const INBOX_DIR = path.join(WECHAT_DIR, "inbox");
const LOCK_FILE = path.join(WECHAT_DIR, "poll.lock");
const CURSOR_FILE = path.join(WECHAT_DIR, "cursor.txt");

export type SessionInfo = {
  id: string;
  name: string;
  cwd: string;
  pid: number;
  lastActive: number;
};

function detectSessionName(): string {
  const cwd = process.cwd();

  const worktreeMatch = cwd.match(/\.claude[/\\]worktrees[/\\]([^/\\]+)/);
  if (worktreeMatch) {
    const repoPath = cwd.split(/\.claude[/\\]worktrees[/\\]/)[0].replace(/[/\\]$/, "");
    const repoName = path.basename(repoPath);
    return `${repoName}/${worktreeMatch[1]}`;
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
    if (branchMatch) {
      return `${repoName}:${branchMatch[1]}`;
    }
  } catch {}

  return repoName || `session-${process.pid}`;
}

function ensureDirs(): void {
  for (const dir of [WECHAT_DIR, SESSIONS_DIR, INBOX_DIR]) {
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

export class WechatRouter {
  private sessionId: string;
  private sessionName: string;
  private isLeader = false;

  constructor(name?: string) {
    ensureDirs();
    this.sessionId = String(process.pid);
    this.sessionName = name ?? detectSessionName();
    this.register();
    process.on("exit", () => this.cleanup());
  }

  get id(): string {
    return this.sessionId;
  }

  get name(): string {
    return this.sessionName;
  }

  setName(name: string): void {
    this.sessionName = name;
    this.register();
  }

  private register(): void {
    const info: SessionInfo = {
      id: this.sessionId,
      name: this.sessionName,
      cwd: process.cwd(),
      pid: process.pid,
      lastActive: Date.now(),
    };
    fs.writeFileSync(
      path.join(SESSIONS_DIR, `${this.sessionId}.json`),
      JSON.stringify(info)
    );
  }

  touchActive(): void {
    try {
      const file = path.join(SESSIONS_DIR, `${this.sessionId}.json`);
      const info = JSON.parse(fs.readFileSync(file, "utf-8")) as SessionInfo;
      info.lastActive = Date.now();
      info.name = this.sessionName;
      fs.writeFileSync(file, JSON.stringify(info));
    } catch {
      this.register();
    }
  }

  private cleanup(): void {
    try {
      fs.unlinkSync(path.join(SESSIONS_DIR, `${this.sessionId}.json`));
    } catch {}
    try {
      fs.unlinkSync(path.join(INBOX_DIR, `${this.sessionId}.json`));
    } catch {}
    if (this.isLeader) {
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {}
    }
  }

  tryBecomePollLeader(): boolean {
    try {
      const lockPid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      if (isProcessAlive(lockPid)) {
        this.isLeader = false;
        return false;
      }
      fs.unlinkSync(LOCK_FILE);
    } catch {
      // no lock file
    }

    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
      this.isLeader = true;
      return true;
    } catch {
      this.isLeader = false;
      return false;
    }
  }

  get isPollLeader(): boolean {
    return this.isLeader;
  }

  getCursor(): string {
    try {
      return fs.readFileSync(CURSOR_FILE, "utf-8").trim();
    } catch {
      return "";
    }
  }

  setCursor(cursor: string): void {
    fs.writeFileSync(CURSOR_FILE, cursor);
  }

  listSessions(): SessionInfo[] {
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

  private findSession(selector: string): SessionInfo | undefined {
    const sessions = this.listSessions();
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

  private getDefaultTarget(): SessionInfo | undefined {
    return this.listSessions()[0];
  }

  routeMessage(
    msg: PendingMessage,
    sendReply: (text: string) => Promise<void>
  ): boolean {
    const text = msg.text.trim();

    if (text === "/sessions" || text === "/ls") {
      const sessions = this.listSessions();
      if (sessions.length === 0) {
        sendReply("当前没有活跃的 Claude session。");
        return true;
      }
      const lines = sessions.map((s, i) => {
        const active = Date.now() - s.lastActive < 120_000 ? "●" : "○";
        const cwd = path.basename(s.cwd);
        return `${active} ${i + 1}. ${s.name}\n   目录: ${cwd}`;
      });
      sendReply(`活跃 sessions (${sessions.length}):\n\n${lines.join("\n\n")}\n\n用 /s <编号> <消息> 发送到指定 session\n例: /s 1 你好`);
      return true;
    }

    const routeMatch = text.match(/^\/s\s+(\S+)\s+([\s\S]+)$/);
    if (routeMatch) {
      const selector = routeMatch[1];
      const message = routeMatch[2];
      const target = this.findSession(selector);
      if (!target) {
        sendReply(
          `找不到 "${selector}"。发送 /sessions 查看列表，可用编号或名字。`
        );
        return true;
      }
      this.writeToInbox(target.id, { ...msg, text: message });
      return false;
    }

    const target = this.getDefaultTarget();
    if (!target) {
      sendReply("当前没有活跃的 Claude session，消息无法投递。");
      return true;
    }
    this.writeToInbox(target.id, msg);
    return false;
  }

  private writeToInbox(sessionId: string, msg: PendingMessage): void {
    const file = path.join(INBOX_DIR, `${sessionId}.json`);
    let inbox: PendingMessage[] = [];
    try {
      inbox = JSON.parse(fs.readFileSync(file, "utf-8")) as PendingMessage[];
    } catch {}
    inbox.push(msg);
    fs.writeFileSync(file, JSON.stringify(inbox));
  }

  peekInbox(): number {
    const file = path.join(INBOX_DIR, `${this.sessionId}.json`);
    try {
      const msgs = JSON.parse(fs.readFileSync(file, "utf-8")) as PendingMessage[];
      return msgs.length;
    } catch {
      return 0;
    }
  }

  readInbox(): PendingMessage[] {
    const file = path.join(INBOX_DIR, `${this.sessionId}.json`);
    try {
      const raw = fs.readFileSync(file, "utf-8");
      const msgs = JSON.parse(raw) as PendingMessage[];
      if (msgs.length > 0) {
        fs.writeFileSync(file, "[]");
      }
      return msgs;
    } catch {
      return [];
    }
  }
}
