/**
 * Ship-module catalog (Combat-1a — the FITTING foundation) — the source of truth
 * for the combat GEAR a player slots into a ship's loadout, the way `RESOURCES`
 * is for raw minerals, `PARTS` for production intermediates, and `UPGRADES` for
 * ship capabilities.
 *
 * A module is a MANUFACTURED good: a `recipe` of ship PARTS consumed from a
 * base's silo to `produce` one (mirroring upgrades→parts), a code-derived sell
 * `value` that is always strictly ABOVE its input cost (manufacturing adds
 * value), and a per-slot `stats` block. The catalog is the "shallow archetypal"
 * set from `docs/design/pillars.md` §iv: ~5 slots × a couple of modules each,
 * with legible rock-paper-scissors counters (targeting ↔ evasion, ecm ↔
 * targeting, shield ↔ burst, missiles ↔ evasion).
 *
 * This phase ships the GEAR + the fitting UX only — `stats` are DEFINED here but
 * not yet exercised. Combat-1b (the interactive phase resolver + the PvE bounty
 * board) consumes a player's fitted loadout and aggregates these `stats` into the
 * engagement; that is where `ModuleStats` finally bites.
 *
 * Pure: no IO, no `server-only`, so the resolver, the `produce`/`equip` handlers,
 * the renderer, and unit tests all share it. Recipes reference only real `PARTS`
 * ids; the value > input invariant is locked by `combat-fitting.test.ts`.
 */
import { partValue } from "./parts";

/** The module slot families — one stat archetype each (shallow model). */
export type ModuleSlot = "weapon" | "shield" | "evasion" | "ecm" | "targeting";

/** Weapon firing profiles (the RPS axis for Combat-1b). */
export type WeaponProfile = "burst" | "sustained" | "missile";

/**
 * Per-slot combat stat block, sufficient for Combat-1b's RPS resolver (defined
 * now, consumed later). A discriminated union keyed by the slot family; every
 * numeric stat is POSITIVE.
 */
export type ModuleStats =
  | { slot: "weapon"; damage: number; profile: WeaponProfile }
  | { slot: "shield"; absorb: number }
  | { slot: "evasion"; evade: number }
  | { slot: "ecm"; jam: number }
  | { slot: "targeting"; lock: number };

export interface ShipModule {
  /** Stable id (the `produce`/`equip` argument + the `player_modules` row key). */
  id: string;
  /** Display name. */
  name: string;
  /** Which slot family this module belongs to. */
  slot: ModuleSlot;
  /** Production recipe — PART ids (consumed from a base silo) → qty. */
  recipe: Record<string, number>;
  /** Fixed sell value in credits (code-derived; > input cost). */
  value: number;
  /** Combat stats — consumed by Combat-1b's resolver (unused this phase). */
  stats: ModuleStats;
}

/**
 * How much manufacturing marks a module up over its part inputs ("comfortably
 * above"). `value = round(moduleInputValue × this)`, so the value-adds invariant
 * (`moduleValue > moduleInputValue`) holds for every module — same discipline as
 * `PART_VALUE_MARKUP` / `SMELT_VALUE_MARKUP`.
 */
export const MODULE_VALUE_MARKUP = 1.4;

/** Σ qty × per-part value for a recipe (parts are the only inputs). */
function inputValue(recipe: Record<string, number>): number {
  let total = 0;
  for (const [partId, qty] of Object.entries(recipe)) {
    total += partValue(partId) * qty;
  }
  return total;
}

/** Build a module whose `value` is its input value marked up by the markup. */
function mod(
  id: string,
  name: string,
  recipe: Record<string, number>,
  stats: ModuleStats,
): ShipModule {
  return { id, name, slot: stats.slot, recipe, value: Math.round(inputValue(recipe) * MODULE_VALUE_MARKUP), stats };
}

/**
 * The shallow archetypal module set — ~5 slots × a couple of modules, with the
 * design doc's legible counters. Weapons span the three firing profiles
 * (burst/sustained/missile); defense covers shield + evasion; support covers
 * ecm + targeting. Recipes consume real `PARTS`; each `value` is derived (input
 * value × markup), so manufacturing always adds value (unit-tested).
 */
