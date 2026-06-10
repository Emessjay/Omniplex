/**
 * The `guide` soft-tutorial advisor — a PURE advice engine (player-guidance).
 *
 * `nextStep(snapshot)` reads a plain, IO-free struct of the player's current
 * situation and returns the SINGLE immediate next step to make progress, with a
 * clickable command and a short stage tag. It is STATELESS — there is no
 * persistent tutorial progress; the advice is recomputed from live state each
 * call (the handler in `commands.ts` builds the snapshot from DB + gen reads).
 *
 * No IO, no `Date`, no `Math.random`, no `server-only` — so the renderer, the
 * handler, and unit tests can all share it.
 *
 * The ladder is an ORDERED list of rungs; `nextStep` returns the FIRST one whose
 * condition holds. It is mostly an onboarding ramp (orbit → land → disembark →
 * mine → trade → build → grow) that opens out to open-ended advice once the
 * player is established. A couple of rungs are ordered ahead of the literal
 * spec ladder because the seeded contract (and good UX) demand it:
 *  - "at a trade hub with goods to move" beats the orbit/land navigation rungs
 *    (if you're standing at a market with a haul, sell it — embark state is
 *    irrelevant), and
 *  - "enough credits and no base yet → build one" beats the basic on-foot
 *    mining loop (it's the milestone that distinguishes an established player
 *    with no claim from a fresh one who should keep mining).
 */

/** A plain, IO-free snapshot of the state the advisor reasons about. */
export interface GuideSnapshot {
  /** Aboard the ship (true) or on foot on the surface (false). */
  embarked: boolean;
  /** On the surface (true) or up in orbit (false) — the orbit-land dimension. */
  landed: boolean;
  /** On foot on the surface (the negation of `embarked`, surfaced explicitly). */
  onFoot: boolean;
  /** The planet you're at is a gas giant (no surface to land on). */
  currentPlanetIsGas: boolean;
  /** Physically at a settlement region or orbital outpost (a market). */
  atTradeLocation: boolean;
  /** Carrying mined resources in the cargo hold. */
  hasOreInCargo: boolean;
  /** Carrying anything sellable — resources, materials, or ship parts. */
  hasAnyGoods: boolean;
  /** Current credit balance. */
  credits: number;
  /** Current regular fuel. */
  fuel: number;
  /** Current warp fuel. */
  warpFuel: number;
  /** Own a base in the region you're standing in. */
  hasBaseHere: boolean;
  /** Own a base anywhere. */
  hasAnyBase: boolean;
  /** In an active combat encounter. */
  inCombat: boolean;
}

/** One step of advice: a human message, an optional clickable command, a stage tag. */
export interface GuideAdvice {
  /** The advice, ending with a nudge to check back with `guide`. */
  message: string;
  /** A clickable command to run next (omitted only when there's nothing to click). */
  suggestedCommand?: string;
  /** A short machine tag for the rung reached (for tests/telemetry). */
  stage: string;
}

/** The standard nudge appended to every rung's advice. */
const NUDGE = " Run `guide` again once you've done it for your next step.";

/**
 * The single immediate next step for `snapshot`. Returns the first satisfied
 * rung; the final rung is an open-ended fallback, so a result is always
 * produced (message + stage are always non-empty).
 */
export function nextStep(s: GuideSnapshot): GuideAdvice {
  // 1. Combat overrides everything — resolve the fight first.
  if (s.inCombat) {
    return advice(
      "combat",
      "You're in a fight — `attack` the creature, or `flee` to break off.",
      "attack",
    );
  }

  // 2. Standing at a market with a haul: move the goods (sell / fulfil a
  //    contract). This beats the orbit/land rungs — trading works aboard or on
  //    foot, and it's the most immediate progress when you're already at a hub.
  if (s.atTradeLocation && s.hasAnyGoods) {
    return advice(
      "trade-hub",
      "You're at a trade hub. Check `contracts` to see what the local faction wants and `fulfill` one for credits + reputation, or just `sell` your haul.",
      "contracts",
    );
  }

  // 3. Orbiting a gas giant — no surface to land on; go find a rocky world.
  if (s.embarked && !s.landed && s.currentPlanetIsGas) {
    return advice(
      "orbit-gas",
      "This is a gas giant — there's no surface to land on. `scan` the system, then `orbit` a rocky world to set down on.",
      "orbit",
    );
  }

  // 4. Orbiting a rocky world — descend.
  if (s.embarked && !s.landed) {
    return advice(
      "orbit-land",
      "You're in orbit. `land` to descend to the surface.",
      "land",
    );
  }

  // 5. Landed aboard the ship — step out onto the surface.
  if (s.embarked && s.landed) {
    return advice(
      "disembark",
      "You're parked on the surface. `disembark` to step out onto the planet.",
      "disembark",
    );
  }

  // 6. On foot, no base, and credits to spare — claim territory. This is the
  //    milestone that preempts the basic mining loop for an established-but-
  //    unclaimed player (a fresh player with starter credits stays below the
  //    threshold and so keeps mining at rung 7).
  if (s.onFoot && !s.hasAnyBase && s.credits >= BASE_GUIDE_CREDITS) {
    return advice(
      "build-base",
      "You've got the credits to put down roots — `build base` here (on foot) to claim a region and start producing.",
      "build base",
    );
  }

  // 7. On foot with an empty hold — find something to mine.
  if (s.onFoot && !s.hasOreInCargo) {
    return advice(
      "mine",
      "`scan` the region for deposits, then `mine <resource>` to fill your hold.",
      "scan",
    );
  }

  // 8. Carrying goods but not at a market — go somewhere you can sell/trade.
  if (s.hasAnyGoods && !s.atTradeLocation) {
    return advice(
      "find-hub",
      "Your hold is worth something — find a settlement or orbital outpost to sell at. Use `map`/`regions` to look around, then travel there (`jump O` docks at a station).",
      "map",
    );
  }

  // 9. You have a base — grow it.
  if (s.hasBaseHere || s.hasAnyBase) {
    return advice(
      "grow-base",
      "Grow your base: `build excavator`/`silo`, `produce` ship parts, or farm with `plant`/`ranch`. `storage` shows what it's holding.",
      "storage",
    );
  }

  // 10. Established — open-ended exploration / industry / reputation.
  return advice(
    "established",
    "You're well underway — `warp` to explore new systems, raise faction `standing`, or expand your industry. There's no single next step now; play how you like.",
    "map",
  );
}

/**
 * Credits at which `guide` starts steering an unclaimed player toward building a
 * base. Set well above the starting balance (1000) so a brand-new player is told
 * to mine first and only sees the base nudge after some successful trading.
 */
export const BASE_GUIDE_CREDITS = 2000;

/** Assemble a `GuideAdvice`, appending the standard "check back" nudge. */
function advice(stage: string, message: string, suggestedCommand?: string): GuideAdvice {
  return { stage, message: message + NUDGE, suggestedCommand };
}
