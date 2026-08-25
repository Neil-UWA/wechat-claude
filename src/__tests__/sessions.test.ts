import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-sessions-test-"));
const sessionsDir = path.join(testHome, ".claude", "wechat", "sessions");
const heartbeatDir = path.join(testHome, ".claude", "wechat", "heartbeat");
const numbersFile = path.join(testHome, ".claude", "wechat", "session-numbers.json");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const {
  listSessions,
  sortedSessions,
  findSession,
  matchSessions,
  getDefaultTarget,
  sessionLabel,
} = await import("../sessions.js");

// process.pid and process.ppid are alive; use them so isProcessAlive passes.
const ALIVE = process.pid;
const ALIVE2 = process.ppid;

function fake(id: string, name: string, pid: number, lastActive = Date.now()): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, `${id}.json`),
    JSON.stringify({ id, name, cwd: `/fake/${name}`, pid, lastActive })
  );
}

function monitor(id: string): void {
  mkdirSync(heartbeatDir, { recursive: true });
  writeFileSync(path.join(heartbeatDir, id), String(Date.now()));
}

function clearDir(dir: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { force: true });
}

beforeEach(() => {
  clearDir(sessionsDir);
  clearDir(heartbeatDir);
  rmSync(numbersFile, { force: true });
});

afterAll(() => rmSync(testHome, { recursive: true, force: true }));

describe("listSessions", () => {
  it("returns live sessions and cleans up dead ones", () => {
    fake("a", "alpha", ALIVE);
    fake("dead", "ghost", 999999999);
    const list = listSessions();
    expect(list.map((s) => s.name)).toContain("alpha");
    expect(list.find((s) => s.name === "ghost")).toBeUndefined();
    expect(existsSync(path.join(sessionsDir, "dead.json"))).toBe(false);
  });
});

describe("sortedSessions", () => {
  it("puts monitored sessions first", () => {
    fake("a", "plain", ALIVE);
    fake("b", "watched", ALIVE2);
    monitor("b");
    expect(sortedSessions()[0].id).toBe("b");
  });
});

describe("getDefaultTarget", () => {
  it("prefers a monitored session over a more recent unmonitored one", () => {
    fake("old", "older", ALIVE, Date.now() - 60_000);
    fake("new", "newer", ALIVE2, Date.now() + 60_000);
    monitor("old");
    expect(getDefaultTarget(sortedSessions())?.id).toBe("old");
  });

  it("falls back to most recently active when none monitored", () => {
    fake("old", "older", ALIVE, Date.now() - 60_000);
    fake("new", "newer", ALIVE2, Date.now() + 60_000);
    expect(getDefaultTarget(sortedSessions())?.id).toBe("new");
  });

  it("returns undefined with no sessions", () => {
    expect(getDefaultTarget([])).toBeUndefined();
  });
});

describe("findSession", () => {
  it("resolves by pid", () => {
    fake("x", "twin", ALIVE);
    fake("y", "twin", ALIVE2);
    expect(findSession(String(ALIVE2))?.id).toBe("y");
  });

  it("resolves by exact name and fuzzy substring", () => {
    fake("x", "my-long-session", ALIVE);
    expect(findSession("my-long-session")?.id).toBe("x");
    expect(findSession("long")?.id).toBe("x");
  });

  it("on an ambiguous name prefers the monitored one", () => {
    fake("x", "twin", ALIVE, Date.now() + 60_000);
    fake("y", "twin", ALIVE2, Date.now() - 60_000);
    monitor("y");
    expect(findSession("twin")?.id).toBe("y");
  });

  it("resolves by stable number", () => {
    fake("x", "one", ALIVE);
    const numbered = findSession("1");
    expect(numbered?.id).toBe("x");
  });

  it("returns undefined for an unknown selector", () => {
    fake("x", "one", ALIVE);
    expect(findSession("nope")).toBeUndefined();
  });
});

describe("matchSessions", () => {
  it("returns all sessions sharing a name", () => {
    fake("x", "twin", ALIVE);
    fake("y", "twin", ALIVE2);
    expect(matchSessions("twin").length).toBe(2);
  });

  it("a pid selector matches exactly one", () => {
    fake("x", "twin", ALIVE);
    fake("y", "twin", ALIVE2);
    expect(matchSessions(String(ALIVE)).length).toBe(1);
  });
});

describe("sessionLabel", () => {
  it("appends #pid only for duplicate names", () => {
    const a = { id: "x", name: "twin", cwd: "/", pid: 1, lastActive: 0 };
    const b = { id: "y", name: "twin", cwd: "/", pid: 2, lastActive: 0 };
    const c = { id: "z", name: "solo", cwd: "/", pid: 3, lastActive: 0 };
    expect(sessionLabel(a, [a, b, c])).toBe("twin#1");
    expect(sessionLabel(c, [a, b, c])).toBe("solo");
  });
});
