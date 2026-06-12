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
  /**
   * On the planet's surface (true) or up in orbit (false) — the orbit-land
   * dimension. With `embarked` it forms the three-state machine: Orbiting
   * (`embarked && !landed`), Landed (`embarked && landed`), On-foot (`!embarked`,
   * which always implies `landed`). Orbiting unlocks travel (`orbit`/`land`/
   * `warp`/`hyperwarp`); Landed unlocks `launch`/`disembark`.
   */
  landed: boolean;
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
  // shared-world presence (foundation 3a) — `here` lists co-located players.
  // Read-only, usable in every state like the other info commands.
  "here",
  // Keystone 1a — faction info. `standing` (your reputation with each faction)
  // is usable anywhere; `contracts` is usable anywhere too and shows the off-hub
  // note itself when you're not at a trade hub (so it stays informational).
  "standing",
  "contracts",
  // cartography (Keystone 3b) — your exploration progression (worlds charted +
  // rank). Read-only, usable in every state like the other info commands.
  "cartography",
  // player-guidance — the soft-tutorial advisor. Usable in EVERY state including
  // combat (it advises `attack`/`flee` then), so it lives with the informational
  // commands rather than gating on embark/location.
  "guide",
  // ships (Keystone 2a) — browse the ship catalog. Read-only, usable anywhere;
  // it shows the off-hub note itself when you can't yet `buyship` here (the
  // actual purchase is the economy-gated `buyship`).
  "shipyard",
  // Combat-1a — the fitting screen. Read-only (browse your ship's module slots),
  // usable in every state; the `fit` alias follows its canonical `loadout` verb.
  "loadout",
  "fit",
]);

/** Combat actions — applicable ONLY while in an encounter. */
const COMBAT_ONLY = new Set(["attack", "flee"]);

/**
 * Economy commands — applicable iff at a TRADE LOCATION (a settlement region or
 * the orbital outpost) and out of combat, REGARDLESS of embark state (P12a). You
 * can only `buy`/`sell` where there's actually a market to trade with; this
 * superseded the old "economy = embarked anywhere" rule. (`buy fuel`/`buy
 * warpfuel` are covered by `buy`.) `fulfill` (Keystone 1a — deliver goods to the
 * hub's faction for a contract) joins them: you fulfill at the hub.
 */
const ECONOMY = new Set(["buy", "sell", "fulfill", "buyship"]);

/**
 * In-system travel usable ABOARD in EITHER orbit/surface state (out of combat).
 * `orbit <planet>` flies you to orbit another planet; `land` descends to a
 * surface (no-arg = the planet you're orbiting; `land <planet>` = the orbit-then-
 * descend combo). From the SURFACE these CHAIN an implicit launch first (you lift
 * off, then fly/descend) — so they don't force an explicit `launch` for ordinary
 * planet-to-planet movement. (The long jumps `warp`/`hyperwarp` deliberately do
 * NOT chain: they require being in orbit already — see `ORBITING_ONLY`.)
 */
const ABOARD_TRAVEL = new Set([
  "orbit",
  "land",
]);

/**
 * Long jumps — usable ONLY while ABOARD and already UP IN ORBIT
 * (`embarked && !landed`, out of combat). Unlike `orbit`/`land`, these do not
 * auto-launch: you must `launch` to orbit first when on the surface.
 */
const ORBITING_ONLY = new Set([
  "warp",
  "hyperwarp",
]);

/**
 * Surface-aboard actions — usable while ABOARD but ON THE SURFACE
 * (`embarked && landed`, out of combat). `launch` lifts back to orbit (billing
 * the atmosphere climb); `disembark` steps off the ship onto the surface (you
 * can only do that once landed).
 */
const SURFACE_ABOARD_ACTIONS = new Set([
  "launch",
  "disembark",
]);

/**
 * Surface + base actions — require being ON FOOT in the region (and out of
 * combat). `embark` lives here: you can only climb aboard while you're on the
 * surface. Base operations (`produce`/`deposit`/`withdraw`) join the
 * surface work under one model — `storage` (viewing the base) stays
 * informational, but acting on the base requires being on foot. (Excavators
 * funnel ore on their own now — P13 removed the manual `collect`.)
 */
