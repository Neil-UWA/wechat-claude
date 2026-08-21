import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = path.join(
  os.homedir(),
  ".claude",
  "wechat",
  "session-numbers.json"
);

type Registry = { next: number; map: Record<string, number> };

function readRegistry(): Registry {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Registry).next === "number" &&
      typeof (parsed as Registry).map === "object"
    ) {
      return parsed as Registry;
    }
  } catch {}
  return { next: 1, map: {} };
}

// Assign stable display numbers to sessions. A session keeps its number for
// its whole lifetime; numbers of closed sessions are retired (not reused), so
// "/s 3" always means the same session no matter what opened or closed in
// between. The counter resets to 1 once no sessions are left.
export function assignSessionNumbers(
  liveIds: string[]
): Record<string, number> {
  const reg = readRegistry();
  const map: Record<string, number> = {};
  for (const [id, num] of Object.entries(reg.map)) {
    if (liveIds.includes(id)) map[id] = num;
  }
  let next = Object.keys(map).length === 0 ? 1 : reg.next;
  const newIds = liveIds
    .filter((id) => !(id in map))
    .sort((a, b) => Number(a) - Number(b));
  for (const id of newIds) {
    map[id] = next;
    next += 1;
  }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ next, map }));
  } catch {}
  return map;
}
