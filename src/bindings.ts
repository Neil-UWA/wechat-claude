import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = path.join(os.homedir(), ".claude", "wechat", "bindings.json");

// WeChat user id -> session id. A bound user's plain messages go straight to
// the bound session instead of the default routing target.
type Bindings = Record<string, string>;

function readBindings(): Bindings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Bindings;
    }
  } catch {}
  return {};
}

function writeBindings(bindings: Bindings): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(bindings));
  } catch {}
}

export function getBinding(userId: string): string | undefined {
  return readBindings()[userId];
}

// All current bindings (WeChat user id -> session id), for status reporting.
export function listBindings(): Record<string, string> {
  return readBindings();
}

export function setBinding(userId: string, sessionId: string): void {
  const bindings = readBindings();
  bindings[userId] = sessionId;
  writeBindings(bindings);
}

export function clearBinding(userId: string): void {
  const bindings = readBindings();
  if (!(userId in bindings)) return;
  delete bindings[userId];
  writeBindings(bindings);
}

// Remove every binding that points at a (closed) session.
export function clearBindingsToSession(sessionId: string): void {
  const bindings = readBindings();
  let changed = false;
  for (const [userId, boundId] of Object.entries(bindings)) {
    if (boundId === sessionId) {
      delete bindings[userId];
      changed = true;
    }
  }
  if (changed) writeBindings(bindings);
}
