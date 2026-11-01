// Claude Code's user settings (~/.claude/settings.json), which wechat-claude
// touches for three things: the hook that lets `/wechat <name>` rename the
// session (see rename-hook.ts), an allow rule for its tools, and
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

type HookCommand = { type?: unknown; command?: unknown };
type HookGroup = { matcher?: unknown; hooks?: unknown };

// Entries written before the tag existed, by an npm install of this package:
// the path still says whose script it is.
const LEGACY_PATH = /[\\/]wechat-claude-sessions[\\/]dist[\\/]rename-hook\.js\b/;

function isOurs(h: unknown): boolean {
  if (typeof h !== "object" || h === null) return false;
  const cmd = (h as HookCommand).command;
  return typeof cmd === "string" && (cmd.includes(HOOK_TAG) || LEGACY_PATH.test(cmd));
}

export function renameHookCommand(scriptPath: string): string {
  // JSON.stringify quotes the path for the shell, spaces and all.
  return `node ${JSON.stringify(scriptPath)} ${HOOK_TAG}`;
}

// The settings object and its UserPromptSubmit groups, or null when the file
// is corrupt or shaped unlike Claude Code's — in which case nothing is written.
function load(
  file: string
): { settings: Record<string, unknown>; groups: unknown[] } | null {
  const settings = readJsonObjectOrEmpty(file);
  if (settings === null) return null;
  const hooks = settings.hooks ?? {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return null;
  const groups = (hooks as Record<string, unknown>).UserPromptSubmit ?? [];
  if (!Array.isArray(groups)) return null;
  settings.hooks = hooks;
  return { settings, groups };
}

// Our entries among the UserPromptSubmit groups, whatever their shape.
function ourHooks(groups: unknown[]): HookCommand[] {
  const out: HookCommand[] = [];
  for (const g of groups as HookGroup[]) {
    if (!Array.isArray(g?.hooks)) continue;
    for (const h of g.hooks as unknown[]) if (isOurs(h)) out.push(h as HookCommand);
  }
  return out;
}

// Our entries in the file as it now stands on disk, or null when it can't be
// read — which must not pass for "none there". Claude Code writes this file
// too and may have replaced it between our read and our rename, so a write is
// only trusted once read back.
function ourHooksOnDisk(file: string): HookCommand[] | null {
  const loaded = load(file);
  return loaded ? ourHooks(loaded.groups) : null;
}

// "already": an identical entry was there. "installed"/"updated": this call
// added it or replaced one pointing at another install. "failed": the file is
// corrupt or unwritable and was left untouched — or it was written, but
// another writer replaced it before the entry could be confirmed there.
export type HookInstallResult = "already" | "installed" | "updated" | "failed";

export function installRenameHook(
  command: string,
  file = CLAUDE_SETTINGS_FILE
): HookInstallResult {
  const loaded = load(file);
  if (!loaded) return "failed";
  const { settings, groups } = loaded;

  const ours = ourHooks(groups);
  const found = ours.length > 0;
  if (found && ours.every((h) => h.command === command)) return "already";
  for (const h of ours) h.command = command;
  if (!found) groups.push({ hooks: [{ type: "command", command }] });
  (settings.hooks as Record<string, unknown>).UserPromptSubmit = groups;

  if (!writeJsonAtomic(file, settings)) return "failed";
  const after = ourHooksOnDisk(file);
  if (!after?.some((h) => h.command === command)) return "failed";
  return found ? "updated" : "installed";
}

// Undoes installRenameHook. Once the package is gone the hook points at a
// script that no longer exists, and Claude Code would report it failing on
// every prompt of every session. Groups left empty are dropped with it.
export type HookRemoveResult = "removed" | "absent" | "failed";

export function removeRenameHook(file = CLAUDE_SETTINGS_FILE): HookRemoveResult {
  const loaded = load(file);
  if (!loaded) return "failed";
  const { settings, groups } = loaded;

  let removed = false;
  const kept = (groups as HookGroup[]).filter((g) => {
    if (!Array.isArray(g?.hooks)) return true;
    const rest = (g.hooks as unknown[]).filter((h) => !isOurs(h));
    if (rest.length === g.hooks.length) return true;
    removed = true;
    g.hooks = rest;
    return rest.length > 0;
  });
  if (!removed) return "absent";

  const hooks = settings.hooks as Record<string, unknown>;
  if (kept.length > 0) hooks.UserPromptSubmit = kept;
  else delete hooks.UserPromptSubmit;
  if (!writeJsonAtomic(file, settings)) return "failed";
  return ourHooksOnDisk(file)?.length === 0 ? "removed" : "failed";
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
