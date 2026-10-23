import { describe, it, expect } from "vitest";
import { sessionTitleFor } from "../rename-hook.js";

describe("sessionTitleFor", () => {
  it("takes the name from /wechat <name>", () => {
    expect(sessionTitleFor("/wechat integration")).toBe("integration");
    expect(sessionTitleFor("  /wechat  backend-api \n")).toBe("backend-api");
  });

  it("leaves a bare /wechat and other prompts alone", () => {
    expect(sessionTitleFor("/wechat")).toBeUndefined();
    expect(sessionTitleFor("/wechatx foo")).toBeUndefined();
    expect(sessionTitleFor("please run /wechat foo")).toBeUndefined();
    expect(sessionTitleFor(undefined)).toBeUndefined();
  });

  it("skips names the WeChat routing side would refuse", () => {
    // Renaming anyway would leave the two names out of step.
    expect(sessionTitleFor("/wechat 42")).toBeUndefined();
    expect(sessionTitleFor("/wechat two words")).toBeUndefined();
  });
});
