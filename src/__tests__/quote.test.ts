import { describe, it, expect } from "vitest";
import {
  extractQuote,
  extractStructuredQuote,
  matchOutbound,
  matchOutboundByTime,
  parseFooter,
  parseTextQuote,
  quoteExcerpt,
  resolveQuoteTarget,
  stripQuotedNickname,
} from "../quote.js";
import type { OutboundRecord } from "../outbox.js";
import type { SessionInfo } from "../sessions.js";
import type { WeixinMessage } from "../types.js";

const SEP = "- - - - - - - - - - - - - - -";

function quoted(quote: string, body: string): string {
  return `「${quote}」\n${SEP}\n${body}`;
}

function msg(text: string, extra: Record<string, unknown> = {}): WeixinMessage {
  return {
    seq: 1,
    message_id: "m1",
    from_user_id: "u@im.wechat",
    to_user_id: "bot",
    client_id: "c",
    create_time_ms: 0,
    update_time_ms: 0,
    delete_time_ms: 0,
    session_id: "s",
    group_id: "",
    message_type: 1,
    message_state: 2,
    context_token: "t",
    item_list: [{ type: 1, text_item: { text } }],
    ...extra,
  } as WeixinMessage;
}

// Fixed, not Date.now(): these helpers are compared with toEqual, and two
// calls a millisecond apart would differ in a field nothing here is testing.
const SENT_AT = 1789142249000;

function record(over: Partial<OutboundRecord> = {}): OutboundRecord {
  return {
    sessionId: "100",
    sessionName: "backend",
    claudeName: "backend-7a",
    userId: "u@im.wechat",
    text: "构建已经修好了，是缓存没清。",
    messageIds: ["out-1"],
    at: SENT_AT,
    ...over,
  };
}

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "100",
    name: "backend",
    claudeName: "backend-7a",
    cwd: "/repo",
    pid: 100,
    lastActive: SENT_AT,
    ...over,
  };
}

describe("parseTextQuote", () => {
  it("splits a quoted reply into the quote and the reply", () => {
    expect(parseTextQuote(quoted("张三：在吗", "在的"))).toEqual({
      quotedText: "张三：在吗",
      body: "在的",
    });
  });

  it("keeps multi-line quotes together", () => {
    const text = quoted("张三：第一行\n第二行", "收到");
    expect(parseTextQuote(text)?.quotedText).toBe("张三：第一行\n第二行");
  });

  it("takes the last separator, so a bracketed aside doesn't cut it short", () => {
    const text = quoted("张三：看这个「例子」再说", "好");
    expect(parseTextQuote(text)).toEqual({
      quotedText: "张三：看这个「例子」再说",
      body: "好",
    });
  });

  it("accepts other dash styles for the separator", () => {
    expect(parseTextQuote(`「a：hello」\n———————\nhi`)?.body).toBe("hi");
  });

  it("is undefined for ordinary text, including text in brackets", () => {
    expect(parseTextQuote("在吗")).toBeUndefined();
    expect(parseTextQuote("「只是引号」不是引用")).toBeUndefined();
  });

  it("is undefined when nothing was typed under the separator", () => {
    expect(parseTextQuote(`「a：hi」\n${SEP}\n   `)).toBeUndefined();
  });
});

describe("stripQuotedNickname", () => {
  it("drops the sender prefix WeChat adds", () => {
    expect(stripQuotedNickname("张三：在吗")).toBe("在吗");
    expect(stripQuotedNickname("Neil: hello")).toBe("hello");
  });

  it("leaves text with no prefix alone", () => {
    expect(stripQuotedNickname("在吗")).toBe("在吗");
  });
});

describe("extractStructuredQuote", () => {
  // Exactly the shape WeChat sends: the quote hangs off the *item*, carries an
  // id and a timestamp, and has no text whatsoever.
  const wechatQuote = {
    item_list: [
      {
        type: 1,
        msg_id: "v1:7616463724773447674",
        ref_msg: {
          message_item: {
            type: 0,
            create_time_ms: 1789142249000,
            update_time_ms: 1789142249000,
            is_completed: true,
            msg_id: "7504206488704563208",
            button_item_list: [],
            at_bot_username_list: [],
          },
        },
        text_item: { text: "消息来了" },
      },
    ],
  };

  it("reads WeChat's own ref_msg, id and time and all", () => {
    expect(extractStructuredQuote(wechatQuote)).toEqual({
      quotedText: "",
      quotedMessageId: "7504206488704563208",
      quotedAt: 1789142249000,
    });
  });

  it("does not mistake the item's own id for the quoted one", () => {
    expect(extractStructuredQuote(wechatQuote)?.quotedMessageId).not.toContain("v1:");
  });

  it("finds a quote under a refer-ish key whatever it is called", () => {
    expect(
      extractStructuredQuote(
        msg("在的", { refer_msg: { message_id: "out-1", text: "构建修好了" } })
      )
    ).toEqual({ quotedText: "构建修好了", quotedMessageId: "out-1" });
  });

  it("reads a bare id field", () => {
    expect(
      extractStructuredQuote(msg("在的", { quote_msg_id: "out-7" }))
    ).toEqual({ quotedText: "", quotedMessageId: "out-7" });
  });

  it("is undefined for a message with no quote at all", () => {
    expect(extractStructuredQuote(msg("在吗"))).toBeUndefined();
  });
});

