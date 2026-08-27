// Detecting "Claude is out of usage quota".
//
// When a Claude subscription hits its limit, every session stops answering at
// once: the model call is rejected, so nothing reaches the inbox reader and
// nothing comes back to WeChat. From the phone it looks identical to a crashed
// daemon. The daemon therefore probes the limit itself — one throttled headless
// `claude -p` call — and tells the user what is going on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG_FILE, USAGE_STATE_FILE } from "./paths.js";

export type LimitProbe =
  | { state: "ok" }
  | { state: "limited"; resetAt?: number; resetText?: string; detail: string }
  | { state: "unknown"; detail: string };

// Phrases that mean "quota exhausted" rather than any other failure. Matched
// only against output that already failed, so ordinary replies can't trip them.
const LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /\blimit reached\b/i,
  /\brate[_ -]?limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota (?:exceeded|exhausted)/i,
  /out of (?:usage|credits?)/i,
  /credit balance is too low/i,
  /insufficient (?:credits?|quota)/i,
  /用量|额度|次数已达|已达上限/,
];

// Human-readable reset hint, e.g. "resets at 10pm (America/Los_Angeles)".
function parseResetText(text: string): string | undefined {
  const m = text.match(
    /reset(?:s|ting)?(?: will be)?(?: at| in)?\s+([^."\n}]{2,60})/i
  );
  if (m) return m[1].trim();
  const zh = text.match(/(?:将于|大约)?\s*([^。"\n]{2,30}?)\s*(?:后)?恢复/);
  return zh ? zh[1].trim() : undefined;
}

// Absolute reset time, when the failure carries a machine-readable one.
function parseResetAt(text: string, now: number): number | undefined {
  const epoch = text.match(/"?reset(?:s)?[_-]?at"?\s*[:=]\s*"?(\d{10,13})/i);
  if (epoch) {
    const n = parseInt(epoch[1], 10);
    return epoch[1].length <= 10 ? n * 1000 : n;
  }
  const iso = text.match(
    /"?reset(?:s)?[_-]?at"?\s*[:=]\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/i
  );
  if (iso) {
    const ms = Date.parse(iso[1]);
    if (Number.isFinite(ms)) return ms;
  }
  const retryAfter = text.match(/retry[_ -]?after"?\s*[:=]?\s*"?(\d{1,6})/i);
  if (retryAfter) return now + parseInt(retryAfter[1], 10) * 1000;
  return undefined;
}

// Pull the most useful line out of a probe failure for logs / WeChat.
function summarize(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 220)}…` : cleaned;
}

// Classify one `claude -p --output-format json` run. Exported for tests: the
// real output shape is the CLI's, so this must stay tolerant — a failure we
// cannot attribute to the quota is "unknown", never a false "limited".
export function parseProbeOutput(
  exitCode: number | null,
  output: string,
  now: number = Date.now()
): LimitProbe {
  let failed = exitCode !== 0;
  let message = output;

  const jsonStart = output.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(output.slice(jsonStart)) as {
        is_error?: boolean;
        result?: unknown;
        subtype?: string;
        error?: unknown;
      };
      if (typeof parsed.is_error === "boolean") failed = parsed.is_error;
      const detail = [parsed.result, parsed.error, parsed.subtype]
        .filter((v) => typeof v === "string")
        .join(" ");
      if (detail) message = detail;
    } catch {
      // Not JSON (crash before the CLI could format a result) — use raw text.
    }
  }

  if (!failed) return { state: "ok" };
  if (!LIMIT_PATTERNS.some((re) => re.test(message)))
    return { state: "unknown", detail: summarize(message) };

  return {
    state: "limited",
    resetAt: parseResetAt(message, now),
    resetText: parseResetText(message),
    detail: summarize(message),
  };
}

function readConfig(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// The daemon runs under launchd with a minimal PATH, so a bare "claude" may not
// resolve. Prefer an explicit override, then the usual install locations.
export function resolveClaudeBin(): string {
  const env = process.env.WECHAT_CLAUDE_BIN;
  if (env) return env;
  const configured = readConfig().claudeBin;
  if (typeof configured === "string" && configured) {
    return configured.startsWith("~/")
      ? path.join(os.homedir(), configured.slice(2))
      : configured;
  }
  const candidates = [
    path.join(os.homedir(), ".local/bin/claude"),
    path.join(os.homedir(), ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  return "claude";
}

// Model used for the probe. Cheap by default: subscription limits are
// account-wide, so a Haiku call is rejected by the same limit that stops the
// real sessions, at a fraction of the cost. Override with `probeModel` in
// ~/.claude/wechat/config.json (e.g. to catch an Opus-only weekly cap).
export function probeModel(): string | undefined {
  const configured = readConfig().probeModel;
  if (typeof configured === "string" && configured) {
    return configured === "default" ? undefined : configured;
  }
  return "claude-haiku-4-5-20251001";
}

export const PROBE_TIMEOUT_MS = 90_000;

// One headless round-trip. `--strict-mcp-config` with an empty server map
// matters (the map must be spelled out in full — `{}` alone is rejected): the
// probe must not load this package's own MCP server, which would register a
// phantom session in the list every time we check.
export function probeUsageLimit(
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<LimitProbe> {
  const model = probeModel();
  const args = [
    "-p",
    "ok",
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--allowedTools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    ...(model ? ["--model", model] : []),
  ];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveClaudeBin(), args, {
        cwd: os.tmpdir(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${process.env.PATH ?? ""}:${path.join(os.homedir(), ".local/bin")}:/opt/homebrew/bin:/usr/local/bin`,
        },
      });
    } catch (err) {
      resolve({
        state: "unknown",
        detail: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let out = "";
    const capture = (chunk: Buffer): void => {
      // Cap the buffer: a wedged CLI must not grow the daemon's memory.
      if (out.length < 64_000) out += chunk.toString();
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    let settled = false;
    const finish = (probe: LimitProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({ state: "unknown", detail: `probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.on("error", (err) =>
      finish({ state: "unknown", detail: `probe failed: ${err.message}` })
    );
    child.on("close", (code) => finish(parseProbeOutput(code, out)));
  });
}

export type UsageState = {
  limited: boolean;
  // When the current limit episode was first confirmed.
  since?: number;
  resetAt?: number;
  resetText?: string;
  lastProbeAt: number;
  // Users already told about this episode, so a limit is announced once.
  notified: string[];
};

export const OK_PROBE_INTERVAL_MS = 5 * 60_000;
export const LIMITED_PROBE_INTERVAL_MS = 2 * 60_000;

// Probes cost a little quota, so they are throttled. While limited they are
// free (the call is rejected instantly), but if a reset time is known there is
// no point asking again before it — except for a slow safety re-check, in case
// the reported reset time was wrong.
export function shouldProbe(
  state: UsageState,
  now: number,
  opts: { okIntervalMs?: number; limitedIntervalMs?: number } = {}
): boolean {
  const since = now - state.lastProbeAt;
  if (!state.limited) return since >= (opts.okIntervalMs ?? OK_PROBE_INTERVAL_MS);
  if (state.resetAt !== undefined) {
    // Before the announced reset there is nothing to learn; check slowly, only
    // in case the announced time was wrong. Once it is due, check promptly so
    // recovery is announced quickly.
    return now < state.resetAt - 30_000 ? since >= 10 * 60_000 : since >= 30_000;
  }
  return since >= (opts.limitedIntervalMs ?? LIMITED_PROBE_INTERVAL_MS);
}

// How the limit reads to the user: prefer the CLI's own wording, fall back to
// a countdown derived from the machine-readable reset time.
export function resetHint(state: UsageState, now: number): string | undefined {
  if (state.resetText) return state.resetText;
  if (state.resetAt === undefined || state.resetAt <= now) return undefined;
  const mins = Math.max(1, Math.round((state.resetAt - now) / 60_000));
  return mins >= 60
    ? `~${Math.round(mins / 60)}h`
    : `~${mins}m`;
}

export function readUsageState(): UsageState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(USAGE_STATE_FILE, "utf-8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as UsageState).limited === "boolean"
    ) {
      const state = parsed as UsageState;
      return {
        ...state,
        lastProbeAt: Number.isFinite(state.lastProbeAt) ? state.lastProbeAt : 0,
        notified: Array.isArray(state.notified) ? state.notified : [],
      };
    }
  } catch {}
  return { limited: false, lastProbeAt: 0, notified: [] };
}

export function writeUsageState(state: UsageState): void {
  try {
    fs.writeFileSync(USAGE_STATE_FILE, JSON.stringify(state));
  } catch {}
}
