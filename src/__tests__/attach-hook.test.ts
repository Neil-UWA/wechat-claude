import { describe, it, expect } from "vitest";
import { attachInstruction, hookOutput, shouldAct } from "../attach-hook.js";

describe("shouldAct", () => {
  it("acts on a tool call or a turn end in a known session", () => {
    expect(shouldAct({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash" })).toBe(true);
    expect(shouldAct({ hook_event_name: "Stop", session_id: "s", stop_hook_active: false })).toBe(true);
  });

  it("stays out of a session already using the WeChat tools", () => {
    expect(
      shouldAct({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "mcp__wechat__wechat_status" })
    ).toBe(false);
  });

  it("never blocks a stop that is already the continuation of a blocked one", () => {
    expect(shouldAct({ hook_event_name: "Stop", session_id: "s", stop_hook_active: true })).toBe(false);
  });

  it("ignores other events and input without a session id", () => {
    expect(shouldAct({ hook_event_name: "UserPromptSubmit", session_id: "s" })).toBe(false);
    expect(shouldAct({ hook_event_name: "PostToolUse" })).toBe(false);
  });
});

describe("hookOutput", () => {
  it("adds the instruction to the tool result on PostToolUse", () => {
    const out = JSON.parse(hookOutput("PostToolUse", "api") ?? "{}");
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: attachInstruction("api") },
    });
  });

  it("blocks the stop with the instruction as the reason", () => {
    const out = JSON.parse(hookOutput("Stop", "api") ?? "{}");
    expect(out).toEqual({ decision: "block", reason: attachInstruction("api") });
  });

  it("names the session and the way to attach", () => {
    const text = attachInstruction("api");
    expect(text).toContain('"api"');
    expect(text).toContain("wechat_status");
    expect(text).toContain("Monitor");
  });
});
