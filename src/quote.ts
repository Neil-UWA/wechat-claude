// Quoted ("引用") replies. In WeChat, quoting a message and typing an answer is
// the natural way to say "I mean *this* one" — and with several Claude sessions
// answering into one chat it is the shortcut that makes "/s <name>" unnecessary:
// the quote already names the session, if we can read it.
//
// Two things have to happen for that. Reading the quote out of the incoming
// message, which arrives in one of two shapes (see extractQuote), and mapping
// the quoted message back to the session that wrote it, which is what the
// outbox is for.
import type { OutboundRecord } from "./outbox.js";
import type { SessionInfo } from "./sessions.js";
import type { Quote, WeixinMessage } from "./types.js";

export type { Quote };

export type IncomingQuote = Quote & {
  // What the user actually typed, with the quoted block removed.
  body: string;
};

// A quoted reply arrives as plain text from every WeChat client we have seen:
// the quoted message in corner brackets, a dashed separator, then the reply.
// (`「张三：在吗」\n- - - - - - - - - - -\n在的`)
const QUOTE_OPEN = "「";
const QUOTE_CLOSE = "」";

// The separator is drawn with dashes, but which dash and how many spaces
// between them differs by client ("- - - - - -", "———————").
function isSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!/^[-—–─\s]+$/.test(trimmed)) return false;
  return (trimmed.match(/[-—–─]/g) ?? []).length >= 3;
}

// Split a quoted reply's text into the quoted message and the reply body.
// Undefined when the text is not in that shape at all — which is the common
// case, so this must stay cheap and must never claim a quote it is unsure of.
export function parseTextQuote(
  text: string
): { quotedText: string; body: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(QUOTE_OPEN)) return undefined;
  // The quoted message can itself contain 」, so anchor on the closing bracket
  // that a separator line actually follows: the last one that qualifies, so a
  // quote containing a bracketed aside is not cut short.
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 1; i--) {
    if (!isSeparator(lines[i])) continue;
    if (!lines[i - 1].trimEnd().endsWith(QUOTE_CLOSE)) continue;
    const quoted = lines
      .slice(0, i)
      .join("\n")
      .trimEnd()
      .slice(QUOTE_OPEN.length, -QUOTE_CLOSE.length);
    const body = lines.slice(i + 1).join("\n").trim();
    // Nothing typed under the separator: whatever this is, stripping the quote
    // would leave the session with an empty message.
    if (body === "") return undefined;
    return { quotedText: quoted, body };
  }
  return undefined;
}

// "张三：在吗" → "在吗". WeChat prefixes the quoted message with the sender's
// display name; the text we matched it against never had one.
export function stripQuotedNickname(quoted: string): string {
  const m = quoted.match(/^([^\n：:]{1,32})[：:]\s*([\s\S]*)$/);
  return m ? m[2] : quoted;
}

// "ref_msg" is what WeChat itself sends (item_list[].ref_msg.message_item);
// the rest are the names other clients and bridges have used for the same
// thing. Matched at a word boundary so an unrelated "preference" or
// "referrer_count" can't be mistaken for a quote.
const QUOTE_KEY = /(^|_)(ref|refer|referred|quote|quoted|reply|replied|origin|source)(_|$)/i;
const TEXT_KEY = /^(text|content|title|desc|description|digest|msg|message)$/i;
const ID_KEY = /(msg_?id|message_?id|svr_?id|^id$)/i;
const TIME_KEY = /^(create_time_ms|createtime_ms|create_time|timestamp|time_ms)$/i;

// Pull whatever a structured quote carries out of one object: the quoted text
// and/or the quoted message's id, wherever they sit inside it.
type QuoteFields = {
  quotedText?: string;
  quotedMessageId?: string;
  quotedAt?: number;
};

