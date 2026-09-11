#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type ClaudeSessionRecord,
  claudeRecordsForSessions,
  ownClaudeSessionName,
} from "./claude-sessions.js";
import {
  DAEMON_PATH,
  ensureDaemonRunning,
  isDaemonRunning,
  restartDaemonForNewLogin,
} from "./daemon-control.js";
import {
  ILinkClient,
  SESSION_EXPIRED,
  SESSION_REPLACED,
} from "./ilink.js";
import { loginVerification, verificationNote } from "./login-state.js";
import { PKG_VERSION } from "./version.js";
import { peekInbox as peekInboxFor, readInbox as readInboxFor } from "./inbox.js";
import { isMonitoring, touchHeartbeat } from "./monitoring.js";
import { markReplied } from "./replies.js";
import { replyFooter, withReplyFooter } from "./reply-footer.js";
import { routingLines } from "./routing.js";
import { transcriptPath } from "./transcripts.js";
import { readUsageState, resetHint } from "./usage.js";
import {
  DAEMON_LOG_FILE,
  EXPIRED_FLAG_FILE,
  SESSIONS_DIR,
  TYPING_DIR,
  ensureDirs as ensureWechatDirs,
} from "./paths.js";
import {
  type SessionInfo,
  cwdLabel,
  detectSessionName as detectSessionNameFor,
  findNameConflict,
  listSessions,
  validateSessionName,
  writeSessionFile,
} from "./sessions.js";


const WATCHER_PATH = fileURLToPath(new URL("./watch-inbox.js", import.meta.url));

function ensureDirs(): void {
  ensureWechatDirs();
}

function detectSessionName(): string {
  return detectSessionNameFor(process.cwd());
}

// Start the daemon if nothing is polling. Shared with the CLI so both agree on
// the rules (launchd owns it where installed; a pid file is only trusted once
// the process behind it is confirmed to be a daemon).
async function ensureDaemon(): Promise<{
  running: boolean;
  autoStarted: boolean;
}> {
  if (isDaemonRunning()) return { running: true, autoStarted: false };
  if (!client.isLoggedIn) return { running: false, autoStarted: false };
  const ok = await ensureDaemonRunning();
  return { running: ok, autoStarted: ok };
}

function isLoginExpired(): boolean {
  return fs.existsSync(EXPIRED_FLAG_FILE);
}

const sessionId = String(process.pid);
const sessionName = { value: detectSessionName() };
const client = new ILinkClient();

