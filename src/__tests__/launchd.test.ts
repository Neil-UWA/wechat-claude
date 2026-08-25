import { vi, describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// A home directory containing & and < exercises the plist escaping through the
// real substitution path, since the log path is derived from the home dir.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "wc-launchd-a&b<c-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawnSync: (...args: unknown[]) => spawnSyncMock(...args) };
});

const launchd = await import("../launchd.js");

function argvOf(callIndex: number): string[] {
  return spawnSyncMock.mock.calls[callIndex][1] as string[];
}

describe("launchd", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "" });
  });

  describe("writePlist", () => {
    it("writes into the user's LaunchAgents directory", () => {
      const written = launchd.writePlist();
      expect(written).toBe(launchd.PLIST_PATH);
      expect(written.startsWith(testHome)).toBe(true);
      expect(fs.existsSync(written)).toBe(true);
    });

    it("substitutes every placeholder", () => {
      const plist = fs.readFileSync(launchd.writePlist(), "utf-8");
      expect(plist).not.toMatch(/__[A-Z_]+__/);
    });

    it("escapes XML metacharacters in substituted paths", () => {
      const plist = fs.readFileSync(launchd.writePlist(), "utf-8");
      // The home dir contains & and <, so the log path must arrive escaped.
      expect(plist).toContain("a&amp;b&lt;c");
      // No raw & survives: every one must be the start of an entity.
      expect(plist).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    });

    it("points the job at this install's daemon and log file", () => {
      const plist = fs.readFileSync(launchd.writePlist(), "utf-8");
      expect(plist).toContain("daemon.js");
      expect(plist).toContain(".claude/wechat/daemon.log".replace(/\//g, path.sep));
    });

    it("creates the log's parent directory so launchd can open it", () => {
      fs.rmSync(path.join(testHome, ".claude"), { recursive: true, force: true });
      launchd.writePlist();
      expect(fs.existsSync(path.join(testHome, ".claude", "wechat"))).toBe(true);
    });
  });

  describe("load", () => {
    it("unloads before loading so a reload picks up a changed plist", () => {
      launchd.load();
      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      expect(argvOf(0)).toEqual(["unload", launchd.PLIST_PATH]);
      expect(argvOf(1)).toEqual(["load", launchd.PLIST_PATH]);
    });

    it("reports the load result, not the unload result", () => {
      // A first-time install has nothing to unload: that failure is expected.
      spawnSyncMock
        .mockReturnValueOnce({ status: 1, stdout: "" })
        .mockReturnValueOnce({ status: 0, stdout: "" });
      expect(launchd.load()).toBe(true);
    });

    it("fails when the load fails", () => {
      spawnSyncMock
        .mockReturnValueOnce({ status: 0, stdout: "" })
        .mockReturnValueOnce({ status: 1, stdout: "" });
      expect(launchd.load()).toBe(false);
    });
  });

  describe("isLoaded", () => {
    it("finds the job by label in launchctl list", () => {
      spawnSyncMock.mockReturnValue({ status: 0, stdout: `123\t0\t${launchd.LABEL}\n` });
      expect(launchd.isLoaded()).toBe(true);
    });

    it("is false when the label is absent", () => {
      spawnSyncMock.mockReturnValue({ status: 0, stdout: "123\t0\tcom.other.thing\n" });
      expect(launchd.isLoaded()).toBe(false);
    });

    it("is false when launchctl produces nothing", () => {
      spawnSyncMock.mockReturnValue({ status: 1, stdout: undefined });
      expect(launchd.isLoaded()).toBe(false);
    });
  });
});
