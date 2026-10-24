import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { installRenameHook, removeRenameHook, renameHookCommand } from "../claude-settings.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-claude-settings-"));
const FILE = path.join(dir, "settings.json");
const CMD = renameHookCommand("/opt/new/dist/rename-hook.js");

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
    installRenameHook(renameHookCommand("/opt/old/dist/rename-hook.js"), FILE);
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

  it("leaves a user's own hook of the same script name alone", () => {
    const theirs = { hooks: [{ type: "command", command: "node ~/bin/rename-hook.js" }] };
    fs.writeFileSync(FILE, JSON.stringify({ hooks: { UserPromptSubmit: [theirs] } }));
    expect(installRenameHook(CMD, FILE)).toBe("installed");
    expect(read().hooks.UserPromptSubmit[0]).toEqual(theirs);
  });

  it("adopts an untagged entry from an earlier npm install", () => {
    const legacy = 'node "/usr/lib/node_modules/wechat-claude-sessions/dist/rename-hook.js"';
    fs.writeFileSync(
      FILE,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: legacy }] }] } })
    );
    expect(installRenameHook(CMD, FILE)).toBe("updated");
    expect(read().hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: CMD }] }]);
  });

  it("tolerates null entries instead of throwing", () => {
    fs.writeFileSync(FILE, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [null] }] } }));
    expect(installRenameHook(CMD, FILE)).toBe("installed");
  });

  it("writes through a symlinked settings file", () => {
    const real = path.join(dir, "dotfiles-settings.json");
    fs.writeFileSync(real, JSON.stringify({ theme: "dark" }));
    fs.symlinkSync(real, FILE);
    expect(installRenameHook(CMD, FILE)).toBe("installed");
    expect(fs.lstatSync(FILE).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf-8")).hooks.UserPromptSubmit).toHaveLength(1);
    fs.unlinkSync(real);
  });

  describe("removeRenameHook", () => {
    it("removes our entry and keeps the rest", () => {
      const other = { hooks: [{ type: "command", command: "echo hi" }] };
      fs.writeFileSync(FILE, JSON.stringify({ theme: "dark", hooks: { UserPromptSubmit: [other] } }));
      installRenameHook(CMD, FILE);
      expect(removeRenameHook(FILE)).toBe("removed");
      expect(read()).toEqual({ theme: "dark", hooks: { UserPromptSubmit: [other] } });
    });

    it("drops the event key when nothing else was there", () => {
      installRenameHook(CMD, FILE);
      expect(removeRenameHook(FILE)).toBe("removed");
      expect(read().hooks).toEqual({});
    });

    it("reports absent when there is nothing to remove", () => {
      expect(removeRenameHook(FILE)).toBe("absent");
      fs.writeFileSync(FILE, JSON.stringify({ theme: "dark" }));
      expect(removeRenameHook(FILE)).toBe("absent");
    });
  });
});