// A session's Claude Code name for display: the live registry record (found
// through its MCP server's parent process) first, since Claude Code can rename
// a session after its session file was last written; the stored name only as
// a fallback (e.g. `ps` unavailable). Never guessed: a wrong name here is
// worse than "unknown", because an agent will act on it.
function claudeNameLabel(
  s: SessionInfo,
  records: Map<string, ClaudeSessionRecord>
): string {
  return records.get(s.id)?.name ?? s.claudeName ?? "unknown";
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
    // Lets listSessions() tell a reconnect's leftover MCP server apart from a
    // genuinely separate session (see supersededIds()).
    claudePid: process.ppid,
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

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// A send is where the truth about the token surfaces: the API answers a
// revoked credential with an error in the body, and until now that came back
// as a bare "Send failed". Record the expiry so wechat_status stops claiming
// otherwise, and say what fixes it.
function sendFailure(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  // A newer login landed mid-send. Flagging expiry here would mark a perfectly
  // good credential dead and send the user back to a QR code for nothing.
  if (msg.includes(SESSION_REPLACED)) {
    return {
      content: [
        {
          type: "text",
          text: "Send failed: another session logged in to WeChat while this message was in flight, so this send used a credential that is no longer current. The new login has been picked up — send again.",
        },
      ],
      isError: true,
    };
  }
  if (msg.includes(SESSION_EXPIRED)) {
    try {
      fs.writeFileSync(EXPIRED_FLAG_FILE, String(Date.now()));
    } catch {}
    return {
      content: [
        {
          type: "text",
          text: "Send failed: the WeChat login has EXPIRED — the token was revoked (e.g. `wechat-claude uninstall` on another machine) or timed out, and it has been cleared. Call wechat_login, have the user scan the QR code, then send again.",
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: `Send failed: ${msg}` }], isError: true };
}

const NOT_LOGGED_IN: ToolResult = {
  content: [
    {
      type: "text",
      text: "Not logged in. Call wechat_login and have the user scan the QR code.",
    },
  ],
  isError: true,
};

// When each QR code was handed out. The API reports "expired" but never says
// how long a code is good for, and there is at least one conversational round
// trip between showing the URL and the next poll — long enough, in practice,
// for the user to lose the race without ever being told there was one. Age is
// surfaced on every poll so the agent can hurry the user along, and an expired
// code is replaced on the spot instead of costing another round trip.
const qrIssuedAt = new Map<string, number>();

function rememberQR(token: string): void {
  // Only the current login attempt matters; don't grow without bound.
  if (qrIssuedAt.size > 20) qrIssuedAt.clear();
  qrIssuedAt.set(token, Date.now());
}

function qrAgeNote(token: string): string {
  const issued = qrIssuedAt.get(token);
  if (issued === undefined) return "";
  const secs = Math.round((Date.now() - issued) / 1000);
  const hurry =
    secs >= 45
      ? " — QR codes are short-lived (they have expired inside two minutes); if the user has not scanned yet, tell them to scan now."
      : "";
  return ` QR issued ${secs}s ago${hurry}.`;
}

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
      rememberQR(qr.qrcode);
      return {
        content: [
          {
            type: "text",
            text: `QR code generated. Show this URL to the user right now and ask them to scan it — QR codes are short-lived (they have expired inside two minutes), and the clock is already running.\n\nQR Code URL: ${qr.qrcode_img_content}\n\nUse wechat_login_poll with qrcode_token="${qr.qrcode}" to check scan status. Poll promptly; if the code expires, the poll issues a fresh one and returns its URL.`,
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
        // Restart, never "start if absent": a daemon that is already running
        // holds the credential it read at startup and never re-reads
        // session.json, so it would keep polling with the token this login
        // just replaced — and exit when that one is rejected, leaving the new
        // login with nothing polling.
        const restarted = await restartDaemonForNewLogin();
        const daemonNote = restarted
          ? "Daemon restarted with the new login."
          : `Daemon could not be started — run: wechat-claude daemon start (or node ${DAEMON_PATH})`;
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
        // Reissue here rather than making the agent call wechat_login again:
        // the user is waiting, and every round trip burns more of the next
        // code's life.
        try {
          const fresh = await client.getQRCode();
          rememberQR(fresh.qrcode);
          return {
            content: [
              {
                type: "text",
                text: `QR code expired.${qrAgeNote(qrcode_token)} A fresh one has been issued — show this URL to the user now and ask them to scan immediately.\n\nQR Code URL: ${fresh.qrcode_img_content}\n\nKeep polling with qrcode_token="${fresh.qrcode}".`,
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `QR code expired.${qrAgeNote(qrcode_token)} Issuing a replacement failed — call wechat_login again.`,
              },
            ],
          };
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `Status: ${status.status}. ${status.status === "scaned" ? "Scanned, awaiting confirmation..." : "Waiting for scan..."} Keep polling.${qrAgeNote(qrcode_token)}`,
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
    if (!client.isLoggedIn) return NOT_LOGGED_IN;
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
      return sendFailure(err);
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
    if (!client.isLoggedIn) return NOT_LOGGED_IN;
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
      // The caption goes through sendText, which splits at the API's text
      // limit; sendImage sends its caption as a single item and would fail
      // once the footer pushed a long caption over that limit. Same order as
      // sendImage's own caption handling: text first, then the image.
      if (fullCaption) await client.sendText(to_user_id, fullCaption);
      await client.sendImage(to_user_id, file_path);
      markReplied(sessionId, to_user_id);
      await client.sendTyping(to_user_id, false);
      return {
        content: [
          { type: "text", text: `Image sent to ${to_user_id}.` },
        ],
      };
    } catch (err) {
      return sendFailure(err);
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
      const theirs = `, Claude Code name: ${claudeNameLabel(holder, claudeRecordsForSessions([holder]))}`;
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
    const daemon = await ensureDaemon();
    // Running /wechat is the user turning their attention to this session, so
    // it should become the default target for plain messages once its watcher
    // is up (the default is the most recently active monitored session).
    touchActive();
    const sessions = listSessions();
    const inboxCount = peekInbox();
    const monitoring = isMonitoring(sessionId);
    const ownClaudeName = ownClaudeSessionName(process.ppid);
    // Every live session's Claude Code record, in one `ps` call: the current
    // cross-session name and the directory Claude is really in now.
    const records = claudeRecordsForSessions(sessions);
    const lines = [
      `wechat-claude v${PKG_VERSION}`,
      `Logged in: ${client.isLoggedIn}${client.isLoggedIn ? ` ${verificationNote(loginVerification())}` : ""}`,
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
        const dir = `  ·  dir: ${cwdLabel(records.get(s.id)?.cwd ?? s.cwd)}`;
        const claude = `  ·  SendMessage: ${claudeNameLabel(s, records)}`;
        return `  ${active} ${s.name} (pid: ${s.pid})${mon}${self}${dir}${claude}`;
      }),
      `  (Names before "(pid" are WeChat routing names for "/s <name> <msg>" — they are NOT Claude Code session names. To message a session with SendMessage, use the name after "SendMessage:", or ListAgents. Either name works as the /s selector. "dir:" is the directory that session's Claude is currently in, worktrees as repo/worktree.)`,
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
