/**
 * Factions catalog + the DEMAND side of the economy (Keystone 1a).
 *
 * NPC **factions** are anchored at trade hubs (settlement regions + orbital
 * outposts) and post rotating **contracts** for goods. Fulfilling a contract
 * from your hold pays a credit PREMIUM over dumping on the market, plus faction
 * **reputation** — the keystone that gives exploration/production/capitalism a
 * purpose beyond "sell for credits". This module is PURE & deterministic
 * (mirrors the procedural universe): the catalog, hub→faction alignment, and
 * contract generation are all functions of their inputs — nothing stored except
 * a player's COMPLETION (see `completed_contracts` / `player_reputation` in the
 * factions-core migration + `world.ts`).
 *
 * Like `RESOURCES`/`MATERIALS`/`PARTS`, the catalog is the code source of truth.
 * `demand` ids are real player-CARRIABLE goods — resource ids (`RESOURCES`),
 * material ids (`MATERIALS`, incl. crops/food/animal products), or ship-part ids
 * (`PARTS`) — so a contract can always be fulfilled from a player's hold. Silo-
 * only ingots and capability upgrades are deliberately EXCLUDED (you don't carry
 * those in a deliverable store).
 *
 * Keystone 1b adds reputation RANKS / gated access; 1c adds faction politics.
 * This phase is the core loop only: factions exist, hubs are aligned, you
 * deliver what they demand, your standing rises.
 */
import { makeRng, pick, randInt } from "@/lib/universe/prng";
import { getResource, RESOURCES } from "@/lib/universe";
import { isMaterialId, materialValue } from "./materials";
import { isPartId, partValue } from "./parts";

export interface Faction {
  id: string;
  name: string;
  blurb: string;
  /** Item ids this faction demands (real resource / material / part ids). */
  demand: readonly string[];
}

/**
 * The faction catalog — four powers with distinct demand themes:
 *   - Iron Vanguard (militarist): metals + ship parts.
 *   - Verdant Compact (agrarian): food, crops, animal products.
 *   - Arcanum Collegium (scientific): rare minerals + precursor relics.
 *   - Free Traders' League (mercantile): a broad, mixed basket.
 * Every `demand` id is a real carriable good (resource/material/part); no silo-
 * only ingots or capability upgrades. (Invariant unit-tested in
 * `factions-core.test.ts`.)
 */
export const FACTIONS: readonly Faction[] = [
  {
    id: "iron_vanguard",
    name: "Iron Vanguard",
    blurb: "A militarist order forever rearming — they want metal and ship parts.",
    demand: ["iron", "titanium", "iridium", "hull_plating", "alloy_beam"],
  },
  {
    id: "verdant_compact",
    name: "Verdant Compact",
    blurb: "Agrarian settlers who feed the frontier — crops, livestock, and rations.",
    demand: ["verdant_fruit", "jungle_tuber", "sunmelon", "poultry_meat", "tender_loin", "spore_broth"],
  },
  {
    id: "arcanum_collegium",
    name: "Arcanum Collegium",
    blurb: "Scholars chasing the rare and the ancient — exotic minerals and relics.",
    demand: ["xenon", "voidstone", "prismatic_gem", "precursor_relic", "void_idol", "meteoric_dust"],
  },
  {
    id: "free_traders_league",
    name: "Free Traders' League",
    blurb: "Merchant princes who deal in everything — a broad, mixed basket of goods.",
    demand: ["copper", "cobalt", "silica", "geode_cluster", "circuit_board", "scaled_hide"],
  },
] as const;

/** Valid faction ids. */
export const FACTION_IDS: readonly string[] = FACTIONS.map((f) => f.id);

const BY_ID: ReadonlyMap<string, Faction> = new Map(FACTIONS.map((f) => [f.id, f]));

/** Whether `id` is a known faction id. */
export function isFactionId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Look up a faction by id. Throws on unknown ids (mirrors `getResource` /
 * `getPart`) so a typo surfaces loudly rather than producing `undefined`.
 */
export function getFaction(id: string): Faction {
  const f = BY_ID.get(id);
  if (!f) throw new Error(`unknown faction id: ${id}`);
  return f;
}

/**
 * The unit market value of a demandable good (the floor a contract's reward must
 * beat): a resource's `baseValue`, a part's `partValue`, or a material's
 * `materialValue`. Throws on an unknown id (the catalog guards against this).
 */
