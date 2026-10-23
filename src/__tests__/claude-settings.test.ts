import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { installRenameHook } from "../claude-settings.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-claude-settings-"));
const FILE = path.join(dir, "settings.json");
const CMD = 'node "/opt/new/dist/rename-hook.js"';

function read(): any {
  return JSON.parse(fs.readFileSync(FILE, "utf-8"));
}

describe("installRenameHook", () => {
  beforeEach(() => {
    try {
      fs.unlinkSync(FILE);
    } catch {}
  });

  it("creates the settings file when there is none", () => {
    expect(installRenameHook(CMD, FILE)).toBe("installed");
    expect(read().hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: CMD }] },
    ]);
  });

  it("keeps other settings and hooks", () => {
    const other = { hooks: [{ type: "command", command: "echo hi" }] };
    fs.writeFileSync(
      FILE,
      JSON.stringify({ theme: "dark", hooks: { UserPromptSubmit: [other], Stop: [other] } })
    );
    expect(installRenameHook(CMD, FILE)).toBe("installed");
    const s = read();
    expect(s.theme).toBe("dark");
    expect(s.hooks.Stop).toEqual([other]);
    expect(s.hooks.UserPromptSubmit).toHaveLength(2);
    expect(s.hooks.UserPromptSubmit[0]).toEqual(other);
  });

  it("is idempotent", () => {
    installRenameHook(CMD, FILE);
    expect(installRenameHook(CMD, FILE)).toBe("already");
    expect(read().hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("repoints an entry left by another install instead of adding a second", () => {
    installRenameHook('node "/opt/old/dist/rename-hook.js"', FILE);
    expect(installRenameHook(CMD, FILE)).toBe("updated");
    expect(read().hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: CMD }] },
    ]);
  });

  it("leaves a corrupt file untouched", () => {
    fs.writeFileSync(FILE, "{ not json");
    expect(installRenameHook(CMD, FILE)).toBe("failed");
    expect(fs.readFileSync(FILE, "utf-8")).toBe("{ not json");
  });
});
