import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import {
  latestTranscriptMtime,
  looksStalled,
  projectDirName,
  transcriptPath,
} from "../transcripts.js";

const root = mkdtempSync(path.join(tmpdir(), "wc-transcripts-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function writeTranscript(cwd: string, name: string, ageMs: number): void {
  const dir = path.join(root, projectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "{}\n");
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(file, when, when);
}

describe("projectDirName", () => {
  it("matches Claude Code's dash-encoded project directories", () => {
    expect(projectDirName("/Users/me/repos/my-app")).toBe(
      "-Users-me-repos-my-app"
    );
    expect(projectDirName("/private/tmp")).toBe("-private-tmp");
  });
});

describe("latestTranscriptMtime", () => {
  it("is undefined when the project has no transcripts", () => {
    expect(latestTranscriptMtime("/Users/me/nothing", root)).toBeUndefined();
  });

  it("picks the newest transcript", () => {
    const cwd = "/Users/me/repos/app";
    writeTranscript(cwd, "old.jsonl", 600_000);
    writeTranscript(cwd, "new.jsonl", 5_000);
    const mtime = latestTranscriptMtime(cwd, root);
    expect(mtime).toBeDefined();
    expect(Date.now() - (mtime as number)).toBeLessThan(60_000);
  });
});

describe("looksStalled", () => {
  it("is false while the session keeps writing (busy, not blocked)", () => {
    const cwd = "/Users/me/repos/busy";
    writeTranscript(cwd, "a.jsonl", 5_000);
    expect(looksStalled({ cwd }, 60_000, Date.now(), root)).toBe(false);
  });

  it("is true when nothing has been written for a while", () => {
    const cwd = "/Users/me/repos/quiet";
    writeTranscript(cwd, "a.jsonl", 300_000);
    expect(looksStalled({ cwd }, 60_000, Date.now(), root)).toBe(true);
  });

  it("treats an unknown project as no evidence, not as stalled", () => {
    expect(looksStalled({ cwd: "/Users/me/unknown" }, 60_000, Date.now(), root)).toBe(
      false
    );
  });

  it("judges the session's own transcript, not a busy neighbour's", () => {
    const cwd = "/Users/me/repos/shared";
    writeTranscript(cwd, "mine.jsonl", 300_000);
    writeTranscript(cwd, "neighbour.jsonl", 1_000);
    const session = { cwd, transcript: transcriptPath(cwd, "mine", root) };
    expect(looksStalled(session, 60_000, Date.now(), root)).toBe(true);
  });

  it("is not fooled into a stall by a neighbour's old transcript", () => {
    const cwd = "/Users/me/repos/shared2";
    writeTranscript(cwd, "stale.jsonl", 900_000);
    writeTranscript(cwd, "mine.jsonl", 1_000);
    const session = { cwd, transcript: transcriptPath(cwd, "mine", root) };
    expect(looksStalled(session, 60_000, Date.now(), root)).toBe(false);
  });

  it("falls back to the directory when the recorded transcript is gone", () => {
    const cwd = "/Users/me/repos/moved";
    writeTranscript(cwd, "current.jsonl", 300_000);
    const session = { cwd, transcript: transcriptPath(cwd, "deleted", root) };
    expect(looksStalled(session, 60_000, Date.now(), root)).toBe(true);
  });
});
