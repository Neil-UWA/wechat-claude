import { describe, it, expect } from "vitest";
import {
  HEALTHY,
  type DeliveryHealth,
  healthTransition,
  isHealthy,
} from "../health.js";

const expired: DeliveryHealth = { daemonRunning: false, loginExpired: true };
const daemonDown: DeliveryHealth = {
  daemonRunning: false,
  loginExpired: false,
};

describe("healthTransition", () => {
  it("says nothing while everything works", () => {
    expect(healthTransition(HEALTHY, HEALTHY)).toBeUndefined();
  });

  it("reports an expired login once, not on every tick", () => {
    expect(healthTransition(HEALTHY, expired)).toContain("EXPIRED");
    expect(healthTransition(expired, expired)).toBeUndefined();
  });

  it("blames the login rather than the daemon it took down with it", () => {
    const line = healthTransition(HEALTHY, expired);
    expect(line).toContain("wechat_login");
    expect(line).not.toContain("daemon.log");
  });

  it("reports a dead daemon once", () => {
    expect(healthTransition(HEALTHY, daemonDown)).toContain("daemon");
    expect(healthTransition(daemonDown, daemonDown)).toBeUndefined();
  });

  it("reports recovery so the session knows it is live again", () => {
    expect(healthTransition(expired, HEALTHY)).toContain("recovered");
  });

  it("treats a login that expired while the daemon was already down as news", () => {
    expect(healthTransition(daemonDown, expired)).toContain("EXPIRED");
  });
});

describe("isHealthy", () => {
  it("needs both a running daemon and a valid login", () => {
    expect(isHealthy(HEALTHY)).toBe(true);
    expect(isHealthy(expired)).toBe(false);
    expect(isHealthy(daemonDown)).toBe(false);
  });
});
