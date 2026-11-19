import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ATTACH_GRACE_MS,
  type AttachDeps,
  type AttachRequest,
  attachSession,
  autoAttachEnabled,
  clearAttachRequest,
  hasAttachRequests,
  isAncestor,
  takeAttachRequest,
  typablePane,
  writeAttachRequest,
} from "../attach.js";
import type { ClaudeSessionRecord } from "../claude-sessions.js";
import type { SessionInfo } from "../sessions.js";
import { paneIdOf } from "../tmux.js";

const session: SessionInfo = {
  id: "4242",
  name: "api",
  cwd: "/repo/api",
  pid: 4242,
  lastActive: 0,
  claudePid: 4000,
};

function deps(over: Partial<AttachDeps> = {}): AttachDeps & {
  typed: string[];
  requests: AttachRequest[];
  relayed: string[];
} {
  const typed: string[] = [];
  const requests: AttachRequest[] = [];
  const relayed: string[] = [];
  return {
    enabled: () => true,
    isMonitoring: () => false,
    readRecord: (pid) => ({ pid, name: "api-3e", status: "busy" }),
    typablePane: () => undefined,
    typeIntoPane: (pane, text) => {
      typed.push(`${pane} ${text}`);
      return null;
    },
    relay: async (socket) => {
      relayed.push(socket);
      return true;
    },
    writeRequest: (r) => requests.push(r),
    now: () => 1_000_000,
    attempts: new Map(),
    typed,
    requests,
    relayed,
    ...over,
  };
}

describe("attachSession", () => {
  it("does nothing for a session that is already monitoring", () => {
    const d = deps({ isMonitoring: () => true });
    expect(attachSession(session, d)).toEqual({ kind: "monitoring" });
    expect(d.typed).toEqual([]);
    expect(d.requests).toEqual([]);
  });

  it("does nothing when autoAttach is off in config", () => {
    const d = deps({ enabled: () => false });
    expect(attachSession(session, d)).toEqual({ kind: "disabled" });
    expect(d.requests).toEqual([]);
  });

  it("types /wechat into the pane of an idle tmux session", () => {
    const d = deps({ typablePane: () => "%3" });
    expect(attachSession(session, d)).toEqual({ kind: "typed", pane: "%3" });
    expect(d.typed).toEqual(["%3 /wechat"]);
    expect(d.requests).toEqual([]);
  });

  it("leaves a request for the hook when the session can't be typed into", () => {
    const d = deps();
    expect(attachSession(session, d)).toEqual({ kind: "requested" });
    expect(d.requests).toEqual([
      { sessionId: "4242", claudePid: 4000, name: "api", requestedAt: 1_000_000 },
    ]);
  });

  it("relays through the session's messaging socket when it can't be typed into", async () => {
    const d = deps({
      readRecord: (pid) => ({ pid, name: "api-3e", status: "idle", messagingSocketPath: "/tmp/cc-socks/4000.sock" }),
    });
    const outcome = attachSession(session, d);
    expect(outcome.kind).toBe("relaying");
    if (outcome.kind !== "relaying") return;
    expect(await outcome.done).toBe(true);
    expect(d.relayed).toEqual(["/tmp/cc-socks/4000.sock"]);
    expect(d.requests).toEqual([]);
  });

  it("falls back to a request for the hook when the relay fails", async () => {
    const d = deps({
      readRecord: (pid) => ({ pid, name: "api-3e", status: "busy", messagingSocketPath: "/tmp/cc-socks/4000.sock" }),
      relay: async () => false,
    });
    const outcome = attachSession(session, d);
    if (outcome.kind !== "relaying") throw new Error(outcome.kind);
    expect(await outcome.done).toBe(false);
    expect(d.requests).toHaveLength(1);
  });

  it("never relays to a socket path that isn't one", () => {
    const d = deps({
      readRecord: (pid) => ({ pid, name: "x", status: "idle", messagingSocketPath: '/tmp/a.sock" and also' }),
    });
    expect(attachSession(session, d)).toEqual({ kind: "requested" });
    expect(d.relayed).toEqual([]);
  });

  it("falls back to a request when typing into the pane fails", () => {
    const d = deps({ typablePane: () => "%3", typeIntoPane: () => "tmux exited with 1" });
    expect(attachSession(session, d)).toEqual({ kind: "requested" });
    expect(d.requests).toHaveLength(1);
  });

  it("does not attach twice while the first attempt is still starting up", () => {
    let now = 1_000_000;
    const d = deps({ typablePane: () => "%3", now: () => now });
    expect(attachSession(session, d).kind).toBe("typed");
    now += ATTACH_GRACE_MS - 1;
    expect(attachSession(session, d)).toEqual({ kind: "pending" });
    expect(d.typed).toHaveLength(1);
    now += 1;
    expect(attachSession(session, d).kind).toBe("typed");
    expect(d.typed).toHaveLength(2);
  });

  it("reports a session from an older build, with no Claude pid, as unreachable", () => {
    const d = deps();
    const { claudePid: _omit, ...old } = session;
    expect(attachSession(old, d)).toEqual({ kind: "unreachable" });
    expect(d.requests).toEqual([]);
  });
});

