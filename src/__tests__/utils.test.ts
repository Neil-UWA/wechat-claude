import { describe, it, expect } from "vitest";
import { extractText, aesEcbPaddedSize } from "../utils.js";
import type { WeixinMessage, MessageItem } from "../types.js";

const CDN_STUB = { encrypt_query_param: "", aes_key: "", encrypt_type: 0 };

function makeMsg(items: MessageItem[]): WeixinMessage {
  return {
    seq: 1,
    message_id: "msg-1",
    from_user_id: "user@im.wechat",
    to_user_id: "bot@im.wechat",
    client_id: "c-1",
    create_time_ms: Date.now(),
    update_time_ms: 0,
    delete_time_ms: 0,
    session_id: "s-1",
    group_id: "",
    message_type: 1,
    message_state: 2,
    context_token: "tok",
    item_list: items,
  };
}

describe("extractText", () => {
  it("extracts a single text item", () => {
    const msg = makeMsg([{ type: 1, text_item: { text: "hello" } }]);
    expect(extractText(msg)).toBe("hello");
  });

  it("joins multiple text items with newline", () => {
    const msg = makeMsg([
      { type: 1, text_item: { text: "line1" } },
      { type: 1, text_item: { text: "line2" } },
    ]);
    expect(extractText(msg)).toBe("line1\nline2");
  });

  it("returns [图片] for image items", () => {
    const msg = makeMsg([
      {
        type: 2,
        image_item: { media: CDN_STUB },
      },
    ]);
    expect(extractText(msg)).toBe("[图片]");
  });

  it("returns transcription for voice items with text", () => {
    const msg = makeMsg([
      {
        type: 3,
        voice_item: { media: CDN_STUB, encode_type: 6, text: "你好" },
      },
    ]);
    expect(extractText(msg)).toBe("[语音转文字] 你好");
  });

  it("skips voice items without transcription text", () => {
    const msg = makeMsg([
      {
        type: 3,
        voice_item: { media: CDN_STUB, encode_type: 6 },
      },
    ]);
    expect(extractText(msg)).toBe("");
  });

  it("returns [文件: name] for file items", () => {
    const msg = makeMsg([
      {
        type: 4,
        file_item: {
          media: CDN_STUB,
          file_name: "report.pdf",
          md5: "abc",
          len: "1024",
        },
      },
    ]);
    expect(extractText(msg)).toBe("[文件: report.pdf]");
  });

  it("returns [视频] for video items", () => {
    const msg = makeMsg([
      {
        type: 5,
        video_item: {
          media: CDN_STUB,
          video_size: 100,
          play_length: 10,
          video_md5: "abc",
        },
      },
    ]);
    expect(extractText(msg)).toBe("[视频]");
  });

  it("handles mixed item types", () => {
    const msg = makeMsg([
      { type: 1, text_item: { text: "看这个" } },
      { type: 2, image_item: { media: CDN_STUB } },
      {
        type: 4,
        file_item: {
          media: CDN_STUB,
          file_name: "data.csv",
          md5: "x",
          len: "50",
        },
      },
    ]);
    expect(extractText(msg)).toBe("看这个\n[图片]\n[文件: data.csv]");
  });

  it("returns empty string for empty item_list", () => {
    const msg = makeMsg([]);
    expect(extractText(msg)).toBe("");
  });
});

describe("aesEcbPaddedSize", () => {
  it.each([
    [0, 16],
    [1, 16],
    [15, 16],
    [16, 32],
    [17, 32],
    [31, 32],
    [32, 48],
    [47, 48],
    [48, 64],
  ])("aesEcbPaddedSize(%i) = %i", (input, expected) => {
    expect(aesEcbPaddedSize(input)).toBe(expected);
  });
});
