import { execFile, spawnSync } from "node:child_process";

// All tmux interaction goes through argv arrays (never a shell string), so
// session names and directories from user input cannot inject shell commands.

export function hasTmux(): boolean {
  const r = spawnSync("tmux", ["-V"], { stdio: "ignore" });
  return r.status === 0;
}

export function tmuxSessionExists(name: string): boolean {
  const r = spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
  return r.status === 0;
}

export function listTmuxSessions(): string[] {
  const r = spawnSync("tmux", ["ls", "-F", "#{session_name}"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function killTmuxSession(name: string): boolean {
  const r = spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
  return r.status === 0;
}

// Start a detached session running shellCmd (executed by tmux's own shell, so
// shellCmd itself must already be a safe shell string — see buildRunPrompt's
// file-based task passing). Returns null on success or an error string.
export function newTmuxSession(
  name: string,
  cwd: string,
  shellCmd: string
): string | null {
  const r = spawnSync(
    "tmux",
    ["new-session", "-d", "-s", name, "-c", cwd, shellCmd],
    { stdio: "ignore" }
  );
  if (r.error) return String(r.error);
  if (r.status !== 0) return `tmux exited with ${r.status}`;
  return null;
}

// The pane id ("%12") at the end of a target as Claude Code records it
// ("<session>:@<window>.%<pane>"). Pane ids are unique on a tmux server,
// whatever the session is called; undefined when there is none.
export function paneIdOf(target: string): string | undefined {
  return target.match(/(%\d+)$/)?.[1];
}

// The attach path (attach.ts) runs on the daemon's message path, so its tmux
// calls are asynchronous and time-limited: a slow or hung tmux server must not
// stall polling and routing for everyone.
const TMUX_TIMEOUT_MS = 3_000;

function tmuxAsync(args: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile("tmux", args, { timeout: TMUX_TIMEOUT_MS, encoding: "utf-8" }, (err, stdout) => {
      if (err) resolve({ ok: false, stdout: "", error: String(err) });
      else resolve({ ok: true, stdout: typeof stdout === "string" ? stdout : "" });
    });
  });
}

// The pid of the process a pane was started with, or undefined when the pane
// does not exist on this tmux server (or tmux isn't installed).
export async function panePid(paneId: string): Promise<number | undefined> {
  const r = await tmuxAsync(["display-message", "-p", "-t", paneId, "#{pane_pid}"]);
  if (!r.ok) return undefined;
  const pid = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

// The visible screen of a pane, with its colour/attribute escapes (-e) kept:
// promptIsEmpty needs them to tell a dimmed placeholder from typed text.
export async function capturePane(paneId: string): Promise<string | undefined> {
  const r = await tmuxAsync(["capture-pane", "-p", "-e", "-t", paneId]);
  return r.ok ? r.stdout : undefined;
}

// Type `text` into a pane and press Enter. -l sends the text literally, so
// nothing in it is read as a key name.
export async function typeIntoPane(paneId: string, text: string): Promise<string | null> {
  for (const args of [
    ["send-keys", "-t", paneId, "-l", text],
    ["send-keys", "-t", paneId, "Enter"],
  ]) {
    const r = await tmuxAsync(args);
    if (!r.ok) return r.error ?? "tmux failed";
  }
  return null;
}

// Claude Code's input box, as tmux captures it: a rule of "─", a line opening
// with "❯", any continuation lines of a multi-line draft, then another rule.
// An empty box shows nothing after the "❯" but, at most, a dimmed (SGR 2)
// suggestion. Anything else — typed text, or a screen that doesn't look like
// that at all — means a draft may be there, and typing would append to it and
// submit it. So this only says true when it can see the box is empty.
const SGR = /\x1b\[([0-9;]*)m/g;
const RULE = /^[─━]{8,}/;

function visibleText(line: string, dim: { on: boolean }): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(SGR)) {
    if (!dim.on) out += line.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    const codes = m[1] === "" ? ["0"] : m[1].split(";");
    for (const c of codes) {
      if (c === "0" || c === "22") dim.on = false;
      else if (c === "2") dim.on = true;
    }
  }
  if (!dim.on) out += line.slice(last);
  // Any other escape left in the text counts as content: be conservative.
  return out;
}

function plain(line: string): string {
  return line.replace(SGR, "").trim();
}

export function promptIsEmpty(screen: string): boolean {
  const lines = screen.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (plain(lines[i]).startsWith("❯")) {
      start = i;
      break;
    }
  }
  if (start < 1 || !RULE.test(plain(lines[start - 1]))) return false;
  const dim = { on: false };
  for (let i = start; i < lines.length; i++) {
    if (i > start && RULE.test(plain(lines[i]))) return true;
    let text = visibleText(lines[i], dim);
    if (i === start) text = text.replace(/^[^❯]*❯/, "");
    if (text.replace(/[\s\u00a0]/g, "") !== "") return false;
  }
  // No closing rule below the prompt: not the input box we know.
  return false;
}

// A tmux session name safe to embed and to hand back to the user: no shell
// metacharacters, no spaces.
export function isSafeSessionName(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name);
}

export function sanitizeForSessionName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 40) || "x";
}
