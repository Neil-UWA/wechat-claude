#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  claudeNameForMcpPid,
  ownClaudeSessionName,
  parentPids,
} from "./claude-sessions.js";
import { ILinkClient } from "./ilink.js";
import { PKG_VERSION } from "./version.js";
import { peekInbox as peekInboxFor, readInbox as readInboxFor } from "./inbox.js";
import { isMonitoring, touchHeartbeat } from "./monitoring.js";
import { markReplied } from "./replies.js";
import { replyFooter, withReplyFooter } from "./reply-footer.js";
import { routingLines } from "./routing.js";
import { transcriptPath } from "./transcripts.js";
import { readUsageState, resetHint } from "./usage.js";
import {
  DAEMON_PID_FILE,
  EXPIRED_FLAG_FILE,
  SESSIONS_DIR,
  TYPING_DIR,
  WECHAT_DIR,
  ensureDirs as ensureWechatDirs,
  isProcessAlive,
} from "./paths.js";
import {
  type SessionInfo,
  detectSessionName as detectSessionNameFor,
  findNameConflict,
  listSessions,
  validateSessionName,
  writeSessionFile,
} from "./sessions.js";

const DAEMON_LOG_FILE = path.join(WECHAT_DIR, "daemon.log");
const DAEMON_PATH = fileURLToPath(new URL("./daemon.js", import.meta.url));

const WATCHER_PATH = fileURLToPath(new URL("./watch-inbox.js", import.meta.url));

function ensureDirs(): void {
  ensureWechatDirs();
}

function detectSessionName(): string {
  return detectSessionNameFor(process.cwd());
}

function isDaemonRunning(): boolean {
  try {
    const pid = parseInt(
      fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim(),
      10
    );
    return isProcessAlive(pid);
  } catch {
    return false;
  }
}

