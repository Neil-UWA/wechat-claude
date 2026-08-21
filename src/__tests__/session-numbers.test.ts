import { describe, it, expect, vi, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

const testHome = mkdtempSync(path.join(tmpdir(), "wc-numbers-test-"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual.default, homedir: () => testHome },
    homedir: () => testHome,
  };
});

const { assignSessionNumbers } = await import("../session-numbers.js");

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe("assignSessionNumbers", () => {
  it("assigns ascending numbers by numeric id", () => {
    const map = assignSessionNumbers(["300", "100", "200"]);
    expect(map["100"]).toBe(1);
    expect(map["200"]).toBe(2);
    expect(map["300"]).toBe(3);
  });

  it("keeps numbers stable when a session closes", () => {
    const map = assignSessionNumbers(["100", "300"]);
    expect(map["100"]).toBe(1);
    expect(map["300"]).toBe(3);
  });

  it("does not reuse retired numbers for new sessions", () => {
    const map = assignSessionNumbers(["100", "300", "400"]);
    expect(map["100"]).toBe(1);
    expect(map["300"]).toBe(3);
    expect(map["400"]).toBe(4);
  });

  it("keeps numbers stable across repeated calls", () => {
    const a = assignSessionNumbers(["100", "300", "400"]);
    const b = assignSessionNumbers(["100", "300", "400"]);
    expect(b).toEqual(a);
  });

  it("resets to 1 when no known session remains", () => {
    const map = assignSessionNumbers(["999"]);
    expect(map["999"]).toBe(1);
  });
});
