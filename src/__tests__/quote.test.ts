import { describe, it, expect } from "vitest";
import {
  extractQuote,
  extractStructuredQuote,
  footerSelector,
  matchOutbound,
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

function record(over: Partial<OutboundRecord> = {}): OutboundRecord {
  return {
    sessionId: "100",
    sessionName: "backend",
    userId: "u@im.wechat",
    text: "构建已经修好了，是缓存没清。",
    messageIds: ["out-1"],
    at: Date.now(),
    ...over,
  };
}

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "100",
    name: "backend",
    cwd: "/repo",
    pid: 100,
    lastActive: Date.now(),
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

  it("matches on the time when the id is unknown and there is no text", () => {
    const rec = record({ messageIds: [], at: 1789142249233 });
    const got = matchOutbound(
      { quotedText: "", quotedMessageId: "7504206488704563208", quotedAt: 1789142249000 },
      [rec]
    );
    expect(got?.sessionId).toBe("100");
  });

  it("does not fall back to time when ids are being recorded and none matched", () => {
    // The user quoted their own message: it has an id, ours are recorded, and
    // none of them is it. Whichever session happened to answer at that moment
    // must not be handed the reply.
    const answered = record({ messageIds: ["out-1"], at: 1789142249500 });
    expect(
      matchOutbound(
        { quotedText: "", quotedMessageId: "not-ours", quotedAt: 1789142249000 },
        [answered]
      )
    ).toBeUndefined();
  });

  it("does not match a reply sent minutes from the quoted message", () => {
    const rec = record({ messageIds: [], at: 1789142249000 - 5 * 60_000 });
    expect(
      matchOutbound({ quotedText: "", quotedAt: 1789142249000 }, [rec])
    ).toBeUndefined();
  });

  it("takes the send closest in time when several are close", () => {
    const near = record({ sessionId: "200", messageIds: [], at: 1789142249500 });
    const far = record({ sessionId: "100", messageIds: [], at: 1789142240000 });
    expect(
      matchOutbound({ quotedText: "", quotedAt: 1789142249000 }, [far, near])?.sessionId
    ).toBe("200");
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

  it("does not match on a scrap of text", () => {
    expect(matchOutbound({ quotedText: "好" }, [record({ text: "好的" })])).toBeUndefined();
  });
});

describe("footerSelector", () => {
  it("reads the session from a quoted reply trailer", () => {
    expect(footerSelector("done\n—— 来自 backend（#3）· 直接回复: /s 3 <消息>")).toBe("3");
    expect(footerSelector("done\n—— from backend (#3) · reply directly: /s 3 <message>")).toBe("3");
  });

  it("ignores the worked example in /ls, which is not a trailer", () => {
    // The trailer's "<消息>" placeholder is what distinguishes it; the legend
    // and the sample command in /ls spell out a real message instead.
    expect(
      footerSelector("用 /s <编号> <消息> 发到指定 session，例: /s 1 你好")
    ).toBeUndefined();
  });

  it("is undefined when there is no trailer", () => {
    expect(footerSelector("just a message")).toBeUndefined();
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

  it("follows the name when that session's MCP server reconnected under a new pid", () => {
    const restarted = session({ id: "300", pid: 300 });
    const got = resolveQuoteTarget(
      { quotedText: "构建已经修好了，是缓存没清。" },
      deps({ live: [restarted], find: (sel) => (sel === "backend" ? restarted : undefined) })
    );
    expect(got).toMatchObject({ kind: "session", session: restarted });
  });

  it("reports the session as gone when nothing answers to its name", () => {
    expect(
      resolveQuoteTarget({ quotedText: "构建已经修好了，是缓存没清。" }, deps({ live: [] }))
    ).toEqual({ kind: "gone", name: "backend" });
  });

  it("falls back to the trailer when the outbox has forgotten the message", () => {
    const got = resolveQuoteTarget(
      { quotedText: "老消息\n—— 来自 backend（#3）· 直接回复: /s 3 <消息>" },
      deps({ records: [], find: (sel) => (sel === "3" ? session() : undefined) })
    );
    expect(got).toEqual({ kind: "session", session: session() });
  });

  it("is undefined when the quoted message was not a session's", () => {
    expect(
      resolveQuoteTarget({ quotedText: "🤖 wechat-claude 用法" }, deps({ records: [] }))
    ).toBeUndefined();
  });
});

describe("quoteExcerpt", () => {
  it("drops the nickname and the reply trailer", () => {
    expect(
      quoteExcerpt("backend：构建修好了\n—— 来自 backend（#3）· 直接回复: /s 3 <消息>")
    ).toBe("构建修好了");
  });

  it("caps long quotes", () => {
    const excerpt = quoteExcerpt("あ".repeat(300));
    expect(excerpt.length).toBe(121);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
