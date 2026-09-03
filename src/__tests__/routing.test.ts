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

const { routingLines } = await import("../routing.js");
const { setBinding, clearBinding } = await import("../bindings.js");

const WECHAT_DIR = path.join(testHome, ".claude", "wechat");
const SESSIONS_DIR = path.join(WECHAT_DIR, "sessions");
const HEARTBEAT_DIR = path.join(WECHAT_DIR, "heartbeat");

// An id whose pid is alive (ours) so listSessions keeps the session file. Two
// distinct session ids may share the live pid — liveness is all that matters.
const ALIVE_PID = process.pid;

function writeSession(id: string, name: string, lastActive: number): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    path.join(SESSIONS_DIR, `${id}.json`),
    JSON.stringify({ id, name, cwd: `/tmp/${name}`, pid: ALIVE_PID, lastActive })
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
    writeSession("200", "other", Date.now() - 1000);
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
    writeSession("200", "other", Date.now());
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
    writeSession("200", "other", Date.now() + 60_000);
    markMonitoring("100");
    const text = routingLines("100").join("\n");
    expect(text).toContain("(this session)");
  });

  it("returns no default line when there are no sessions", () => {
    expect(routingLines("100")).toEqual([]);
  });
});
