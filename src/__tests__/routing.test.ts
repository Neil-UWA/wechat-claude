import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-routing-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const { routingLines, parseRouteCommand, isBareRouteCommand } = await import(
  "../routing.js"
);
const { setBinding, clearBinding } = await import("../bindings.js");

const WECHAT_DIR = path.join(testHome, ".claude", "wechat");
const SESSIONS_DIR = path.join(WECHAT_DIR, "sessions");
const HEARTBEAT_DIR = path.join(WECHAT_DIR, "heartbeat");

// Pids that are alive, so listSessions keeps the session files. Each session
// needs its own: listSessions now groups servers by their live parent process
// to hide the leftovers of an MCP reconnect, and two rows sharing one pid
// would look like exactly that — one of them would be hidden as a ghost.
const ALIVE_PID = process.pid;
const OTHER_PID = process.ppid;

function writeSession(
  id: string,
  name: string,
  lastActive: number,
  pid: number = ALIVE_PID
): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    path.join(SESSIONS_DIR, `${id}.json`),
    JSON.stringify({ id, name, cwd: `/tmp/${name}`, pid, lastActive })
  );
}

function markMonitoring(id: string): void {
  mkdirSync(HEARTBEAT_DIR, { recursive: true });
  writeFileSync(path.join(HEARTBEAT_DIR, id), String(Date.now()));
}

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  rmSync(HEARTBEAT_DIR, { recursive: true, force: true });
  clearBinding("u@im.wechat");
});

describe("routingLines", () => {
  it("reports this session as the default target when it is the monitored one", () => {
    writeSession("100", "here", Date.now());
    markMonitoring("100");
    const lines = routingLines("100");
    expect(lines.join("\n")).toContain("Default target for unbound plain messages");
    expect(lines.join("\n")).toContain("(this session)");
  });

  it("warns when a binding points at a different live session", () => {
    writeSession("100", "here", Date.now());
    writeSession("200", "other", Date.now() - 1000, OTHER_PID);
    setBinding("u@im.wechat", "200");
    const text = routingLines("100").join("\n");
    expect(text).toContain("will NOT arrive in this session");
    expect(text).toContain("/use off");
    expect(text).toContain("other");
  });

  it("labels a binding to this session as such", () => {
    writeSession("100", "here", Date.now());
    setBinding("u@im.wechat", "100");
    const text = routingLines("100").join("\n");
    expect(text).toContain("Binding: u@im.wechat → this session");
    expect(text).not.toContain("will NOT arrive");
  });

  it("marks a binding to a vanished session as stale", () => {
    writeSession("100", "here", Date.now());
    setBinding("u@im.wechat", "999999");
    const text = routingLines("100").join("\n");
    expect(text).toContain("stale");
    expect(text).toContain("999999");
  });

  it("says plainly when the default target is a different session", () => {
    writeSession("100", "here", Date.now() - 60_000);
    writeSession("200", "other", Date.now(), OTHER_PID);
    markMonitoring("100");
    markMonitoring("200");
    const text = routingLines("100").join("\n");
    expect(text).toContain("Default target for unbound plain messages: other");
    expect(text).toContain("NOT this session");
    expect(text).toContain("/use <n>");
    expect(text).not.toContain("(this session)");
  });

  it("prefers a monitored session over a more recently active unmonitored one", () => {
    writeSession("100", "here", Date.now());
    writeSession("200", "other", Date.now() + 60_000, OTHER_PID);
    markMonitoring("100");
    const text = routingLines("100").join("\n");
    expect(text).toContain("(this session)");
  });

  it("returns no default line when there are no sessions", () => {
    expect(routingLines("100")).toEqual([]);
  });
});

describe("parseRouteCommand", () => {
  it("reads /s <target> <message>", () => {
    expect(parseRouteCommand("/s 3 你好")).toEqual({
      selector: "3",
      message: "你好",
    });
    expect(parseRouteCommand("/s backend deploy now")).toEqual({
      selector: "backend",
      message: "deploy now",
    });
  });

  it("accepts the /3 shorthand people actually type", () => {
    expect(parseRouteCommand("/3 你好")).toEqual({
      selector: "3",
      message: "你好",
    });
  });

  it("keeps the message intact, newlines and all", () => {
    expect(parseRouteCommand("/2 line one\nline two")?.message).toBe(
      "line one\nline two"
    );
  });

  it("claims nothing but the two routing forms", () => {
    // The shorthand is digits-only, so a mistyped command stays a plain
    // message instead of being routed to a session named after the typo, and
    // a real command is never mistaken for a selector.
    expect(parseRouteCommand("/lss hi")).toBeUndefined();
    expect(parseRouteCommand("/close 3 all")).toBeUndefined();
    expect(parseRouteCommand("/use 2")).toBeUndefined();
  });

  it("is undefined for anything that isn't a routing command", () => {
    expect(parseRouteCommand("在吗")).toBeUndefined();
    expect(parseRouteCommand("/s 3")).toBeUndefined();
    expect(parseRouteCommand("/3")).toBeUndefined();
  });
});

describe("isBareRouteCommand", () => {
  it("recognises a routing command with nothing to route", () => {
    expect(isBareRouteCommand("/s")).toBe(true);
    expect(isBareRouteCommand("/s 3")).toBe(true);
    expect(isBareRouteCommand("/3")).toBe(true);
    expect(isBareRouteCommand("/3  ")).toBe(true);
  });

  it("leaves a complete command, and ordinary text, alone", () => {
    expect(isBareRouteCommand("/s 3 hi")).toBe(false);
    expect(isBareRouteCommand("/3 hi")).toBe(false);
    expect(isBareRouteCommand("/ls")).toBe(false);
    expect(isBareRouteCommand("在吗")).toBe(false);
  });
});
