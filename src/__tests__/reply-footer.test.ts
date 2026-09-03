import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-reply-footer-test-"));
const wechatDir = path.join(testHome, ".claude", "wechat");
const sessionsDir = path.join(wechatDir, "sessions");
const configFile = path.join(wechatDir, "config.json");
const numbersFile = path.join(wechatDir, "session-numbers.json");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const { replyFooter, replyFooterEnabled, withReplyFooter } = await import(
  "../reply-footer.js"
);

function fake(id: string, name: string, pid: number): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, `${id}.json`),
    JSON.stringify({ id, name, cwd: `/fake/${name}`, pid, lastActive: Date.now() })
  );
}

beforeEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
  rmSync(configFile, { force: true });
  rmSync(numbersFile, { force: true });
});
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

describe("replyFooter", () => {
  it("names the session and gives its stable /s number", () => {
    fake("a", "naming", process.pid);
    fake("b", "review", process.ppid);
    const footer = replyFooter("b", "review", "zh");
    expect(footer).toContain("review");
    expect(footer).toMatch(/#\d+/);
    expect(footer).toMatch(/\/s \d+ <消息>/);
    // The number agrees with what /ls hands out for the same session.
    const n = footer.match(/\/s (\d+)/)?.[1];
    expect(footer).toContain(`#${n}`);
  });

  it("speaks the configured language", () => {
    fake("a", "naming", process.pid);
    expect(replyFooter("a", "naming", "en")).toMatch(/from naming \(#\d+\) · reply directly: \/s \d+ <message>/);
  });

  it("falls back to the name when the session has no number yet", () => {
    // Not registered: nothing to number, but the name still routes.
    expect(replyFooter("ghost", "solo", "zh")).toBe("—— 来自 solo · 直接回复: /s solo <消息>");
  });

  it("is empty when disabled in config.json", () => {
    mkdirSync(wechatDir, { recursive: true });
    writeFileSync(configFile, JSON.stringify({ replyFooter: false }));
    fake("a", "naming", process.pid);
    expect(replyFooterEnabled()).toBe(false);
    expect(replyFooter("a", "naming", "zh")).toBe("");
  });

  it("is enabled by default, including with a config file that says nothing", () => {
    expect(replyFooterEnabled()).toBe(true);
    mkdirSync(wechatDir, { recursive: true });
    writeFileSync(configFile, JSON.stringify({ lang: "en" }));
    expect(replyFooterEnabled()).toBe(true);
    writeFileSync(configFile, "{not json");
    expect(replyFooterEnabled()).toBe(true);
  });
});

describe("withReplyFooter", () => {
  it("appends after a blank line, trimming trailing whitespace first", () => {
    expect(withReplyFooter("done\n\n", "—— from x")).toBe("done\n\n—— from x");
  });

  it("leaves the text alone when there is no footer", () => {
    expect(withReplyFooter("done", "")).toBe("done");
  });
});
