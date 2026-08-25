import { describe, it, expect } from "vitest";
import { isSafeSessionName, sanitizeForSessionName } from "../tmux.js";

describe("isSafeSessionName", () => {
  it("accepts our generated names", () => {
    expect(isSafeSessionName("wc-myapp-me3f9k2")).toBe(true);
    expect(isSafeSessionName("wc-repo.name-abc")).toBe(true);
  });

  it("rejects shell metacharacters and spaces", () => {
    expect(isSafeSessionName("wc-x`$(id)`")).toBe(false);
    expect(isSafeSessionName('wc-x";rm -rf ~"')).toBe(false);
    expect(isSafeSessionName("wc x")).toBe(false);
    expect(isSafeSessionName("wc-$(whoami)")).toBe(false);
  });
});

describe("sanitizeForSessionName", () => {
  it("strips unsafe chars from a directory basename", () => {
    expect(sanitizeForSessionName("my app")).toBe("my-app");
    expect(sanitizeForSessionName("a`b$c")).toBe("a-b-c");
    expect(isSafeSessionName(sanitizeForSessionName("weird$(name)"))).toBe(true);
  });

  it("collapses runs of dashes and caps length", () => {
    expect(sanitizeForSessionName("a###b")).toBe("a-b");
    expect(sanitizeForSessionName("x".repeat(100)).length).toBe(40);
  });

  it("never yields an empty string", () => {
    expect(sanitizeForSessionName("$$$")).toBe("-"); // collapsed, non-empty
    expect(sanitizeForSessionName("")).toBe("x");
  });
});
