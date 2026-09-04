import { describe, it, expect, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  checkForUpdate,
  compareVersions,
  parseVersion,
  readPkgVersion,
} from "../version.js";

const dir = mkdtempSync(path.join(tmpdir(), "wc-version-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readPkgVersion", () => {
  it("reads the version out of package.json", () => {
    const root = path.join(dir, "pkg");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "3.4.5" }));
    expect(readPkgVersion(root)).toBe("3.4.5");
  });

  it("falls back to 0.0.0 when the file is missing or malformed", () => {
    expect(readPkgVersion(path.join(dir, "nope"))).toBe("0.0.0");
    const root = path.join(dir, "bad");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "package.json"), "{oops");
    expect(readPkgVersion(root)).toBe("0.0.0");
  });

  it("reports this repo's own version", () => {
    const own = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf-8")
    ) as { version: string };
    expect(readPkgVersion()).toBe(own.version);
  });
});

describe("parseVersion", () => {
  it("takes a branch dev build apart", () => {
    expect(parseVersion("1.2.0-dev.session-naming.10.1e0b17f")).toEqual({
      raw: "1.2.0-dev.session-naming.10.1e0b17f",
      base: "1.2.0",
      dev: { branch: "session-naming", build: 10, sha: "1e0b17f" },
    });
  });

  it("takes a dev-branch build (no slug) apart", () => {
    expect(parseVersion("1.2.0-dev.10.1e0b17f").dev).toEqual({
      branch: undefined,
      build: 10,
      sha: "1e0b17f",
    });
  });

  it("treats a release as having no dev part, and tolerates a v prefix", () => {
    expect(parseVersion("v1.2.0")).toEqual({ raw: "1.2.0", base: "1.2.0" });
    expect(parseVersion("1.2.0")).toEqual({ raw: "1.2.0", base: "1.2.0" });
  });

  it("keeps an unrecognised prerelease intact rather than mangling it", () => {
    const info = parseVersion("1.2.0-rc.1");
    expect(info.base).toBe("1.2.0");
    expect(info.dev).toBeUndefined();
    expect(info.raw).toBe("1.2.0-rc.1");
  });

});

