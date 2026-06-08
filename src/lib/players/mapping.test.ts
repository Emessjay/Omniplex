import { describe, expect, it } from "vitest";
import { rowToPlayer } from "./mapping";
import type { PlayerRow } from "./types";

describe("rowToPlayer", () => {
  const row: PlayerRow = {
    id: "11111111-1111-1111-1111-111111111111",
    user_id: "22222222-2222-2222-2222-222222222222",
    handle: "nova",
    credits: 1000,
    fuel: 100,
    cargo_cap: 50,
    galaxy: 0,
    arm: 0,
    cluster: 0,
    system: 0,
    planet: 0,
    region: 0,
    created_at: "2026-06-07T00:00:00.000Z",
  };

  it("maps every snake_case column to its camelCase field", () => {
    expect(rowToPlayer(row)).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      userId: "22222222-2222-2222-2222-222222222222",
      handle: "nova",
      credits: 1000,
      fuel: 100,
      cargoCap: 50,
      galaxy: 0,
      arm: 0,
      cluster: 0,
      system: 0,
      planet: 0,
      region: 0,
      createdAt: "2026-06-07T00:00:00.000Z",
    });
  });

  it("preserves non-default location coordinates", () => {
    const moved = rowToPlayer({
      ...row,
      galaxy: 0,
      arm: 7,
      cluster: 3,
      system: 12,
      planet: 4,
      region: 4096,
    });
    expect([
      moved.galaxy,
      moved.arm,
      moved.cluster,
      moved.system,
      moved.planet,
      moved.region,
    ]).toEqual([0, 7, 3, 12, 4, 4096]);
  });
});