export const MODULES: readonly ShipModule[] = [
  // Weapons — the three firing profiles.
  mod("railgun", "Railgun", { alloy_beam: 2, circuit_board: 1 }, { slot: "weapon", damage: 14, profile: "burst" }),
  mod("autocannon", "Autocannon", { alloy_beam: 1, hull_plating: 2 }, { slot: "weapon", damage: 9, profile: "sustained" }),
  mod("missile_rack", "Missile Rack", { hull_plating: 1, circuit_board: 2 }, { slot: "weapon", damage: 18, profile: "missile" }),
  // Defense — shield (counters burst) + evasion (counters missiles).
  mod("ablative_plating", "Ablative Plating", { hull_plating: 3 }, { slot: "shield", absorb: 12 }),
  mod("evasion_thrusters", "Evasion Thrusters", { alloy_beam: 1, circuit_board: 1 }, { slot: "evasion", evade: 10 }),
  // Support — ecm (counters targeting) + targeting (counters evasion).
  mod("ecm_suite", "ECM Suite", { circuit_board: 2, sensor_array: 1 }, { slot: "ecm", jam: 8 }),
  mod("targeting_array", "Targeting Array", { sensor_array: 2, circuit_board: 1 }, { slot: "targeting", lock: 8 }),
] as const;

/** Valid module ids. */
export const MODULE_IDS: readonly string[] = MODULES.map((m) => m.id);

const BY_ID: ReadonlyMap<string, ShipModule> = new Map(MODULES.map((m) => [m.id, m]));

/** Whether `id` is a known ship-module id. */
export function isModuleId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Look up a module by id. Throws on unknown ids (mirrors `getPart`/`getUpgrade`)
 * so a typo surfaces loudly rather than producing `undefined`.
 */
export function getModule(id: string): ShipModule {
  const m = BY_ID.get(id);
  if (!m) throw new Error(`unknown module id: ${id}`);
  return m;
}

/** The part recipe (partId -> qty) for a module. Throws on unknown id. */
export function moduleRecipeOf(id: string): Record<string, number> {
  return getModule(id).recipe;
}

/** A module's fixed sell value. Throws on unknown id. */
export function moduleValue(id: string): number {
  return getModule(id).value;
}

/**
 * Summed value of a module's recipe inputs (Σ qty × `partValue`): the floor under
 * the module's `value` (manufacturing must add value, so every module's `value`
 * is strictly greater — asserted in tests). Throws on an unknown module id or a
 * recipe referencing an unknown part.
 */
export function moduleInputValue(id: string): number {
  return inputValue(moduleRecipeOf(id));
}

// ---------------------------------------------------------------------------
// Pure fitting rules — the loadout math. No IO; the handlers supply owned-counts
// and ship slot counts from authoritative state, and these decide/transform the
// loadout. A loadout is an ordered `string[]` of fitted module ids (length ≤ ship
// slots; an id may repeat if you own + fit duplicates).
// ---------------------------------------------------------------------------

/**
 * Whether `moduleId` can be fitted right now: there must be a FREE SLOT
 * (`loadout.length < shipSlots`) AND an UNFITTED OWNED COPY (you own more copies
 * than are already in the loadout). Pure.
 */
export function canEquip(
  loadout: readonly string[],
  ownedQty: number,
  moduleId: string,
  shipSlots: number,
): boolean {
  if (loadout.length >= shipSlots) return false;
  const fitted = loadout.filter((id) => id === moduleId).length;
  return fitted < ownedQty;
}

/** Equip: append the module to the loadout. Pure (no validation — caller gates). */
export function loadoutAfterEquip(loadout: readonly string[], moduleId: string): string[] {
  return [...loadout, moduleId];
}

/**
 * Unequip: remove the FIRST occurrence of `moduleId` from the loadout (no-op if
 * absent). Pure.
 */
export function loadoutAfterUnequip(loadout: readonly string[], moduleId: string): string[] {
  const i = loadout.indexOf(moduleId);
  if (i < 0) return [...loadout];
  return [...loadout.slice(0, i), ...loadout.slice(i + 1)];
}

/**
 * Trim a loadout to a new ship's slot count: `loadout.slice(0, max(0, newSlots))`.
 * Used on a ship change to a smaller hull — the extra modules become UNFITTED but
 * stay OWNED in `player_modules`. Pure.
 */
export function trimLoadout(loadout: readonly string[], newSlots: number): string[] {
  return loadout.slice(0, Math.max(0, newSlots));
}
