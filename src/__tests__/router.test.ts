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
const { assignSessionNumbers } = await import("../session-numbers.js");

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

    it("puts monitored sessions before unmonitored ones", () => {
      const router = new WechatRouter("sort-test");
      clearDir(sessionsDir);
      createFakeSession("plain", "plain-session", process.pid);
      createFakeSession("watched", "watched-session", process.ppid);

      const heartbeatDir = path.join(testHome, ".claude", "wechat", "heartbeat");
      mkdirSync(heartbeatDir, { recursive: true });
      writeFileSync(path.join(heartbeatDir, "watched"), String(Date.now()));

      const sessions = router.listSessions();
      expect(sessions[0].id).toBe("watched");

      rmSync(path.join(heartbeatDir, "watched"));
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
      const num = assignSessionNumbers([router.id])[router.id];
      const msg = makePendingMessage(`/s ${num} hello there`);
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

    it("/help replies with command list", () => {
      const router = new WechatRouter("help-test");
      const msg = makePendingMessage("/help");
      let reply = "";
      const handled = router.routeMessage(msg, async (text) => {
        reply = text;
      });
      expect(handled).toBe(true);
      expect(reply).toContain("/sessions");
      expect(reply).toContain("/s <编号|名字> <消息>");
    });

    it("/s without message replies with usage", () => {
      const router = new WechatRouter("usage-test");
      const msg = makePendingMessage("/s 1");
      let reply = "";
      const handled = router.routeMessage(msg, async (text) => {
        reply = text;
      });
      expect(handled).toBe(true);
      expect(reply).toContain("用法");

      const inboxFile = path.join(inboxDir, `${router.id}.json`);
      expect(existsSync(inboxFile)).toBe(false);
    });

    it("default routes to the most recently active session", () => {
      const router = new WechatRouter("default-recency");
      // A fake session that is more recently active than the router's own.
      createFakeSession("recent", "recent-session", process.pid, Date.now() + 60_000);

      const msg = makePendingMessage("recency check");
      const handled = router.routeMessage(msg, async () => {});
      expect(handled).toBe(false);

      const inbox = JSON.parse(
        readFileSync(path.join(inboxDir, "recent.json"), "utf-8")
      );
      expect(inbox.length).toBe(1);
      expect(inbox[0].text).toBe("recency check");
    });

    it("default prefers a monitored session over a more recent unmonitored one", () => {
      const router = new WechatRouter("default-monitored");
      createFakeSession("older", "older-session", process.pid, Date.now() - 60_000);
      createFakeSession("newer", "newer-session", process.pid, Date.now() + 60_000);

      const heartbeatDir = path.join(testHome, ".claude", "wechat", "heartbeat");
      mkdirSync(heartbeatDir, { recursive: true });
      writeFileSync(path.join(heartbeatDir, "older"), String(Date.now()));

      const msg = makePendingMessage("to the watcher");
      const handled = router.routeMessage(msg, async () => {});
      expect(handled).toBe(false);

      const inbox = JSON.parse(
        readFileSync(path.join(inboxDir, "older.json"), "utf-8")
      );
      expect(inbox.length).toBe(1);
      expect(inbox[0].text).toBe("to the watcher");
      expect(existsSync(path.join(inboxDir, "newer.json"))).toBe(false);

      rmSync(path.join(heartbeatDir, "older"));
    });

    it("/sessions marks the default target and shows idle time", () => {
      const router = new WechatRouter("marker-default");
      const msg = makePendingMessage("/sessions");
      let reply = "";
      router.routeMessage(msg, async (text) => {
        reply = text;
      });
      // Only session → it is the default target.
      expect(reply).toContain("← 默认接收");
      expect(reply).toContain("刚刚活跃");
    });

    it("/sessions collapses long-idle unmonitored sessions to one line, /ls all expands them", () => {
      const router = new WechatRouter("idle-hider");
      createFakeSession("idle", "sleepy", process.ppid, Date.now() - 3 * 3_600_000);

      const msg = makePendingMessage("/sessions");
      let reply = "";
      router.routeMessage(msg, async (text) => {
        reply = text;
      });
      expect(reply).toContain("闲置（未监控、2 小时以上未活跃）");
      expect(reply).toContain("sleepy · 3 小时前");
      expect(reply).not.toContain("目录: path/sleepy");

      const allMsg = makePendingMessage("/ls all");
      let allReply = "";
      router.routeMessage(allMsg, async (text) => {
        allReply = text;
      });
      expect(allReply).not.toContain("闲置（未监控、2 小时以上未活跃）");
      expect(allReply).toContain("sleepy\n   目录: sleepy");
    });

    it("/sessions marks monitored sessions", () => {
      const router = new WechatRouter("mark-test");
      const heartbeatDir = path.join(testHome, ".claude", "wechat", "heartbeat");
      mkdirSync(heartbeatDir, { recursive: true });
      writeFileSync(path.join(heartbeatDir, router.id), String(Date.now()));

      const msg = makePendingMessage("/sessions");
      let reply = "";
      router.routeMessage(msg, async (text) => {
        reply = text;
      });
      expect(reply).toContain("[监控中]");

      rmSync(path.join(heartbeatDir, router.id));
    });

    it("/sessions disambiguates duplicate names with #pid", () => {
      const router = new WechatRouter("dup-lister");
      createFakeSession("dup-a", "twin", process.pid);
      createFakeSession("dup-b", "twin", process.ppid);

      const msg = makePendingMessage("/sessions");
      let reply = "";
      router.routeMessage(msg, async (text) => {
        reply = text;
      });
      expect(reply).toContain(`twin#${process.pid}`);
      expect(reply).toContain(`twin#${process.ppid}`);
      expect(reply).toContain(`dup-lister\n`);
    });

    it("/s <pid> routes by pid", () => {
      const router = new WechatRouter("pid-select");
      createFakeSession("by-pid", "twin", process.ppid);

      const msg = makePendingMessage(`/s ${process.ppid} pid message`);
      const handled = router.routeMessage(msg, async () => {});
      expect(handled).toBe(false);

      const inbox = JSON.parse(
        readFileSync(path.join(inboxDir, "by-pid.json"), "utf-8")
      );
      expect(inbox[0].text).toBe("pid message");
    });

    it("/s with an ambiguous name prefers the monitored session", () => {
      const router = new WechatRouter("ambiguous-base");
      createFakeSession("twin-new", "twin", process.pid, Date.now() + 60_000);
      createFakeSession("twin-old", "twin", process.ppid, Date.now() - 60_000);

      const heartbeatDir = path.join(testHome, ".claude", "wechat", "heartbeat");
      mkdirSync(heartbeatDir, { recursive: true });
      writeFileSync(path.join(heartbeatDir, "twin-old"), String(Date.now()));

      const msg = makePendingMessage("/s twin ambiguous pick");
      const handled = router.routeMessage(msg, async () => {});
      expect(handled).toBe(false);

      const inbox = JSON.parse(
        readFileSync(path.join(inboxDir, "twin-old.json"), "utf-8")
      );
      expect(inbox[0].text).toBe("ambiguous pick");
      expect(existsSync(path.join(inboxDir, "twin-new.json"))).toBe(false);

      rmSync(path.join(heartbeatDir, "twin-old"));
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
