import { describe, it, expect, vi, afterAll } from "vitest";
import { tmpdir, platform } from "node:os";
import { mkdtempSync, mkdirSync, statSync, rmSync, chmodSync } from "node:fs";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-paths-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const { ensureDirs, WECHAT_DIR, SESSIONS_DIR, INBOX_DIR, TYPING_DIR } =
  await import("../paths.js");

afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const isPosix = platform() !== "win32";

describe("ensureDirs", () => {
  it("creates the tree 0700", () => {
    ensureDirs();
    for (const dir of [WECHAT_DIR, SESSIONS_DIR, INBOX_DIR, TYPING_DIR]) {
      if (isPosix) expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it("tightens a pre-existing loose subdirectory (Copilot finding)", () => {
    // Simulate a subdir created before the hardening with group/world bits.
    mkdirSync(SESSIONS_DIR, { recursive: true });
    if (isPosix) {
      chmodSync(SESSIONS_DIR, 0o755);
      expect(statSync(SESSIONS_DIR).mode & 0o777).toBe(0o755);
    }
    ensureDirs();
    if (isPosix) expect(statSync(SESSIONS_DIR).mode & 0o777).toBe(0o700);
  });
});