const DISEMBARKED_ACTIONS = new Set([
  "mine",
  "explore",
  "harvest",
  "plant",
  "ranch",
  "feed",
  "slaughter",
  "build",
  "upgrade",
  "produce",
  "deposit",
  "withdraw",
  "embark",
]);

/**
 * Fabrication / free region navigation / self-service identity usable in EITHER
 * embark state and at any location, but NOT in combat. `craft` is fabrication
 * (cook food / make Hyperwarp Condensate, ungated by embark); `jump` is free
 * region navigation; `rename` sets your public handle (a self-service identity
 * action — not economy/travel/surface, so it isn't tied to embark or location).
 * Combat still overrides — you can't slip to another region, step to a workbench,
 * or fiddle with your callsign mid-fight.
 */
const ANYTIME_OUT_OF_COMBAT = new Set([
  "craft",
  "jump",
  // surface-nav: directional surface movement, like region `jump` (free, no
  // fuel). Usable in either embark state out of combat; the handler itself
  // rejects it when not standing on a surface (orbiting / outpost / gas giant),
  // mirroring how `jump` does its own gas/outpost guards.
  "move",
  "rename",
  // player-guidance — emergency rescue. Works stranded in ANY embark/surface
  // state (the anti-softlock safety net), but not mid-fight: `flee` first.
  "distress",
  // Combat-1a — refit your ship's modules. Allowed in either embark/surface state
  // and anywhere, but NOT mid-fight (you can't swap gear in the middle of a
  // battle); the fitting screen (`loadout`) stays informational.
  "equip",
  "unequip",
]);

/**
 * Salvage actions usable while ORBITING (`embarked && !landed`) OR ON FOOT
 * (`!embarked`), but NOT while landed-aboard, and never in combat (Keystone 3c).
 * `salvage` works in two contexts: an ORBITAL derelict (read while orbiting — no
 * surface, no hazard) and an on-foot SURFACE site (the original, with a hazard
 * roll). The one excluded aboard state is Landed: you've put down on the surface
 * but not stepped off — `disembark` to work the ground, or `launch` to reach the
 * orbital wreck.
 */
const ORBIT_OR_FOOT = new Set(["salvage"]);

/**
 * `eat` is allowed in EVERY state (including combat) — you can always snack to
 * heal — so it joins the always-applicable set.
 */
const ALWAYS = new Set<string>(["eat", "say", ...INFORMATIONAL]);

/**
 * Whether `verb` is usable in `state`. The ONE predicate both `help` and
 * dispatch consult.
 *
 * Combat overrides everything: while `inCombat`, only the combat actions
 * (`attack`/`flee`) plus the always-applicable set (informational + `eat`) are
 * applicable. Out of combat, the combat actions are hidden ("nothing to fight"),
 * fabrication/navigation work in any embark/surface state, the economy commands
 * work iff at a trade location (settlement/outpost), and the remaining actions
 * split by the three-state machine: Orbiting (aboard + in orbit) unlocks travel,
 * Landed (aboard + on surface) unlocks launch/disembark, On-foot unlocks the
 * surface/base work.
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
  // Salvage: orbital derelict (orbiting) OR surface site (on foot) — anything
  // but landed-aboard. Checked before the embark split because it spans states.
  if (ORBIT_OR_FOOT.has(verb)) return !state.embarked || !state.landed;
  // Economy is gated by LOCATION (a settlement/outpost), not embark state.
  if (ECONOMY.has(verb)) return state.atTradeLocation;
  if (!state.embarked) return DISEMBARKED_ACTIONS.has(verb); // on foot ⇒ landed
  // Aboard: `orbit`/`land` work in EITHER orbit/surface state (from the surface
  // they chain an implicit launch); the long jumps need to be in orbit already;
  // `launch`/`disembark` need to be on the surface.
  if (ABOARD_TRAVEL.has(verb)) return true;
  return state.landed ? SURFACE_ABOARD_ACTIONS.has(verb) : ORBITING_ONLY.has(verb);
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
