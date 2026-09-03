import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  claudeNameForMcpPid,
  claudeRecordsForSessions,
  ownClaudeSessionName,
  parentPids,
  readClaudeSession,
} from "../claude-sessions.js";

const dir = mkdtempSync(path.join(tmpdir(), "wc-claude-sessions-test-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function record(pid: number, body: unknown): void {
  writeFileSync(
    path.join(dir, `${pid}.json`),
    typeof body === "string" ? body : JSON.stringify(body)
  );
}

describe("readClaudeSession", () => {
  it("reads the name Claude Code recorded for a pid", () => {
    record(100, {
      pid: 100,
      sessionId: "s-100",
      cwd: "/repo",
      name: "repo-a9",
      nameSource: "derived",
    });
    expect(readClaudeSession(100, dir)).toEqual({
      pid: 100,
      name: "repo-a9",
      sessionId: "s-100",
      cwd: "/repo",
    });
  });

  it("returns undefined when there is no record", () => {
    expect(readClaudeSession(101, dir)).toBeUndefined();
  });

  it("returns undefined for corrupt or nameless records", () => {
    record(102, "{not json");
    record(103, { pid: 103 });
    record(104, { pid: 104, name: "   " });
    expect(readClaudeSession(102, dir)).toBeUndefined();
    expect(readClaudeSession(103, dir)).toBeUndefined();
    expect(readClaudeSession(104, dir)).toBeUndefined();
  });

  it("rejects a record whose pid field disagrees with the file name", () => {
    record(105, { pid: 999, name: "someone-else" });
    expect(readClaudeSession(105, dir)).toBeUndefined();
  });
});

describe("parentPids", () => {
  it("reports our own parent, and omits pids that have exited", () => {
    // A child that has already exited: a real, in-range, dead pid.
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    expect(dead).toBeGreaterThan(0);
    const parents = parentPids([process.pid, dead]);
    expect(parents.get(process.pid)).toBe(process.ppid);
    expect(parents.has(dead)).toBe(false);
  });

  it("returns an empty map for no or invalid pids", () => {
    expect(parentPids([]).size).toBe(0);
    expect(parentPids([-1, 0, 1.5, 999_999_999]).size).toBe(0);
  });
});

describe("claudeRecordsForSessions", () => {
  it("maps each WeChat session to its Claude record through the parent pid", () => {
    record(400, { pid: 400, name: "repo-11", cwd: "/repo/.claude/worktrees/feat" });
    record(401, { pid: 401, name: "repo-22", cwd: "/repo" });
    const sessions = [
      { id: "s1", pid: 4000 },
      { id: "s2", pid: 4001 },
      { id: "s3", pid: 4002 }, // parent unknown
    ];
    const parents = new Map([
      [4000, 400],
      [4001, 401],
    ]);
    const out = claudeRecordsForSessions(sessions, dir, parents);
    expect(out.get("s1")?.name).toBe("repo-11");
    expect(out.get("s1")?.cwd).toBe("/repo/.claude/worktrees/feat");
    expect(out.get("s2")?.name).toBe("repo-22");
    expect(out.has("s3")).toBe(false);
  });
});

describe("claudeNameForMcpPid", () => {
  it("follows the MCP pid to its parent's Claude record", () => {
    record(300, { pid: 300, name: "parent-name-1" });
    const parents = new Map([[301, 300]]);
    expect(claudeNameForMcpPid(301, parents, dir)).toBe("parent-name-1");
  });

  it("is undefined when the parent is unknown or has no record", () => {
    expect(claudeNameForMcpPid(302, new Map(), dir)).toBeUndefined();
    expect(claudeNameForMcpPid(303, new Map([[303, 304]]), dir)).toBeUndefined();
  });
});

describe("ownClaudeSessionName", () => {
  it("returns the name when the session id matches", () => {
    record(200, { pid: 200, sessionId: "s-200", name: "mine-11" });
    expect(ownClaudeSessionName(200, "s-200", dir)).toBe("mine-11");
  });

  it("returns the name when we have no session id to check against", () => {
    record(201, { pid: 201, sessionId: "s-201", name: "mine-22" });
    expect(ownClaudeSessionName(201, undefined, dir)).toBe("mine-22");
  });

  it("refuses a stale record left by a different session on a reused pid", () => {
    record(202, { pid: 202, sessionId: "old-session", name: "stranger-33" });
    expect(ownClaudeSessionName(202, "new-session", dir)).toBeUndefined();
  });

  it("returns undefined when Claude Code left no record", () => {
    expect(ownClaudeSessionName(203, "s-203", dir)).toBeUndefined();
  });
});
