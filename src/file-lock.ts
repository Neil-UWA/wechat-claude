import fs from "node:fs";

const LOCK_TIMEOUT_MS = 5000;
const LOCK_SPINS = 100;

// Serialize access to a small JSON file across processes with an atomic mkdir
// lock, so a reader-modify-writer in one process can't interleave with another
// (which would lose or duplicate entries). Critical sections must stay tiny —
// one file read plus one write.
//
// A lock nobody released within LOCK_TIMEOUT_MS is stolen: the holder is a
// crashed process, and waiting on it forever would wedge every writer.
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  for (let i = 0; i < LOCK_SPINS; i++) {
    try {
      fs.mkdirSync(lock);
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_TIMEOUT_MS) {
          fs.rmdirSync(lock);
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
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
