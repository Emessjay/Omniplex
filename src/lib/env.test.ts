import { describe, it, expect } from "vitest";
import {
  REQUIRED_SERVER_ENV,
  checkServerEnv,
  serverEnvErrorMessage,
  assertServerEnv,
} from "@/lib/env";

const FULL_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  WORLD_SEED: "omniplex-prod",
};

describe("checkServerEnv", () => {
  it("reports ok with no missing vars when all are present", () => {
    expect(checkServerEnv(FULL_ENV)).toEqual({ ok: true, missing: [] });
  });

  it("reports every missing var when the env is empty", () => {
    const result = checkServerEnv({});
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([...REQUIRED_SERVER_ENV]);
  });

  it("treats empty and whitespace-only values as missing", () => {
    const result = checkServerEnv({
      ...FULL_ENV,
      NEXT_PUBLIC_SUPABASE_URL: "",
      WORLD_SEED: "   ",
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "WORLD_SEED"]);
  });

  it("preserves the canonical var ordering in the missing list", () => {
    const result = checkServerEnv({
      SUPABASE_SERVICE_ROLE_KEY: "present",
    });
    expect(result.missing).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "WORLD_SEED",
    ]);
  });
});

describe("serverEnvErrorMessage", () => {
  it("names the missing vars and never leaks values", () => {
    const msg = serverEnvErrorMessage(["SUPABASE_SERVICE_ROLE_KEY"]);
    expect(msg).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(msg).toContain("DEPLOY.md");
  });
});

describe("assertServerEnv", () => {
  it("does not throw when all required vars are present", () => {
    expect(() => assertServerEnv(FULL_ENV)).not.toThrow();
  });

  it("throws naming all missing vars when some are absent", () => {
    expect(() => assertServerEnv({ WORLD_SEED: "seed" })).toThrowError(
      /NEXT_PUBLIC_SUPABASE_URL.*NEXT_PUBLIC_SUPABASE_ANON_KEY.*SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});
