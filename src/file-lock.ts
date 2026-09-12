import fs from "node:fs";

// A lock nobody released within this is a crashed holder's, and may be stolen.
const LOCK_TIMEOUT_MS = 5000;
// Long enough to outlast that: a budget shorter than the stale threshold can
// never reach the steal, so every contender would give up and write unlocked —
// exactly the concurrent read-modify-write the lock exists to prevent.
const LOCK_BUDGET_MS = LOCK_TIMEOUT_MS * 2;
const SPIN_MS = 20;

// Serialize access to a small JSON file across processes with an atomic mkdir
// lock, so a reader-modify-writer in one process can't interleave with another
// (which would lose or duplicate entries). Critical sections must stay tiny —
// one file read plus one write.
//
// A lock nobody released within LOCK_TIMEOUT_MS is stolen: the holder is a
// crashed process, and waiting on it forever would wedge every writer.
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_BUDGET_MS;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lock);
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_TIMEOUT_MS) {
          fs.rmdirSync(lock);
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SPIN_MS);
      continue;
    }
    try {
      return fn();
    } finally {
      try {
        fs.rmdirSync(lock);
      } catch {}
    }
  }
  // Couldn't acquire within the budget — proceed unlocked rather than drop the
  // write entirely.
  return fn();
}
