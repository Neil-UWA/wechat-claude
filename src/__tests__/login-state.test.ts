import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "wc-login-state-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const {
  VERIFIED_WINDOW_MS,
  clearLoginVerified,
  loginVerification,
  loginVerifiedAt,
  markLoginVerified,
  verificationNote,
} = await import("../login-state.js");
const { LOGIN_VERIFIED_FILE } = await import("../paths.js");

const WECHAT_DIR = path.join(testHome, ".claude", "wechat");

beforeEach(() => {
  fs.mkdirSync(WECHAT_DIR, { recursive: true });
  clearLoginVerified();
});

afterAll(() => fs.rmSync(testHome, { recursive: true, force: true }));

describe("markLoginVerified", () => {
  it("records the time of a successful WeChat call", () => {
    markLoginVerified(1_000);
    expect(loginVerifiedAt()).toBe(1_000);
    expect(fs.existsSync(LOGIN_VERIFIED_FILE)).toBe(true);
  });

  it("keeps the freshest proof, and forgets it on a clear", () => {
    markLoginVerified(1_000);
    markLoginVerified(2_000);
    expect(loginVerifiedAt()).toBe(2_000);
    clearLoginVerified();
    expect(loginVerifiedAt()).toBeUndefined();
  });
});

describe("loginVerification", () => {
  it("is fresh inside the window", () => {
    const v = loginVerification(10_000, 10_000 - 1_000);
    expect(v.state).toBe("fresh");
  });

  it("goes stale once no call has succeeded for a while", () => {
    const v = loginVerification(10_000, 10_000 - VERIFIED_WINDOW_MS - 1);
    expect(v.state).toBe("stale");
  });

  it("reports 'never' when nothing has ever succeeded", () => {
    expect(loginVerification(10_000, undefined).state).toBe("never");
  });
});

describe("verificationNote", () => {
  // The point of the whole module: an unverified login must not read like a
  // healthy one, because the user acts on that line.
  it("qualifies a stale login loudly", () => {
    const note = verificationNote(
      loginVerification(VERIFIED_WINDOW_MS + 10_000, 1)
    );
    expect(note).toContain("UNVERIFIED");
    expect(note).toContain("revoked");
  });

  it("stays quiet when a call just succeeded", () => {
    const note = verificationNote(loginVerification(10_000, 9_000));
    expect(note).toContain("verified");
    expect(note).not.toContain("UNVERIFIED");
  });
});