// Spawn the daemon detached if it is not already running. The daemon has its
// own pid-file singleton guard, so a concurrent spawn from another session is
// harmless. Returns true if the daemon is running when we're done.
async function ensureDaemonRunning(): Promise<{
  running: boolean;
  autoStarted: boolean;
}> {
  if (isDaemonRunning()) return { running: true, autoStarted: false };
  if (!client.isLoggedIn) return { running: false, autoStarted: false };
  try {
    const logFd = fs.openSync(DAEMON_LOG_FILE, "a");
    const child = spawn(process.execPath, [DAEMON_PATH], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
  } catch {
    return { running: false, autoStarted: false };
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (isDaemonRunning()) return { running: true, autoStarted: true };
    await new Promise((r) => setTimeout(r, 150));
  }
  return { running: false, autoStarted: false };
}

function isLoginExpired(): boolean {
  return fs.existsSync(EXPIRED_FLAG_FILE);
}

const sessionId = String(process.pid);
const sessionName = { value: detectSessionName() };
const client = new ILinkClient();

// A session's Claude Code name for display: what it recorded itself, else
// looked up through its MCP server's parent process (sessions from an older
// build recorded nothing). Never guessed: a wrong name here is worse than
// "unknown", because an agent will act on it.
function claudeNameLabel(s: SessionInfo, parents: Map<number, number>): string {
  return s.claudeName ?? claudeNameForMcpPid(s.pid, parents) ?? "unknown";
}

function currentSessionInfo(): SessionInfo {
  // Claude Code passes its own session id to MCP servers; it is the transcript
  // file's name, which is how the daemon can watch this exact session for
  // signs of life instead of guessing from the project directory.
  const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  return {
    id: sessionId,
    name: sessionName.value,
    cwd: process.cwd(),
    pid: process.pid,
    lastActive: Date.now(),
    transcript: claudeSessionId
      ? transcriptPath(process.cwd(), claudeSessionId)
      : undefined,
    // Re-read each time: Claude Code can rename its session after we start.
    claudeName: ownClaudeSessionName(process.ppid),
  };
}

function register(): void {
  ensureDirs();
  writeSessionFile(currentSessionInfo());
}

function unregister(): void {
  try {
    fs.unlinkSync(path.join(SESSIONS_DIR, `${sessionId}.json`));
  } catch {}
}

function touchActive(): void {
  writeSessionFile(currentSessionInfo());
}

function readInbox(): {
  id: string;
  fromUserId: string;
  text: string;
  contextToken: string;
  timestamp: number;
}[] {
  return readInboxFor(sessionId);
}

function peekInbox(): number {
  return peekInboxFor(sessionId);
}

function clearTyping(userId: string): void {
  try {
    fs.unlinkSync(path.join(TYPING_DIR, userId));
  } catch {}
}

const server = new McpServer({ name: "wechat-claude", version: PKG_VERSION });

server.tool(
  "wechat_login",
  "Login to WeChat by scanning a QR code.",
  {},
  async () => {
    if (client.isLoggedIn) {
      return {
        content: [
          { type: "text", text: "Already logged in. Use wechat_logout first." },
        ],
      };
    }
    try {
      const qr = await client.getQRCode();
      return {
        content: [
          {
            type: "text",
            text: `QR code generated. Ask the user to scan it with WeChat.\n\nQR Code URL: ${qr.qrcode_img_content}\n\nUse wechat_login_poll with qrcode_token="${qr.qrcode}" to check scan status.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Login failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "wechat_login_poll",
  "Poll QR code scan status until 'confirmed'.",
  { qrcode_token: z.string().describe("The qrcode token from wechat_login") },
  async ({ qrcode_token }) => {
    try {
      const status = await client.pollQRCodeStatus(qrcode_token);
      if (
        status.status === "confirmed" &&
        status.bot_token &&
        status.ilink_bot_id &&
        status.ilink_user_id
      ) {
        client.setSession({
          botToken: status.bot_token,
          ilinkBotId: status.ilink_bot_id,
          ilinkUserId: status.ilink_user_id,
          baseUrl: status.baseurl || "https://ilinkai.weixin.qq.com",
        });
        try {
          fs.unlinkSync(EXPIRED_FLAG_FILE);
        } catch {}
        const daemon = await ensureDaemonRunning();
        const daemonNote = daemon.running
          ? daemon.autoStarted
            ? "Daemon auto-started."
            : "Daemon already running."
          : `Daemon could not be started — run: wechat-claude daemon (or node ${DAEMON_PATH})`;
        return {
          content: [
            {
              type: "text",
              text: `Login successful! Session: "${sessionName.value}".\n\n${daemonNote}`,
            },
          ],
        };
      }
      if (status.status === "expired") {
        return {
          content: [
            { type: "text", text: "QR code expired. Call wechat_login again." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Status: ${status.status}. ${status.status === "scaned" ? "Scanned, awaiting confirmation..." : "Waiting for scan..."} Keep polling.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Poll failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "wechat_get_messages",
  "Get unread WeChat messages routed to this session by the daemon.",
  {},
  async () => {
    touchActive();
    touchHeartbeat(sessionId);
    const msgs = readInbox();
    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No new messages." }] };
    }
    for (const m of msgs) {
      if (m.contextToken && m.fromUserId) {
        client.trackContextToken(m.fromUserId, m.contextToken);
      }
    }
    const formatted = msgs.map((m) => {
      const time = new Date(m.timestamp).toLocaleString("zh-CN");
      return `[${time}] ${m.fromUserId}:\n${m.text}`;
    });
    return {
      content: [
        {
          type: "text",
          text: `${msgs.length} new message(s):\n\n${formatted.join("\n\n---\n\n")}`,
        },
      ],
    };
  }
);

server.tool(
  "wechat_send_text",
  "Send a text message to a WeChat user. A one-line trailer naming this session and its '/s <n>' reply command is appended automatically (config.json \"replyFooter\": false disables it) — do not add your own.",
  {
    to_user_id: z.string().describe("User ID (e.g. 'xxx@im.wechat')"),
    text: z.string().describe("Text message to send"),
  },
  async ({ to_user_id, text }) => {
    if (!client.isLoggedIn) {
      return {
        content: [{ type: "text", text: "Not logged in." }],
        isError: true,
      };
    }
    try {
      clearTyping(to_user_id);
      await client.sendText(
        to_user_id,
        withReplyFooter(text, replyFooter(sessionId, sessionName.value))
      );
      // Tells the daemon this session actually answered, so its silence
      // watchdog (usage-limit detection) stops tracking the delivery.
      markReplied(sessionId, to_user_id);
      await client.sendTyping(to_user_id, false);
      return {
        content: [
          { type: "text", text: `Sent to ${to_user_id} (${text.length} chars).` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Send failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "wechat_send_image",
  "Send an image file to a WeChat user. The session trailer (see wechat_send_text) is appended to the caption, or sent as the caption when none is given.",
  {
    to_user_id: z.string().describe("User ID (e.g. 'xxx@im.wechat')"),
    file_path: z.string().describe("Absolute path to the image file"),
    caption: z.string().optional().describe("Optional text caption to send with the image"),
  },
  async ({ to_user_id, file_path, caption }) => {
    if (!client.isLoggedIn) {
      return {
        content: [{ type: "text", text: "Not logged in." }],
        isError: true,
      };
    }
    try {
      const fs = await import("node:fs");
      if (!fs.existsSync(file_path)) {
        return {
          content: [{ type: "text", text: `File not found: ${file_path}` }],
          isError: true,
        };
      }
      clearTyping(to_user_id);
      const footer = replyFooter(sessionId, sessionName.value);
      const fullCaption = caption
        ? withReplyFooter(caption, footer)
        : footer || undefined;
      await client.sendImage(to_user_id, file_path, fullCaption);
      markReplied(sessionId, to_user_id);
      await client.sendTyping(to_user_id, false);
      return {
        content: [
          { type: "text", text: `Image sent to ${to_user_id}.` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Send image failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "wechat_set_session_name",
  "Set this session's WeChat routing name (used in '/s <name> <msg>' from WeChat). This is NOT the Claude Code session name that SendMessage/ListAgents use; wechat_status shows both. Rejects whitespace, purely numeric names, and names another live session already holds. Setting the current name again is a no-op.",
  {
    name: z
      .string()
      .describe(
        "Routing name, one word without spaces (e.g. 'backend', 'review', 'integration')"
      ),
  },
  async ({ name: raw }) => {
    const checked = validateSessionName(raw);
    if (!checked.ok) {
      const hint = checked.suggestion
        ? ` Try "${checked.suggestion}" instead.`
        : "";
      return {
        content: [{ type: "text", text: `${checked.reason}${hint}` }],
        isError: true,
      };
    }
    const name = checked.name;
    if (name === sessionName.value) {
      touchActive();
      return {
        content: [
          {
            type: "text",
            text: `Session name is already "${name}" — nothing changed. Route: /s ${name} <msg>`,
          },
        ],
      };
    }
    const holder = findNameConflict(name, sessionId);
    if (holder) {
      const theirs = `, Claude Code name: ${claudeNameLabel(holder, parentPids([holder.pid]))}`;
      return {
        content: [
          {
            type: "text",
            text: `Name "${name}" is already used by another live session (pid: ${holder.pid}${theirs}, cwd: ${holder.cwd}). Session name unchanged ("${sessionName.value}"). Pick a different name, or close that session first (/close ${holder.pid} in WeChat).`,
          },
        ],
        isError: true,
      };
    }
    const previous = sessionName.value;
    sessionName.value = name;
    register();
    return {
      content: [
        {
          type: "text",
          text: `Session name: "${name}" (was "${previous}"). Route from WeChat: /s ${name} <msg>`,
        },
      ],
    };
  }
);

server.tool(
  "wechat_status",
  "Check WeChat connection, daemon status, and active sessions. Call at session start to see if WeChat monitoring is available.",
  {},
  async () => {
    const daemon = await ensureDaemonRunning();
    // Running /wechat is the user turning their attention to this session, so
    // it should become the default target for plain messages once its watcher
    // is up (the default is the most recently active monitored session).
    touchActive();
    const sessions = listSessions();
    const inboxCount = peekInbox();
    const monitoring = isMonitoring(sessionId);
    const ownClaudeName = ownClaudeSessionName(process.ppid);
    const parents = parentPids(
      sessions.filter((s) => !s.claudeName).map((s) => s.pid)
    );
    const lines = [
      `wechat-claude v${PKG_VERSION}`,
      `Logged in: ${client.isLoggedIn}`,
      `Daemon running: ${daemon.running}${daemon.autoStarted ? " (auto-started just now)" : ""}`,
      `Session: ${sessionName.value} (id: ${sessionId})  ·  WeChat routing name, use in "/s ${sessionName.value} <msg>"`,
      `Claude Code session name: ${ownClaudeName ?? "unknown"}  ·  what other Claude sessions pass to SendMessage; see ListAgents`,
      `Inbox: ${inboxCount} message(s)`,
      `Watcher: ${monitoring ? "active — this session is monitoring messages" : "NOT active — messages routed here will sit unread"}`,
      ...routingLines(sessionId),
      `Active sessions (${sessions.length}):`,
      ...sessions.map((s) => {
        const active = Date.now() - s.lastActive < 120_000 ? "●" : "○";
        const mon = isMonitoring(s.id) ? " [monitoring]" : "";
        const self = s.id === sessionId ? " (this session)" : "";
        const claude = `  ·  SendMessage: ${claudeNameLabel(s, parents)}`;
        return `  ${active} ${s.name} (pid: ${s.pid})${mon}${self}${claude}`;
      }),
      `  (Names before "(pid" are WeChat routing names for "/s <name> <msg>" — they are NOT Claude Code session names. To message a session with SendMessage, use the name after "SendMessage:", or ListAgents. Either name works as the /s selector.)`,
    ];
    // The daemon records this; a session that was rate-limited comes back with
    // no idea why it went quiet, and the user is owed an explanation.
    const usage = readUsageState();
    if (usage.limited && (usage.resetAt === undefined || Date.now() < usage.resetAt)) {
      lines.push(
        "",
        `Claude usage limit is currently reached (reset: ${resetHint(usage, Date.now()) ?? "unknown"}). All sessions are blocked from replying until it lifts; the daemon notified the user on WeChat and will nudge this session when it recovers.`
      );
    }
    if (isLoginExpired()) {
      lines.push(
        "",
        "WeChat login has EXPIRED. Call wechat_login to re-authenticate (scan QR code)."
      );
    } else if (!client.isLoggedIn) {
      lines.push("", "Not logged in. Call wechat_login to authenticate.");
    }
    if (!daemon.running && client.isLoggedIn) {
      lines.push(
        "",
        `Daemon is NOT running and auto-start failed. Check ${DAEMON_LOG_FILE}, or start manually: wechat-claude daemon (or node ${DAEMON_PATH} if the bin is not on PATH)`
      );
    }
    if (!monitoring) {
      lines.push(
        "",
        `To monitor messages in this session, start a persistent Monitor with: node ${WATCHER_PATH} ${sessionId}`
      );
    }
    if (client.isLoggedIn && daemon.running && monitoring) {
      lines.push("", "WeChat is fully operational. Messages are being monitored.");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "wechat_logout",
  "Disconnect from WeChat and clear session.",
  {},
  async () => {
    client.logout();
    return {
      content: [{ type: "text", text: "Logged out. Session cleared." }],
    };
  }
);

async function main(): Promise<void> {
  ensureDirs();
  register();
  process.on("exit", unregister);

  client.tryRestoreSession();

  process.stderr.write(
    `[wechat-claude] MCP server started. Session: "${sessionName.value}", logged in: ${client.isLoggedIn}\n`
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
