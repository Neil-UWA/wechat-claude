import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { WeixinMessage } from "../types.js";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "wc-ilink-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, default: { ...actual.default, homedir: () => testHome }, homedir: () => testHome };
});

const { ILinkClient } = await import("../ilink.js");

const WECHAT_DIR = path.join(testHome, ".claude", "wechat");
const SESSION_FILE = path.join(WECHAT_DIR, "session.json");
const CONTEXT_TOKENS_FILE = path.join(WECHAT_DIR, "context_tokens.json");
const OLD_SESSION_FILE = path.join(testHome, ".claude", "wechat-session.json");

const TEST_SESSION = {
  botToken: "test-token",
  ilinkBotId: "bot-123",
  ilinkUserId: "user-456",
  baseUrl: "https://test.example.com",
};

const TEST_USER_ID = "user-abc@im.wechat";

function mockFetchResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(headers),
  } as Response;
}

function makeTextMessage(overrides?: Partial<WeixinMessage>): WeixinMessage {
  return {
    seq: 1,
    message_id: "msg-1",
    from_user_id: TEST_USER_ID,
    to_user_id: "bot-123",
    client_id: "client-1",
    create_time_ms: Date.now(),
    update_time_ms: Date.now(),
    delete_time_ms: 0,
    session_id: "sess-1",
    group_id: "",
    message_type: 1,
    message_state: 2,
    context_token: "ctx-token-abc",
    item_list: [{ type: 1, text_item: { text: "hello" } }],
    ...overrides,
  };
}

afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

beforeEach(() => {
  vi.restoreAllMocks();
  if (fs.existsSync(WECHAT_DIR)) fs.rmSync(WECHAT_DIR, { recursive: true, force: true });
  fs.mkdirSync(WECHAT_DIR, { recursive: true });
});

