#!/usr/bin/env node
// UserPromptSubmit hook: `/wechat <name>` also renames the Claude Code session,
// the same as typing `/rename <name>`.
//
// The agent cannot do this itself — /rename is a built-in command, and the
// model has no tool that runs one. A hook can: Claude Code applies the
// `sessionTitle` a UserPromptSubmit hook returns exactly as /rename would. The
// hook sees the prompt as typed ("/wechat integration"), before the command
// expands. `wechat-claude setup` registers it in ~/.claude/settings.json.
//
// Only names the WeChat routing side will also accept are applied — valid,
// and not held by another live session — so the two names do not drift apart
// when wechat_set_session_name refuses one.
//
// This runs on every prompt of every session, nearly all of which have nothing
// to do with WeChat: everything beyond the regex is imported lazily.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const WECHAT_ARG = /^\s*\/wechat\s+(\S+)\s*$/;

export function wechatNameArg(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return undefined;
  return prompt.match(WECHAT_ARG)?.[1];
}

export async function sessionTitleFor(
  prompt: unknown,
  claudeSessionId?: string
): Promise<string | undefined> {
  const arg = wechatNameArg(prompt);
  if (arg === undefined) return undefined;
  const { listSessions, validateSessionName } = await import("./sessions.js");
  const v = validateSessionName(arg);
  if (!v.ok) return undefined;
  const lower = v.name.toLowerCase();
  const holders = listSessions().filter((s) => s.name.toLowerCase() === lower);
  if (holders.length === 0) return v.name;
  // Held already — fine if by this very session (re-running /wechat with its
  // current name). When ownership can't be established, don't rename: a title
  // that disagrees with the routing name is the thing this check prevents.
  const { claudePidForSessionId } = await import("./claude-sessions.js");
  const own = claudeSessionId ? claudePidForSessionId(claudeSessionId) : undefined;
  if (own === undefined) return undefined;
  return holders.every((s) => s.claudePid === own) ? v.name : undefined;
}

async function main(): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf-8"));
  } catch {
    return;
  }
  if (typeof input !== "object" || input === null) return;
  const { prompt, session_id } = input as { prompt?: unknown; session_id?: unknown };
  const title = await sessionTitleFor(
    prompt,
    typeof session_id === "string" ? session_id : undefined
  );
  if (!title) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: title },
    })
  );
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

// A hook must never block the prompt: any failure just means no rename.
if (isEntryPoint()) main().catch(() => {});
