#!/usr/bin/env node
// PostToolUse + Stop hook: attaches WeChat to this session when the daemon
// asked for it — a message was sent here while no watcher was running (see
// attach.ts for when the daemon asks, and why it cannot just do it itself).
//
// PostToolUse reaches a session that is busy: the instruction rides along with
// the next tool result. Stop reaches one finishing its turn: blocking the stop
// makes Claude carry on and attach before going idle.
//
// This runs on every tool call of every session, nearly all of which have
// nothing to do with WeChat: when there is no request on disk at all it exits
// after one readdir, and everything beyond that is imported lazily.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ATTACH_DIR = path.join(os.homedir(), ".claude", "wechat", "attach");

export type HookInput = {
  hook_event_name?: unknown;
  session_id?: unknown;
  tool_name?: unknown;
  stop_hook_active?: unknown;
};

export function attachInstruction(name: string): string {
  return [
    `A WeChat message was sent to this session (WeChat routing name "${name}"), but this session is not monitoring WeChat, so the message is sitting unread.`,
    "Attach WeChat now: invoke the `wechat` skill (the /wechat command) with the Skill tool. If it is not available, do its steps yourself — call wechat_status, start a persistent Monitor with the watcher command it prints, then call wechat_get_messages.",
    "Then handle the message and reply with wechat_send_text. If you were in the middle of a task, attach first and carry on with the task afterwards.",
  ].join(" ");
}

// The hook's stdout for this event, or undefined to stay silent.
export function hookOutput(event: string, name: string): string | undefined {
  const text = attachInstruction(name);
  if (event === "PostToolUse") {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
    });
  }
  if (event === "Stop") return JSON.stringify({ decision: "block", reason: text });
  return undefined;
}

// Whether this invocation may act at all. A session already talking to the
// WeChat tools is attaching (or answering) on its own; a Stop that is itself
// the continuation of a blocked stop must not be blocked again.
export function shouldAct(input: HookInput): boolean {
  const event = input.hook_event_name;
  if (event !== "PostToolUse" && event !== "Stop") return false;
  if (typeof input.session_id !== "string") return false;
  if (typeof input.tool_name === "string" && input.tool_name.startsWith("mcp__wechat__")) {
    return false;
  }
  if (event === "Stop" && input.stop_hook_active === true) return false;
  return true;
}

async function main(): Promise<void> {
  try {
    if (!fs.readdirSync(ATTACH_DIR).some((f) => f.endsWith(".json"))) return;
  } catch {
    return;
  }
  let input: HookInput;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(0, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return;
    input = parsed as HookInput;
  } catch {
    return;
  }
  if (!shouldAct(input)) return;

  const { claudePidForSessionId } = await import("./claude-sessions.js");
  const claudePid = claudePidForSessionId(input.session_id as string);
  if (claudePid === undefined) return;
  const { takeAttachRequest } = await import("./attach.js");
  const req = takeAttachRequest(claudePid, ATTACH_DIR);
  if (!req) return;
  const { isMonitoring } = await import("./monitoring.js");
  if (isMonitoring(req.sessionId)) return;

  const out = hookOutput(input.hook_event_name as string, req.name);
  if (out) process.stdout.write(out);
}

function isEntryPoint(): boolean {
  try {
    return (
      process.argv[1] !== undefined &&
      fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

// A hook must never break the session: any failure just means no attach.
if (isEntryPoint()) {
  main().catch(() => {});
}
