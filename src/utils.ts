import crypto from "node:crypto";
import { type Lang, marker } from "./i18n.js";
import type { WeixinMessage } from "./types.js";

export function extractText(msg: WeixinMessage, lang: Lang = "zh"): string {
  const parts: string[] = [];
  for (const item of msg.item_list) {
    if (item.type === 1) parts.push(item.text_item.text);
    else if (item.type === 3 && item.voice_item.text)
      parts.push(marker("voice", lang, item.voice_item.text));
    else if (item.type === 2) parts.push(marker("image", lang));
    else if (item.type === 4)
      parts.push(marker("file", lang, item.file_item.file_name));
    else if (item.type === 5) parts.push(marker("video", lang));
  }
  return parts.join("\n");
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// Incoming CDN media carries aes_key as base64. Depending on the sender it
// decodes to either the raw 16-byte key or the 32-char hex string of the key
// (our own uploads use the latter — see sendImage).
export function resolveCdnAesKey(aesKeyB64: string): Buffer {
  const decoded = Buffer.from(aesKeyB64, "base64");
  if (decoded.length === 16) return decoded;
  const asText = decoded.toString("utf-8");
  if (/^[0-9a-fA-F]{32}$/.test(asText)) return Buffer.from(asText, "hex");
  if (decoded.length > 16) return decoded.subarray(0, 16);
  throw new Error(`Unsupported aes_key length: ${decoded.length}`);
}

export function decryptCdnMedia(
  ciphertext: Buffer,
  aesKeyB64: string,
  encryptType: number
): Buffer {
  if (encryptType === 0) return ciphertext;
  const key = resolveCdnAesKey(aesKeyB64);
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Sniff a downloaded image's type so the saved file gets a usable extension.
export function imageExtension(buf: Buffer): string {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "GIF8") return "gif";
  if (buf.length >= 12 && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return "jpg";
}

// Parse leading flags of a "/run" argument string.
// Remote tasks run unattended, so skip-permissions is the default; "--safe"
// opts back into acceptEdits (bash commands then wait for confirmation).
// "-y" / "--yes" are still accepted as no-ops.
export function parseRunFlags(args: string): { auto: boolean; rest: string } {
  let auto = true;
  let rest = args.trim();
  while (true) {
    const m = rest.match(/^(-y|--yes|--safe)(?:\s+|$)/);
    if (!m) break;
    if (m[1] === "--safe") auto = false;
    rest = rest.slice(m[0].length).trim();
  }
  return { auto, rest };
}

// Build the prompt for a remotely-launched Claude session so the result
// comes back to WeChat instead of dying inside tmux.
export function buildRunPrompt(task: string, fromUserId: string): string {
  const shortTask = task.replace(/\s+/g, " ").slice(0, 12);
  return [
    "这个任务是用户通过微信远程发起的，请严格按以下步骤执行:",
    "",
    `第一步: 调用 wechat_set_session_name 工具把本 session 命名为 "run:${shortTask}"，然后启动微信监控 — 调用 wechat_status 工具，按其输出的 watcher 命令启动一个 persistent Monitor（即 /wechat 命令的流程），这样用户可以在微信里继续跟进和补充指示。`,
    "",
    "第二步: 执行以下任务:",
    task,
    "",
    `第三步: 任务完成后，必须调用 wechat_send_text 工具把结果摘要发送给用户 "${fromUserId}"。`,
    "如果任务失败、被阻塞或需要用户决策，也必须通过 wechat_send_text 说明情况，并保持微信监控运行以等待用户回复。",
  ].join("\n");
}

// What an existing MCP registration points at, derived from `claude mcp get`
// output. "current" means it already targets serverJs (matched as an exact
// substring, so paths with spaces are fine); any other successful output is
// "other" — an existing registration that needs replacing — even when no path
// can be extracted from it. Only a failed `get` (stdout === undefined) means
// there is no registration at all.
export type McpRegistration =
  | { kind: "none" }
  | { kind: "current" }
  | { kind: "other"; target?: string };

export function classifyMcpRegistration(
  stdout: string | undefined,
  serverJs: string
): McpRegistration {
  if (stdout === undefined) return { kind: "none" };
  if (stdout.includes(serverJs)) return { kind: "current" };
  // Best-effort label for the message; absence must not change the outcome.
  const target = stdout.match(/\S*dist[/\\]server\.js/)?.[0];
  return { kind: "other", target };
}
