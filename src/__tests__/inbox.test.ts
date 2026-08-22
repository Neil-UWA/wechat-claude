import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { PendingMessage } from "../types.js";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-inbox-test-"));
const inboxDir = path.join(testHome, ".claude", "wechat", "inbox");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const { writeToInbox, readInbox, peekInbox } = await import("../inbox.js");

function msg(id: string, text: string): PendingMessage {
  return {
    id,
    fromUserId: "u@im.wechat",
    text,
    contextToken: "t",
    timestamp: 0,
    rawItems: [],
  };
}

beforeEach(() => {
  mkdirSync(inboxDir, { recursive: true });
  for (const f of ["s1.json", "s1.json.reading." + process.pid]) {
    rmSync(path.join(inboxDir, f), { force: true });
  }
});

afterAll(() => rmSync(testHome, { recursive: true, force: true }));

describe("inbox", () => {
  it("peek is 0 and read is empty when nothing delivered", () => {
    expect(peekInbox("s1")).toBe(0);
    expect(readInbox("s1")).toEqual([]);
  });

  it("write then read returns messages in order", () => {
    writeToInbox("s1", msg("1", "hello"));
    writeToInbox("s1", msg("2", "world"));
    expect(peekInbox("s1")).toBe(2);
    const got = readInbox("s1");
    expect(got.map((m) => m.text)).toEqual(["hello", "world"]);
  });

  it("read drains the inbox (atomic rename, file left empty of messages)", () => {
    writeToInbox("s1", msg("1", "a"));
    readInbox("s1");
    expect(peekInbox("s1")).toBe(0);
    expect(readInbox("s1")).toEqual([]);
  });

  it("a message written after a drain is not lost", () => {
    writeToInbox("s1", msg("1", "a"));
    expect(readInbox("s1").length).toBe(1);
    writeToInbox("s1", msg("2", "b"));
    expect(readInbox("s1").map((m) => m.text)).toEqual(["b"]);
  });

  it("tolerates a corrupt inbox file", () => {
    writeFileSync(path.join(inboxDir, "s1.json"), "{ not json");
    expect(peekInbox("s1")).toBe(0);
    expect(readInbox("s1")).toEqual([]);
  });

  it("write recovers a corrupt file by starting fresh", () => {
    writeFileSync(path.join(inboxDir, "s1.json"), "garbage");
    writeToInbox("s1", msg("1", "ok"));
    const parsed = JSON.parse(readFileSync(path.join(inboxDir, "s1.json"), "utf-8"));
    expect(parsed.length).toBe(1);
  });
});