describe("typablePane", () => {
  const rec: ClaudeSessionRecord = {
    pid: 4000,
    name: "wc-x",
    tmux: "wc-repo-abc:@0.%7",
    status: "idle",
  };
  const ok = {
    hasTmux: () => true,
    panePid: () => 3900,
    isAncestor: (a: number, p: number) => a === 3900 && p === 4000,
  };

  it("returns the pane of an idle session running in tmux", () => {
    expect(typablePane(rec, ok)).toBe("%7");
  });

  it("refuses unless the session is idle — Enter would answer an open dialog", () => {
    for (const status of ["busy", "waiting", "shell", undefined]) {
      expect(typablePane({ ...rec, status }, ok)).toBeUndefined();
    }
  });

  it("refuses a session not in tmux, or with no tmux installed", () => {
    expect(typablePane({ ...rec, tmux: undefined }, ok)).toBeUndefined();
    expect(typablePane(rec, { ...ok, hasTmux: () => false })).toBeUndefined();
  });

  it("refuses a pane that doesn't exist on this tmux server", () => {
    expect(typablePane(rec, { ...ok, panePid: () => undefined })).toBeUndefined();
  });

  it("refuses a pane that isn't running this Claude process", () => {
    expect(typablePane(rec, { ...ok, isAncestor: () => false })).toBeUndefined();
  });
});

describe("isAncestor", () => {
  const parents: Record<number, number> = { 4000: 3950, 3950: 3900, 3900: 1 };
  const parentOf = (p: number): number | undefined => parents[p];

  it("finds the pane's process among Claude's ancestors, or Claude itself", () => {
    expect(isAncestor(3900, 4000, parentOf)).toBe(true);
    expect(isAncestor(4000, 4000, parentOf)).toBe(true);
  });

  it("rejects an unrelated process", () => {
    expect(isAncestor(1234, 4000, parentOf)).toBe(false);
  });
});

describe("paneIdOf", () => {
  it("takes the pane id from Claude Code's tmux field", () => {
    expect(paneIdOf("wc-wechat-claude-mwn7u6yf:@0.%0")).toBe("%0");
    expect(paneIdOf("my session:@2.%15")).toBe("%15");
  });

  it("returns undefined when there is no pane id", () => {
    expect(paneIdOf("main:0.1")).toBeUndefined();
    expect(paneIdOf("%1; rm -rf ~")).toBeUndefined();
  });
});

describe("attach requests on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-attach-"));
  const req: AttachRequest = { sessionId: "4242", claudePid: 4000, name: "api", requestedAt: 1 };

  beforeEach(() => {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  });

  it("hands a request to the Claude process it names, exactly once", () => {
    writeAttachRequest(req, dir);
    expect(hasAttachRequests(dir)).toBe(true);
    expect(takeAttachRequest(9999, dir)).toBeUndefined();
    expect(takeAttachRequest(4000, dir)).toEqual(req);
    expect(takeAttachRequest(4000, dir)).toBeUndefined();
    expect(hasAttachRequests(dir)).toBe(false);
  });

  it("is cleared when the session's watcher starts", () => {
    writeAttachRequest(req, dir);
    clearAttachRequest("4242", dir);
    expect(takeAttachRequest(4000, dir)).toBeUndefined();
  });

  it("ignores files that aren't requests", () => {
    fs.writeFileSync(path.join(dir, "junk.json"), "{not json");
    fs.writeFileSync(path.join(dir, "other.json"), JSON.stringify({ claudePid: 4000 }));
    expect(takeAttachRequest(4000, dir)).toBeUndefined();
  });

  it("reports no requests when the directory doesn't exist", () => {
    expect(hasAttachRequests(path.join(dir, "missing"))).toBe(false);
    expect(takeAttachRequest(4000, path.join(dir, "missing"))).toBeUndefined();
  });
});

describe("autoAttachEnabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-attach-cfg-"));
  const file = path.join(dir, "config.json");

  it("is on by default, including with no config file", () => {
    expect(autoAttachEnabled(path.join(dir, "missing.json"))).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ repoDirs: [] }));
    expect(autoAttachEnabled(file)).toBe(true);
  });

  it('is off with "autoAttach": false', () => {
    fs.writeFileSync(file, JSON.stringify({ autoAttach: false }));
    expect(autoAttachEnabled(file)).toBe(false);
  });
});