function unitValue(id: string): number {
  if (RESOURCES.some((r) => r.id === id)) return getResource(id).baseValue;
  if (isPartId(id)) return partValue(id);
  if (isMaterialId(id)) return materialValue(id);
  throw new Error(`faction demand references unknown good: ${id}`);
}

// ---------------------------------------------------------------------------
// Hub → faction alignment. Every trade hub (a settlement region or an orbital
// outpost, keyed by its location key) belongs to exactly one faction, derived
// deterministically from the key. Pure: same hub ⇒ same faction always.
// ---------------------------------------------------------------------------

/**
 * The faction that controls the trade hub at `locationKey` (a 6-segment region
 * key — region ≥ 0 for a settlement, the `-1` sentinel for an orbital outpost).
 * Deterministic: a uniform pick over `FACTION_IDS` keyed by the hub, so the same
 * hub is always aligned to the same faction. Returns a real faction id.
 */
export function factionAt(seed: string, locationKey: string): string {
  return pick(makeRng(seed, "faction", locationKey), FACTION_IDS);
}

// ---------------------------------------------------------------------------
// Contracts. Procedurally generated per (hub, time-bucket) — deterministic like
// the universe — and ROTATE over time. Only a player's COMPLETION persists.
// ---------------------------------------------------------------------------

export interface Contract {
  /** Deterministic id incl. the time bucket — stable within a bucket, distinct across buckets. */
  key: string;
  factionId: string;
  want: { itemId: string; qty: number };
  rewardCredits: number;
  rewardRep: number;
}

/**
 * Contract rotation period: the time-bucket size. `timeBucket = floor(nowMs /
 * CONTRACT_ROTATION_MS)` (computed in the handler from `Date.now()`; the
 * generator takes the bucket as a param so it stays pure). A hub's contract
 * board fully refreshes every bucket — three hours here.
 */
export const CONTRACT_ROTATION_MS = 3 * 60 * 60 * 1000;

/**
 * How much a contract pays over dumping the goods on the open market — the whole
 * incentive. `rewardCredits = round(itemUnitValue × qty × this)`, so a contract
 * always beats the market (invariant unit-tested). > 1 by construction.
 */
export const CONTRACT_REWARD_MARKUP = 1.5;

/** Min / max contracts a hub posts per time bucket (a small, bounded board). */
const CONTRACTS_MIN = 3;
const CONTRACTS_MAX = 5;

/** Min / max units a single contract asks for. */
const QTY_MIN = 5;
const QTY_MAX = 25;

/**
 * The contracts on offer at `locationKey`'s faction board for `timeBucket`.
 * PURE & deterministic: a bounded set (`CONTRACTS_MIN..CONTRACTS_MAX`) keyed by
 * `(hub, bucket)`, each wanting an item drawn from the hub faction's `demand`
 * with `qty > 0`. Reward is a strict PREMIUM over market value; rep scales
 * modestly with the contract size. `key` is `<locationKey>|<bucket>|<slot>` —
 * stable within a bucket and naturally distinct across buckets (so a board fully
 * rotates each bucket). No `Date` / `Math.random` — the bucket is passed in.
 */
export function contractsAt(
  seed: string,
  locationKey: string,
  factionId: string,
  timeBucket: number,
): Contract[] {
  const faction = getFaction(factionId);
  const rng = makeRng(seed, "contract", locationKey, timeBucket);
  const count = randInt(rng, CONTRACTS_MIN, CONTRACTS_MAX);
  const contracts: Contract[] = [];
  for (let slot = 0; slot < count; slot++) {
    const itemId = pick(rng, faction.demand);
    const qty = randInt(rng, QTY_MIN, QTY_MAX);
    const market = unitValue(itemId) * qty;
    const rewardCredits = Math.round(market * CONTRACT_REWARD_MARKUP);
    // Modest, size-scaled reputation; always ≥ 1 so every contract is worth doing.
    const rewardRep = Math.max(1, Math.round(rewardCredits / 200));
    contracts.push({
      key: `${locationKey}|${timeBucket}|${slot}`,
      factionId,
      want: { itemId, qty },
      rewardCredits,
      rewardRep,
    });
  }
  return contracts;
}
