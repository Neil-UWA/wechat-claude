import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  GetConfigResponse,
  GetUpdatesResponse,
  GetUploadUrlResponse,
  PendingMessage,
  QRCodeResponse,
  QRCodeStatusResponse,
  Session,
  TextItem,
  UploadedMedia,
  WeixinMessage,
} from "./types.js";
import { extractText } from "./utils.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const BASE_INFO = { channel_version: "1.0.0" } as const;
const TEXT_LIMIT = 2000;
const WECHAT_DIR = path.join(os.homedir(), ".claude", "wechat");
const SESSION_FILE = path.join(WECHAT_DIR, "session.json");
const OLD_SESSION_FILE = path.join(os.homedir(), ".claude", "wechat-session.json");
const CONTEXT_TOKENS_FILE = path.join(WECHAT_DIR, "context_tokens.json");

function generateUin(): string {
  const n = crypto.randomBytes(4).readUInt32BE();
  return Buffer.from(String(n)).toString("base64");
}

function generateClientId(): string {
  return `wechat-claude-${crypto.randomBytes(8).toString("hex")}`;
}

export class ILinkClient {
  private session: Session | null = null;

  setSession(session: Session): void {
    this.session = session;
    this.saveSession();
  }

  private saveSession(): void {
    try {
      if (!fs.existsSync(WECHAT_DIR)) fs.mkdirSync(WECHAT_DIR, { recursive: true });
      fs.writeFileSync(SESSION_FILE, JSON.stringify(this.session), { mode: 0o600 });
      process.stderr.write(`[wechat-claude] Session saved to ${SESSION_FILE}\n`);
    } catch (err) {
      process.stderr.write(`[wechat-claude] Failed to save session: ${err}\n`);
    }
  }

  tryRestoreSession(): boolean {
    for (const file of [SESSION_FILE, OLD_SESSION_FILE]) {
      try {
        if (!fs.existsSync(file)) {
          process.stderr.write(`[wechat-claude] Session file not found: ${file}\n`);
          continue;
        }
        const data = JSON.parse(fs.readFileSync(file, "utf-8")) as Session;
        if (data.botToken && data.ilinkBotId && data.ilinkUserId) {
          this.session = data;
          process.stderr.write(`[wechat-claude] Session restored from ${file}\n`);
          if (file === OLD_SESSION_FILE) {
            this.saveSession();
            try { fs.unlinkSync(OLD_SESSION_FILE); } catch {}
          }
          return true;
        }
      } catch (err) {
        process.stderr.write(`[wechat-claude] Error reading ${file}: ${err}\n`);
      }
    }
    return false;
  }

  private clearSessionFile(): void {
    try {
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    } catch {
      // non-fatal
    }
  }
  private updatesCursor = "";
  private pendingMessages: PendingMessage[] = [];
  private contextTokens = new Map<string, string>();
  private typingTickets = new Map<string, { ticket: string; expiry: number }>();
  private polling = false;
  private pollAbort: AbortController | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  startTypingKeepAlive(userId: string, shouldContinue?: () => boolean): void {
    this.stopTypingKeepAlive(userId);
    this.sendTyping(userId, true);
    const interval = setInterval(() => {
      if (shouldContinue && !shouldContinue()) {
        this.stopTypingKeepAlive(userId);
        this.sendTyping(userId, false);
        return;
      }
      this.sendTyping(userId, true);
    }, 4000);
    this.typingIntervals.set(userId, interval);
  }

  stopTypingKeepAlive(userId: string): void {
    const interval = this.typingIntervals.get(userId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(userId);
    }
  }

  get isLoggedIn(): boolean {
    return this.session !== null;
  }

  getUpdatesCursor(): string {
    return this.updatesCursor;
  }

  setUpdatesCursor(cursor: string): void {
    this.updatesCursor = cursor;
  }

  trackContextToken(userId: string, token: string): void {
    this.contextTokens.set(userId, token);
    this.saveContextTokens();
  }

  private saveContextTokens(): void {
    try {
      const data: Record<string, string> = {};
      for (const [k, v] of this.contextTokens) data[k] = v;
      fs.writeFileSync(CONTEXT_TOKENS_FILE, JSON.stringify(data));
    } catch {}
  }

  private loadContextTokens(): void {
    try {
      if (!fs.existsSync(CONTEXT_TOKENS_FILE)) {
        process.stderr.write(`[wechat-claude] context_tokens.json not found at ${CONTEXT_TOKENS_FILE}\n`);
        return;
      }
      const data = JSON.parse(fs.readFileSync(CONTEXT_TOKENS_FILE, "utf-8")) as Record<string, string>;
      for (const [k, v] of Object.entries(data)) {
        if (!this.contextTokens.has(k)) this.contextTokens.set(k, v);
      }
    } catch (err) {
      process.stderr.write(`[wechat-claude] loadContextTokens failed: ${err}\n`);
    }
  }

