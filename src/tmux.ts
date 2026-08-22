import { spawnSync } from "node:child_process";

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

// A tmux session name safe to embed and to hand back to the user: no shell
// metacharacters, no spaces.
export function isSafeSessionName(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name);
}

export function sanitizeForSessionName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 40) || "x";
}
