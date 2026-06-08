import { describe, it, expect } from "vitest";
import {
  DEFAULT_DEV_LOGIN_EMAIL,
  isDevLoginEnabled,
  devLoginEmail,
} from "@/lib/devAuth";

describe("isDevLoginEnabled", () => {
  it("is OFF by default (var unset)", () => {
    expect(isDevLoginEnabled({})).toBe(false);
  });

  it("is OFF for explicit falsy strings", () => {
    for (const v of ["", "0", "false", "off", "no", "  FALSE ", "Off"]) {
      expect(isDevLoginEnabled({ OMNIPLEX_DEV_LOGIN: v })).toBe(false);
    }
  });

  it("is ON for truthy strings", () => {
    for (const v of ["1", "true", "yes", "on", "enabled"]) {
      expect(isDevLoginEnabled({ OMNIPLEX_DEV_LOGIN: v })).toBe(true);
    }
  });
});

describe("devLoginEmail", () => {
  it("defaults when unset or blank", () => {
    expect(devLoginEmail({})).toBe(DEFAULT_DEV_LOGIN_EMAIL);
    expect(devLoginEmail({ OMNIPLEX_DEV_LOGIN_EMAIL: "   " })).toBe(
      DEFAULT_DEV_LOGIN_EMAIL,
    );
  });

  it("uses and trims a configured value", () => {
    expect(
      devLoginEmail({ OMNIPLEX_DEV_LOGIN_EMAIL: "  pilot@test.dev " }),
    ).toBe("pilot@test.dev");
  });
});