describe("extractQuote", () => {
  it("strips the quoted block out of the body", () => {
    const got = extractQuote(msg(quoted("bot：构建修好了", "为什么")), quoted("bot：构建修好了", "为什么"));
    expect(got).toMatchObject({
      quotedText: "bot：构建修好了",
      body: "为什么",
      fromText: true,
    });
  });

  it("keeps the whole text as the body for a structured-only quote", () => {
    const got = extractQuote(msg("为什么", { refer_msg_id: "out-1" }), "为什么");
    expect(got).toMatchObject({
      quotedMessageId: "out-1",
      body: "为什么",
      fromText: false,
    });
  });

  it("carries the quoted message's timestamp, the only other thing WeChat sends", () => {
    const withRef = msg("在的", {
      item_list: [
        {
          type: 1,
          ref_msg: { message_item: { msg_id: "out-1", create_time_ms: 1789142249000 } },
          text_item: { text: "在的" },
        },
      ],
    });
    expect(extractQuote(withRef, "在的")).toMatchObject({
      quotedMessageId: "out-1",
      quotedAt: 1789142249000,
    });
  });

  it("is undefined when there is no quote", () => {
    expect(extractQuote(msg("在吗"), "在吗")).toBeUndefined();
  });
});

describe("matchOutbound", () => {
  it("matches on the message id when there is one", () => {
    const other = record({ sessionId: "200", messageIds: ["out-2"], text: "别的" });
    const got = matchOutbound(
      { quotedText: "", quotedMessageId: "out-1" },
      [other, record()]
    );
    expect(got?.sessionId).toBe("100");
  });

  it("matches the quoted text, nickname prefix and all", () => {
    const got = matchOutbound(
      { quotedText: "backend：构建已经修好了，是缓存没清。" },
      [record()]
    );
    expect(got?.sessionId).toBe("100");
  });

  it("still matches an id-less record on time while newer records have ids", () => {
    // The 24 hours it takes the outbox to turn over: one session's replies
    // carry ids, an older record does not, and quoting that older reply must
    // still work.
    const legacy = record({ messageIds: [], at: 1789142249100, text: "老回复" });
    const modern = record({ sessionId: "200", messageIds: ["out-9"], at: 1789142249050 });
    expect(
      matchOutboundByTime(
        { quotedText: "", quotedMessageId: "unmatched", quotedAt: 1789142249000 },
        [modern, legacy]
      )?.sessionId
    ).toBe("100");
  });

  it("never matches on time — that is a separate, later resort", () => {
    const rec = record({ messageIds: [], at: 1789142249233 });
    expect(
      matchOutbound({ quotedText: "", quotedAt: 1789142249000 }, [rec])
    ).toBeUndefined();
  });

  it("does not let a short reply be the prefix of a longer quote", () => {
    // "好的" is the start of half of what any session says; matching it would
    // collect replies meant for whoever actually wrote the longer message.
    const short = record({ text: "好的" });
    expect(
      matchOutbound({ quotedText: "好的，我把缓存清掉再跑一遍构建。" }, [short])
    ).toBeUndefined();
  });

  it("matches a quote the client truncated", () => {
    const got = matchOutbound({ quotedText: "构建已经修好了，是缓..." }, [record()]);
    expect(got?.sessionId).toBe("100");
  });

  it("matches when the quote kept the reply trailer we sent", () => {
    const sent = record({ text: "构建已经修好了。\n\n—— 来自 backend（#3）· 直接回复: /s 3 <消息>" });
    const got = matchOutbound({ quotedText: "构建已经修好了。" }, [sent]);
    expect(got?.sessionId).toBe("100");
  });

  it("prefers the newest record when the same text was sent twice", () => {
    const older = record({ sessionId: "100" });
    const newer = record({ sessionId: "200", sessionName: "frontend" });
    // listOutbound hands records over newest first.
    expect(matchOutbound({ quotedText: "构建已经修好了，是缓存没清。" }, [newer, older])?.sessionId)
      .toBe("200");
  });

  it("does not match text buried inside a newer, different message", () => {
    // Records arrive newest first; a reply that merely mentions the quoted
    // line must not win over the message that is the quoted line.
    const quoting = record({
      sessionId: "200",
      claudeName: "other-1b",
      text: "关于「构建已经修好了，是缓存没清。」这句，我有个补充",
    });
    const original = record();
    expect(
      matchOutbound({ quotedText: "构建已经修好了，是缓存没清。" }, [quoting, original])
        ?.sessionId
    ).toBe("100");
  });

  it("keeps the newer record when two are equally close in time", () => {
    // WeChat reports the quoted time to the second, so ties are ordinary.
    const newer = record({ sessionId: "200", messageIds: [], at: SENT_AT + 1000 });
    const older = record({ sessionId: "100", messageIds: [], at: SENT_AT - 1000 });
    expect(
      matchOutboundByTime({ quotedText: "", quotedAt: SENT_AT }, [newer, older])
        ?.sessionId
    ).toBe("200");
  });

  it("does not match on a scrap of text", () => {
    expect(matchOutbound({ quotedText: "好" }, [record({ text: "好的" })])).toBeUndefined();
  });
});

