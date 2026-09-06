import fs from "node:fs";
import { LOGIN_VERIFIED_FILE } from "./paths.js";

// "Logged in" is only ever a claim about a file on disk: the bot token lives
// in ~/.claude/wechat/session.json, and nothing local can tell whether the
// server still honours it (a `wechat-claude uninstall` on another machine
// revokes it, and this machine keeps the file). The only real proof is a
// WeChat call that came back OK — so every authenticated call stamps this
// file, and status reports how old the proof is instead of an unqualified
// "true". A false green here is worse than a false red: the user trusts it,
// sends, and finds out at the moment they needed it to work.

// The daemon's long poll returns every long-poll cycle (tens of seconds), so a
// healthy setup re-stamps many times over inside this window. Wide enough to
// ride out the occasional dropped or timed-out poll: "unverified" must mean
// something is actually wrong, or the warning becomes noise people learn to
// scroll past.
export const VERIFIED_WINDOW_MS = 300_000;

// Written on every successful call rather than throttled: it is a 13-byte
// write next to a network round trip, and a throttle would leave the freshest
// proof — the send the user is waiting on — unrecorded.
export function markLoginVerified(now: number = Date.now()): void {
  try {
    fs.writeFileSync(LOGIN_VERIFIED_FILE, String(now));
  } catch {}
}

export function clearLoginVerified(): void {
  try {
    fs.unlinkSync(LOGIN_VERIFIED_FILE);
  } catch {}
}

export function loginVerifiedAt(): number | undefined {
  try {
    const ts = parseInt(
      fs.readFileSync(LOGIN_VERIFIED_FILE, "utf-8").trim(),
      10
    );
    return Number.isFinite(ts) ? ts : undefined;
  } catch {
    return undefined;
  }
}

export type LoginVerification =
  | { state: "fresh"; at: number; ageMs: number }
  | { state: "stale"; at: number; ageMs: number }
  | { state: "never" };

// How much the local "logged in" flag is actually worth right now.
export function loginVerification(
  now: number = Date.now(),
  at: number | undefined = loginVerifiedAt()
): LoginVerification {
  if (at === undefined) return { state: "never" };
  const ageMs = Math.max(0, now - at);
  return { state: ageMs < VERIFIED_WINDOW_MS ? "fresh" : "stale", at, ageMs };
}

function ago(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

// The qualifier appended to the `Logged in:` line in wechat_status.
export function verificationNote(v: LoginVerification): string {
  switch (v.state) {
    case "fresh":
      return `(verified ${ago(v.ageMs)} — a WeChat call succeeded)`;
    case "stale":
      return `(UNVERIFIED — last successful WeChat call ${ago(v.ageMs)}; the token is only cached locally and may have been revoked elsewhere, e.g. by \`wechat-claude uninstall\` on another machine. Sending may fail.)`;
    case "never":
      return "(UNVERIFIED — no successful WeChat call recorded yet on this machine; the token is only cached locally. Sending may fail.)";
  }
}
