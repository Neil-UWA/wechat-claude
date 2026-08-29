import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type UsageState,
  parseProbeOutput,
  probeUsageLimit,
  resetHint,
  shouldProbe,
} from "../usage.js";

const NOW = 1_700_000_000_000;

describe("parseProbeOutput", () => {
  it("treats a successful run as ok", () => {
    const out = JSON.stringify({
      is_error: false,
      result: "ok",
      usage: { output_tokens: 3 },
    });
    expect(parseProbeOutput(0, out, NOW)).toEqual({ state: "ok" });
  });

  it("does not report a limit when a successful reply mentions one", () => {
    const out = JSON.stringify({
      is_error: false,
      result: "Your usage limit resets at midnight.",
    });
    expect(parseProbeOutput(0, out, NOW).state).toBe("ok");
  });

  it("detects the usage limit from a failed JSON result", () => {
    const out = JSON.stringify({
      is_error: true,
      subtype: "error_during_execution",
      result:
        "Claude usage limit reached. Your limit will reset at 10pm (America/Los_Angeles).",
    });
    const probe = parseProbeOutput(1, out, NOW);
    expect(probe.state).toBe("limited");
    if (probe.state !== "limited") throw new Error("unreachable");
    expect(probe.resetText).toContain("10pm");
  });

  it("detects a rate limit from non-JSON stderr", () => {
    const probe = parseProbeOutput(1, "API Error: 429 rate_limit_error", NOW);
    expect(probe.state).toBe("limited");
  });

  it("reads a machine-readable reset time", () => {
    const resetAt = Math.floor((NOW + 3_600_000) / 1000);
    const probe = parseProbeOutput(
      1,
      `{"is_error":true,"result":"rate_limit_error resets_at: ${resetAt}"}`,
      NOW
    );
    if (probe.state !== "limited") throw new Error("expected limited");
    expect(probe.resetAt).toBe(resetAt * 1000);
  });

  it("turns retry-after seconds into an absolute reset", () => {
    const probe = parseProbeOutput(
      1,
      '{"is_error":true,"result":"429 too many requests, retry-after: 120"}',
      NOW
    );
    if (probe.state !== "limited") throw new Error("expected limited");
    expect(probe.resetAt).toBe(NOW + 120_000);
  });

  it("keeps unrelated failures unknown rather than claiming a limit", () => {
    const probe = parseProbeOutput(1, "Error: connect ECONNREFUSED", NOW);
    expect(probe.state).toBe("unknown");
    if (probe.state !== "unknown") throw new Error("unreachable");
    expect(probe.detail).toContain("ECONNREFUSED");
  });

  it("trusts is_error over a non-zero exit code", () => {
    const out = JSON.stringify({ is_error: false, result: "ok" });
    expect(parseProbeOutput(143, out, NOW).state).toBe("ok");
  });
});

describe("shouldProbe", () => {
  const base: UsageState = { limited: false, lastProbeAt: NOW, notified: [] };

  it("throttles probes while everything looks fine", () => {
    expect(shouldProbe(base, NOW + 60_000)).toBe(false);
    expect(shouldProbe(base, NOW + 5 * 60_000)).toBe(true);
  });

  it("re-checks often while limited with no known reset time", () => {
    const limited: UsageState = { ...base, limited: true };
    expect(shouldProbe(limited, NOW + 60_000)).toBe(false);
    expect(shouldProbe(limited, NOW + 2 * 60_000)).toBe(true);
  });

  it("waits for the reported reset time instead of hammering", () => {
    const limited: UsageState = {
      ...base,
      limited: true,
      resetAt: NOW + 30 * 60_000,
    };
    expect(shouldProbe(limited, NOW + 5 * 60_000)).toBe(false);
    // ...but re-checks slowly anyway, in case the reset time was wrong.
    expect(shouldProbe(limited, NOW + 11 * 60_000)).toBe(true);
    // ...and immediately once the reset time is due.
    expect(shouldProbe({ ...limited, lastProbeAt: NOW + 29 * 60_000 }, NOW + 30 * 60_000)).toBe(true);
  });
});

describe("resetHint", () => {
  it("prefers the CLI's own wording", () => {
    const state: UsageState = {
      limited: true,
      lastProbeAt: NOW,
      notified: [],
      resetText: "10pm (America/Los_Angeles)",
      resetAt: NOW + 60_000,
    };
    expect(resetHint(state, NOW)).toBe("10pm (America/Los_Angeles)");
  });

  it("falls back to a countdown", () => {
    const state: UsageState = {
      limited: true,
      lastProbeAt: NOW,
      notified: [],
      resetAt: NOW + 90 * 60_000,
    };
    expect(resetHint(state, NOW)).toBe("~2h");
  });

  it("has no hint when the reset time is unknown or past", () => {
    const state: UsageState = { limited: true, lastProbeAt: NOW, notified: [] };
    expect(resetHint(state, NOW)).toBeUndefined();
    expect(resetHint({ ...state, resetAt: NOW - 1 }, NOW)).toBeUndefined();
  });
});

describe("probeUsageLimit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wc-usage-probe-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.WECHAT_CLAUDE_BIN;
  });

  function fakeClaude(script: string): string {
    const bin = path.join(dir, `claude-${Math.random().toString(36).slice(2)}`);
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  it("reports a limit from the CLI's failure output", async () => {
    process.env.WECHAT_CLAUDE_BIN = fakeClaude(
      `echo '{"is_error":true,"result":"Claude usage limit reached. Your limit will reset at 3pm."}'; exit 1`
    );
    const probe = await probeUsageLimit(10_000);
    expect(probe.state).toBe("limited");
    if (probe.state !== "limited") throw new Error("unreachable");
    expect(probe.resetText).toContain("3pm");
  });

  it("reports ok from a normal reply", async () => {
    process.env.WECHAT_CLAUDE_BIN = fakeClaude(
      `echo '{"is_error":false,"result":"ok"}'`
    );
    expect((await probeUsageLimit(10_000)).state).toBe("ok");
  });

  it("gives up on a hung CLI instead of blocking the daemon", async () => {
    process.env.WECHAT_CLAUDE_BIN = fakeClaude("sleep 30");
    const probe = await probeUsageLimit(300);
    expect(probe.state).toBe("unknown");
    if (probe.state !== "unknown") throw new Error("unreachable");
    expect(probe.detail).toContain("timed out");
  });

  it("does not mistake a missing CLI for a usage limit", async () => {
    process.env.WECHAT_CLAUDE_BIN = path.join(dir, "definitely-not-here");
    expect((await probeUsageLimit(10_000)).state).toBe("unknown");
  });
});
