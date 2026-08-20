import type { WeixinMessage } from "./types.js";

export function extractText(msg: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list) {
    if (item.type === 1) parts.push(item.text_item.text);
    else if (item.type === 3 && item.voice_item.text)
      parts.push(`[语音转文字] ${item.voice_item.text}`);
    else if (item.type === 2) parts.push("[图片]");
    else if (item.type === 4) parts.push(`[文件: ${item.file_item.file_name}]`);
    else if (item.type === 5) parts.push("[视频]");
  }
  return parts.join("\n");
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}
