import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJsonObject, readJsonObjectOrEmpty, writeJsonAtomic } from "../json-file.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-json-file-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readJsonObject", () => {
  it("returns the object, or null for anything else", () => {
    const f = path.join(dir, "read.json");
    fs.writeFileSync(f, JSON.stringify({ a: 1 }));
    expect(readJsonObject(f)).toEqual({ a: 1 });
    for (const body of ["[1]", "null", "3", "{ broken"]) {
      fs.writeFileSync(f, body);
      expect(readJsonObject(f)).toBeNull();
    }
    expect(readJsonObject(path.join(dir, "missing.json"))).toBeNull();
  });
});

describe("readJsonObjectOrEmpty", () => {
  it("reads a missing file as {}, a corrupt or unreadable one as null", () => {
    expect(readJsonObjectOrEmpty(path.join(dir, "absent.json"))).toEqual({});
    const f = path.join(dir, "corrupt.json");
    fs.writeFileSync(f, "{ broken");
    expect(readJsonObjectOrEmpty(f)).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ a: 1 }));
    expect(readJsonObjectOrEmpty(f)).toEqual({ a: 1 });
    // A directory where the file should be is not "missing".
    expect(readJsonObjectOrEmpty(dir)).toBeNull();
  });
});

describe("writeJsonAtomic", () => {
  it("creates the file and its directory", () => {
    const f = path.join(dir, "new", "deep.json");
    expect(writeJsonAtomic(f, { a: 1 })).toBe(true);
    expect(readJsonObject(f)).toEqual({ a: 1 });
  });

  it("keeps the existing permissions", () => {
    const f = path.join(dir, "private.json");
    fs.writeFileSync(f, "{}", { mode: 0o600 });
    fs.chmodSync(f, 0o600);
    writeJsonAtomic(f, { a: 1 });
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("writes through a symlink instead of replacing it", () => {
    const real = path.join(dir, "dotfiles.json");
    const link = path.join(dir, "linked.json");
    fs.writeFileSync(real, "{}");
    fs.symlinkSync(real, link);
    expect(writeJsonAtomic(link, { a: 1 })).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readJsonObject(real)).toEqual({ a: 1 });
  });

  it("follows a symlink whose target does not exist yet", () => {
    const real = path.join(dir, "not-yet", "settings.json");
    const link = path.join(dir, "dangling.json");
    fs.symlinkSync(real, link);
    expect(writeJsonAtomic(link, { a: 1 })).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readJsonObject(real)).toEqual({ a: 1 });
  });

  it("refuses a symlink loop rather than renaming over the link", () => {
    const a = path.join(dir, "loop-a.json");
    const b = path.join(dir, "loop-b.json");
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    expect(writeJsonAtomic(a, { a: 1 })).toBe(false);
    expect(fs.lstatSync(a).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(a)).toBe(b);
  });

  it("keeps a group-writable mode the umask would narrow", () => {
    const f = path.join(dir, "shared.json");
    fs.writeFileSync(f, "{}");
    fs.chmodSync(f, 0o664);
    writeJsonAtomic(f, { a: 1 });
    expect(fs.statSync(f).mode & 0o777).toBe(0o664);
  });

  it("is not fooled by a leftover temp file's mode", () => {
    const f = path.join(dir, "secret.json");
    fs.writeFileSync(f, "{}");
    fs.chmodSync(f, 0o600);
    const stale = `${f}.wechat-claude.${process.pid}.tmp`;
    fs.writeFileSync(stale, "junk");
    fs.chmodSync(stale, 0o644);
    writeJsonAtomic(f, { a: 1 });
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  // root ignores directory permissions, so the failure can't be staged.
  it.skipIf(process.getuid?.() === 0)("fails without touching the file or leaving a temp file behind", () => {
    const ro = path.join(dir, "ro");
    fs.mkdirSync(ro);
    const f = path.join(ro, "c.json");
    fs.writeFileSync(f, '{"keep":true}');
    fs.chmodSync(ro, 0o500);
    try {
      expect(writeJsonAtomic(f, { a: 1 })).toBe(false);
      expect(readJsonObject(f)).toEqual({ keep: true });
      expect(fs.readdirSync(ro)).toEqual(["c.json"]);
    } finally {
      fs.chmodSync(ro, 0o700);
    }
  });
});
