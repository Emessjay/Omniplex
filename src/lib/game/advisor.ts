/**
 * The `guide` soft-tutorial advisor — a PURE advice engine (player-guidance,
 * reworked by guide-advisor-fix).
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
 * condition holds. Crucially it is MILESTONE-based, not micro-step based: each
 * rung keys off STABLE state (base ownership, ship, credits, holdings of the
 * specific minerals a base needs), so the advice toward the current milestone is
 * the SAME whether or not the player momentarily holds ore. This kills the
 * mine↔sell flip-flop the original ladder produced: there is NO bare "sell" rung
 * that ping-pongs with "mine" — selling is only ever advised as a means toward a
 * NAMED goal (e.g. affording the base fee, or saving for a bigger ship).
 *
 * The progression it walks: reach a workable surface (orbit → land → disembark)
 * → mine the minerals a base needs and `build base` → grow the base → buy/build a
 * bigger ship → explore / factions → open-ended. Each milestone is a different,
 * FORWARD rung, so a progressing player keeps getting new advice rather than
 * being trapped before the build-base/grow/ship/explore rungs.
 */

import { BASE_BUILD_MINERALS, BASE_BUILD_CREDITS } from "./bases";

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
  /** In an active combat encounter. */
  inCombat: boolean;
  /** Current credit balance (STABLE — keys the build-base / ship milestones). */
  credits: number;
  /** Own a base anywhere (STABLE — the production milestone). */
  hasAnyBase: boolean;
  /** Own a base in the region you're standing in. */
  hasBaseHere: boolean;
  /** Carrying mined resources in the cargo hold (transient — display only). */
  hasOreInCargo: boolean;
  /** Carrying anything sellable — resources, materials, or ship parts (transient). */
  hasAnyGoods: boolean;
  /**
   * Cargo holds every mineral a base build needs (`BASE_BUILD_MINERALS`) in the
   * required amounts. STABLE w.r.t. the base milestone — this, not generic ore,
   * is what gates the build-base rung, so the advice doesn't flip with each haul.
   */
  hasBaseMinerals: boolean;
  /** Still flying the free starter ship (`STARTER_SHIP_ID`). */
  shipIsStarter: boolean;
  /** Current regular fuel (optional; informational). */
  fuel?: number;
  /** Current warp fuel (optional; informational). */
  warpFuel?: number;
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
 * Credits at which `guide` starts steering an established (based) player who's
 * still on the starter ship toward buying/building a bigger hull. Set well above
 * the starting balance so it only fires once a player has actually accumulated
 * wealth from production/trade.
 */
export const SHIP_GUIDE_CREDITS = 20_000;

/** A human list of the minerals a base needs, e.g. "iron + titanium". */
const BASE_MINERAL_NAMES: string = Object.keys(BASE_BUILD_MINERALS).join(" + ");

/**
 * The single immediate next step for `snapshot`. Returns the first satisfied
 * rung; the final rung is an open-ended fallback, so a result is always
 * produced (message + stage are always non-empty). PURE and TOTAL.
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

  // 2-4. Situational: get an embarked player down onto a workable surface so
  // they can mine / build. Skipped when docked at a trade hub (where the move
  // is to trade, not to land) — see the milestone rungs below.
  if (!s.atTradeLocation && s.embarked && !s.landed && s.currentPlanetIsGas) {
    return advice(
      "orbit-gas",
      "This is a gas giant — there's no surface to land on. `scan` the system, then `orbit` a rocky world to set down on.",
      "orbit",
    );
  }
  if (!s.atTradeLocation && s.embarked && !s.landed) {
    return advice(
      "orbit-land",
      "You're in orbit. `land` to descend to the surface.",
      "land",
    );
  }
  if (!s.atTradeLocation && s.embarked && s.landed) {
    return advice(
      "disembark",
      "You're parked on the surface. `disembark` to step out onto the planet.",
      "disembark",
    );
  }

  // 5. No base yet — the first big milestone. This is ONE stable goal (claim a
  //    base), gated on the SPECIFIC minerals a base needs, not on generic ore,
  //    so it never flip-flops with "sell". A brand-new player already has the
  //    credits, so they're told to MINE the base mats, never to sell.
  if (!s.hasAnyBase) {
    if (!s.hasBaseMinerals) {
      return advice(
        "gather-base-mats",
        `Your first goal is a base. It needs ${BASE_MINERAL_NAMES} — find a rocky world, \`scan\` a region for those deposits and \`mine\` them, then \`build base\` to start producing.`,
        "scan",
      );
    }
    if (s.credits >= BASE_BUILD_CREDITS) {
      return advice(
        "build-base",
        `You've got the minerals and the ${BASE_BUILD_CREDITS}cr fee — \`build base\` here (on foot) to claim a region and start producing.`,
        "build base",
      );
    }
    // Have the minerals but short the cash fee — sell toward the NAMED goal
    // (the base), not as a bare ping-ponging rung.
    return advice(
      "build-base",
      `You've got the base minerals but need ${BASE_BUILD_CREDITS}cr for the claim fee — \`sell\` some other goods (or fulfill a \`contracts\`) to cover it, then \`build base\`.`,
      "sell",
    );
  }

  // 6. Established explorer — past the ship milestone (flying a bigger hull).
  //    Open out to exploration, charting, and factions.
  if (!s.shipIsStarter) {
    return advice(
      "explore",
      "You're well-established. `warp`/`hyperwarp` to chart new worlds — `salvage` derelicts for discovery bounties, raise faction `standing` with `contracts`, and push coreward for the rarest ore.",
      "map",
    );
  }

  // 7. Based, still on the starter ship, but wealthy — buy or build a real hold.
  if (s.credits >= SHIP_GUIDE_CREDITS) {
    return advice(
      "bigger-ship",
      "You're flush — trade up the starter shuttle for a bigger hold. Check the `shipyard` to buy one, or `produce` a ship at a base with a production line. More cargo means bigger hauls and contract deliveries.",
      "shipyard",
    );
  }

  // 8. Have a base — grow it (and earn from it). Many forward options; the
  //    message names them so the player picks what's not yet done.
  return advice(
    "grow-base",
    "Grow your base: `build` an excavator/silo/production_line, `produce` parts, or farm with `plant`/`ranch` — `storage` shows what it holds. Fulfill `contracts` at a trade hub for credits + reputation to keep climbing.",
    "storage",
  );
}

/** Assemble a `GuideAdvice`, appending the standard "check back" nudge. */
function advice(stage: string, message: string, suggestedCommand?: string): GuideAdvice {
  return { stage, message: message + NUDGE, suggestedCommand };
}
