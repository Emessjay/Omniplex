/**
 * Hyperwarp — the long-haul fast-travel tier (the capstone of the exploration
 * track).
 *
 * For ONE **Hyperwarp Condensate** you jump either (1) ANYWHERE in your current
 * galaxy — any `(arm, cluster, system)`, no distance/fuel cost — or (2) to an
 * ADJACENT galaxy's rim (galaxy ±1). The condensate is a craftable consumable (a
 * `consumable`-category material in `materials.ts`, stored in `player_materials`
 * like food) whose recipe demands a *significant* amount of voidstone — a
 * rarity-5, savage/coreward mineral — so the long-haul tier sits behind deep
 * exploration. This REPLACES the old fixed-core-entry `hyperwarp <galaxy>`.
 *
 * This module is PURE (no IO, no `Date`, no `Math.random`): the recipe constant,
 * the condensate gate, and the destination validators. The condensate is crafted
 * via `commands.ts` (`craft hyperwarp_condensate`, consuming voidstone from
 * cargo) and spent by `hyperwarp` (`handleHyperwarp`). The voidstone cost is
 * checked with the shared `canCraft` (which `commands.ts` runs against cargo).
 */
import { MAX_CLUSTERS_PER_ARM, STARS_PER_CLUSTER } from "@/lib/universe";

/** The material id of the craftable galaxy-jump consumable. */
export const HYPERWARP_CONDENSATE_ID = "hyperwarp_condensate";

/**
 * Crafting recipe for one Hyperwarp Condensate: a *significant* amount of
 * voidstone (the rarest mineral). Tunable — raising the count gates galaxy
 * travel behind more savage-world mining. `voidstone` is a RESOURCE id (it lives
 * in the ship's cargo hold), so `craft` validates this against cargo with
 * `canCraft`, not against `player_materials`.
 */
export const CONDENSATE_RECIPE: Record<string, number> = { voidstone: 10 };

/** Why a hyperwarp was refused. */
export type HyperwarpDenial = "no-condensate" | "same-galaxy";

/**
 * Whether the player can hyperwarp RIGHT NOW: they must own at least one
 * Hyperwarp Condensate. Pure — the handler reads the LIVE condensate count and
 * passes it in; on success it consumes one condensate and relocates. The
 * destination itself (an in-galaxy `(arm, cluster, system)` or an adjacent
 * galaxy) is validated separately by `isValidInGalaxyTarget` /
 * `isAdjacentGalaxy`, so the only gate here is "do you have a condensate".
 *
 * The optional `fromGalaxy`/`toGalaxy` args are retained for backward
 * compatibility: when BOTH are supplied and equal, the legacy `"same-galaxy"`
 * refusal is returned. The current handler does NOT pass them — in-galaxy
 * hyperwarp (to a different system of the SAME galaxy) is now allowed — so this
 * branch is inert in normal play and exists only so older callers/tests keep
 * their meaning.
 */
export function canHyperwarp(
  condensateOwned: number,
  fromGalaxy?: number,
  toGalaxy?: number,
): { ok: true } | { ok: false; reason: HyperwarpDenial } {
  if (condensateOwned < 1) return { ok: false, reason: "no-condensate" };
  if (fromGalaxy !== undefined && toGalaxy !== undefined && fromGalaxy === toGalaxy) {
    return { ok: false, reason: "same-galaxy" };
  }
  return { ok: true };
}

/**
 * Is `(arm, cluster, system)` a valid IN-GALAXY hyperwarp destination? `cluster`
 * must be inside the finite disk `[0, MAX_CLUSTERS_PER_ARM)` and `system` a real
 * star index `[0, STARS_PER_CLUSTER)`. The arm is ALWAYS valid — the handler
 * takes it modulo the galaxy's `armCount` (a ring), so any integer wraps in.
 * Pure; no IO.
 */
export function isValidInGalaxyTarget(
  _arm: number,
  cluster: number,
  system: number,
  _armCount: number,
): boolean {
  return (
    cluster >= 0 &&
    cluster < MAX_CLUSTERS_PER_ARM &&
    system >= 0 &&
    system < STARS_PER_CLUSTER
  );
}

/**
 * Is `to` an ADJACENT galaxy of `from`? Adjacent means a non-negative galaxy
 * index exactly one step away (`|from − to| === 1`). Hyperwarp can only hop one
 * galaxy at a time (you arrive at the neighbor's rim). Pure.
 */
export function isAdjacentGalaxy(from: number, to: number): boolean {
  return to >= 0 && Math.abs(from - to) === 1;
}
