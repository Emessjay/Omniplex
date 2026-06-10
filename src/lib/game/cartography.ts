/**
 * Cartography rank ladder (Keystone 3b) — the EXPLORER's progression identity,
 * mirroring the faction reputation ranks (`factions.ts` `RANKS`/`rankFor`) that
 * give traders a ladder.
 *
 * Each FIRST-discovery of a planet raises a player's stored `players.charted`
 * count (incremented exactly once per planet inside the same gate that pays the
 * `DISCOVERY_BOUNTY` — see `world.recordDiscovery` / `commands.ts`). That count
 * maps PURELY here to a cartography rank/title, shown in the `cartography`
 * command, the first-discovery scan message, and the public leaderboard / `who`.
 *
 * This module is PURE — no IO, no `Date`, no `Math.random`. The ladder is the
 * code source of truth (like the faction `RANKS` and the resource/part/ship
 * catalogs); thresholds + titles are tunable. (3c — orbital derelicts + scaling
 * discovery payouts — builds on this.)
 */

/** A cartography rank: an ordered title earned at a worlds-charted threshold. */
export interface CartoRank {
  /** 0-based ladder position; `CARTO_RANKS[i].tier === i`. */
  tier: number;
  /** Flavor title shown to the player. */
  title: string;
  /** The minimum worlds charted to hold this rank (the ladder's lower bound). */
  minCharted: number;
}

/**
 * The cartography ladder — six tiers from a fresh pilot to a master mapper.
 * Ordered ascending by `minCharted` (and by `tier`, which equals the array
 * index). Tier 0 starts at 0 charted so every player has a rank. Thresholds +
 * titles are tunable; the structural contract (ascending, `tier === index`,
 * tier 0 at 0) is what `cartography.test.ts` locks.
 */
export const CARTO_RANKS: readonly CartoRank[] = [
  { tier: 0, title: "Greenhorn", minCharted: 0 },
  { tier: 1, title: "Wayfarer", minCharted: 3 },
  { tier: 2, title: "Pathfinder", minCharted: 10 },
  { tier: 3, title: "Trailblazer", minCharted: 30 },
  { tier: 4, title: "Voyager", minCharted: 80 },
  { tier: 5, title: "Cartographer", minCharted: 200 },
] as const;

/** The highest cartography tier on the ladder. */
export const MAX_CARTO_TIER: number = CARTO_RANKS[CARTO_RANKS.length - 1]!.tier;

/**
 * The cartography rank a player holds at `charted` worlds: the highest rank whose
 * `minCharted ≤ charted`. Clamps to tier 0 below the first threshold (incl.
 * negative inputs, which never occur — `players.charted` is `≥ 0`) and to the top
 * rank above the final threshold. Monotonic non-decreasing in `charted`.
 */
export function cartographyRank(charted: number): CartoRank {
  let rank = CARTO_RANKS[0]!;
  for (const r of CARTO_RANKS) {
    if (charted >= r.minCharted) rank = r;
    else break;
  }
  return rank;
}

/**
 * Worlds the player must chart to reach the NEXT tier (the lowest `minCharted`
 * strictly above `charted`), or `null` when already at the top rank. Handy for
 * the `cartography` display ("3 worlds to Pathfinder"). Pure.
 */
export function nextCartoThreshold(charted: number): number | null {
  for (const r of CARTO_RANKS) {
    if (r.minCharted > charted) return r.minCharted;
  }
  return null;
}
