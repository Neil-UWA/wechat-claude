import { describe, expect, it, vi, afterAll } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-replies-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const { markReplied, lastReplyAt } = await import("../replies.js");
const { nudgeSession, consumeNudge } = await import("../nudge.js");

afterAll(() => rmSync(testHome, { recursive: true, force: true }));

describe("reply markers", () => {
  it("is 0 for a user who has never been replied to", () => {
    expect(lastReplyAt("nobody@im.wechat")).toBe(0);
  });

  it("records and reads back the reply time", () => {
    markReplied("someone@im.wechat", 1_700_000_000_000);
    expect(lastReplyAt("someone@im.wechat")).toBe(1_700_000_000_000);
  });

  it("keeps user ids from escaping the directory", () => {
    markReplied("../../escape", 123);
    const dir = path.join(testHome, ".claude", "wechat", "replies");
    // Separators are stripped, so the name can never leave the directory.
    expect(readdirSync(dir).every((f) => !f.includes("/"))).toBe(true);
    expect(lastReplyAt("../../escape")).toBe(123);
  });
});

describe("nudges", () => {
  it("is consumed exactly once", () => {
    expect(consumeNudge("1234")).toBe(false);
    nudgeSession("1234");
    expect(consumeNudge("1234")).toBe(true);
    expect(consumeNudge("1234")).toBe(false);
  });
});
