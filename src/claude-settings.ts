// Claude Code's user settings (~/.claude/settings.json), which wechat-claude
// touches for four things: the hook that lets `/wechat <name>` rename the
// session (see rename-hook.ts), the hook that attaches WeChat to a session a
// message was sent to (see attach-hook.ts), an allow rule for its tools, and
// accepting messages from the user's other Claude sessions.
import os from "node:os";
import path from "node:path";
import { readJsonObject, readJsonObjectOrEmpty, writeJsonAtomic } from "./json-file.js";

export const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), ".claude", "settings.json");

// Appended to the hook command as a shell comment, and how our entry is
// recognised on later runs. Not the script name: "rename-hook.js" is generic
// enough that a user's own hook could share it, and we would overwrite it.
// Not the full path either, so an upgrade that moved the install replaces the
// old entry instead of leaving a second hook pointing at nothing.
export const HOOK_TAG = "# wechat-claude:rename-hook";
export const ATTACH_HOOK_TAG = "# wechat-claude:attach-hook";

type HookCommand = { type?: unknown; command?: unknown };
type HookGroup = { matcher?: unknown; hooks?: unknown };

// Which of our hooks an entry belongs to: its tag, and the Claude Code events
// it is registered under.
type HookSpec = {
  tag: string;
  events: readonly string[];
  // Entries written before the tag existed, by an npm install of this
  // package: the path still says whose script it is.
  legacy?: RegExp;
};

const RENAME_HOOK: HookSpec = {
  tag: HOOK_TAG,
  events: ["UserPromptSubmit"],
  legacy: /[\\/]wechat-claude-sessions[\\/]dist[\\/]rename-hook\.js\b/,
};

// Tool calls and turn ends are the moments a session that is not running a
// watcher can still be reached (see attach-hook.ts).
const ATTACH_HOOK: HookSpec = {
  tag: ATTACH_HOOK_TAG,
  events: ["PostToolUse", "Stop"],
};

function isOurs(spec: HookSpec, h: unknown): boolean {
  if (typeof h !== "object" || h === null) return false;
  const cmd = (h as HookCommand).command;
  return (
    typeof cmd === "string" &&
    (cmd.includes(spec.tag) || (spec.legacy?.test(cmd) ?? false))
  );
}

export function renameHookCommand(scriptPath: string): string {
  // JSON.stringify quotes the path for the shell, spaces and all.
  return `node ${JSON.stringify(scriptPath)} ${HOOK_TAG}`;
}

export function attachHookCommand(scriptPath: string): string {
  return `node ${JSON.stringify(scriptPath)} ${ATTACH_HOOK_TAG}`;
}

