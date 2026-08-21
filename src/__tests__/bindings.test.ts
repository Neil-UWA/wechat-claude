import { describe, it, expect, vi, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-bindings-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const { getBinding, setBinding, clearBinding, clearBindingsToSession } =
  await import("../bindings.js");

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe("bindings", () => {
  it("returns undefined for an unbound user", () => {
    expect(getBinding("nobody@im.wechat")).toBeUndefined();
  });

  it("set and get round-trip", () => {
    setBinding("u1@im.wechat", "12345");
    expect(getBinding("u1@im.wechat")).toBe("12345");
  });

  it("rebinding overwrites", () => {
    setBinding("u2@im.wechat", "111");
    setBinding("u2@im.wechat", "222");
    expect(getBinding("u2@im.wechat")).toBe("222");
  });

  it("clearBinding removes only that user", () => {
    setBinding("u3@im.wechat", "333");
    setBinding("u4@im.wechat", "444");
    clearBinding("u3@im.wechat");
    expect(getBinding("u3@im.wechat")).toBeUndefined();
    expect(getBinding("u4@im.wechat")).toBe("444");
  });

  it("clearBindingsToSession removes every binding to that session", () => {
    setBinding("u5@im.wechat", "555");
    setBinding("u6@im.wechat", "555");
    setBinding("u7@im.wechat", "777");
    clearBindingsToSession("555");
    expect(getBinding("u5@im.wechat")).toBeUndefined();
    expect(getBinding("u6@im.wechat")).toBeUndefined();
    expect(getBinding("u7@im.wechat")).toBe("777");
  });
});
