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

// One SendMessage call needs no reasoning: the cheapest model does it.
export const RELAY_MODEL = "claude-haiku-4-5-20251001";
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
// The model's own prose is not trusted: only the tool's result counts.
export function relaySucceeded(streamJson: string): boolean {
  const sendIds = new Set<string>();
  const results: { id: string; text: string }[] = [];
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
        results.push({ id: b.tool_use_id, text: resultText(b.content) });
      }
    }
  }
  return results.some(({ id, text }) => {
    if (!sendIds.has(id)) return false;
    try {
      return (JSON.parse(text) as { success?: unknown }).success === true;
    } catch {
      return false;
    }
  });
}

// `--strict-mcp-config` with an empty map keeps this package's own MCP server
// out of the relay, which would otherwise register a phantom WeChat session.
export function relayArgs(socketPath: string, message: string): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "3",
    "--model",
    RELAY_MODEL,
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--allowedTools",
    "SendMessage",
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
