// A one-line trailer for every reply a session sends to WeChat, naming the
// session and the exact command that reaches it again. With several sessions
// answering into one chat, the user otherwise has to guess which one spoke and
// look up /ls before replying.
import fs from "node:fs";
import { type Lang, getLang, t } from "./i18n.js";
import { CONFIG_FILE } from "./paths.js";
import { assignSessionNumbers } from "./session-numbers.js";
import { sortedSessions } from "./sessions.js";

// `"replyFooter": false` in ~/.claude/wechat/config.json turns the trailer off.
export function replyFooterEnabled(configFile: string = CONFIG_FILE): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    if (typeof parsed === "object" && parsed !== null) {
      return (parsed as Record<string, unknown>).replyFooter !== false;
    }
  } catch {}
  return true;
}

// The trailer text (without the leading separator), or "" when disabled. The
// number is the same stable /ls number the daemon shows, so "/s <n>" in the
// footer keeps working for the session's whole lifetime.
export function replyFooter(
  sessionId: string,
  sessionName: string,
  lang: Lang = getLang(),
  configFile: string = CONFIG_FILE
): string {
  if (!replyFooterEnabled(configFile)) return "";
  const sessions = sortedSessions();
  const numbers = assignSessionNumbers(sessions.map((s) => s.id));
  const n = numbers[sessionId];
  return t(lang).replyFooter(sessionName, n);
}

// Append the trailer to an outgoing message body.
export function withReplyFooter(text: string, footer: string): string {
  if (!footer) return text;
  return `${text.replace(/\s+$/, "")}\n\n${footer}`;
}
