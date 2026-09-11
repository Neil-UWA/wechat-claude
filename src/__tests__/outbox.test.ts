import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-outbox-test-"));
const wechatDir = path.join(testHome, ".claude", "wechat");
const outboxFile = path.join(wechatDir, "outbox.json");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const { recordOutbound, listOutbound } = await import("../outbox.js");

const HOUR = 60 * 60 * 1000;

function send(over: Partial<Parameters<typeof recordOutbound>[0]> = {}): void {
  recordOutbound({
    sessionId: "100",
    sessionName: "backend",
    userId: "u@im.wechat",
    text: "done",
    messageIds: [],
    ...over,
  });
}

beforeEach(() => {
  mkdirSync(wechatDir, { recursive: true });
  rmSync(outboxFile, { force: true });
  rmSync(`${outboxFile}.lock`, { recursive: true, force: true });
});

afterAll(() => rmSync(testHome, { recursive: true, force: true }));

describe("outbox", () => {
  it("is empty before anything is sent", () => {
    expect(listOutbound()).toEqual([]);
  });

  it("returns records newest first", () => {
    send({ text: "first" });
    send({ text: "second" });
    expect(listOutbound().map((r) => r.text)).toEqual(["second", "first"]);
  });

  it("keeps each user's records apart", () => {
    send({ userId: "a@im.wechat", text: "for a" });
    send({ userId: "b@im.wechat", text: "for b" });
    expect(listOutbound("a@im.wechat").map((r) => r.text)).toEqual(["for a"]);
  });

  it("forgets records older than a day", () => {
    send({ text: "ancient", at: Date.now() - 25 * HOUR });
    send({ text: "recent" });
    expect(listOutbound().map((r) => r.text)).toEqual(["recent"]);
  });

  it("survives a corrupt file rather than throwing", () => {
    writeFileSync(outboxFile, "not json");
    expect(listOutbound()).toEqual([]);
    send({ text: "after" });
    expect(listOutbound().map((r) => r.text)).toEqual(["after"]);
  });

  it("caps how much it remembers", () => {
    for (let i = 0; i < 210; i++) send({ text: `m${i}` });
    const all = listOutbound();
    expect(all.length).toBe(200);
    expect(all[0].text).toBe("m209");
  });
});
