import { describe, it, expect } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { extractText, aesEcbPaddedSize, buildRunPrompt, decryptCdnMedia, imageExtension, parseRunFlags } from "../utils.js";
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

describe("parseRunFlags", () => {
  it("defaults to auto (skip permissions)", () => {
    expect(parseRunFlags("myapp 跑测试")).toEqual({
      auto: true,
      rest: "myapp 跑测试",
    });
  });

  it("-y is accepted as a no-op", () => {
    expect(parseRunFlags("-y myapp 跑测试")).toEqual({
      auto: true,
      rest: "myapp 跑测试",
    });
  });

  it("--safe opts back into acceptEdits", () => {
    expect(parseRunFlags("--safe 修复 bug")).toEqual({
      auto: false,
      rest: "修复 bug",
    });
  });

  it("bare --safe leaves empty rest", () => {
    expect(parseRunFlags("--safe")).toEqual({ auto: false, rest: "" });
  });

  it("--safe embedded in the task is not a flag", () => {
    expect(parseRunFlags("检查 --safe 参数")).toEqual({
      auto: true,
      rest: "检查 --safe 参数",
    });
  });
});

describe("buildRunPrompt", () => {
  it("includes the task and the report-back instruction with the user id", () => {
    const prompt = buildRunPrompt("跑一遍测试", "user@im.wechat");
    expect(prompt).toContain("跑一遍测试");
    expect(prompt).toContain("wechat_send_text");
    expect(prompt).toContain('"user@im.wechat"');
  });

  it("instructs the session to start WeChat monitoring first", () => {
    const prompt = buildRunPrompt("修 bug", "user@im.wechat");
    expect(prompt).toContain("wechat_status");
    expect(prompt).toContain("微信监控");
  });

  it("instructs the session to rename itself with a run: prefix", () => {
    const prompt = buildRunPrompt("跑一遍测试并修复失败的用例", "user@im.wechat");
    expect(prompt).toContain("wechat_set_session_name");
    expect(prompt).toContain('"run:跑一遍测试并修复失败的用'); // 12-char cap
  });
});

describe("decryptCdnMedia", () => {
  function encrypt(plaintext: Buffer, key: Buffer): Buffer {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
  }

  it("decrypts with a raw 16-byte base64 key", () => {
    const key = randomBytes(16);
    const plain = Buffer.from("hello image bytes");
    const out = decryptCdnMedia(encrypt(plain, key), key.toString("base64"), 1);
    expect(out.equals(plain)).toBe(true);
  });

  it("decrypts with a base64-encoded hex-string key (our upload format)", () => {
    const key = randomBytes(16);
    const aesKeyB64 = Buffer.from(key.toString("hex")).toString("base64");
    const plain = Buffer.from("hex-key roundtrip");
    const out = decryptCdnMedia(encrypt(plain, key), aesKeyB64, 1);
    expect(out.equals(plain)).toBe(true);
  });

  it("returns ciphertext untouched when encrypt_type is 0", () => {
    const buf = Buffer.from("no encryption");
    expect(decryptCdnMedia(buf, "", 0).equals(buf)).toBe(true);
  });
});

describe("imageExtension", () => {
  it("detects common formats and falls back to jpg", () => {
    expect(imageExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe("png");
    expect(imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(imageExtension(Buffer.from("GIF89a"))).toBe("gif");
    expect(imageExtension(Buffer.concat([Buffer.from("RIFF1234"), Buffer.from("WEBPxx")]))).toBe("webp");
    expect(imageExtension(Buffer.from("unknown-bytes"))).toBe("jpg");
  });
});