function collectQuoteFields(
  node: unknown,
  out: QuoteFields,
  depth = 0
): void {
  if (depth > 4 || typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === "string" && value !== "") {
      if (!out.quotedText && TEXT_KEY.test(key) && value.length <= 4000) {
        out.quotedText = value;
      } else if (!out.quotedMessageId && ID_KEY.test(key)) {
        out.quotedMessageId = value;
      }
    } else if (typeof value === "number" && value > 0) {
      // Seconds or milliseconds, depending on the field; normalise to ms.
      if (!out.quotedAt && TIME_KEY.test(key)) {
        out.quotedAt = value < 1e12 ? value * 1000 : value;
      }
    } else if (typeof value === "object") {
      collectQuoteFields(value, out, depth + 1);
    }
  }
}

// Some clients deliver the quote as structured data rather than in the text.
// The field is not in the documented message shape and its name has differed
// between builds, so rather than hard-coding one guess this looks for any
// nested object under a refer/quote/reply-ish key and takes the text and
// message id out of it. Returns undefined when the message carries no quote.
export function extractStructuredQuote(
  msg: unknown,
  depth = 0
): Quote | undefined {
  if (depth > 4 || typeof msg !== "object" || msg === null) return undefined;
  for (const [key, value] of Object.entries(msg as Record<string, unknown>)) {
    if (value === null || value === undefined || value === "") continue;
    if (QUOTE_KEY.test(key)) {
      const found: QuoteFields = {};
      if (typeof value === "string") {
        if (ID_KEY.test(key)) found.quotedMessageId = value;
        else found.quotedText = value;
      } else {
        collectQuoteFields(value, found);
      }
      if (found.quotedText || found.quotedMessageId) {
        return {
          quotedText: found.quotedText ?? "",
          quotedMessageId: found.quotedMessageId,
          quotedAt: found.quotedAt,
        };
      }
    }
    if (typeof value === "object") {
      const nested = extractStructuredQuote(value, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

// The quote in an incoming message, if any, and the reply text with the quoted
// block taken out of it. `text` is the message as extractText() rendered it.
export function extractQuote(
  msg: WeixinMessage,
  text: string
): IncomingQuote | undefined {
  const textual = parseTextQuote(text);
  const structured = extractStructuredQuote(msg);
  if (!textual && !structured) return undefined;
  return {
    // The client's own rendering is the better text when both exist: it is
    // exactly what the user saw in the quote bubble.
    quotedText: textual?.quotedText || structured?.quotedText || "",
    quotedMessageId: structured?.quotedMessageId,
    quotedAt: structured?.quotedAt,
    fromText: textual !== undefined,
    body: textual?.body ?? text,
  };
}

// Collapse everything that differs between "what we sent" and "what the client
// quoted back": line breaks, padding, and the ellipsis a truncated quote ends
// with.
export function normalizeQuoted(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(\.{3}|…+)$/, "")
    .trim();
}

// Text matching has to survive truncation (long replies are quoted only in
// part) and the reply trailer (present in what we sent, sometimes absent from
// what came back), so a prefix on either side counts — but only once there is
// enough text for the match to mean anything.
const MIN_PREFIX_MATCH = 8;

function textMatches(quoted: string, sent: string): boolean {
  if (quoted === "" || sent === "") return false;
  if (quoted === sent) return true;
  if (quoted.length < MIN_PREFIX_MATCH) return false;
  return sent.startsWith(quoted) || quoted.startsWith(sent) || sent.includes(quoted);
}

// How far apart the server's idea of when a message was created and ours of
// when we sent it may be for the two to still be the same message. WeChat
// reports the quoted message's time to the second, so this is mostly clock
// skew and flight time.
const TIME_MATCH_MS = 15_000;

// The outbound record sent closest to when the quoted message was created, if
// one is close enough. Only reached when the id did not match: a session whose
// reply predates this version has no recorded id, and WeChat's quote carries
// no text to fall back on.
function matchByTime(
  quotedAt: number,
  records: OutboundRecord[]
): OutboundRecord | undefined {
  let best: OutboundRecord | undefined;
  let bestGap = TIME_MATCH_MS;
  for (const r of records) {
    const gap = Math.abs(r.at - quotedAt);
    if (gap <= bestGap) {
      best = r;
      bestGap = gap;
    }
  }
  return best;
}

// The outbound message a quote refers to. Message id first — when the API
// gives us one it is exact — then the text, newest record first, and finally
// the time the quoted message was created.
export function matchOutbound(
  quote: Quote,
  records: OutboundRecord[]
): OutboundRecord | undefined {
  if (quote.quotedMessageId) {
    const byId = records.find((r) =>
      r.messageIds?.includes(quote.quotedMessageId as string)
    );
    if (byId) return byId;
  }
  const candidates = [
    normalizeQuoted(quote.quotedText),
    normalizeQuoted(stripQuotedNickname(quote.quotedText)),
  ].filter((c) => c !== "");
  const byText = records.find((r) => {
    const sent = normalizeQuoted(r.text);
    return candidates.some((c) => textMatches(c, sent));
  });
  if (byText) return byText;
  if (!quote.quotedAt) return undefined;
  // Time is a fallback for records written before ids were captured — never a
  // second opinion on an id that simply didn't match. When ids are being
  // recorded and none of them is this one, the quoted message is not a
  // session's at all (the user quoting their own message, say), and guessing
  // by time would hand it to whichever session happened to be talking then.
  const haveIds = records.some((r) => (r.messageIds?.length ?? 0) > 0);
  if (quote.quotedMessageId && haveIds) return undefined;
  return matchByTime(quote.quotedAt, records);
}

// Every reply carries a trailer naming its session ("—— 来自 backend（#3）· 直接
// 回复: /s 3 <消息>"), so a quote that kept the trailer names the session even
// when the outbox has already forgotten the message. The placeholder brackets
// are what keep this from matching the example line in /ls or /help, which
// spell out a real message instead.
export function footerSelector(quotedText: string): string | undefined {
  const m = quotedText.match(/\/s\s+([^\s<>]+)\s+<[^<>]*>/);
  return m?.[1];
}

export type QuoteTarget =
  // The live session that wrote the quoted message. `quotedText` is what that
  // session actually sent, recovered from the outbox: WeChat's own quote
  // carries an id and a timestamp but never the text, so this is the only way
  // the receiving session can be shown what it is answering.
  | { kind: "session"; session: SessionInfo; quotedText?: string }
  // We know which session wrote it, and that session is gone.
  | { kind: "gone"; name: string };

export type ResolveDeps = {
  records: OutboundRecord[];
  live: SessionInfo[];
  find: (selector: string) => SessionInfo | undefined;
};

// Which session a quoted reply is aimed at. Undefined means "no idea" — the
// quoted message was the daemon's own (an /ls listing, say) or too old to be
// in the outbox — and the caller should route the message as if it had no
// quote at all.
export function resolveQuoteTarget(
  quote: Quote,
  deps: ResolveDeps
): QuoteTarget | undefined {
  const record = matchOutbound(quote, deps.records);
  if (record) {
    const exact = deps.live.find((s) => s.id === record.sessionId);
    if (exact) return { kind: "session", session: exact, quotedText: record.text };
    // The id is a pid, and an MCP server that reconnected got a new one while
    // remaining the same Claude session the user was talking to. The name is
    // what survives that, so try it before declaring the session gone.
    const byName = deps.find(record.sessionName);
    if (byName) return { kind: "session", session: byName, quotedText: record.text };
    return { kind: "gone", name: record.sessionName };
  }
  const selector = footerSelector(quote.quotedText);
  if (selector) {
    const target = deps.find(selector);
    if (target) return { kind: "session", session: target };
    return { kind: "gone", name: selector };
  }
  return undefined;
}

// A one-line rendering of the quoted message, for the session that receives
// the reply: enough to recognise which of its own messages is being answered,
// without pasting the whole thing back.
const EXCERPT_MAX = 120;

export function quoteExcerpt(quotedText: string): string {
  const withoutFooter = quotedText
    .split("\n")
    .filter((line) => !/^\s*(——|--)\s*(来自|from)\s/.test(line))
    .join("\n");
  const flat = normalizeQuoted(stripQuotedNickname(withoutFooter));
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX)}…` : flat;
}
