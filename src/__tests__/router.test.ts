import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import type { PendingMessage } from "../types.js";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-router-test-"));
const sessionsDir = path.join(testHome, ".claude", "wechat", "sessions");
const inboxDir = path.join(testHome, ".claude", "wechat", "inbox");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const { WechatRouter } = await import("../router.js");

function makePendingMessage(text: string): PendingMessage {
  return {
    id: "msg-1",
    fromUserId: "user@im.wechat",
    text,
    contextToken: "ctx-token",
    timestamp: Date.now(),
    rawItems: [{ type: 1, text_item: { text } }],
  };
}

function createFakeSession(
  id: string,
  name: string,
  pid: number,
  lastActive?: number
): void {
  writeFileSync(
    path.join(sessionsDir, `${id}.json`),
    JSON.stringify({
      id,
      name,
      cwd: `/fake/path/${name}`,
      pid,
      lastActive: lastActive ?? Date.now(),
    })
  );
}

function clearDir(dir: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    try {
      rmSync(path.join(dir, f));
    } catch {}
  }
}

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe("WechatRouter", () => {
  beforeEach(() => {
    clearDir(sessionsDir);
    clearDir(inboxDir);
  });

  describe("initialization", () => {
    it("creates with custom name", () => {
      const router = new WechatRouter("test-session");
      expect(router.name).toBe("test-session");
      expect(router.id).toBe(String(process.pid));
    });

    it("registers session file on creation", () => {
      const router = new WechatRouter("init-test");
      const sessionFile = path.join(sessionsDir, `${router.id}.json`);
      expect(existsSync(sessionFile)).toBe(true);
      const data = JSON.parse(readFileSync(sessionFile, "utf-8"));
      expect(data.name).toBe("init-test");
      expect(data.pid).toBe(process.pid);
    });
  });

  describe("setName", () => {
    it("updates name and persists to session file", () => {
      const router = new WechatRouter("old-name");
      router.setName("new-name");
      expect(router.name).toBe("new-name");

      const sessionFile = path.join(sessionsDir, `${router.id}.json`);
      const data = JSON.parse(readFileSync(sessionFile, "utf-8"));
      expect(data.name).toBe("new-name");
    });
  });

  describe("listSessions", () => {
    it("returns empty when no sessions", () => {
      clearDir(sessionsDir);
      const router = new WechatRouter("lister");
      clearDir(sessionsDir);
      expect(router.listSessions()).toEqual([]);
    });

    it("returns alive sessions sorted by PID", () => {
      const router = new WechatRouter("lister");
      clearDir(sessionsDir);
      createFakeSession("100", "session-b", process.pid);
      createFakeSession("50", "session-a", process.pid);

      const sessions = router.listSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < sessions.length; i++) {
        expect(sessions[i].pid).toBeGreaterThanOrEqual(sessions[i - 1].pid);
      }
    });

    it("cleans up dead session files", () => {
      const router = new WechatRouter("cleaner");
      clearDir(sessionsDir);
      const deadPid = 999999999;
      createFakeSession("dead-1", "ghost", deadPid);
      writeFileSync(path.join(inboxDir, "dead-1.json"), "[]");

      const sessions = router.listSessions();
      expect(sessions.find((s) => s.name === "ghost")).toBeUndefined();
      expect(existsSync(path.join(sessionsDir, "dead-1.json"))).toBe(false);
      expect(existsSync(path.join(inboxDir, "dead-1.json"))).toBe(false);
    });
  });

  describe("routeMessage", () => {
    it("/sessions lists active sessions", async () => {
      const router = new WechatRouter("my-session");
      const msg = makePendingMessage("/sessions");
      let reply = "";
      const sendReply = async (text: string): Promise<void> => {
        reply = text;
      };

      const handled = router.routeMessage(msg, sendReply);
      expect(handled).toBe(true);
      expect(reply).toContain("活跃 sessions");
      expect(reply).toContain("my-session");
    });

    it("/ls is alias for /sessions", async () => {
      const router = new WechatRouter("alias-test");
      const msg = makePendingMessage("/ls");
      let reply = "";
      const handled = router.routeMessage(msg, async (text) => {
        reply = text;
      });
      expect(handled).toBe(true);
      expect(reply).toContain("活跃 sessions");
    });

    it("/s <number> routes to numbered session", () => {
      const router = new WechatRouter("target");
      const msg = makePendingMessage("/s 1 hello there");
      const handled = router.routeMessage(msg, async () => {});
      expect(handled).toBe(false);

      const inboxFile = path.join(inboxDir, `${router.id}.json`);
      expect(existsSync(inboxFile)).toBe(true);
      const inbox = JSON.parse(readFileSync(inboxFile, "utf-8"));
      expect(inbox.length).toBe(1);
      expect(inbox[0].text).toBe("hello there");
    });

    it("/s <name> routes by exact name match", () => {
      const router = new WechatRouter("named-target");
      const msg = makePendingMessage("/s named-target test message");
      const handled = router.routeMessage(msg, async () => {});
      expect(handled).toBe(false);
    });

    it("/s <partial> routes by fuzzy match", () => {
      const router = new WechatRouter("my-long-session-name");
      const msg = makePendingMessage("/s long-session fuzzy match");
      const handled = router.routeMessage(msg, async () => {});
      expect(handled).toBe(false);
    });

    it("/s with unknown selector sends error reply", () => {
      const router = new WechatRouter("only-session");
      const msg = makePendingMessage("/s nonexistent hello");
      let reply = "";
      const handled = router.routeMessage(msg, async (text) => {
        reply = text;
      });
      expect(handled).toBe(true);
      expect(reply).toContain("找不到");
    });

    it("default routes to first session", () => {
      const router = new WechatRouter("default-target");
      const msg = makePendingMessage("just a normal message");
      const handled = router.routeMessage(msg, async () => {});
      expect(handled).toBe(false);

      const inboxFile = path.join(inboxDir, `${router.id}.json`);
      const inbox = JSON.parse(readFileSync(inboxFile, "utf-8"));
      expect(inbox.length).toBe(1);
      expect(inbox[0].text).toBe("just a normal message");
    });

    it("sends 'no active session' when none available", () => {
      const router = new WechatRouter("disposable");
      clearDir(sessionsDir);

      const msg = makePendingMessage("hello?");
      let reply = "";
      const handled = router.routeMessage(msg, async (text) => {
        reply = text;
      });
      expect(handled).toBe(true);
      expect(reply).toContain("没有活跃的 Claude session");
    });

    it("/sessions shows empty message when no sessions", () => {
      const router = new WechatRouter("disposable2");
      clearDir(sessionsDir);

      const msg = makePendingMessage("/sessions");
      let reply = "";
      router.routeMessage(msg, async (text) => {
        reply = text;
      });
      expect(reply).toContain("没有活跃的 Claude session");
    });
  });

  describe("inbox", () => {
    it("peekInbox returns 0 when empty", () => {
      const router = new WechatRouter("inbox-test");
      expect(router.peekInbox()).toBe(0);
    });

    it("readInbox returns empty array when no file", () => {
      const router = new WechatRouter("inbox-empty");
      expect(router.readInbox()).toEqual([]);
    });

    it("readInbox returns messages and clears inbox", () => {
      const router = new WechatRouter("inbox-read");
      const inboxFile = path.join(inboxDir, `${router.id}.json`);
      const msgs = [makePendingMessage("msg1"), makePendingMessage("msg2")];
      writeFileSync(inboxFile, JSON.stringify(msgs));

      const result = router.readInbox();
      expect(result.length).toBe(2);
      expect(result[0].text).toBe("msg1");
      expect(result[1].text).toBe("msg2");

      const after = JSON.parse(readFileSync(inboxFile, "utf-8"));
      expect(after).toEqual([]);
    });

    it("peekInbox returns count without clearing", () => {
      const router = new WechatRouter("inbox-peek");
      const inboxFile = path.join(inboxDir, `${router.id}.json`);
      const msgs = [
        makePendingMessage("a"),
        makePendingMessage("b"),
        makePendingMessage("c"),
      ];
      writeFileSync(inboxFile, JSON.stringify(msgs));

      expect(router.peekInbox()).toBe(3);
      expect(router.peekInbox()).toBe(3);
    });
  });

  describe("touchActive", () => {
    it("updates lastActive timestamp", async () => {
      const router = new WechatRouter("touch-test");
      const sessionFile = path.join(sessionsDir, `${router.id}.json`);
      const before = JSON.parse(readFileSync(sessionFile, "utf-8"));

      await new Promise((r) => setTimeout(r, 10));
      router.touchActive();

      const after = JSON.parse(readFileSync(sessionFile, "utf-8"));
      expect(after.lastActive).toBeGreaterThan(before.lastActive);
    });
  });

  describe("cursor", () => {
    it("getCursor returns empty string when no cursor file", () => {
      const router = new WechatRouter("cursor-test");
      expect(router.getCursor()).toBe("");
    });

    it("setCursor and getCursor round-trip", () => {
      const router = new WechatRouter("cursor-rt");
      router.setCursor("abc123");
      expect(router.getCursor()).toBe("abc123");
    });
  });

  describe("poll leader", () => {
    it("first caller becomes leader", () => {
      const router = new WechatRouter("leader-test");
      expect(router.tryBecomePollLeader()).toBe(true);
      expect(router.isPollLeader).toBe(true);
    });
  });
});