describe("ILinkClient", () => {
  describe("session management", () => {
    it("starts not logged in", () => {
      const client = new ILinkClient();
      expect(client.isLoggedIn).toBe(false);
    });

    it("setSession marks as logged in and saves to file", () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);
      expect(client.isLoggedIn).toBe(true);
      expect(client.baseUrl).toBe(TEST_SESSION.baseUrl);
      expect(fs.existsSync(SESSION_FILE)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      expect(saved.botToken).toBe(TEST_SESSION.botToken);
    });

    it("tryRestoreSession restores from file", () => {
      fs.writeFileSync(SESSION_FILE, JSON.stringify(TEST_SESSION));
      const client = new ILinkClient();
      const restored = client.tryRestoreSession();
      expect(restored).toBe(true);
      expect(client.isLoggedIn).toBe(true);
      expect(client.baseUrl).toBe(TEST_SESSION.baseUrl);
    });

    it("picks up a login that happened after the client was created", () => {
      // A long-lived MCP server starts before `wechat-claude login` runs; its
      // isLoggedIn must notice the session file appearing, not cache "false".
      const client = new ILinkClient();
      expect(client.isLoggedIn).toBe(false);
      fs.writeFileSync(SESSION_FILE, JSON.stringify(TEST_SESSION));
      expect(client.isLoggedIn).toBe(true);
      expect(client.baseUrl).toBe(TEST_SESSION.baseUrl);
    });

    it("tryRestoreSession returns false when no file exists", () => {
      const client = new ILinkClient();
      const restored = client.tryRestoreSession();
      expect(restored).toBe(false);
      expect(client.isLoggedIn).toBe(false);
    });

    it("tryRestoreSession rejects incomplete session data", () => {
      fs.writeFileSync(SESSION_FILE, JSON.stringify({ botToken: "x" }));
      const client = new ILinkClient();
      expect(client.tryRestoreSession()).toBe(false);
    });

    it("logout is not undone by a leftover legacy session file", () => {
      // isLoggedIn re-reads from disk, so logout has to clear the pre-migration
      // file too or the next check silently restores the session.
      fs.writeFileSync(OLD_SESSION_FILE, JSON.stringify(TEST_SESSION));
      const client = new ILinkClient();
      expect(client.isLoggedIn).toBe(true);

      client.logout();

      expect(client.isLoggedIn).toBe(false);
      expect(fs.existsSync(OLD_SESSION_FILE)).toBe(false);
      expect(fs.existsSync(SESSION_FILE)).toBe(false);
    });

    it("logout clears all state and deletes session file", () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);
      client.trackContextToken(TEST_USER_ID, "tok");
      client.setUpdatesCursor("cursor-123");
      expect(fs.existsSync(SESSION_FILE)).toBe(true);

      client.logout();

      expect(client.isLoggedIn).toBe(false);
      expect(client.getUpdatesCursor()).toBe("");
      expect(client.getStatus().trackedUsers).toBe(0);
      expect(fs.existsSync(SESSION_FILE)).toBe(false);
    });
  });

  describe("cursor management", () => {
    it("get/set cursor", () => {
      const client = new ILinkClient();
      expect(client.getUpdatesCursor()).toBe("");
      client.setUpdatesCursor("abc-123");
      expect(client.getUpdatesCursor()).toBe("abc-123");
    });
  });

  describe("context tokens", () => {
    it("trackContextToken saves to memory and persists to file", () => {
      const client = new ILinkClient();
      client.trackContextToken(TEST_USER_ID, "tok-1");
      expect(fs.existsSync(CONTEXT_TOKENS_FILE)).toBe(true);
      const data = JSON.parse(fs.readFileSync(CONTEXT_TOKENS_FILE, "utf-8"));
      expect(data[TEST_USER_ID]).toBe("tok-1");
    });

    it("sendText loads tokens from file if not in memory", async () => {
      fs.writeFileSync(CONTEXT_TOKENS_FILE, JSON.stringify({ [TEST_USER_ID]: "ctx-from-file" }));
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      const mockFetch = vi.fn().mockResolvedValue(mockFetchResponse({}));
      vi.stubGlobal("fetch", mockFetch);

      await client.sendText(TEST_USER_ID, "hello");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.msg.context_token).toBe("ctx-from-file");
    });
  });

  describe("processMessages", () => {
    it("extracts text and tracks context tokens", () => {
      const client = new ILinkClient();
      const msg = makeTextMessage();
      const result = client.processMessages([msg]);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("hello");
      expect(result[0].fromUserId).toBe(TEST_USER_ID);
      expect(result[0].contextToken).toBe("ctx-token-abc");
      expect(client.getStatus().trackedUsers).toBe(1);
    });

    it("filters non-user messages (message_type !== 1)", () => {
      const client = new ILinkClient();
      const msg = makeTextMessage({ message_type: 2 });
      const result = client.processMessages([msg]);
      expect(result).toHaveLength(0);
    });

    it("filters non-finished messages (message_state !== 2)", () => {
      const client = new ILinkClient();
      const msg = makeTextMessage({ message_state: 1 });
      const result = client.processMessages([msg]);
      expect(result).toHaveLength(0);
    });

    it("skips messages with empty text", () => {
      const client = new ILinkClient();
      const msg = makeTextMessage({
        item_list: [{ type: 1, text_item: { text: "" } }],
      });
      const result = client.processMessages([msg]);
      expect(result).toHaveLength(0);
    });

    it("accumulates in pendingMessages", () => {
      const client = new ILinkClient();
      client.processMessages([makeTextMessage()]);
      expect(client.peekPending()).toHaveLength(1);
      client.processMessages([makeTextMessage({ message_id: "msg-2" })]);
      expect(client.peekPending()).toHaveLength(2);
    });

    it("consumePending drains the queue", () => {
      const client = new ILinkClient();
      client.processMessages([makeTextMessage()]);
      const consumed = client.consumePending();
      expect(consumed).toHaveLength(1);
      expect(client.peekPending()).toHaveLength(0);
    });
  });

  describe("sendText", () => {
    it("sends a single message", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);
      client.trackContextToken(TEST_USER_ID, "ctx-1");

      const mockFetch = vi.fn().mockResolvedValue(mockFetchResponse({}));
      vi.stubGlobal("fetch", mockFetch);

      await client.sendText(TEST_USER_ID, "hello");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://test.example.com/ilink/bot/sendmessage");
      const body = JSON.parse(opts.body);
      expect(body.msg.to_user_id).toBe(TEST_USER_ID);
      expect(body.msg.item_list[0].text_item.text).toBe("hello");
    });

    it("chunks long text at 2000 chars", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);
      client.trackContextToken(TEST_USER_ID, "ctx-1");

      const mockFetch = vi.fn().mockResolvedValue(mockFetchResponse({}));
      vi.stubGlobal("fetch", mockFetch);

      const longText = "x".repeat(4500);
      await client.sendText(TEST_USER_ID, longText);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      const chunk1 = JSON.parse(mockFetch.mock.calls[0][1].body).msg.item_list[0].text_item.text;
      const chunk2 = JSON.parse(mockFetch.mock.calls[1][1].body).msg.item_list[0].text_item.text;
      const chunk3 = JSON.parse(mockFetch.mock.calls[2][1].body).msg.item_list[0].text_item.text;
      expect(chunk1.length).toBe(2000);
      expect(chunk2.length).toBe(2000);
      expect(chunk3.length).toBe(500);
    });

    it("throws when not logged in", async () => {
      const client = new ILinkClient();
      await expect(client.sendText(TEST_USER_ID, "hello")).rejects.toThrow("Not logged in");
    });

    it("throws when no context token", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);
      await expect(client.sendText(TEST_USER_ID, "hello")).rejects.toThrow("No context_token");
    });

    it("throws on HTTP error", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);
      client.trackContextToken(TEST_USER_ID, "ctx-1");

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({}, 500)));

      await expect(client.sendText(TEST_USER_ID, "hello")).rejects.toThrow("sendmessage failed: 500");
    });
  });

  describe("uploadMedia", () => {
    const testImagePath = path.join(testHome, "test.png");

    beforeEach(() => {
      fs.writeFileSync(testImagePath, crypto.randomBytes(64));
    });

    it("full upload flow with upload_param (current protocol)", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ upload_param: "upload-param-abc" }))
        .mockResolvedValueOnce(mockFetchResponse({}, 200, { "x-encrypted-param": "download-xyz" }));
      vi.stubGlobal("fetch", mockFetch);

      const result = await client.uploadMedia(testImagePath, TEST_USER_ID, 1);

      expect(result.downloadParam).toBe("download-xyz");
      expect(result.aesKeyHex).toHaveLength(32);
      expect(result.fileSize).toBe(64);
      expect(result.ciphertextSize).toBeGreaterThan(0);
      expect(result.ciphertextSize % 16).toBe(0);

      const getUploadCall = mockFetch.mock.calls[0];
      expect(getUploadCall[0]).toBe("https://test.example.com/ilink/bot/getuploadurl");
      const getUploadBody = JSON.parse(getUploadCall[1].body);
      expect(getUploadBody.media_type).toBe(1);
      expect(getUploadBody.to_user_id).toBe(TEST_USER_ID);
      expect(getUploadBody.rawsize).toBe(64);

      const cdnCall = mockFetch.mock.calls[1];
      expect(cdnCall[0]).toContain("novac2c.cdn.weixin.qq.com/c2c/upload");
      expect(cdnCall[0]).toContain("upload-param-abc");
      expect(cdnCall[1].headers["Content-Type"]).toBe("application/octet-stream");
    });

    it("full upload flow with upload_full_url (legacy)", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ upload_full_url: "https://cdn.example.com/upload/legacy" }))
        .mockResolvedValueOnce(mockFetchResponse({}, 200, { "x-encrypted-param": "download-legacy" }));
      vi.stubGlobal("fetch", mockFetch);

      const result = await client.uploadMedia(testImagePath, TEST_USER_ID, 1);

      expect(result.downloadParam).toBe("download-legacy");
      const cdnCall = mockFetch.mock.calls[1];
      expect(cdnCall[0]).toBe("https://cdn.example.com/upload/legacy");
    });

    it("throws when not logged in", async () => {
      const client = new ILinkClient();
      await expect(client.uploadMedia(testImagePath, TEST_USER_ID, 1)).rejects.toThrow("Not logged in");
    });

    it("throws when API returns no upload URL", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({})));
      await expect(client.uploadMedia(testImagePath, TEST_USER_ID, 1)).rejects.toThrow("no upload URL");
    });

    it("throws when CDN returns no x-encrypted-param header", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ upload_param: "p" }))
        .mockResolvedValueOnce(mockFetchResponse({}, 200));
      vi.stubGlobal("fetch", mockFetch);

      await expect(client.uploadMedia(testImagePath, TEST_USER_ID, 1)).rejects.toThrow("x-encrypted-param");
    });

    it("AES encryption produces decryptable ciphertext", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      const testData = Buffer.from("test image data for roundtrip");
      fs.writeFileSync(testImagePath, testData);

      let capturedBody: Uint8Array | undefined;
      let capturedAesKey: string | undefined;

      const mockFetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (String(url).includes("getuploadurl")) {
          const reqBody = JSON.parse(opts?.body as string);
          capturedAesKey = reqBody.aeskey;
          return Promise.resolve(mockFetchResponse({ upload_param: "p" }));
        }
        capturedBody = opts?.body as Uint8Array;
        return Promise.resolve(mockFetchResponse({}, 200, { "x-encrypted-param": "dl" }));
      });
      vi.stubGlobal("fetch", mockFetch);

      await client.uploadMedia(testImagePath, TEST_USER_ID, 1);

      expect(capturedAesKey).toBeDefined();
      expect(capturedBody).toBeDefined();

      const key = Buffer.from(capturedAesKey!, "hex");
      const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
      const decrypted = Buffer.concat([decipher.update(Buffer.from(capturedBody!)), decipher.final()]);
      expect(decrypted.toString()).toBe(testData.toString());
    });
  });

  describe("sendImage", () => {
    const testImagePath = path.join(testHome, "test-img.png");

    beforeEach(() => {
      fs.writeFileSync(testImagePath, crypto.randomBytes(32));
    });

    it("sends image without caption (upload + 1 sendmessage)", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);
      client.trackContextToken(TEST_USER_ID, "ctx-1");

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ upload_param: "up" }))
        .mockResolvedValueOnce(mockFetchResponse({}, 200, { "x-encrypted-param": "dl" }))
        .mockResolvedValueOnce(mockFetchResponse({}));
      vi.stubGlobal("fetch", mockFetch);

      await client.sendImage(TEST_USER_ID, testImagePath);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      const sendCall = mockFetch.mock.calls[2];
      const body = JSON.parse(sendCall[1].body);
      expect(body.msg.item_list[0].type).toBe(2);
      expect(body.msg.item_list[0].image_item.media.encrypt_query_param).toBe("dl");
    });

    it("sends image with caption (upload + 2 sendmessage calls)", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);
      client.trackContextToken(TEST_USER_ID, "ctx-1");

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ upload_param: "up" }))
        .mockResolvedValueOnce(mockFetchResponse({}, 200, { "x-encrypted-param": "dl" }))
        .mockResolvedValueOnce(mockFetchResponse({}))
        .mockResolvedValueOnce(mockFetchResponse({}));
      vi.stubGlobal("fetch", mockFetch);

      await client.sendImage(TEST_USER_ID, testImagePath, "caption text");

      expect(mockFetch).toHaveBeenCalledTimes(4);
      const captionBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(captionBody.msg.item_list[0].type).toBe(1);
      expect(captionBody.msg.item_list[0].text_item.text).toBe("caption text");
      const imageBody = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(imageBody.msg.item_list[0].type).toBe(2);
    });

    it("throws when not logged in", async () => {
      const client = new ILinkClient();
      await expect(client.sendImage(TEST_USER_ID, testImagePath)).rejects.toThrow("Not logged in");
    });
  });

  describe("getUpdates", () => {
    it("returns messages and updates cursor", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      const msgs = [makeTextMessage()];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        mockFetchResponse({ ret: 0, msgs, get_updates_buf: "cursor-new" })
      ));

      const result = await client.getUpdates();

      expect(result).toEqual(msgs);
      expect(client.getUpdatesCursor()).toBe("cursor-new");
    });

    it("handles session expiry (ret=-14)", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        mockFetchResponse({ ret: -14, msgs: [], get_updates_buf: "" })
      ));

      await expect(client.getUpdates()).rejects.toThrow("Session expired");
      expect(client.isLoggedIn).toBe(false);
    });

    it("handles session expiry reported as errcode=-14 (no ret field)", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        mockFetchResponse({ errcode: -14, errmsg: "session timeout" })
      ));

      await expect(client.getUpdates()).rejects.toThrow("Session expired");
      expect(client.isLoggedIn).toBe(false);
    });

    it("throws on a nonzero errcode instead of silently returning no messages", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        mockFetchResponse({ errcode: -1, errmsg: "internal error" })
      ));

      await expect(client.getUpdates()).rejects.toThrow(
        "getupdates error -1: internal error"
      );
      expect(client.isLoggedIn).toBe(true);
    });

    it("throws on a nonzero ret code", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        mockFetchResponse({ ret: -7, msgs: [], get_updates_buf: "" })
      ));

      await expect(client.getUpdates()).rejects.toThrow("getupdates error -7");
    });

    it("throws when not logged in", async () => {
      const client = new ILinkClient();
      await expect(client.getUpdates()).rejects.toThrow("Not logged in");
    });

    it("throws on HTTP error", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({}, 500)));
      await expect(client.getUpdates()).rejects.toThrow("getupdates failed: 500");
    });

    it("returns empty array when no msgs field", async () => {
      const client = new ILinkClient();
      client.setSession(TEST_SESSION);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        mockFetchResponse({ ret: 0, get_updates_buf: "c" })
      ));

      const result = await client.getUpdates();
      expect(result).toEqual([]);
    });
  });

  describe("getStatus", () => {
    it("returns current state", () => {
      const client = new ILinkClient();
      let status = client.getStatus();
      expect(status.loggedIn).toBe(false);
      expect(status.polling).toBe(false);
      expect(status.pendingCount).toBe(0);
      expect(status.trackedUsers).toBe(0);

      client.setSession(TEST_SESSION);
      client.trackContextToken(TEST_USER_ID, "tok");
      client.processMessages([makeTextMessage()]);

      status = client.getStatus();
      expect(status.loggedIn).toBe(true);
      expect(status.pendingCount).toBe(1);
      expect(status.trackedUsers).toBe(1);
    });
  });
});
