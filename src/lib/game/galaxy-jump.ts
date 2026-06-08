/**
 * Galaxy jump (P3) — the capstone of the exploration track.
 *
 * Galaxies are infinite outward, and the ONLY way to change the one you're in
 * is to consume a **Hyperwarp Condensate**: a craftable consumable (a
 * `consumable`-category material in `materials.ts`, stored in `player_materials`
 * like food) whose recipe demands a *significant* amount of voidstone — a
 * rarity-5, savage-world-only mineral. So inter-galaxy travel sits behind deep
 * exploration.
 *
 * This module is PURE (no IO, no `Date`, no `Math.random`): just the recipe
 * constant and the jump-gating predicate. The condensate is mined/crafted via
 * `commands.ts` (`craft hyperwarp_condensate`, consuming voidstone from cargo)
 * and spent by `hyperwarp <galaxy>`. The voidstone cost is checked with the
 * shared `canCraft` (which `commands.ts` runs against the player's cargo).
 */

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

/** Why a galaxy jump was refused. */
export type HyperwarpDenial = "no-condensate" | "same-galaxy";

/**
 * Whether the player can make the inter-galaxy jump RIGHT NOW: they must own at
 * least one Hyperwarp Condensate AND be targeting a galaxy different from their
 * current one. Pure — the handler reads the live condensate count + galaxy and
 * passes them in; on success it consumes one condensate and relocates. The
 * condensate check comes first so an empty-handed player is told to craft one
 * (the more actionable message) even when they also typed their current galaxy.
 */
export function canHyperwarp(
  condensateOwned: number,
  fromGalaxy: number,
  toGalaxy: number,
): { ok: true } | { ok: false; reason: HyperwarpDenial } {
  if (condensateOwned < 1) return { ok: false, reason: "no-condensate" };
  if (toGalaxy === fromGalaxy) return { ok: false, reason: "same-galaxy" };
  return { ok: true };
}
