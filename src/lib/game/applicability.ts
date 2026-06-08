/**
 * The SINGLE source of truth for which commands are usable in a given player
 * state — consumed by BOTH the no-arg `help` listing (`renderHelp`) and the
 * dispatch gate (`dispatchResolved`). Because help and gating read the same
 * predicate, "shown in `help`" ⇔ "usable right now" can never drift (the same
 * single-source-of-truth pattern we use for arg domains and the verb registry).
 *
 * Pure — no IO, no `server-only` — so the renderer, the dispatcher, and unit
 * tests can all share it. The state is the minimal slice that affects
 * applicability: whether the player is aboard their ship (`embarked`) and
 * whether they are in an active combat encounter (`inCombat`, i.e.
 * `player.encounter != null`).
 *
 * To add a command, put it in exactly ONE of the buckets below (or extend a
 * bucket) — that one placement decides both whether `help` offers it and
 * whether dispatch accepts it.
 */
import { VERBS } from "./usage";

/** The minimal player-state slice that decides command applicability. */
export interface PlayerStateView {
  /** Aboard the ship (true) or on foot on the surface (false). */
  embarked: boolean;
  /** In an active combat encounter (`player.encounter != null`). */
  inCombat: boolean;
  /**
   * Physically at a TRADE LOCATION — a surface region bearing a settlement, or
   * the planet's orbital outpost (P12a). The economy commands (`buy`/`sell`)
   * are usable iff this holds (regardless of embark state), superseding the old
   * "economy = embarked anywhere" rule. Travel still requires being embarked.
   */
  atTradeLocation: boolean;
}

/**
 * Informational / read-only commands — usable in EVERY state (you can always
 * inspect the world, your ship, your bases). Combat does not hide these.
 * Includes the `look`→`scan` and `base`→`storage` aliases (they follow their
 * canonical verb, which is informational).
 */
const INFORMATIONAL = new Set([
  "help",
  "scan",
  "look",
  "map",
  "inventory",
  "upgrades",
  "who",
  "bases",
  "regions",
  "storage",
  "base",
]);

/** Combat actions — applicable ONLY while in an encounter. */
const COMBAT_ONLY = new Set(["attack", "flee"]);

/**
 * Economy commands — applicable iff at a TRADE LOCATION (a settlement region or
 * the orbital outpost) and out of combat, REGARDLESS of embark state (P12a). You
 * can only `buy`/`sell` where there's actually a market to trade with; this
 * superseded the old "economy = embarked anywhere" rule. (`buy fuel`/`buy
 * warpfuel` are covered by `buy`.)
 */
const ECONOMY = new Set(["buy", "sell"]);

/**
 * Ship travel — requires being ABOARD the ship (and out of combat). `disembark`
 * lives here: you can only step off the ship while you're on it.
 */
const EMBARKED_ACTIONS = new Set([
  "warp",
  "land",
  "hyperwarp",
  "disembark",
]);

/**
 * Surface + base actions — require being ON FOOT in the region (and out of
 * combat). `embark` lives here: you can only climb aboard while you're on the
 * surface. Base operations (`produce`/`collect`/`deposit`/`withdraw`) join the
 * surface work under one model — `storage` (viewing the base) stays
 * informational, but acting on the base requires being on foot.
 */
const DISEMBARKED_ACTIONS = new Set([
  "mine",
  "explore",
  "harvest",
  "build",
  "produce",
  "collect",
  "deposit",
  "withdraw",
  "embark",
]);

/**
 * Fabrication / free region navigation usable in EITHER embark state, but NOT in
 * combat. `craft` is fabrication (cook food / make Hyperwarp Condensate, ungated
 * by embark); `jump` is free region navigation. Combat still overrides — you
 * can't slip to another region or step to a workbench mid-fight.
 */
const ANYTIME_OUT_OF_COMBAT = new Set(["craft", "jump"]);

/**
 * `eat` is allowed in EVERY state (including combat) — you can always snack to
 * heal — so it joins the always-applicable set.
 */
const ALWAYS = new Set<string>(["eat", ...INFORMATIONAL]);

/**
 * Whether `verb` is usable in `state`. The ONE predicate both `help` and
 * dispatch consult.
 *
 * Combat overrides everything: while `inCombat`, only the combat actions
 * (`attack`/`flee`) plus the always-applicable set (informational + `eat`) are
 * applicable. Out of combat, the combat actions are hidden ("nothing to fight"),
 * fabrication/navigation work in either embark state, the economy commands work
 * iff at a trade location (settlement/outpost), and the remaining actions split
 * by embark state (travel aboard, surface/base on foot).
 */
export function isApplicable(verb: string, state: PlayerStateView): boolean {
  if (ALWAYS.has(verb)) return true;
  if (state.inCombat) {
    // Combat overrides everything else.
    return COMBAT_ONLY.has(verb);
  }
  // Out of combat:
  if (COMBAT_ONLY.has(verb)) return false; // nothing to fight
  if (ANYTIME_OUT_OF_COMBAT.has(verb)) return true;
  // Economy is gated by LOCATION (a settlement/outpost), not embark state.
  if (ECONOMY.has(verb)) return state.atTradeLocation;
  return state.embarked ? EMBARKED_ACTIONS.has(verb) : DISEMBARKED_ACTIONS.has(verb);
}

/** Whether `verb` is an economy command (gated by being at a trade location). */
export function isEconomyVerb(verb: string): boolean {
  return ECONOMY.has(verb);
}

/**
 * The verbs applicable in `state`, in `VERBS` (display) order. This is exactly
 * the set the no-arg `help` lists (minus aliases, filtered by the caller) and
 * exactly the set the dispatch gate permits — so the two can never disagree.
 */
export function applicableVerbs(
  state: PlayerStateView,
  verbs: readonly string[] = VERBS,
): string[] {
  return verbs.filter((v) => isApplicable(v, state));
}