  get baseUrl(): string {
    return this.session?.baseUrl ?? DEFAULT_BASE_URL;
  }

  private authHeaders(): Record<string, string> {
    if (!this.session) throw new Error("Not logged in");
    return {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${this.session.botToken}`,
      "X-WECHAT-UIN": generateUin(),
    };
  }

  async getQRCode(): Promise<QRCodeResponse> {
    const res = await fetch(
      `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`
    );
    if (!res.ok) throw new Error(`QR code request failed: ${res.status}`);
    return res.json() as Promise<QRCodeResponse>;
  }

  async pollQRCodeStatus(qrcode: string): Promise<QRCodeStatusResponse> {
    const res = await fetch(
      `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      {
        headers: { "iLink-App-ClientVersion": "1" },
      }
    );
    if (!res.ok) throw new Error(`QR status request failed: ${res.status}`);
    return res.json() as Promise<QRCodeStatusResponse>;
  }

  async login(
    onQRCode: (url: string) => void,
    onStatus: (status: string) => void
  ): Promise<void> {
    const qr = await this.getQRCode();
    onQRCode(qr.qrcode_img_content);

    const maxAttempts = 120;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const status = await this.pollQRCodeStatus(qr.qrcode);

      if (status.status === "expired") {
        throw new Error("QR code expired, please try again");
      }

      onStatus(status.status);

      if (
        status.status === "confirmed" &&
        status.bot_token &&
        status.ilink_bot_id &&
        status.ilink_user_id
      ) {
        this.session = {
          botToken: status.bot_token,
          ilinkBotId: status.ilink_bot_id,
          ilinkUserId: status.ilink_user_id,
          baseUrl: status.baseurl || DEFAULT_BASE_URL,
        };
        return;
      }
    }
    throw new Error("Login timed out");
  }

  async getUpdates(): Promise<WeixinMessage[]> {
    if (!this.session) throw new Error("Not logged in");

    const res = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        get_updates_buf: this.updatesCursor,
        base_info: BASE_INFO,
      }),
      signal: AbortSignal.timeout(40_000),
    });

    if (!res.ok) throw new Error(`getupdates failed: ${res.status}`);
    const data = (await res.json()) as GetUpdatesResponse;

    if (data.ret === -14) {
      this.session = null;
      this.clearSessionFile();
      throw new Error("Session expired, please login again");
    }

    if (data.get_updates_buf) {
      this.updatesCursor = data.get_updates_buf;
    }

    return data.msgs ?? [];
  }

  async sendText(toUserId: string, text: string): Promise<void> {
    if (!this.session) throw new Error("Not logged in");

    let contextToken = this.contextTokens.get(toUserId);
    if (!contextToken) {
      this.loadContextTokens();
      contextToken = this.contextTokens.get(toUserId);
    }
    if (!contextToken) {
      throw new Error(
        `No context_token for user ${toUserId}. They must send a message first.`
      );
    }

    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += TEXT_LIMIT) {
      chunks.push(text.slice(i, i + TEXT_LIMIT));
    }

    for (const chunk of chunks) {
      const textItem: TextItem = { type: 1, text_item: { text: chunk } };
      const res = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          msg: {
            from_user_id: "",
            to_user_id: toUserId,
            client_id: generateClientId(),
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [textItem],
          },
          base_info: BASE_INFO,
        }),
      });

      if (!res.ok) throw new Error(`sendmessage failed: ${res.status}`);
    }
  }

  async uploadMedia(
    filePath: string,
    toUserId: string,
    mediaType: number
  ): Promise<UploadedMedia> {
    if (!this.session) throw new Error("Not logged in");

    const plaintext = fs.readFileSync(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
    const aeskey = crypto.randomBytes(16);
    const filekey = crypto.randomBytes(16).toString("hex");
    const filesize = Math.ceil((rawsize + 1) / 16) * 16;

    const uploadRes = await fetch(`${this.baseUrl}/ilink/bot/getuploadurl`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString("hex"),
        base_info: BASE_INFO,
      }),
    });
    if (!uploadRes.ok)
      throw new Error(`getuploadurl failed: ${uploadRes.status}`);
    const uploadData = (await uploadRes.json()) as GetUploadUrlResponse;

    const fullUrl = uploadData.upload_full_url?.trim();
    let cdnUrl: string;
    if (fullUrl) {
      cdnUrl = fullUrl;
    } else if (uploadData.upload_param) {
      cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadData.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
    } else {
      throw new Error("getuploadurl returned no upload URL");
    }

    const cipher = crypto.createCipheriv("aes-128-ecb", aeskey, null);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    const cdnRes = await fetch(cdnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
    });
    if (!cdnRes.ok)
      throw new Error(`CDN upload failed: ${cdnRes.status}`);

    const downloadParam = cdnRes.headers.get("x-encrypted-param");
    if (!downloadParam)
      throw new Error("CDN response missing x-encrypted-param header");

    return {
      downloadParam,
      aesKeyHex: aeskey.toString("hex"),
      fileSize: rawsize,
      ciphertextSize: ciphertext.length,
    };
  }

  async sendImage(
    toUserId: string,
    filePath: string,
    caption?: string
  ): Promise<void> {
    if (!this.session) throw new Error("Not logged in");

    let contextToken = this.contextTokens.get(toUserId);
    if (!contextToken) {
      this.loadContextTokens();
      contextToken = this.contextTokens.get(toUserId);
    }
    if (!contextToken) {
      throw new Error(
        `No context_token for user ${toUserId}. They must send a message first.`
      );
    }

    const uploaded = await this.uploadMedia(filePath, toUserId, 1);

    if (caption) {
      const textItem: TextItem = { type: 1, text_item: { text: caption } };
      const textRes = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          msg: {
            from_user_id: "",
            to_user_id: toUserId,
            client_id: generateClientId(),
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [textItem],
          },
          base_info: BASE_INFO,
        }),
      });
      if (!textRes.ok)
        throw new Error(`sendmessage (caption) failed: ${textRes.status}`);
    }

    const imageItem = {
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadParam,
          aes_key: Buffer.from(uploaded.aesKeyHex).toString("base64"),
          encrypt_type: 1,
        },
        mid_size: uploaded.ciphertextSize,
      },
    };

    const res = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: generateClientId(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [imageItem],
        },
        base_info: BASE_INFO,
      }),
    });
    if (!res.ok) throw new Error(`sendmessage (image) failed: ${res.status}`);
  }

  async sendTyping(userId: string, typing: boolean): Promise<void> {
    if (!this.session) throw new Error("Not logged in");

    const ticket = await this.getTypingTicket(userId);
    if (!ticket) return;

    await fetch(`${this.baseUrl}/ilink/bot/sendtyping`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: typing ? 1 : 2,
        base_info: BASE_INFO,
      }),
    }).catch(() => {});
  }

  private async getTypingTicket(userId: string): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached && cached.expiry > Date.now()) return cached.ticket;

    let contextToken = this.contextTokens.get(userId);
    if (!contextToken) {
      this.loadContextTokens();
      contextToken = this.contextTokens.get(userId);
    }
    if (!contextToken) return null;

    try {
      const res = await fetch(`${this.baseUrl}/ilink/bot/getconfig`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({
          ilink_user_id: userId,
          context_token: contextToken,
          base_info: BASE_INFO,
        }),
      });

      if (!res.ok) return null;
      const data = (await res.json()) as GetConfigResponse;
      if (data.ret !== 0) return null;

      this.typingTickets.set(userId, {
        ticket: data.typing_ticket,
        expiry: Date.now() + 20 * 3600 * 1000,
      });
      return data.typing_ticket;
    } catch {
      return null;
    }
  }

  processMessages(msgs: WeixinMessage[]): PendingMessage[] {
    const newMessages: PendingMessage[] = [];

    for (const msg of msgs) {
      if (msg.message_type !== 1) continue;
      if (msg.message_state !== 2) continue;

      this.contextTokens.set(msg.from_user_id, msg.context_token);

      const text = extractText(msg);
      if (!text) continue;

      const pending: PendingMessage = {
        id: msg.message_id,
        fromUserId: msg.from_user_id,
        text,
        contextToken: msg.context_token,
        timestamp: msg.create_time_ms,
        rawItems: msg.item_list,
      };

      newMessages.push(pending);
      this.pendingMessages.push(pending);
    }

    return newMessages;
  }

  consumePending(): PendingMessage[] {
    const msgs = [...this.pendingMessages];
    this.pendingMessages = [];
    return msgs;
  }

  peekPending(): PendingMessage[] {
    return [...this.pendingMessages];
  }

  startPolling(onMessages: (msgs: PendingMessage[]) => void): void {
    if (this.polling) return;
    this.polling = true;
    this.pollAbort = new AbortController();

    const poll = async (): Promise<void> => {
      while (this.polling && this.session) {
        try {
          const msgs = await this.getUpdates();
          const pending = this.processMessages(msgs);
          if (pending.length > 0) onMessages(pending);
        } catch (err) {
          if (!this.polling) break;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("Session expired")) {
            this.polling = false;
            break;
          }
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };

    poll();
  }

  stopPolling(): void {
    this.polling = false;
    this.pollAbort?.abort();
    this.pollAbort = null;
  }

  logout(): void {
    this.stopPolling();
    this.session = null;
    this.updatesCursor = "";
    this.pendingMessages = [];
    this.contextTokens.clear();
    this.typingTickets.clear();
    this.clearSessionFile();
  }

  getStatus(): {
    loggedIn: boolean;
    polling: boolean;
    pendingCount: number;
    trackedUsers: number;
  } {
    return {
      loggedIn: this.isLoggedIn,
      polling: this.polling,
      pendingCount: this.pendingMessages.length,
      trackedUsers: this.contextTokens.size,
    };
  }
}
