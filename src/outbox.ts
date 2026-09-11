// What each session has already said to each WeChat user. Written by the MCP
// server (the only place a session's replies are sent), read by the daemon,
// which uses it to answer the one question a quoted ("引用") reply asks:
// *which session wrote the message the user just quoted?*
//
// WeChat gives no session id back with a quote — at best the quoted text, and
// sometimes the quoted message's server id — so the mapping has to be kept on
// our side. Entries are small, capped and short-lived: this is a lookup table
// for a conversation in progress, not a transcript.
import fs from "node:fs";
import { withFileLock } from "./file-lock.js";
import { OUTBOX_FILE, ensureDirs } from "./paths.js";

export type OutboundRecord = {
  sessionId: string;
  // The session's WeChat routing name as it was when it sent this. Kept so a
  // reply can still find the session after its MCP server reconnected under a
  // new pid (and therefore a new session id).
  sessionName: string;
  userId: string;
  // Exactly what went out, trailer included — that is what the user sees in
  // the quote bubble, so that is what a quote has to be matched against.
  text: string;
  // Server ids of the sent message(s), when the API returned any.
  messageIds: string[];
  at: number;
};

const MAX_RECORDS = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Long replies are chunked and quoted only in part; the head is what a quote
// can ever match against, and storing megabytes of transcript is pointless.
const MAX_TEXT = 4000;

function load(): OutboundRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(OUTBOX_FILE, "utf-8")) as unknown;
    return Array.isArray(parsed) ? (parsed as OutboundRecord[]) : [];
  } catch {
    return [];
  }
}

function fresh(records: OutboundRecord[], now: number): OutboundRecord[] {
  return records
    .filter((r) => typeof r?.text === "string" && now - r.at < MAX_AGE_MS)
    .slice(-MAX_RECORDS);
}

// Record one outgoing message. Best-effort throughout: a session must never
// fail to reply because this bookkeeping could not be written.
export function recordOutbound(
  record: Omit<OutboundRecord, "at"> & { at?: number }
): void {
  const at = record.at ?? Date.now();
  try {
    ensureDirs();
    withFileLock(OUTBOX_FILE, () => {
      const records = fresh(load(), at);
      records.push({
        ...record,
        text: record.text.slice(0, MAX_TEXT),
        at,
      });
      fs.writeFileSync(OUTBOX_FILE, JSON.stringify(fresh(records, at)), {
        mode: 0o600,
      });
    });
  } catch {}
}

// Records for one user (or all of them), newest first — the order a quote
// should be resolved in, since the same text may have been sent twice.
export function listOutbound(userId?: string): OutboundRecord[] {
  const records = fresh(load(), Date.now());
  const mine = userId ? records.filter((r) => r.userId === userId) : records;
  return mine.reverse();
}
