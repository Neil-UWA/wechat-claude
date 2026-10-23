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
// Only names the WeChat routing side would also accept are applied, so the
// two names do not drift apart on a typo the routing side refuses.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { validateSessionName } from "./sessions.js";

export function sessionTitleFor(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return undefined;
  const m = prompt.match(/^\s*\/wechat\s+(\S+)\s*$/);
  if (!m) return undefined;
  const v = validateSessionName(m[1]);
  return v.ok ? v.name : undefined;
}

function main(): void {
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf-8"));
  } catch {
    return;
  }
  const prompt =
    typeof input === "object" && input !== null
      ? (input as { prompt?: unknown }).prompt
      : undefined;
  const title = sessionTitleFor(prompt);
  if (!title) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: title },
    })
  );
}

// A hook must never block the prompt: any failure just means no rename.
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

if (isEntryPoint()) {
  try {
    main();
  } catch {}
}