// The settings object and its hooks map, or null when the file is corrupt or
// shaped unlike Claude Code's — in which case nothing is written.
function load(
  file: string,
  events: readonly string[]
): { settings: Record<string, unknown>; hooks: Record<string, unknown[]> } | null {
  const settings = readJsonObjectOrEmpty(file);
  if (settings === null) return null;
  const hooks = settings.hooks ?? {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return null;
  const map = hooks as Record<string, unknown>;
  for (const event of events) {
    if (map[event] !== undefined && !Array.isArray(map[event])) return null;
  }
  settings.hooks = map;
  return { settings, hooks: map as Record<string, unknown[]> };
}

// Our entries among one event's groups, whatever their shape.
function ourHooks(spec: HookSpec, groups: unknown[] | undefined): HookCommand[] {
  const out: HookCommand[] = [];
  for (const g of (groups ?? []) as HookGroup[]) {
    if (!Array.isArray(g?.hooks)) continue;
    for (const h of g.hooks as unknown[]) if (isOurs(spec, h)) out.push(h as HookCommand);
  }
  return out;
}

// Whether every event has our entry with exactly `command`, in the file as it
// now stands on disk. Claude Code writes this file too and may have replaced
// it between our read and our rename, so a write is only trusted once read
// back; an unreadable file must not pass for either answer.
function onDisk(spec: HookSpec, file: string): Record<string, HookCommand[]> | null {
  const loaded = load(file, spec.events);
  if (!loaded) return null;
  const out: Record<string, HookCommand[]> = {};
  for (const event of spec.events) out[event] = ourHooks(spec, loaded.hooks[event]);
  return out;
}

// "already": an identical entry was there. "installed"/"updated": this call
// added it or replaced one pointing at another install. "failed": the file is
// corrupt or unwritable and was left untouched — or it was written, but
// another writer replaced it before the entry could be confirmed there.
export type HookInstallResult = "already" | "installed" | "updated" | "failed";

function installHook(spec: HookSpec, command: string, file: string): HookInstallResult {
  const loaded = load(file, spec.events);
  if (!loaded) return "failed";
  const { settings, hooks } = loaded;

  let anyFound = false;
  let allCurrent = true;
  for (const event of spec.events) {
    const groups = hooks[event] ?? [];
    const ours = ourHooks(spec, groups);
    if (ours.length > 0) anyFound = true;
    if (ours.length === 0 || !ours.every((h) => h.command === command)) allCurrent = false;
    for (const h of ours) h.command = command;
    if (ours.length === 0) groups.push({ hooks: [{ type: "command", command }] });
    hooks[event] = groups;
  }
  if (allCurrent) return "already";

  if (!writeJsonAtomic(file, settings)) return "failed";
  const after = onDisk(spec, file);
  if (!after) return "failed";
  if (!spec.events.every((e) => after[e]?.some((h) => h.command === command))) return "failed";
  return anyFound ? "updated" : "installed";
}

// Undoes installHook. Once the package is gone the hook points at a script
// that no longer exists, and Claude Code would report it failing on every
// prompt of every session. Groups left empty are dropped with it.
export type HookRemoveResult = "removed" | "absent" | "failed";

function removeHook(spec: HookSpec, file: string): HookRemoveResult {
  const loaded = load(file, spec.events);
  if (!loaded) return "failed";
  const { settings, hooks } = loaded;

  let removed = false;
  for (const event of spec.events) {
    const groups = hooks[event];
    if (!groups) continue;
    const kept = (groups as HookGroup[]).filter((g) => {
      if (!Array.isArray(g?.hooks)) return true;
      const rest = (g.hooks as unknown[]).filter((h) => !isOurs(spec, h));
      if (rest.length === g.hooks.length) return true;
      removed = true;
      g.hooks = rest;
      return rest.length > 0;
    });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!removed) return "absent";

  if (!writeJsonAtomic(file, settings)) return "failed";
  const after = onDisk(spec, file);
  if (!after) return "failed";
  return spec.events.every((e) => after[e]?.length === 0) ? "removed" : "failed";
}

export function installRenameHook(
  command: string,
  file = CLAUDE_SETTINGS_FILE
): HookInstallResult {
  return installHook(RENAME_HOOK, command, file);
}

export function removeRenameHook(file = CLAUDE_SETTINGS_FILE): HookRemoveResult {
  return removeHook(RENAME_HOOK, file);
}

export function installAttachHook(
  command: string,
  file = CLAUDE_SETTINGS_FILE
): HookInstallResult {
  return installHook(ATTACH_HOOK, command, file);
}

export function removeAttachHook(file = CLAUDE_SETTINGS_FILE): HookRemoveResult {
  return removeHook(ATTACH_HOOK, file);
}

// Every tool of the wechat MCP server. In auto mode each call otherwise goes
// to the classifier, and when the classifier can't answer ("gave no verdict")
// the call is refused — a reply the user is waiting for simply doesn't go out,
// and a login expiring while nobody is at the keyboard can't be renewed. A
// server-wide rule rather than a list, so tools added later are covered too.
export const WECHAT_ALLOW_RULES = ["mcp__wechat"];

// Relaying a WeChat message to another session (SendMessage) is held for
// manual review whenever the two sessions run in different permission modes —
// and nobody is at the terminal to review it, which is the point of WeChat.
// "accept" delivers them. It trusts every Claude session of this user on this
// machine, so it is only set where the user has not chosen a value already.
const CROSS_SESSION_KEY = "crossSessionInbound";

export type WechatSettingsResult = {
  added: string[]; // allow rules this call added
  crossSession: "set" | "already" | "kept"; // "kept": the user chose another value
} | null; // the file is corrupt, shaped unlike Claude Code's, or unwritable

export function installWechatSettings(
  file = CLAUDE_SETTINGS_FILE
): WechatSettingsResult {
  const settings = readJsonObjectOrEmpty(file);
  if (settings === null) return null;
  const permissions = settings.permissions ?? {};
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions))
    return null;
  const perms = permissions as Record<string, unknown>;
  const allow = perms.allow ?? [];
  if (!Array.isArray(allow)) return null;

  const added = WECHAT_ALLOW_RULES.filter((r) => !allow.includes(r));
  const current = settings[CROSS_SESSION_KEY];
  const crossSession =
    current === "accept" ? "already" : current === undefined ? "set" : "kept";
  if (added.length === 0 && crossSession !== "set") return { added, crossSession };

  perms.allow = [...allow, ...added];
  settings.permissions = perms;
  if (crossSession === "set") settings[CROSS_SESSION_KEY] = "accept";
  if (!writeJsonAtomic(file, settings)) return null;

  // Read back, as for the hook: Claude Code may have rewritten the file. This
  // confirms our own change survived, not that the rest of the file did.
  const after = readJsonObject(file);
  const afterAllow = (after?.permissions as Record<string, unknown> | undefined)?.allow;
  const ok =
    Array.isArray(afterAllow) &&
    WECHAT_ALLOW_RULES.every((r) => afterAllow.includes(r)) &&
    (crossSession !== "set" || after?.[CROSS_SESSION_KEY] === "accept");
  return ok ? { added, crossSession } : null;
}

// Whether the allow rule installWechatSettings writes is in place. A /run task
// reports back through wechat_send_text; without the rule, auto mode sends
// that call to the classifier, which can refuse it.
export function wechatToolsAllowed(file = CLAUDE_SETTINGS_FILE): boolean {
  const allow = (readJsonObject(file)?.permissions as Record<string, unknown> | undefined)?.allow;
  return Array.isArray(allow) && WECHAT_ALLOW_RULES.every((r) => allow.includes(r));
}
