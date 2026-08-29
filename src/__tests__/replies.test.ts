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

const { markReplied, lastReplyAt, pruneReplies } = await import("../replies.js");
const { nudgeSession, consumeNudge } = await import("../nudge.js");

afterAll(() => rmSync(testHome, { recursive: true, force: true }));

describe("reply markers", () => {
  it("is 0 for a user who has never been replied to", () => {
    expect(lastReplyAt("100", "nobody@im.wechat")).toBe(0);
  });

  it("records and reads back the reply time", () => {
    markReplied("100", "someone@im.wechat", 1_700_000_000_000);
    expect(lastReplyAt("100", "someone@im.wechat")).toBe(1_700_000_000_000);
  });

  it("does not let one session's reply speak for another", () => {
    markReplied("100", "user@im.wechat", 1_700_000_000_000);
    // Session 200 still owes this user an answer.
    expect(lastReplyAt("200", "user@im.wechat")).toBe(0);
  });

  it("keeps user ids from escaping the directory", () => {
    markReplied("100", "../../escape", 123);
    const dir = path.join(testHome, ".claude", "wechat", "replies");
    // Separators are stripped, so the name can never leave the directory.
    expect(readdirSync(dir).every((f) => !f.includes("/"))).toBe(true);
    expect(lastReplyAt("100", "../../escape")).toBe(123);
  });

  it("prunes markers left behind by sessions that are gone", () => {
    markReplied("300", "user@im.wechat", 5);
    markReplied("400", "user@im.wechat", 6);
    pruneReplies(["300"]);
    expect(lastReplyAt("300", "user@im.wechat")).toBe(5);
    expect(lastReplyAt("400", "user@im.wechat")).toBe(0);
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