describe("parseFooter", () => {
  it("reads both the session name and the number from a trailer", () => {
    expect(parseFooter("done\n—— 来自 backend（#3）· 直接回复: /s 3 <消息>")).toEqual({
      name: "backend",
      selector: "3",
    });
    expect(
      parseFooter("done\n—— from backend (#3) · reply directly: /s 3 <message>")
    ).toEqual({ name: "backend", selector: "3" });
  });

  it("ignores the worked example in /ls, which is not a trailer", () => {
    // The trailer's "<消息>" placeholder is what distinguishes it; the legend
    // and the sample command in /ls spell out a real message instead.
    expect(
      parseFooter("用 /s <编号> <消息> 发到指定 session，例: /s 1 你好")
    ).toEqual({ name: undefined, selector: undefined });
  });

  it("keeps a routing name that contains brackets", () => {
    // validateSessionName allows anything without whitespace, so the name has
    // to be read up to the trailer's own separator.
    expect(
      parseFooter("done\n—— 来自 api(v2)（#3）· 直接回复: /s 3 <消息>").name
    ).toBe("api(v2)");
  });

  it("is empty when there is no trailer", () => {
    expect(parseFooter("just a message")).toEqual({
      name: undefined,
      selector: undefined,
    });
  });
});

describe("resolveQuoteTarget", () => {
  const deps = (over: Partial<Parameters<typeof resolveQuoteTarget>[1]> = {}) => ({
    records: [record()],
    live: [session()],
    find: () => undefined,
    ...over,
  });

  it("routes to the live session that wrote the quoted message", () => {
    const got = resolveQuoteTarget({ quotedText: "构建已经修好了，是缓存没清。" }, deps());
    // The text comes back with it: WeChat's quote has none, so what the
    // session actually sent is recovered from the record it matched.
    expect(got).toEqual({
      kind: "session",
      session: session(),
      quotedText: "构建已经修好了，是缓存没清。",
    });
  });

  it("follows a reconnect by Claude Code's session name, not the routing name", () => {
    // Same Claude session, new MCP server, new pid.
    const restarted = session({ id: "300", pid: 300 });
    const got = resolveQuoteTarget(
      { quotedText: "构建已经修好了，是缓存没清。" },
      deps({ live: [restarted] })
    );
    expect(got).toMatchObject({ kind: "session", session: restarted });
  });

  it("does not accept a recycled pid", () => {
    // Session ids are pids, and the OS reuses them well within the day a
    // record lives. Same number, different Claude session, different person's
    // conversation.
    const recycled = session({ claudeName: "someone-else" });
    expect(
      resolveQuoteTarget(
        { quotedText: "构建已经修好了，是缓存没清。" },
        deps({ live: [recycled] })
      )
    ).toMatchObject({ kind: "gone", name: "backend" });
  });

  it("accepts the pid when neither side claims an identity", () => {
    // An older record, or a machine where `ps` told us nothing: the pid is all
    // there is, and it is still the best evidence available.
    const unnamed = session({ claudeName: undefined });
    expect(
      resolveQuoteTarget(
        { quotedText: "构建已经修好了，是缓存没清。" },
        deps({ records: [record({ claudeName: undefined })], live: [unnamed] })
      )
    ).toMatchObject({ kind: "session", session: unnamed });
  });

  it("does not hand the reply to a stranger with the same routing name", () => {
    // Routing names come from repo and branch, so a second session in the same
    // checkout — or the next one opened after this one exited — wears the same
    // one. It is not the session the user was talking to.
    const namesake = session({ id: "400", pid: 400, claudeName: "someone-else" });
    expect(
      resolveQuoteTarget(
        { quotedText: "构建已经修好了，是缓存没清。" },
        deps({ live: [namesake], find: () => namesake })
      )
    ).toMatchObject({ kind: "gone", name: "backend" });
  });

  it("reports the session as gone, but still says what was quoted", () => {
    // The message is still delivered somewhere, and that session should see
    // the quote rather than a bare "fix it".
    expect(
      resolveQuoteTarget({ quotedText: "构建已经修好了，是缓存没清。" }, deps({ live: [] }))
    ).toEqual({
      kind: "gone",
      name: "backend",
      quotedText: "构建已经修好了，是缓存没清。",
    });
  });

  it("falls back to the trailer when the outbox has forgotten the message", () => {
    const got = resolveQuoteTarget(
      { quotedText: "老消息\n—— 来自 backend（#3）· 直接回复: /s 3 <消息>" },
      deps({
        records: [],
        find: (sel) => (sel === "3" || sel === "backend" ? session() : undefined),
      })
    );
    expect(got).toEqual({ kind: "session", session: session() });
  });

  it("trusts the trailer's name over its number", () => {
    // Session numbers restart at 1 once every session is gone, so a day-old
    // "#3" can lead to a session that never sent the quoted message.
    const stranger = session({ id: "500", name: "frontend", pid: 500 });
    expect(
      resolveQuoteTarget(
        { quotedText: "老消息\n—— 来自 backend（#3）· 直接回复: /s 3 <消息>" },
        deps({
          records: [],
          live: [stranger],
          find: (sel) => (sel === "3" ? stranger : undefined),
        })
      )
    ).toEqual({ kind: "gone", name: "backend" });
  });

  it("reads the trailer before guessing from a timestamp", () => {
    // A record sent seconds from the quoted message, but by another session:
    // the trailer says who wrote it, and it is right.
    const coincidence = record({
      sessionId: "700",
      sessionName: "other",
      messageIds: [],
      text: "unrelated",
      at: 1789142249100,
    });
    expect(
      resolveQuoteTarget(
        {
          quotedText: "老消息\n—— 来自 backend（#3）· 直接回复: /s 3 <消息>",
          quotedAt: 1789142249000,
        },
        deps({
          records: [coincidence],
          find: (sel) => (sel === "backend" ? session() : undefined),
        })
      )
    ).toEqual({ kind: "session", session: session() });
  });

  it("uses the timestamp only when nothing better is on offer", () => {
    const rec = record({ messageIds: [], at: 1789142249100 });
    expect(
      resolveQuoteTarget(
        { quotedText: "", quotedAt: 1789142249000 },
        deps({ records: [rec] })
      )
    ).toMatchObject({ kind: "session", session: session() });
  });

  it("will not answer a trailer from \"backend\" with \"backend-api\"", () => {
    // findSession matches fuzzily, which is right for a person typing "/s
    // back" and wrong for deciding who wrote a message.
    const other = session({ id: "800", name: "backend-api", pid: 800 });
    expect(
      resolveQuoteTarget(
        { quotedText: "老消息\n—— 来自 backend（#3）· 直接回复: /s 3 <消息>" },
        deps({ records: [], live: [other], find: () => other })
      )
    ).toEqual({ kind: "gone", name: "backend" });
  });

  it("separates two sessions sharing a name by the trailer's number", () => {
    // Routing names are auto-detected, so a checkout with two sessions has two
    // of them; the stable number is what tells them apart.
    const first = session({ id: "900", pid: 900, claudeName: "a" });
    const second = session({ id: "901", pid: 901, claudeName: "b" });
    expect(
      resolveQuoteTarget(
        { quotedText: "老消息\n—— 来自 backend（#3）· 直接回复: /s 3 <消息>" },
        deps({
          records: [],
          live: [first, second],
          find: (sel) => (sel === "3" ? second : undefined),
        })
      )
    ).toEqual({ kind: "session", session: second });
  });

  it("is undefined when the quoted message was not a session's", () => {
    expect(
      resolveQuoteTarget({ quotedText: "🤖 wechat-claude 用法" }, deps({ records: [] }))
    ).toBeUndefined();
  });
});

describe("quoteExcerpt", () => {
  it("drops the nickname the client added, and the reply trailer", () => {
    expect(
      quoteExcerpt("backend：构建修好了\n—— 来自 backend（#3）· 直接回复: /s 3 <消息>", true)
    ).toBe("构建修好了");
  });

  it("leaves a colon in text recovered from the outbox alone", () => {
    // That text is what the session itself sent — there is no nickname on it,
    // and stripping one would quote it as something it never said.
    expect(quoteExcerpt("Status: failed")).toBe("Status: failed");
    expect(quoteExcerpt("Status: failed", true)).toBe("failed");
  });

  it("caps long quotes", () => {
    const excerpt = quoteExcerpt("あ".repeat(300));
    expect(excerpt.length).toBe(121);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
