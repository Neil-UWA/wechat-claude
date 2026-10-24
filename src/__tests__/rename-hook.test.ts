import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "wc-rename-hook-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, default: { ...actual.default, homedir: () => testHome }, homedir: () => testHome };
});

const { sessionTitleFor, wechatNameArg } = await import("../rename-hook.js");

const WECHAT_SESSIONS = path.join(testHome, ".claude", "wechat", "sessions");
const CLAUDE_SESSIONS = path.join(testHome, ".claude", "sessions");
const CLAUDE_SESSION_ID = "11111111-2222-3333-4444-555555555555";

// A live WeChat session: the pid must be alive for listSessions to keep it,
// so it is this test process; claudePid says which Claude session owns it.
function holdName(name: string, claudePid: number): void {
  fs.writeFileSync(
    path.join(WECHAT_SESSIONS, "holder.json"),
    JSON.stringify({ id: "holder", name, pid: process.pid, claudePid, cwd: "/x", startedAt: 0, lastActive: 0 })
  );
}

// Must be a live pid: records of dead Claude processes are skipped.
function registerOwnClaude(pid: number): void {
  fs.writeFileSync(
    path.join(CLAUDE_SESSIONS, `${pid}.json`),
    JSON.stringify({ pid, name: "c", sessionId: CLAUDE_SESSION_ID })
  );
}

afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(testHome, ".claude"), { recursive: true, force: true });
  fs.mkdirSync(WECHAT_SESSIONS, { recursive: true });
  fs.mkdirSync(CLAUDE_SESSIONS, { recursive: true });
});

describe("wechatNameArg", () => {
  it("takes the name from /wechat <name> only", () => {
    expect(wechatNameArg("/wechat integration")).toBe("integration");
    expect(wechatNameArg("  /wechat  backend-api \n")).toBe("backend-api");
    expect(wechatNameArg("/wechat")).toBeUndefined();
    expect(wechatNameArg("/wechatx foo")).toBeUndefined();
    expect(wechatNameArg("please run /wechat foo")).toBeUndefined();
    expect(wechatNameArg(undefined)).toBeUndefined();
  });
});

describe("sessionTitleFor", () => {
  it("renames to a free, valid name", async () => {
    expect(await sessionTitleFor("/wechat integration", CLAUDE_SESSION_ID)).toBe("integration");
  });

  it("skips names the WeChat routing side would refuse", async () => {
    // Renaming anyway would leave the two names out of step.
    expect(await sessionTitleFor("/wechat 42", CLAUDE_SESSION_ID)).toBeUndefined();
  });

  it("skips a name another live session holds", async () => {
    registerOwnClaude(process.pid);
    holdName("Integration", 70002);
    expect(await sessionTitleFor("/wechat integration", CLAUDE_SESSION_ID)).toBeUndefined();
  });

  it("renames when the holder is this very session", async () => {
    registerOwnClaude(process.pid);
    holdName("integration", process.pid);
    expect(await sessionTitleFor("/wechat integration", CLAUDE_SESSION_ID)).toBe("integration");
  });

  it("does not rename when it cannot tell whose the name is", async () => {
    holdName("integration", 70001);
    expect(await sessionTitleFor("/wechat integration", CLAUDE_SESSION_ID)).toBeUndefined();
  });
});
