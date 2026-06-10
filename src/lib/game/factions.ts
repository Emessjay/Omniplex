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
  /**
   * The faction id this one is OPPOSED to (Keystone 1c). A SYMMETRIC pairing
   * (`X.rival === Y ⟺ Y.rival === X`), never itself — gaining rep with one
   * costs you rep with its rival, so you can't befriend everyone.
   */
  rival: string;
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
 *
 * RIVALRIES (Keystone 1c) pair the four into two opposed camps — force vs.
 * knowledge (Iron Vanguard ↔ Arcanum Collegium) and self-sufficiency vs. open
 * trade (Verdant Compact ↔ Free Traders' League). Each `rival` points at the
 * other half of its pair; symmetry + totality are unit-tested.
 */
export const FACTIONS: readonly Faction[] = [
  {
    id: "iron_vanguard",
    name: "Iron Vanguard",
    blurb: "A militarist order forever rearming — they want metal and ship parts.",
    demand: ["iron", "titanium", "iridium", "hull_plating", "alloy_beam"],
    rival: "arcanum_collegium",
  },
  {
    id: "verdant_compact",
    name: "Verdant Compact",
    blurb: "Agrarian settlers who feed the frontier — crops, livestock, and rations.",
    demand: ["verdant_fruit", "jungle_tuber", "sunmelon", "poultry_meat", "tender_loin", "spore_broth"],
    rival: "free_traders_league",
  },
  {
    id: "arcanum_collegium",
    name: "Arcanum Collegium",
    blurb: "Scholars chasing the rare and the ancient — exotic minerals and relics.",
    demand: ["xenon", "voidstone", "prismatic_gem", "precursor_relic", "void_idol", "meteoric_dust"],
    rival: "iron_vanguard",
  },
  {
    id: "free_traders_league",
    name: "Free Traders' League",
    blurb: "Merchant princes who deal in everything — a broad, mixed basket of goods.",
    demand: ["copper", "cobalt", "silica", "geode_cluster", "circuit_board", "scaled_hide"],
    rival: "verdant_compact",
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
 * The faction `id` is opposed to (Keystone 1c). Symmetric + total: every faction
 * has exactly one rival, never itself. Throws on an unknown id (via `getFaction`).
 */
export function rivalOf(id: string): string {
  return getFaction(id).rival;
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
// Reputation RANKS (Keystone 1b). A player's standing with a faction maps to a
// rank/title via a pure function of their stored `player_reputation.rep` — NO
// stored rank column. Rank gates contract tiers (see `contractsAt`) and is shown
// in `standing`/`contracts`. The ladder is the code source of truth, like the
// faction catalog itself.
// ---------------------------------------------------------------------------

/** A reputation rank: an ordered title earned at a reputation threshold. */
export interface Rank {
  /** 0-based ladder position; `RANKS[i].tier === i`. */
  tier: number;
  /** Flavor title shown to the player. */
  title: string;
  /** The minimum reputation to hold this rank (the ladder's lower bound). */
  minRep: number;
}

/**
 * The reputation ladder — six tiers from newcomer to top standing. Ordered
 * ascending by `minRep` (and by `tier`, which equals the array index). Tier 0
 * starts at rep 0 so every player has a rank. Thresholds + titles are tunable;
 * the only contracts that matter are the structural ones (ascending, tier ===
 * index, tier 0 at rep 0), which `faction-ranks.test.ts` locks.
 */
export const RANKS: readonly Rank[] = [
  { tier: 0, title: "Unknown", minRep: 0 },
  { tier: 1, title: "Associate", minRep: 100 },
  { tier: 2, title: "Contractor", minRep: 300 },
  { tier: 3, title: "Partner", minRep: 700 },
  { tier: 4, title: "Trusted", minRep: 1500 },
  { tier: 5, title: "Champion", minRep: 3000 },
] as const;

/** The highest rank tier on the ladder. */
export const MAX_RANK_TIER: number = RANKS[RANKS.length - 1]!.tier;

/**
 * The rank a player holds at `rep`: the highest rank whose `minRep ≤ rep`.
 * Clamps to tier 0 below the first threshold (incl. negative rep, which never
 * occurs — `player_reputation.rep` is `≥ 0`). Monotonic non-decreasing in rep.
 */
export function rankFor(rep: number): Rank {
  let rank = RANKS[0]!;
  for (const r of RANKS) {
    if (rep >= r.minRep) rank = r;
    else break;
  }
  return rank;
}

// ---------------------------------------------------------------------------
// Faction politics (Keystone 1c). Two pure trade-offs make standing a STRATEGIC
// choice rather than something you max with everyone:
//   1. RIVAL_REP_PENALTY — gaining rep with a faction costs you rep with its
//      rival (`rivalOf`), so you can't befriend both halves of a pair.
//   2. REP_PRICE_DISCOUNT — high standing with a faction earns a trade discount
//      at that faction's hubs (the tangible rank payoff deferred from 1b).
// Both are pure functions of their inputs (no IO/`Date`/`Math.random`).
// ---------------------------------------------------------------------------

/**
 * The fraction of reputation GAINED with a faction that is SUBTRACTED from its
 * rival when you fulfil a contract. ~0.5 — a real bite (you lose half as much as
 * you gain with the rival) without zeroing the rival on a single delivery.
 */
export const RIVAL_REP_PENALTY_FRACTION = 0.5;

/**
 * Reputation lost with a faction's rival for gaining `gainedRep` with it:
 * `floor(gainedRep × RIVAL_REP_PENALTY_FRACTION)`. Non-negative, ≤ `gainedRep`
 * (the fraction is in `(0, 1]`), and monotonic non-decreasing in `gainedRep`.
 * The store clamps the rival's rep at ≥ 0, so this never drives it negative.
 */
export function rivalRepPenalty(gainedRep: number): number {
  return Math.floor(Math.max(0, gainedRep) * RIVAL_REP_PENALTY_FRACTION);
}

/** The discount a higher rank adds per tier, and the ceiling it can reach. */
export const RANK_DISCOUNT_PER_TIER = 0.03;
export const RANK_DISCOUNT_CAP = 0.15;

/**
 * The trade discount (a fraction in `[0, RANK_DISCOUNT_CAP]`) you get at a hub of
 * a faction you hold `rankTier` standing with: `min(cap, rankTier × perTier)`.
 * 0 at tier 0 (and below), monotonic non-decreasing, and strictly below 1 — so a
 * discounted price is never free or negative. At `MAX_RANK_TIER` (5) with the
 * defaults this is the full 0.15 cap; tier 0 gets nothing (the perk is real).
 */
export function repPriceDiscount(rankTier: number): number {
  return Math.min(RANK_DISCOUNT_CAP, Math.max(0, rankTier) * RANK_DISCOUNT_PER_TIER);
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

/** Min / max units a single contract asks for at rank 0 (the starter tier). */
const QTY_MIN = 5;
const QTY_MAX = 25;

/**
 * Each rank tier adds this many multiples of a contract's base size — so rank 0
 * sees the modest starter board (×1) and rank `MAX_RANK_TIER` sees contracts
 * `1 + MAX_RANK_TIER × this` times larger (and proportionally more lucrative).
 * An integer step keeps quantities whole and makes rewards strictly
 * non-decreasing in rank (the monotonic-in-rank invariant).
 */
export const RANK_QTY_PER_TIER = 1;

/**
 * The base→tier size multiplier for a rank. Non-decreasing in `rankTier`, `1` at
 * rank 0 (and below). Higher rank ⇒ bigger contracts ⇒ bigger credit/rep reward.
 */
function rankSizeScale(rankTier: number): number {
  return 1 + Math.max(0, rankTier) * RANK_QTY_PER_TIER;
}

/**
 * The contracts on offer at `locationKey`'s faction board for `timeBucket`, sized
 * to the player's `rankTier` with the hub faction. PURE & deterministic: a
 * bounded set (`CONTRACTS_MIN..CONTRACTS_MAX`) keyed by `(hub, bucket)`, each
 * wanting an item drawn from the hub faction's `demand` with `qty > 0`. Reward is
 * a strict PREMIUM over market value; rep scales with the contract size.
 *
 * RANK-GATING: the RNG stream depends only on `(seed, hub, bucket)` — NOT on
 * rank — so the item mix + slot count are stable across ranks, and rank applies
 * a deterministic size multiplier (`rankSizeScale`) on top. Because that
 * multiplier is non-decreasing in rank and rewards scale with size, a higher
 * rank's board is always at least as lucrative (monotonic-in-rank). The premium
 * holds at every rank (×1.5 over a larger market value is still > market), and
 * `key` (`<locationKey>|<bucket>|<slot>`, rank-independent) keeps a contract's
 * identity stable within a bucket and distinct across buckets.
 * No `Date` / `Math.random` — bucket and rank are passed in.
 */
export function contractsAt(
  seed: string,
  locationKey: string,
  factionId: string,
  timeBucket: number,
  rankTier: number,
): Contract[] {
  const faction = getFaction(factionId);
  const rng = makeRng(seed, "contract", locationKey, timeBucket);
  const count = randInt(rng, CONTRACTS_MIN, CONTRACTS_MAX);
  const sizeScale = rankSizeScale(rankTier);
  const contracts: Contract[] = [];
  for (let slot = 0; slot < count; slot++) {
    const itemId = pick(rng, faction.demand);
    const qty = randInt(rng, QTY_MIN, QTY_MAX) * sizeScale;
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