describe("compareVersions", () => {
  it("orders by major, minor, patch numerically", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.2.1")).toBeLessThan(0);
  });

  it("puts a prerelease below its own release and tolerates a v prefix", () => {
    expect(compareVersions("1.2.0-dev.3.abc", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.2.0-dev.3.abc")).toBeGreaterThan(0);
    expect(compareVersions("1.2.1-dev.1", "1.2.0")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.0", "1.2.0")).toBe(0);
  });

  it("treats unparseable input as equal rather than throwing", () => {
    expect(compareVersions("garbage", "1.0.0")).toBe(0);
  });
});

describe("checkForUpdate", () => {
  const cacheFile = (name: string): string => path.join(dir, "cache", `${name}.json`);

  it("asks the registry when there is no cache, and caches the answer", async () => {
    let calls = 0;
    const r = await checkForUpdate({
      current: "1.2.0",
      now: 1000,
      cacheFile: cacheFile("fresh"),
      fetchLatest: async () => {
        calls += 1;
        return "1.3.0";
      },
    });
    expect(r).toEqual({ current: "1.2.0", latest: "1.3.0", updateAvailable: true });
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(cacheFile("fresh"), "utf-8"))).toEqual({
      checkedAt: 1000,
      latest: "1.3.0",
      attemptedAt: 1000,
    });
  });

  it("uses the cache while it is fresh instead of asking again", async () => {
    writeFileSync(cacheFile("hot"), JSON.stringify({ checkedAt: 5000, latest: "1.2.0" }));
    let calls = 0;
    const r = await checkForUpdate({
      current: "1.2.0",
      now: 5000 + 60_000,
      ttlMs: 3_600_000,
      cacheFile: cacheFile("hot"),
      fetchLatest: async () => {
        calls += 1;
        return "9.9.9";
      },
    });
    expect(calls).toBe(0);
    expect(r.updateAvailable).toBe(false);
    expect(r.latest).toBe("1.2.0");
  });

  it("re-asks once the cache is older than the TTL", async () => {
    writeFileSync(cacheFile("stale"), JSON.stringify({ checkedAt: 0, latest: "1.2.0" }));
    let calls = 0;
    const r = await checkForUpdate({
      current: "1.2.0",
      now: 10 * 3_600_000,
      ttlMs: 3_600_000,
      cacheFile: cacheFile("stale"),
      fetchLatest: async () => {
        calls += 1;
        return "1.2.5";
      },
    });
    expect(calls).toBe(1);
    expect(r).toEqual({ current: "1.2.0", latest: "1.2.5", updateAvailable: true });
  });

  it("falls back to the stale cached answer when the registry is unreachable", async () => {
    writeFileSync(cacheFile("offline"), JSON.stringify({ checkedAt: 0, latest: "1.4.0" }));
    const r = await checkForUpdate({
      current: "1.2.0",
      now: 10 * 3_600_000,
      ttlMs: 3_600_000,
      cacheFile: cacheFile("offline"),
      fetchLatest: async () => undefined,
    });
    expect(r).toEqual({ current: "1.2.0", latest: "1.4.0", updateAvailable: true });
  });

  it("does not retry a failed check until the retry window has passed", async () => {
    let calls = 0;
    const failing = async (): Promise<string | undefined> => {
      calls += 1;
      return undefined;
    };
    const file = cacheFile("backoff");
    await checkForUpdate({ current: "1.2.0", now: 1000, cacheFile: file, fetchLatest: failing });
    await checkForUpdate({ current: "1.2.0", now: 2000, cacheFile: file, fetchLatest: failing });
    expect(calls).toBe(1);
    // Past the retry window it asks again.
    await checkForUpdate({
      current: "1.2.0",
      now: 1000 + 31 * 60_000,
      cacheFile: file,
      retryMs: 30 * 60_000,
      fetchLatest: failing,
    });
    expect(calls).toBe(2);
  });

  it("a failed attempt keeps the previous good answer and its timestamp", async () => {
    const file = cacheFile("keep");
    writeFileSync(file, JSON.stringify({ checkedAt: 5, latest: "1.5.0" }));
    const r = await checkForUpdate({
      current: "1.2.0",
      now: 10 * 3_600_000,
      cacheFile: file,
      fetchLatest: async () => undefined,
    });
    expect(r.latest).toBe("1.5.0");
    const cache = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    expect(cache.latest).toBe("1.5.0");
    expect(cache.checkedAt).toBe(5);
    expect(cache.attemptedAt).toBe(10 * 3_600_000);
  });

  it("coalesces concurrent checks into one registry request", async () => {
    let calls = 0;
    let release: (v: string) => void = () => {};
    const slow = (): Promise<string | undefined> => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const file = cacheFile("coalesce");
    const a = checkForUpdate({ current: "1.2.0", now: 1, cacheFile: file, fetchLatest: slow });
    const b = checkForUpdate({ current: "1.2.0", now: 1, cacheFile: file, fetchLatest: slow });
    release("1.9.0");
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(ra.latest).toBe("1.9.0");
    expect(rb.latest).toBe("1.9.0");
  });

  it("reports no update, and no latest, when nothing is known at all", async () => {
    const r = await checkForUpdate({
      current: "1.2.0",
      cacheFile: cacheFile("nothing"),
      fetchLatest: async () => undefined,
    });
    expect(r).toEqual({ current: "1.2.0", latest: undefined, updateAvailable: false });
  });

  it("does not flag a dev prerelease of the current release as an update", async () => {
    const r = await checkForUpdate({
      current: "1.3.0",
      cacheFile: cacheFile("pre"),
      fetchLatest: async () => "1.3.0",
    });
    expect(r.updateAvailable).toBe(false);
    const r2 = await checkForUpdate({
      current: "1.3.0-dev.7.abc123",
      cacheFile: cacheFile("pre2"),
      fetchLatest: async () => "1.3.0",
    });
    expect(r2.updateAvailable).toBe(true);
  });
});
