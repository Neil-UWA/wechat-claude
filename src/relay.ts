// Reaching a Claude session that is not in tmux: a short headless `claude -p`
// sends it a message with SendMessage. That is Claude Code's own cross-session
// channel — the one ListAgents/SendMessage use between a user's sessions —
// and the only one that wakes an *idle* interactive session from outside. Its
// wire protocol is internal to Claude Code, so it is driven through a Claude
// process rather than spoken directly.
//
// The relay is addressed by the target's messaging socket ("uds:<path>"),
// never by name: names can repeat, the socket cannot.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolveClaudeBin } from "./usage.js";

export const RELAY_TIMEOUT_MS = 120_000;

// A socket path from Claude Code's session record, safe to quote in a prompt.
export function isSocketPath(p: string): boolean {
  return /^\/[A-Za-z0-9._/-]+\.sock$/.test(p);
}

export function relayPrompt(socketPath: string, message: string): string {
  return [
    `Use the SendMessage tool exactly once to send the message between the markers to "uds:${socketPath}". Send it verbatim. Do nothing else.`,
    "<<<",
    message,
    ">>>",
  ].join("\n");
}

type StreamEvent = {
  type?: unknown;
  message?: { content?: unknown };
};

type ContentBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
};

function blocks(e: StreamEvent): ContentBlock[] {
  const c = e.message?.content;
  return Array.isArray(c) ? (c.filter((b) => typeof b === "object" && b !== null) as ContentBlock[]) : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string"
        ? (c as { text: string }).text
        : ""
    )
    .join("");
}

// Whether a SendMessage call in the run's stream-json output reported success.
// The model's own prose is not trusted: only the tool's result counts. Today
// that result is JSON with `success` (`{"success":true,"message":…}`); should
// its shape change, a result that isn't an error and doesn't say
// `success: false` still counts as delivered rather than failing every relay.
export function relaySucceeded(streamJson: string): boolean {
  const sendIds = new Set<string>();
  const results: { id: string; text: string; error: boolean }[] = [];
  for (const line of streamJson.split("\n")) {
    let e: StreamEvent;
    try {
      e = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    for (const b of blocks(e)) {
      if (e.type === "assistant" && b.type === "tool_use" && b.name === "SendMessage" && typeof b.id === "string") {
        sendIds.add(b.id);
      }
      if (e.type === "user" && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        results.push({ id: b.tool_use_id, text: resultText(b.content), error: b.is_error === true });
      }
    }
  }
  return results.some(({ id, text, error }) => {
    if (!sendIds.has(id) || error) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text.trim() !== "";
    }
    if (typeof parsed !== "object" || parsed === null) return text.trim() !== "";
    const r = parsed as { success?: unknown; error?: unknown };
    if ("success" in r) return r.success === true;
    return r.error === undefined;
  });
}

// `--strict-mcp-config` with an empty map keeps this package's own MCP server
// out of the relay, which would otherwise register a phantom WeChat session.
// `--tools SendMessage` is what confines the run to that one tool: on its own,
// `--allowedTools` only pre-approves SendMessage and leaves every other tool
// in place, to be used under whatever allow rules or `defaultMode` the user's
// settings grant. `--permission-mode default` keeps a user-wide
// bypassPermissions from applying here. The model is the user's default.
export function relayArgs(socketPath: string, message: string): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "3",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--tools",
    "SendMessage",
    "--allowedTools",
    "SendMessage",
    "--permission-mode",
    "default",
    "--",
    relayPrompt(socketPath, message),
  ];
}

export function relayMessage(
  socketPath: string,
  message: string,
  timeoutMs: number = RELAY_TIMEOUT_MS
): Promise<boolean> {
  if (!isSocketPath(socketPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveClaudeBin(), relayArgs(socketPath, message), {
        cwd: os.tmpdir(),
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          PATH: `${process.env.PATH ?? ""}:${path.join(os.homedir(), ".local/bin")}:/opt/homebrew/bin:/usr/local/bin`,
        },
      });
    } catch {
      resolve(false);
      return;
    }
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < 256_000) out += chunk.toString();
    });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(false);
    }, timeoutMs);
    child.on("error", () => finish(false));
    child.on("close", () => finish(relaySucceeded(out)));
  });
}
