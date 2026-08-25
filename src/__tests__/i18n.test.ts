import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-i18n-test-"));
const configFile = path.join(testHome, ".claude", "wechat", "config.json");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const { getLang, formatAgo, marker, t } = await import("../i18n.js");

afterEach(() => {
  process.env.WECHAT_LANG = undefined;
  rmSync(configFile, { force: true });
});
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

function writeConfig(obj: unknown): void {
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(obj));
}

describe("getLang", () => {
  it("defaults to zh with no config", () => {
    expect(getLang()).toBe("zh");
  });

  it("reads lang from config.json", () => {
    writeConfig({ lang: "en" });
    expect(getLang()).toBe("en");
  });

  it("env var overrides config", () => {
    writeConfig({ lang: "zh" });
    process.env.WECHAT_LANG = "en";
    expect(getLang()).toBe("en");
  });

  it("ignores an invalid lang value", () => {
    writeConfig({ lang: "fr" });
    expect(getLang()).toBe("zh");
  });
});

describe("formatAgo", () => {
  it("zh ranges", () => {
    expect(formatAgo(10_000)).toBe("刚刚");
    expect(formatAgo(5 * 60_000)).toBe("5 分钟前");
    expect(formatAgo(3 * 3_600_000)).toBe("3 小时前");
    expect(formatAgo(2 * 86_400_000)).toBe("2 天前");
  });

  it("en ranges", () => {
    expect(formatAgo(10_000, "en")).toBe("just now");
    expect(formatAgo(5 * 60_000, "en")).toBe("5m ago");
    expect(formatAgo(3 * 3_600_000, "en")).toBe("3h ago");
    expect(formatAgo(2 * 86_400_000, "en")).toBe("2d ago");
  });
});

describe("marker", () => {
  it("localizes content markers", () => {
    expect(marker("image", "zh")).toBe("[图片]");
    expect(marker("image", "en")).toBe("[image]");
    expect(marker("voice", "zh", "hi")).toBe("[语音转文字] hi");
    expect(marker("voice", "en", "hi")).toBe("[voice→text] hi");
  });
});

describe("t catalog", () => {
  it("zh and en both provide every message and differ", () => {
    const zh = t("zh");
    const en = t("en");
    expect(zh.help).toContain("用法");
    expect(en.help).toContain("commands");
    expect(zh.notFound("x")).not.toBe(en.notFound("x"));
    expect(en.remainingSummary(2, 1)).toContain("2 session");
  });
});
