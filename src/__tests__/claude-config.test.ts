import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureBypassAccepted, isBypassAccepted } from "../claude-config.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-claude-config-"));
const CONFIG = path.join(dir, ".claude.json");

function write(value: unknown): void {
  fs.writeFileSync(CONFIG, JSON.stringify(value));
}

describe("claude-config", () => {
  beforeEach(() => {
    try {
      fs.unlinkSync(CONFIG);
    } catch {}
  });

  it("reports an unaccepted config as not accepted", () => {
    write({ theme: "dark" });
    expect(isBypassAccepted(CONFIG)).toBe(false);
  });

  it("accepts once and leaves the rest of the config intact", () => {
    write({ theme: "dark", projects: { a: 1 } });

    expect(ensureBypassAccepted(CONFIG)).toBe("accepted");
    expect(isBypassAccepted(CONFIG)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(CONFIG, "utf-8"));
    expect(saved.theme).toBe("dark");
    expect(saved.projects).toEqual({ a: 1 });
  });

  it("is a no-op when already accepted", () => {
    write({ bypassPermissionsModeAccepted: true });
    expect(ensureBypassAccepted(CONFIG)).toBe("already");
    expect(isBypassAccepted(CONFIG)).toBe(true);
  });

  it("leaves no temp file behind", () => {
    write({ theme: "dark" });
    ensureBypassAccepted(CONFIG);
    const strays = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(strays).toEqual([]);
  });

  it("reports failure rather than creating a config that does not exist", () => {
    expect(ensureBypassAccepted(CONFIG)).toBe("failed");
    expect(fs.existsSync(CONFIG)).toBe(false);
  });

  it("does not treat a corrupt config as accepted", () => {
    fs.writeFileSync(CONFIG, "{ not json");
    expect(isBypassAccepted(CONFIG)).toBe(false);
    expect(ensureBypassAccepted(CONFIG)).toBe("failed");
  });

  it("reports failure when the config cannot be written", () => {
    write({ theme: "dark" });
    fs.chmodSync(dir, 0o500); // no write permission on the directory
    try {
      expect(ensureBypassAccepted(CONFIG)).toBe("failed");
      expect(isBypassAccepted(CONFIG)).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});
