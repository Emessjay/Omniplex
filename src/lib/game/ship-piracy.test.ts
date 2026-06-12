import { describe, it, expect } from "vitest";
import {
  lawfulnessScore, piracyNotorietyGain, isWantedPlayer, playerBounty,
  piracyOnCooldown, PIRACY_NOTORIETY_BASE, PIRACY_COOLDOWN_MS, WANTED_TIER,
} from "@/lib/game/rules";

describe("lawfulnessScore — policed hub vs lawless frontier", () => {
  it("a hub is fully policed (~1) regardless of radiation", () => {
    expect(lawfulnessScore(0, true)).toBeGreaterThan(0.9);
    expect(lawfulnessScore(100, true)).toBeGreaterThan(0.9);
  });
  it("non-hub: lawfulness falls as radiation (coreward) rises", () => {
    const rim = lawfulnessScore(2, false);     // low radiation = rim
    const core = lawfulnessScore(95, false);   // high radiation = coreward
    expect(rim).toBeGreaterThan(core);
    expect(core).toBeLessThan(0.2);            // lawless frontier
    expect(rim).toBeGreaterThanOrEqual(0);
    expect(rim).toBeLessThanOrEqual(1);
  });
});

describe("piracyNotorietyGain — heat scales with lawfulness", () => {
  it("more heat for pirating in a policed zone than a lawless one", () => {
    const policed = piracyNotorietyGain(PIRACY_NOTORIETY_BASE, 1);
    const lawless = piracyNotorietyGain(PIRACY_NOTORIETY_BASE, 0);
    expect(policed).toBeGreaterThan(lawless);
    expect(lawless).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(policed)).toBe(true);
    // monotonic in lawfulness
    expect(piracyNotorietyGain(PIRACY_NOTORIETY_BASE, 0.5)).toBeGreaterThanOrEqual(lawless);
    expect(piracyNotorietyGain(PIRACY_NOTORIETY_BASE, 1)).toBeGreaterThanOrEqual(piracyNotorietyGain(PIRACY_NOTORIETY_BASE, 0.5));
  });
});

describe("Wanted threshold + claimable bounty", () => {
  it("isWantedPlayer is true only at/above WANTED_TIER's notoriety", () => {
    expect(isWantedPlayer(0)).toBe(false);     // clean
    // a clearly-high heat is wanted
    expect(isWantedPlayer(1_000_000)).toBe(true);
    expect(typeof WANTED_TIER).toBe("number");
  });
  it("playerBounty is 0 for a clean player and positive + rising for a wanted one", () => {
    expect(playerBounty(0)).toBe(0);
    const big = playerBounty(1_000_000);
    const small = playerBounty(1_000_000 / 2);
    expect(big).toBeGreaterThan(0);
    expect(big).toBeGreaterThanOrEqual(small);   // monotonic in heat
  });
});

describe("piracyOnCooldown — per-victim anti-camp", () => {
  it("true within the window, false after / when never pirated", () => {
    const now = 2_000_000_000;
    expect(piracyOnCooldown(now - PIRACY_COOLDOWN_MS / 2, now, PIRACY_COOLDOWN_MS)).toBe(true);
    expect(piracyOnCooldown(now - PIRACY_COOLDOWN_MS * 2, now, PIRACY_COOLDOWN_MS)).toBe(false);
    expect(piracyOnCooldown(null as any, now, PIRACY_COOLDOWN_MS)).toBe(false);
    expect(PIRACY_COOLDOWN_MS).toBeGreaterThan(0);
  });
});
