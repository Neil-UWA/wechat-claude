// The installed package's version, and whether npm has a newer one.
//
// The version is read from package.json rather than hardcoded so it can't
// drift (npm always ships package.json). The update check asks the npm
// registry for the `latest` dist-tag, at most once per TTL, and never blocks
// a reply for long: a slow or offline registry yields "unknown", and the last
// answer we did get is kept on disk so an offline machine still shows it.
import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "./pkg-root.js";
import { UPDATE_CHECK_FILE } from "./paths.js";

export const PKG_NAME = "wechat-claude-sessions";

export function readPkgVersion(root: string = PKG_ROOT): string {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf-8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const PKG_VERSION: string = readPkgVersion();

// A version string taken apart so display can show just x.y.z. Dev builds are
// produced by the publish workflow as "<base>-dev.<branch-slug>.<run>.<sha>"
// (the slug is omitted on the dev branch itself).
export type VersionInfo = {
  raw: string;
  base: string;
  dev?: { branch?: string; build: number; sha: string };
};

export function parseVersion(raw: string): VersionInfo {
  const v = raw.trim().replace(/^v/, "");
  const dev = v.match(
    /^(\d+\.\d+\.\d+)-dev\.(?:([a-z0-9-]+)\.)?(\d+)\.([0-9a-f]{7,40})$/
  );
  if (dev) {
    return {
      raw: v,
      base: dev[1],
      dev: { branch: dev[2], build: Number(dev[3]), sha: dev[4] },
    };
  }
  const base = v.match(/^(\d+\.\d+\.\d+)/);
  return { raw: v, base: base ? base[1] : v };
}


// Numeric compare of the x.y.z part. A prerelease sorts below its own release
// (1.2.0-dev.3 < 1.2.0), otherwise prerelease text is ignored. Returns
// negative / 0 / positive like a sort comparator; unparseable input is 0.
export function compareVersions(a: string, b: string): number {
  const parse = (
    v: string
  ): { nums: number[]; pre: boolean } | undefined => {
    const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
    if (!m) return undefined;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: !!m[4] };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre === pb.pre) return 0;
  return pa.pre ? -1 : 1;
}

export type UpdateCheck = {
  current: string;
  // The registry's `latest`, or undefined when never learned.
  latest?: string;
  updateAvailable: boolean;
};

type Cache = { checkedAt: number; latest: string };

export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 3000;

function readCache(file: string): Cache | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Cache).checkedAt === "number" &&
      typeof (parsed as Cache).latest === "string"
    ) {
      return parsed as Cache;
    }
  } catch {}
  return undefined;
}

function writeCache(file: string, cache: Cache): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
  } catch {}
}

// Ask the npm registry for the `latest` version. Undefined on any failure.
export async function fetchLatestVersion(
  timeoutMs: number = UPDATE_CHECK_TIMEOUT_MS,
  name: string = PKG_NAME
): Promise<string | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}/latest`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    const v =
      typeof body === "object" && body !== null
        ? (body as { version?: unknown }).version
        : undefined;
    return typeof v === "string" && compareVersions(v, "0.0.0") >= 0 && /^\d/.test(v)
      ? v
      : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export type UpdateCheckOptions = {
  current?: string;
  now?: number;
  cacheFile?: string;
  ttlMs?: number;
  fetchLatest?: () => Promise<string | undefined>;
};

// Never rejects. Uses the cached answer while it is fresh; otherwise asks the
// registry and, if that fails, falls back to whatever was cached before.
export async function checkForUpdate(
  opts: UpdateCheckOptions = {}
): Promise<UpdateCheck> {
  const current = opts.current ?? PKG_VERSION;
  const now = opts.now ?? Date.now();
  const cacheFile = opts.cacheFile ?? UPDATE_CHECK_FILE;
  const ttlMs = opts.ttlMs ?? UPDATE_CHECK_TTL_MS;
  const fetchLatest = opts.fetchLatest ?? (() => fetchLatestVersion());

  const cached = readCache(cacheFile);
  let latest: string | undefined;
  if (cached && now - cached.checkedAt < ttlMs) {
    latest = cached.latest;
  } else {
    latest = await fetchLatest();
    if (latest) writeCache(cacheFile, { checkedAt: now, latest });
    else latest = cached?.latest;
  }
  return {
    current,
    latest,
    updateAvailable: latest !== undefined && compareVersions(latest, current) > 0,
  };
}
