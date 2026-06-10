import { describe, it, expect } from "vitest";
import { buildStatusBar } from "@/lib/game/commands"; // or wherever the helper lives
import { frame, text, line } from "@/lib/terminal/helpers";
import type { RenderFrame } from "@/lib/terminal/types";

const SEED = "omniplex-prod-1";
// Minimal Player-shaped fixture (extend to match the real Player type).
const player: any = {
  id: "p1", handle: "Tester", credits: 12345,
  galaxy: 0, arm: 0, cluster: 0, system: 1, planet: 3, region: 0,
  fuel: 80, warpFuel: 60, health: 70, embarked: true, landed: false,
  cargoCap: 50, shipId: "shuttle",
};

describe("buildStatusBar", () => {
  it("captures credits, a location label, fuel/warpFuel, health, ship", () => {
    const s = buildStatusBar(player, SEED);
    expect(s.credits).toBe(12345);
    expect(typeof s.location).toBe("string");
    expect(s.location.length).toBeGreaterThan(0);
    expect(s.fuel).toBe(80);
    expect(s.warpFuel).toBe(60);
    expect(s.health).toBe(70);
    expect(s.maxHealth).toBeGreaterThan(0);
    expect(typeof s.ship).toBe("string");
    expect(s.ship.length).toBeGreaterThan(0);
  });

  it("is pure/deterministic for the same player", () => {
    expect(buildStatusBar(player, SEED)).toStrictEqual(buildStatusBar(player, SEED));
  });
});

describe("RenderFrame.status is additive", () => {
  it("a frame without status still renders (status optional)", () => {
    const f: RenderFrame = frame([line(text("hello"))]);
    expect(f.lines.length).toBe(1);
    // status is optional — undefined is fine on a plain frame
    expect((f as RenderFrame).status).toBeUndefined();
  });

  it("a frame can carry a status snapshot", () => {
    const f: RenderFrame = { ...frame([line(text("hi"))]), status: buildStatusBar(player, SEED) };
    expect(f.status?.credits).toBe(12345);
  });
});
