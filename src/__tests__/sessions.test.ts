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
  cwdLabel,
  listSessions,
  sortedSessions,
  findSession,
  findNameConflict,
  matchSessions,
  getDefaultTarget,
  sessionLabel,
  validateSessionName,
} = await import("../sessions.js");

// process.pid and process.ppid are alive; use them so isProcessAlive passes.
const ALIVE = process.pid;
const ALIVE2 = process.ppid;

function fake(
  id: string,
  name: string,
  pid: number,
  lastActive = Date.now(),
  claudeName?: string
): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, `${id}.json`),
    JSON.stringify({ id, name, cwd: `/fake/${name}`, pid, lastActive, claudeName })
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

  it("accepts the Claude Code session name as an alias, exact and fuzzy", () => {
    fake("x", "integration", ALIVE, Date.now(), "fintary-a9");
    fake("y", "fintary:main", ALIVE2, Date.now(), "fintary-69");
    expect(findSession("fintary-a9")?.id).toBe("x");
    expect(findSession("FINTARY-A9")?.id).toBe("x");
    expect(findSession("fintary-69")?.id).toBe("y");
    // The WeChat routing name still wins an exact match over a fuzzy alias hit.
    expect(findSession("integration")?.id).toBe("x");
  });

  it("prefers the live Claude Code name over the one stored in the session file", () => {
    // Claude Code renamed the session after its MCP server last wrote the file.
    fake("x", "review", ALIVE, Date.now(), "old-name-11");
    const live = new Map([["x", { name: "new-name-22" }]]);
    expect(findSession("new-name-22", live)?.id).toBe("x");
    expect(findSession("old-name-11", live)).toBeUndefined();
    expect(matchSessions("new-name-22", live).map((s) => s.id)).toEqual(["x"]);
  });

  it("does not let a Claude Code alias shadow an exact WeChat routing name", () => {
    fake("x", "review", ALIVE, Date.now(), "backend-12");
    fake("y", "backend-12", ALIVE2, Date.now(), "other-34");
    expect(findSession("backend-12")?.id).toBe("y");
  });
});

describe("validateSessionName", () => {
  it("accepts a plain word and trims it", () => {
    expect(validateSessionName("  integration ")).toEqual({
      ok: true,
      name: "integration",
    });
    expect(validateSessionName("fintary:main")).toEqual({
      ok: true,
      name: "fintary:main",
    });
  });

  it("rejects empty names", () => {
    expect(validateSessionName("   ").ok).toBe(false);
  });

  it("rejects whitespace and suggests a dashed form", () => {
    const r = validateSessionName("reconciliation part 3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestion).toBe("reconciliation-part-3");
  });

  it("rejects purely numeric names, which /s would read as a number", () => {
    const r = validateSessionName("42");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestion).toBe("s42");
  });

  it("rejects a leading slash", () => {
    const r = validateSessionName("/backend");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestion).toBe("backend");
  });
});

describe("findNameConflict", () => {
  it("finds another live session holding the name, case-insensitively", () => {
    fake("x", "integration", ALIVE);
    fake("y", "other", ALIVE2);
    expect(findNameConflict("Integration", "y")?.id).toBe("x");
  });

  it("ignores the session asking (renaming to its own name is idempotent)", () => {
    fake("x", "integration", ALIVE);
    expect(findNameConflict("integration", "x")).toBeUndefined();
  });

  it("returns undefined when the name is free", () => {
    fake("x", "integration", ALIVE);
    expect(findNameConflict("review", "y")).toBeUndefined();
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

describe("cwdLabel", () => {
  it("shows repo/worktree for a Claude worktree and the basename otherwise", () => {
    expect(cwdLabel("/Users/x/repos/fintary/.claude/worktrees/data-sync")).toBe(
      "fintary/data-sync"
    );
    expect(cwdLabel("/Users/x/repos/fintary")).toBe("fintary");
  });
});

describe("sessionLabel", () => {
  it("appends #pid only for duplicate names when no Claude name is known", () => {
    const a = { id: "x", name: "twin", cwd: "/", pid: 1, lastActive: 0 };
    const b = { id: "y", name: "twin", cwd: "/", pid: 2, lastActive: 0 };
    const c = { id: "z", name: "solo", cwd: "/", pid: 3, lastActive: 0 };
    expect(sessionLabel(a, [a, b, c])).toBe("twin#1");
    expect(sessionLabel(c, [a, b, c])).toBe("solo");
  });

  it("prefers the Claude Code name in parentheses to disambiguate", () => {
    const a = { id: "x", name: "fintary:main", cwd: "/", pid: 1, lastActive: 0, claudeName: "fintary-69" };
    const b = { id: "y", name: "fintary:main", cwd: "/", pid: 2, lastActive: 0 };
    expect(sessionLabel(a, [a, b])).toBe("fintary:main (fintary-69)");
    // A live registry name passed explicitly wins over the stored one.
    expect(sessionLabel(a, [a, b], "fintary-70")).toBe("fintary:main (fintary-70)");
    // Unknown Claude name: fall back to the pid.
    expect(sessionLabel(b, [a, b])).toBe("fintary:main#2");
    // Unique names never get a suffix, even with a Claude name.
    expect(sessionLabel(a, [a], "fintary-69")).toBe("fintary:main");
  });
});
