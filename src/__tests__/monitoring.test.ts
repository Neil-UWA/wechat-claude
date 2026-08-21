import { describe, it, expect, vi, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-monitoring-test-"));
const heartbeatDir = path.join(testHome, ".claude", "wechat", "heartbeat");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const { touchHeartbeat, clearHeartbeat, isMonitoring } = await import(
  "../monitoring.js"
);

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe("monitoring heartbeat", () => {
  it("isMonitoring is false without a heartbeat", () => {
    expect(isMonitoring("nobody")).toBe(false);
  });

  it("touchHeartbeat makes isMonitoring true", () => {
    touchHeartbeat("sess-1");
    expect(existsSync(path.join(heartbeatDir, "sess-1"))).toBe(true);
    expect(isMonitoring("sess-1")).toBe(true);
  });

  it("clearHeartbeat makes isMonitoring false again", () => {
    touchHeartbeat("sess-2");
    expect(isMonitoring("sess-2")).toBe(true);
    clearHeartbeat("sess-2");
    expect(isMonitoring("sess-2")).toBe(false);
    expect(existsSync(path.join(heartbeatDir, "sess-2"))).toBe(false);
  });

  it("a stale heartbeat outside the window does not count", () => {
    mkdirSync(heartbeatDir, { recursive: true });
    writeFileSync(
      path.join(heartbeatDir, "sess-stale"),
      String(Date.now() - 60_000)
    );
    expect(isMonitoring("sess-stale")).toBe(false);
    expect(isMonitoring("sess-stale", 120_000)).toBe(true);
  });

  it("garbage heartbeat content does not count", () => {
    mkdirSync(heartbeatDir, { recursive: true });
    writeFileSync(path.join(heartbeatDir, "sess-bad"), "not-a-number");
    expect(isMonitoring("sess-bad")).toBe(false);
  });
});
