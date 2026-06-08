import "server-only";

/**
 * Command dispatcher + handlers — the server-authoritative heart of the game.
 *
 * `dispatch(player, input)` parses the raw input, validates against the rules
 * and current DB state, mutates via the service-role adapters in `world.ts`,
 * and returns a `RenderFrame`. Handlers are deliberately THIN: all gameplay
 * math lives in `rules.ts`, all formatting in `render.ts`, all persistence in
 * `world.ts`. Never trust client input for credits/fuel/location — everything
 * is recomputed here from the authoritative player row + procedural universe.
 *
 * Errors (unknown verb, bad args, can't-afford, depleted) return a frame, never
 * throw to the client.
 */
import type { Player } from "@/lib/players/types";
import {
  galaxyAt,
  planetAt,
  regionAt,
  systemAt,
  systemKey,
  planetKey,
  regionKey,
  warpDistance,
  getResource,
  RESOURCES,
  type SystemCoord,
  type PlanetCoord,
} from "@/lib/universe";
import type { RenderFrame } from "@/lib/terminal/types";
import { frame, line, text } from "@/lib/terminal/helpers";
import { parseCommand } from "./parse";
import { resolveCommandLine, resolveToken, type ResolveLineSpec } from "./resolve";
import { VERBS, USAGE, usageLine } from "./usage";
import { getWorldSeed } from "./seed";
import {
  effectiveAbundance,
  fuelCost,
  miningYield,
  priceAfterSale,
  priceAfterPurchase,
  buyUnitCost,
  sellValue,
  canCraft,
  canLand,
  landingRequirement,
  rollHazardDamage,
  creditsAfterDeath,
  MAX_HEALTH,
  DEPLETION_PER_UNIT,
  FUEL_PRICE_PER_UNIT,
} from "./rules";
import {
  UPGRADE_IDS,
  isUpgradeId,
  getUpgrade,
  upgradeValue,
} from "./upgrades";
import {
  renderHelp,
  renderCommandHelp,
  renderScan,
  renderRegions,
  renderMap,
  renderInventory,
  renderUpgrades,
  renderWho,
  errorFrame,
  type MapNeighbor,
  type RegionListEntry,
  type CommandHelpSlotView,
  type CommandHelpGroup,
} from "./render";
import { groupTradeCandidates, creditLabel, type TradeCategory } from "./trade-help";
import * as world from "./world";

/** Strict integer parse: returns null for missing/non-integer tokens. */
function toInt(token: string | undefined): number | null {
  if (token === undefined) return null;
  const n = Number(token);
  return Number.isInteger(n) ? n : null;
}

function locOf(player: Player): PlanetCoord {
  return {
    galaxy: player.galaxy,
    arm: player.arm,
    cluster: player.cluster,
    system: player.system,
    planet: player.planet,
  };
}

/** The player's current system coordinate (location minus planet/region). */
function systemOf(player: Player): SystemCoord {
  return {
    galaxy: player.galaxy,
    arm: player.arm,
    cluster: player.cluster,
    system: player.system,
  };
}

/**
 * Build the scan frame for the player standing in region `regionIndex` of the
 * planet at `coord`. Shared by `scan`, `warp`, `land`, and `jump` so they
 * describe the world identically. Depletion is read per-REGION (`regionKey`);
 * discovery stays PLANET-level (`planetKey`, idempotent — re-recording the
 * planet you're already on is a no-op). The landing requirement is planet-level
 * (reads the planet's temperature).
 */
async function regionScanFrame(
  player: Player,
  seed: string,
  coord: PlanetCoord,
  regionIndex: number,
): Promise<RenderFrame> {
  const planet = planetAt(seed, coord);
  const system = systemAt(seed, coord);
  const region = regionAt(seed, coord, regionIndex);
  const [depletionMap, justDiscovered, owned] = await Promise.all([
    world.getEffectiveDepletionMap(regionKey(region.coord)),
    world.recordDiscovery(planetKey(coord), player.id),
    world.getOwnedUpgradeIds(player.id),
  ]);
  const requiredUpgrade = landingRequirement(planet.temperature);
  return renderScan({
    planet,
    system,
    region,
    depletionMap,
    justDiscovered,
    requiredUpgrade,
    hasRequiredUpgrade: requiredUpgrade === null || owned.has(requiredUpgrade),
    health: player.health,
    maxHealth: MAX_HEALTH,
    embarked: player.embarked,
  });
}

/**
 * The resource ids minable in the player's CURRENT REGION right now — present
 * deposits whose effective (post-depletion) abundance is still > 0. These are
 * the candidate set for `mine`'s argument.
 */
async function minableHere(player: Player, seed: string): Promise<string[]> {
  const coord = locOf(player);
  const region = regionAt(seed, coord, player.region);
  const depletionMap = await world.getEffectiveDepletionMap(regionKey(region.coord));
  return region.deposits
    .filter((d) => effectiveAbundance(d.abundance, depletionMap[d.resourceId] ?? 0) > 0)
    .map((d) => d.resourceId);
}

/**
 * Sellable arg candidates: resource ids carried in the hold, the literal `all`,
 * and every upgrade id (so `sell ab` abbreviates even before the ownership
 * check; the handler validates you actually own it).
 */
async function sellableHere(player: Player): Promise<string[]> {
  const stacks = await world.getInventory(player.id);
  return [...stacks.map((s) => s.resourceId), "all", ...UPGRADE_IDS];
}

/**
 * The contextual candidate sets the resolver/help need for a verb's resolvable
 * arguments. Only `mine`/`sell` read world state; the rest are static, so we
 * skip the DB for them. Prefetched (the resolver's `argDomain` is synchronous).
 */
interface ArgDomainContext {
  mineCandidates: string[] | null;
  sellCandidates: string[] | null;
}

const EMPTY_ARG_CONTEXT: ArgDomainContext = {
  mineCandidates: null,
  sellCandidates: null,
};

/**
 * Fetch the contextual candidate sets needed to resolve `verb`'s args from
 * authoritative state. Shared by `dispatch` (the resolution path) and the
 * `help <command>` handler so the two NEVER disagree about valid arguments.
 */
async function loadArgDomainContext(
  player: Player,
  seed: string,
  verb: string,
): Promise<ArgDomainContext> {
  if (verb === "mine") {
    return { mineCandidates: await minableHere(player, seed), sellCandidates: null };
  }
  if (verb === "sell") {
    return { mineCandidates: null, sellCandidates: await sellableHere(player) };
  }
  return EMPTY_ARG_CONTEXT;
}

/**
 * Build the resolver spec from prefetched contextual candidates. This is the
 * single source of truth for argument domains — both command resolution and
 * `help` call the SAME `argDomain`, so help can never list an argument the
 * parser would reject (or omit one it accepts). Resolvable positions return a
 * `string[]`; opaque positions (warp coords, land index, quantities) return
 * `null` and are passed through / shown as a placeholder.
 */
function buildResolveSpec(ctx: ArgDomainContext): ResolveLineSpec {
  return {
    verbs: VERBS,
    argDomain: (verb, argIndex) => {
      if (verb === "mine" && argIndex === 0) return ctx.mineCandidates;
      if (verb === "sell" && argIndex === 0) return ctx.sellCandidates;
      if (verb === "craft" && argIndex === 0) return [...UPGRADE_IDS];
      if (verb === "buy" && argIndex === 0) {
        return ["fuel", ...RESOURCES.map((r) => r.id), ...UPGRADE_IDS];
      }
      return null; // opaque: warp coords, land index, buy/craft quantity, …
    },
  };
}

export async function dispatch(player: Player, input: string): Promise<RenderFrame> {
  const seed = getWorldSeed();
  const { verb: rawVerb } = parseCommand(input);
  if (rawVerb === "") {
    return frame([line(text("Type `help` for commands.", "muted"))]);
  }

  // Resolve the verb first so we know which contextual candidate sets to fetch
  // for argument resolution (the candidate sets come from authoritative state).
  const verbRes = resolveToken(rawVerb, VERBS);
  const ctx = verbRes.ok
    ? await loadArgDomainContext(player, seed, verbRes.value)
    : EMPTY_ARG_CONTEXT;
  const spec = buildResolveSpec(ctx);

  const resolved = resolveCommandLine(input, spec);
  if (!resolved.ok) return errorFrame(resolved.error);

  const { verb, args, canonical } = resolved;
  const result = await dispatchResolved(player, seed, verb, args);

  // Echo the expanded form when abbreviation changed what was typed, so the
  // player learns the canonical command.
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();
  if (canonical !== normalized) {
    return frame([line(text(`» ${canonical}`, "muted")), ...result.lines]);
  }
  return result;
}

/**
 * Commands that require being ABOARD the ship: the economy and ship travel.
 * Attempting them on foot is blocked with a message naming the fix (`embark`).
 */
const EMBARKED_ONLY = new Set(["buy", "sell", "warp", "land"]);

/**
 * Commands that require being ON FOOT in the region: surface work. Attempting
 * them from the ship is blocked with a message naming the fix (`disembark`).
 * (Exploration joins this set in P5; today only mining is gated this way.)
 */
const DISEMBARKED_ONLY = new Set(["mine"]);

/** Dispatch an already-resolved (canonical verb, expanded args) command. */
async function dispatchResolved(
  player: Player,
  seed: string,
  verb: string,
  args: string[],
): Promise<RenderFrame> {
  // Embark-state gating: the economy/flying need the ship; mining needs to be
  // on the surface. Each error names the command that fixes the state.
  if (EMBARKED_ONLY.has(verb) && !player.embarked) {
    return errorFrame("You must `embark` your ship first.");
  }
  if (DISEMBARKED_ONLY.has(verb) && player.embarked) {
    return errorFrame("You must `disembark` onto the surface to mine.");
  }

  switch (verb) {
    case "help":
      return handleHelp(player, seed, args);
    case "scan":
    case "look":
      return handleScan(player, seed);
    case "map":
      return handleMap(player, seed);
    case "warp":
      return handleWarp(player, seed, args);
    case "land":
      return handleLand(player, seed, args);
    case "jump":
      return handleJump(player, seed, args);
    case "regions":
      return handleRegions(player, seed, args);
    case "disembark":
      return handleDisembark(player, seed);
    case "embark":
      return handleEmbark(player);
    case "mine":
      return handleMine(player, seed, args);
    case "explore":
      return handleExplore();
    case "inventory":
      return handleInventory(player);
    case "upgrades":
      return handleUpgrades(player);
    case "craft":
      return handleCraft(player, args);
    case "sell":
      return handleSell(player, args);
    case "buy":
      return handleBuy(player, args);
    case "who":
      return handleWho();
    default:
      return errorFrame(`Unknown command "${verb}". Type help for the list.`);
  }
}

// ---------------------------------------------------------------------------
// help  (no arg: command list; with arg: usage + live argument enumerations)
// ---------------------------------------------------------------------------

/** Contextual note when a resolvable position currently has no candidates. */
function emptyDomainNote(verb: string): string {
  switch (verb) {
    case "mine":
      return "nothing minable here — try `scan` or `warp` somewhere else";
    case "sell":
      return "your hold is empty — `mine` something first";
    default:
      return "nothing available right now";
  }
}

/**
 * `help` with no argument is the classic command list (unchanged). `help
 * <command>` (abbreviation allowed: `help mi` → `mine`) shows the command's
 * usage plus, for each argument slot, either the LIVE enumerated candidates
 * (drawn from the same `argDomain` the parser uses) or an opaque `<placeholder>`
 * + hint. Unknown / ambiguous command args produce a helpful error, never a
 * throw.
 */
async function handleHelp(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  if (args.length === 0) return renderHelp();

  const targetRaw = args[0]!;
  const res = resolveToken(targetRaw, VERBS);
  if (!res.ok) {
    if (res.reason === "ambiguous") {
      return errorFrame(
        `Ambiguous command '${targetRaw}' — did you mean: ${res.matches.join(", ")}?`,
      );
    }
    return errorFrame(`No command '${targetRaw}' — type \`help\` for the list.`);
  }

  const verb = res.value;
  const usage = USAGE[verb];
  // Defensive: every verb is expected to have a descriptor (unit-tested), but
  // never throw to the client if one is somehow missing.
  if (!usage) return errorFrame(`No help available for '${verb}'.`);

  // Same contextual domains the resolver uses, so help can't disagree with it.
  const ctx = await loadArgDomainContext(player, seed, verb);
  const spec = buildResolveSpec(ctx);

  // Trade commands annotate their candidates with live prices; fetch the drifted
  // market prices once (the candidate SET still comes from `argDomain`).
  const isTrade = verb === "buy" || verb === "sell";
  const prices = isTrade ? await world.getMarketPrices() : null;

  const slots: CommandHelpSlotView[] = usage.slots.map((slot, i) => {
    const domain = spec.argDomain(verb, i, []);
    if (domain === null) {
      // Opaque: a placeholder + hint, never a bogus enumeration.
      return { name: slot.name, optional: !!slot.optional, hint: slot.hint };
    }
    // Resolvable: clickable only when filling THIS slot alone forms a complete
    // command (no earlier arg required, every later slot optional).
    const laterAllOptional = usage.slots.slice(i + 1).every((s) => s.optional);
    const clickable = i === 0 && laterAllOptional;
    const groups =
      isTrade && prices
        ? tradeSlotGroups(verb, domain, prices, clickable)
        : [
            {
              // Single, unlabeled category (mine/craft): renders as one line
              // against the `<placeholder>:` prefix, exactly as before.
              label: null,
              candidates: domain.map((c) => ({
                label: c,
                command: clickable ? `${verb} ${c}` : null,
              })),
            } satisfies CommandHelpGroup,
          ];
    return {
      name: slot.name,
      optional: !!slot.optional,
      groups,
      emptyNote: domain.length === 0 ? emptyDomainNote(verb) : undefined,
    };
  });

  return renderCommandHelp({ verb, usage: usageLine(verb), desc: usage.desc, slots });
}

/**
 * Build the labeled, price-annotated groups for a `buy`/`sell` argument from its
 * (already `argDomain`-sourced) candidate ids. Grouping is the pure
 * `groupTradeCandidates`; this layers the live prices on top:
 *   - buy: fuel = `FUEL_PRICE_PER_UNIT`; minerals = `buyUnitCost(price)`;
 *     upgrades = `buyUnitCost(upgradeValue)`.
 *   - sell: minerals = current market price; upgrades = `upgradeValue`; the
 *     `all` token carries no price.
 */
function tradeSlotGroups(
  verb: "buy" | "sell",
  domain: string[],
  prices: Record<string, number>,
  clickable: boolean,
): CommandHelpGroup[] {
  return groupTradeCandidates(domain).map((g) => ({
    label: g.category,
    candidates: g.ids.map((id) => ({
      label: id,
      command: clickable ? `${verb} ${id}` : null,
      annotation: tradeAnnotation(verb, id, g.category, prices),
    })),
  }));
}

/** The credit-per-unit annotation for one trade candidate (undefined for `all`). */
function tradeAnnotation(
  verb: "buy" | "sell",
  id: string,
  category: TradeCategory,
  prices: Record<string, number>,
): string | undefined {
  switch (category) {
    case "everything":
      return undefined; // the `all` token has no single price
    case "fuel":
      return creditLabel(FUEL_PRICE_PER_UNIT);
    case "upgrades": {
      const value = upgradeValue(id);
      return creditLabel(verb === "buy" ? buyUnitCost(value) : value);
    }
    case "minerals": {
      // markets seed every resource at base_value, so a row is expected; fall
      // back to base value defensively so help always shows a number.
      const price = prices[id] ?? getResource(id).baseValue;
      return creditLabel(verb === "buy" ? buyUnitCost(price) : price);
    }
  }
}

// ---------------------------------------------------------------------------
// scan / look
// ---------------------------------------------------------------------------

async function handleScan(player: Player, seed: string): Promise<RenderFrame> {
  return regionScanFrame(player, seed, locOf(player), player.region);
}

// ---------------------------------------------------------------------------
// jump / regions — move between and browse the current planet's regions.
// ---------------------------------------------------------------------------

/** How many region rows `regions` shows per page. */
const REGIONS_PAGE_SIZE = 10;

/**
 * `jump <n>` — move to region `n` of the CURRENT planet (free; no fuel, same
 * planet). Validates `0 <= n < regionCount` before mutating; an out-of-range
 * index leaves state untouched. Returns a scan of the new region.
 */
async function handleJump(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const n = toInt(args[0]);
  if (n === null) return errorFrame("Usage: jump <region>  (see `regions`)");

  const coord = locOf(player);
  const planet = planetAt(seed, coord);
  if (n < 0 || n >= planet.regionCount) {
    return errorFrame(
      `No region ${n} on ${planet.name} — it has ${planet.regionCount} (0–${planet.regionCount - 1}). Try \`regions\`.`,
    );
  }

  if (n !== player.region) await world.setRegion(player.id, n);

  const scan = await regionScanFrame(player, seed, coord, n);
  return frame([line(text(`Jumped to region ${n}.`, "success")), ...scan.lines]);
}

/**
 * `regions [page]` — a paged, clickable window of this planet's regions (a
 * planet can have up to 100,000, so we never list them all). Each row is a
 * `jump <n>` action labeled by that region's biome.
 */
function handleRegions(player: Player, seed: string, args: string[]): RenderFrame {
  const coord = locOf(player);
  const planet = planetAt(seed, coord);
  const pageCount = Math.max(1, Math.ceil(planet.regionCount / REGIONS_PAGE_SIZE));

  const requested = toInt(args[0]);
  if (args[0] !== undefined && (requested === null || requested < 1)) {
    return errorFrame("Usage: regions [page]  — page must be a positive whole number.");
  }
  const page = Math.min(pageCount, Math.max(1, requested ?? 1));

  const start = (page - 1) * REGIONS_PAGE_SIZE;
  const end = Math.min(planet.regionCount, start + REGIONS_PAGE_SIZE);
  const entries: RegionListEntry[] = [];
  for (let i = start; i < end; i++) {
    const region = regionAt(seed, coord, i);
    entries.push({ index: i, biome: region.biome, current: i === player.region });
  }

  return renderRegions({
    planetName: planet.name,
    regionCount: planet.regionCount,
    page,
    pageCount,
    entries,
  });
}

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

/**
 * Candidate system offsets around the current system, spanning the three
 * in-galaxy tiers (arm / cluster / system). Arm and cluster indices never go
 * negative (cluster ≥ 0, and arm is normalized into `[0, armCount)` since the
 * ring wraps); system is clamped at 0. Galaxy is fixed (no inter-galaxy travel
 * this phase).
 */
function neighborCandidates(current: SystemCoord, armCount: number): SystemCoord[] {
  const out: SystemCoord[] = [];
  const seen = new Set<string>();
  for (let da = -1; da <= 1; da++) {
    for (let dc = -1; dc <= 1; dc++) {
      for (let dsys = -3; dsys <= 3; dsys++) {
        if (da === 0 && dc === 0 && dsys === 0) continue;
        const cluster = current.cluster + dc;
        const system = current.system + dsys;
        if (cluster < 0 || system < 0) continue;
        // Arm wraps around the ring and is canonicalized into [0, armCount).
        const arm = ((current.arm + da) % armCount + armCount) % armCount;
        const coord: SystemCoord = { galaxy: current.galaxy, arm, cluster, system };
        const key = systemKey(coord);
        if (key === systemKey(current) || seen.has(key)) continue;
        seen.add(key);
        out.push(coord);
      }
    }
  }
  return out;
}

async function handleMap(player: Player, seed: string): Promise<RenderFrame> {
  const current = systemOf(player);
  const galaxy = galaxyAt(seed, current.galaxy);
  const discovered = await world.discoveredSystemKeys();
  const neighbors: MapNeighbor[] = neighborCandidates(current, galaxy.armCount)
    .map((coord) => {
      const sys = systemAt(seed, coord);
      return {
        arm: coord.arm,
        cluster: coord.cluster,
        system: coord.system,
        name: sys.name,
        distance: warpDistance(current, coord, galaxy.armCount),
        discovered: discovered.has(systemKey(coord)),
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8);
  return renderMap(neighbors, player.fuel, {
    galaxyName: galaxy.name,
    armCount: galaxy.armCount,
    galaxy: current.galaxy,
    arm: current.arm,
    cluster: current.cluster,
    system: current.system,
    planet: player.planet,
    region: player.region,
  });
}

// ---------------------------------------------------------------------------
// warp
// ---------------------------------------------------------------------------

async function handleWarp(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const armArg = toInt(args[0]);
  const cluster = toInt(args[1]);
  const system = toInt(args[2]);
  if (armArg === null || cluster === null || system === null) {
    return errorFrame("Usage: warp <arm> <cluster> <system>  (e.g. warp 0 0 1)");
  }
  if (cluster < 0 || system < 0) {
    return errorFrame("Cluster and system must be 0 or greater.");
  }

  const current = systemOf(player);
  // Arm is taken modulo the CURRENT galaxy's arm count — it's a ring, so e.g.
  // `warp 13 …` in a 12-arm galaxy lands on arm 1. Negative inputs wrap too.
  const { armCount } = galaxyAt(seed, current.galaxy);
  const arm = ((armArg % armCount) + armCount) % armCount;
  // Galaxy is unchanged this phase (inter-galaxy travel is later).
  const dest: SystemCoord = { galaxy: current.galaxy, arm, cluster, system };
  if (
    dest.arm === current.arm &&
    dest.cluster === current.cluster &&
    dest.system === current.system
  ) {
    return errorFrame("You're already in that system. Try `map` for neighbors.");
  }

  const distance = warpDistance(current, dest, armCount);
  const cost = fuelCost(distance);
  if (cost > player.fuel) {
    return errorFrame(
      `Not enough fuel: warp needs ${cost}, you have ${player.fuel}. Try a closer system or \`buy fuel\`.`,
    );
  }

  const newFuel = player.fuel - cost;
  await world.setFuelAndLocation(player.id, newFuel, {
    galaxy: dest.galaxy,
    arm: dest.arm,
    cluster: dest.cluster,
    system: dest.system,
    planet: 0,
  });

  // Warp is NOT gated — you always arrive in-system at planet 0, region 0. If
  // that world is hostile you simply can't `mine` it until you have the gear
  // (or `land` a survivable sibling), so this can never softlock you.
  const arrivalCoord: PlanetCoord = { ...dest, planet: 0 };
  const destSystem = systemAt(seed, dest);
  const scan = await regionScanFrame(player, seed, arrivalCoord, 0);
  return frame([
    line([
      text(`Warped to ${destSystem.name}. `, "success"),
      text(`−${cost} fuel (${newFuel} left).`, "muted"),
    ]),
    ...scan.lines,
  ]);
}

// ---------------------------------------------------------------------------
// land
// ---------------------------------------------------------------------------

async function handleLand(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const idx = toInt(args[0]);
  if (idx === null) return errorFrame("Usage: land <planet index>  (see `scan`)");

  const system = systemAt(seed, systemOf(player));
  if (idx < 0 || idx >= system.planetCount) {
    return errorFrame(
      `No planet ${idx} here — this system has ${system.planetCount} (0–${system.planetCount - 1}).`,
    );
  }

  const coord: PlanetCoord = { ...systemOf(player), planet: idx };
  const planet = planetAt(seed, coord);

  // Landing gate: a hostile surface needs the matching upgrade. No move, no
  // state change when blocked — naming the gear the player is missing.
  const owned = await world.getOwnedUpgradeIds(player.id);
  const gate = canLand(planet.temperature, owned);
  if (!gate.ok) {
    const up = getUpgrade(gate.required);
    const why = planet.temperature < 0 ? "freezing" : "boiling";
    return errorFrame(
      `${planet.name} is ${why} (${planet.temperature}°C) — landing requires ${up.name}. \`craft\` or \`buy\` it first.`,
    );
  }

  // Landing always touches you down in region 0 (resets `region`), even when
  // re-landing the planet you're already on after jumping around it.
  await world.setPlanet(player.id, idx);

  const scan = await regionScanFrame(player, seed, coord, 0);
  return frame([
    line(text(`Landed on ${planet.name}.`, "success")),
    ...scan.lines,
  ]);
}

// ---------------------------------------------------------------------------
// disembark / embark — toggle the on-foot survival state.
// ---------------------------------------------------------------------------

/**
 * `disembark` — step out of the ship onto the current region's surface, where
 * mining is possible (and the planet's hazard can wound you). Idempotent-
 * friendly when already on foot. Briefly describes the region you step into.
 */
async function handleDisembark(player: Player, seed: string): Promise<RenderFrame> {
  if (!player.embarked) {
    return frame([line(text("You're already on foot on the surface.", "muted"))]);
  }
  await world.setEmbarked(player.id, false);

  const coord = locOf(player);
  const planet = planetAt(seed, coord);
  const region = regionAt(seed, coord, player.region);
  const hazardPct = Math.round(planet.hazard * 100);
  return frame([
    line([
      text("You disembark onto the surface — ", "success"),
      text(`${region.biome}`, "accent"),
      text(` of ${planet.name}.`, "default"),
    ]),
    line([
      text(`Watch the hazard (${hazardPct}%). `, hazardPct >= 60 ? "danger" : "muted"),
      text(`HP ${player.health}/${MAX_HEALTH}. `, "default"),
      text("`mine` to work the deposits; `embark` to return to your ship.", "muted"),
    ]),
  ]);
}

/**
 * `embark` — climb back aboard the ship, re-enabling the economy and ship
 * travel. Idempotent-friendly when already aboard.
 */
async function handleEmbark(player: Player): Promise<RenderFrame> {
  if (player.embarked) {
    return frame([line(text("You're already aboard your ship.", "muted"))]);
  }
  await world.setEmbarked(player.id, true);
  return frame([
    line([
      text("You climb back aboard your ship. ", "success"),
      text("Trading and warp drives are online.", "muted"),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// mine  (disembarked-only; the surface hazard can wound or kill you)
// ---------------------------------------------------------------------------

async function handleMine(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const resourceId = args[0]?.toLowerCase();
  if (!resourceId) return errorFrame("Usage: mine <resource>  (see `scan`)");

  const coord = locOf(player);
  const planet = planetAt(seed, coord);

  // Same gate as `land`: you can't work a hostile surface without the gear.
  const owned = await world.getOwnedUpgradeIds(player.id);
  const gate = canLand(planet.temperature, owned);
  if (!gate.ok) {
    const up = getUpgrade(gate.required);
    const why = planet.temperature < 0 ? "freezing" : "boiling";
    return errorFrame(
      `${planet.name} is ${why} (${planet.temperature}°C) — mining requires ${up.name}. \`craft\` or \`buy\` it first.`,
    );
  }

  const region = regionAt(seed, coord, player.region);
  const deposit = region.deposits.find((d) => d.resourceId === resourceId);
  if (!deposit) {
    return errorFrame(
      `No ${resourceId} deposit in region ${player.region} of ${planet.name}. Try \`scan\`.`,
    );
  }

  const key = regionKey(region.coord);
  const depletionMap = await world.getEffectiveDepletionMap(key);
  const eff = effectiveAbundance(deposit.abundance, depletionMap[resourceId] ?? 0);
  if (eff <= 0) {
    return errorFrame(`The ${getResource(resourceId).name} here is mined out.`);
  }

  const used = await world.getCargoUsed(player.id);
  const cargoSpace = player.cargoCap - used;
  if (cargoSpace <= 0) {
    return errorFrame("Cargo hold is full. `sell` something first.");
  }

  const yield_ = miningYield({ abundance: eff, cargoSpace });
  if (yield_ <= 0) return errorFrame("Couldn't extract anything this pass.");

  await world.addInventory(player.id, resourceId, yield_);
  await world.recordDepletion(key, resourceId, yield_ * DEPLETION_PER_UNIT, player.id);

  const res = getResource(resourceId);
  const remaining = player.cargoCap - (used + yield_);
  const mineLine = line([
    text(`Mined ${yield_} `, "success"),
    text(`${res.name}. `, "default"),
    text(`Cargo ${used + yield_}/${player.cargoCap} (${remaining} free).`, "muted"),
  ]);

  // Surface hazard: a successful mine exposes you to harm. Two real rolls feed
  // the pure `rollHazardDamage`; the result is subtracted from health (floored
  // at 0 by the death branch). The ore is yours either way — you struck it
  // before the hazard hit.
  const damage = rollHazardDamage(planet.hazard, Math.random(), Math.random());
  if (damage <= 0) {
    return frame([mineLine]);
  }

  const hazardPct = Math.round(planet.hazard * 100);
  const newHealth = player.health - damage;
  if (newHealth > 0) {
    await world.setHealth(player.id, newHealth);
    return frame([
      mineLine,
      line(
        text(
          `${planet.name} wounds you for ${damage} (hazard ${hazardPct}%). HP ${newHealth}/${MAX_HEALTH}.`,
          "danger",
        ),
      ),
    ]);
  }

  // Death: lose 10% of credits (atomic delta via the credits RPC), restore
  // health, and wake aboard the ship (location unchanged). Balances never go
  // negative — `creditsAfterDeath` floors at 0.
  const after = creditsAfterDeath(player.credits);
  const lost = player.credits - after;
  if (lost > 0) await world.addPlayerCredits(player.id, -lost);
  await world.setHealthAndEmbarked(player.id, MAX_HEALTH, true);
  return frame([
    mineLine,
    line(
      text(
        `You succumbed to ${planet.name} (hazard ${hazardPct}%). You wake aboard your ship, 10% of your gold lost.`,
        "danger",
      ),
    ),
    line(
      text(
        `Lost ${lost} cr (balance ${after}). HP restored to ${MAX_HEALTH}.`,
        "muted",
      ),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// explore  (P5 stub — surface scavenging/flora/fauna arrive next phase)
// ---------------------------------------------------------------------------

function handleExplore(): RenderFrame {
  return frame([
    line(text("Surface exploration is coming soon.", "muted")),
  ]);
}

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------

async function handleInventory(player: Player): Promise<RenderFrame> {
  const [stacks, prices] = await Promise.all([
    world.getInventory(player.id),
    world.getMarketPrices(),
  ]);
  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const cargoUsed = stacks.reduce((sum, s) => sum + s.qty, 0);
  return renderInventory({
    stacks: stacks.map((s) => ({
      resourceId: s.resourceId,
      qty: s.qty,
      price: prices[s.resourceId] ?? null,
    })),
    cargoUsed,
    cargoCap: fresh.cargoCap,
    credits: fresh.credits,
    fuel: fresh.fuel,
    health: fresh.health,
    maxHealth: MAX_HEALTH,
    embarked: fresh.embarked,
  });
}

// ---------------------------------------------------------------------------
// upgrades  (owned ship upgrades + their active capability)
// ---------------------------------------------------------------------------

async function handleUpgrades(player: Player): Promise<RenderFrame> {
  const stacks = await world.getPlayerUpgrades(player.id);
  return renderUpgrades({
    owned: stacks.map((s) => ({ upgradeId: s.upgradeId, qty: s.qty })),
  });
}

// ---------------------------------------------------------------------------
// craft  (synthesize one upgrade from mined components)
// ---------------------------------------------------------------------------

async function handleCraft(player: Player, args: string[]): Promise<RenderFrame> {
  const target = args[0]?.toLowerCase();
  if (!target) return errorFrame("Usage: craft <upgrade>  (see `upgrades`)");
  if (!isUpgradeId(target)) {
    return errorFrame(`Unknown upgrade "${target}". Try \`upgrades\` for the list.`);
  }

  const upgrade = getUpgrade(target);
  const recipe = upgrade.recipe;

  // Read current cargo and confirm the recipe is fully covered BEFORE touching
  // any state — a short recipe changes nothing.
  const stacks = await world.getInventory(player.id);
  const have: Record<string, number> = {};
  for (const s of stacks) have[s.resourceId] = s.qty;

  if (!canCraft(have, recipe)) {
    const missing = Object.entries(recipe)
      .filter(([rid, qty]) => (have[rid] ?? 0) < qty)
      .map(([rid, qty]) => `${getResource(rid).name} ${have[rid] ?? 0}/${qty}`);
    return errorFrame(
      `Can't craft ${upgrade.name} — short on ${missing.join(", ")}.`,
    );
  }

  // Consume components atomically (each via the race-safe inventory RPC), then
  // grant the upgrade.
  for (const [rid, qty] of Object.entries(recipe)) {
    await world.removeInventory(player.id, rid, qty);
  }
  const owned = await world.addPlayerUpgrade(player.id, target, 1);

  const consumed = Object.entries(recipe)
    .map(([rid, qty]) => `${qty} ${getResource(rid).name}`)
    .join(" + ");
  return frame([
    line([
      text(`Crafted ${upgrade.name}. `, "success"),
      text(`Consumed ${consumed}. `, "muted"),
      text(`You now own ${owned}.`, "accent"),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// sell
// ---------------------------------------------------------------------------

async function handleSell(player: Player, args: string[]): Promise<RenderFrame> {
  const target = args[0]?.toLowerCase();
  if (!target) return errorFrame("Usage: sell <resource>  or  sell all");

  // Selling an upgrade is code-priced (no market drift); resource selling below
  // is unchanged.
  if (isUpgradeId(target)) return handleSellUpgrade(player, target, args[1]);

  const stacks = await world.getInventory(player.id);
  if (stacks.length === 0) return errorFrame("Nothing to sell — your hold is empty.");

  let toSell = stacks;
  if (target !== "all") {
    toSell = stacks.filter((s) => s.resourceId === target);
    if (toSell.length === 0) {
      return errorFrame(`You aren't carrying any ${target}.`);
    }
  }

  const prices = await world.getMarketPrices();
  let totalGain = 0;
  const soldLines: RenderFrame["lines"] = [];

  for (const stack of toSell) {
    const price = prices[stack.resourceId];
    if (price == null) {
      soldLines.push(
        line(text(`  no market for ${stack.resourceId} — skipped`, "muted")),
      );
      continue;
    }
    const gain = sellValue(price, stack.qty);
    totalGain += gain;
    const newPrice = priceAfterSale(price, stack.qty);
    await world.setMarketPrice(stack.resourceId, newPrice);
    await world.clearInventory(player.id, stack.resourceId);
    const res = getResource(stack.resourceId);
    soldLines.push(
      line([
        text(`  sold ${stack.qty} `, "success"),
        text(`${res.name} `, "default"),
        text(`for ${gain} cr  `, "accent"),
        text(`(price ${price}→${newPrice})`, "muted"),
      ]),
    );
  }

  if (totalGain === 0 && soldLines.every((l) => l[0]?.text?.includes("no market"))) {
    return errorFrame("Nothing sellable on the market right now.");
  }

  const newBalance = await world.addPlayerCredits(player.id, totalGain);
  return frame([
    line([
      text(`Sold for ${totalGain} cr. `, "success"),
      text(`Balance: ${newBalance} cr.`, "accent"),
    ]),
    ...soldLines,
  ]);
}

/**
 * Sell `qty` of an upgrade back for `upgradeValue` per unit (a bit above raw
 * component cost). Code-priced — upgrades aren't in the market and never drift.
 * Validates ownership before mutating; selling your last one drops the
 * capability.
 */
async function handleSellUpgrade(
  player: Player,
  upgradeId: string,
  qtyArg: string | undefined,
): Promise<RenderFrame> {
  const requested = qtyArg === undefined ? 1 : toInt(qtyArg);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: sell <upgrade> [qty]  — qty must be a positive whole number.");
  }
  const qty = requested;
  const upgrade = getUpgrade(upgradeId);

  const stacks = await world.getPlayerUpgrades(player.id);
  const ownedNow = stacks.find((s) => s.upgradeId === upgradeId)?.qty ?? 0;
  if (ownedNow < qty) {
    return errorFrame(
      `You only own ${ownedNow} ${upgrade.name} — can't sell ${qty}.`,
    );
  }

  const unit = upgradeValue(upgradeId);
  const total = unit * qty;
  const remaining = await world.addPlayerUpgrade(player.id, upgradeId, -qty);
  const newBalance = await world.addPlayerCredits(player.id, total);

  return frame([
    line([
      text(`Sold ${qty} ${upgrade.name} `, "success"),
      text(`for ${total} cr `, "accent"),
      text(`(${unit}/u). `, "muted"),
      text(`${remaining} left. Balance ${newBalance} cr.`, "accent"),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// buy fuel [n]  |  buy <resource> [qty]  |  buy <upgrade> [qty]
// ---------------------------------------------------------------------------

async function handleBuy(player: Player, args: string[]): Promise<RenderFrame> {
  const what = args[0]?.toLowerCase();
  if (!what) return errorFrame("Usage: buy fuel [n]  or  buy <resource> [qty]");
  if (what !== "fuel") {
    if (isUpgradeId(what)) return handleBuyUpgrade(player, what, args[1]);
    return handleBuyResource(player, what, args[1]);
  }

  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const maxAffordable = Math.floor(fresh.credits / FUEL_PRICE_PER_UNIT);
  const requested = toInt(args[1]);
  if (args[1] !== undefined && (requested === null || requested <= 0)) {
    return errorFrame("Usage: buy fuel [n]  — n must be a positive whole number.");
  }
  const want = requested ?? maxAffordable;
  const buy = Math.min(want, maxAffordable);

  if (buy <= 0) {
    return errorFrame(
      `Not enough credits: fuel is ${FUEL_PRICE_PER_UNIT} cr/unit and you have ${fresh.credits}.`,
    );
  }

  const cost = buy * FUEL_PRICE_PER_UNIT;
  const newFuel = fresh.fuel + buy;
  await world.addPlayerCredits(player.id, -cost);
  await world.setFuel(player.id, newFuel);

  return frame([
    line([
      text(`Bought ${buy} fuel for ${cost} cr. `, "success"),
      text(`Fuel ${newFuel}, credits ${fresh.credits - cost}.`, "muted"),
    ]),
  ]);
}

/**
 * Purchase a mineral from the global market at `buyUnitCost` (1.5× the current,
 * drift-adjusted price) per unit, which drives the shared price UP — the mirror
 * of `sell`. `resourceId` is already abbrev-resolved by the dispatcher.
 * Validates credits and cargo space BEFORE mutating; an error frame leaves all
 * state untouched.
 */
async function handleBuyResource(
  player: Player,
  resourceId: string,
  qtyArg: string | undefined,
): Promise<RenderFrame> {
  // Parse quantity (default 1; must be a positive whole number when supplied).
  const requested = qtyArg === undefined ? 1 : toInt(qtyArg);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: buy <resource> [qty]  — qty must be a positive whole number.");
  }
  const qty = requested;

  const price = await world.getMarketPrice(resourceId);
  if (price == null) {
    return errorFrame(`No market for ${resourceId} right now.`);
  }

  const res = getResource(resourceId);
  const unitCost = buyUnitCost(price);
  const total = unitCost * qty;

  const fresh = (await world.getPlayerById(player.id)) ?? player;
  if (fresh.credits < total) {
    return errorFrame(
      `Not enough credits: ${qty} ${res.name} costs ${total} cr (${unitCost}/u) and you have ${fresh.credits}.`,
    );
  }

  const used = await world.getCargoUsed(player.id);
  const cargoSpace = fresh.cargoCap - used;
  if (qty > cargoSpace) {
    return errorFrame(
      `Not enough cargo space: buying ${qty} needs ${qty} free, you have ${Math.max(0, cargoSpace)}.`,
    );
  }

  await world.addInventory(player.id, resourceId, qty);
  const newBalance = await world.addPlayerCredits(player.id, -total);
  const newPrice = priceAfterPurchase(price, qty);
  await world.setMarketPrice(resourceId, newPrice);

  return frame([
    line([
      text(`Bought ${qty} `, "success"),
      text(`${res.name} `, "default"),
      text(`for ${total} cr `, "accent"),
      text(`(${unitCost}/u). `, "muted"),
      text(`Balance ${newBalance} cr.`, "accent"),
    ]),
    line(text(`  price ${price}→${newPrice}`, "muted")),
  ]);
}

/**
 * Buy `qty` of an upgrade at `buyUnitCost(upgradeValue)` per unit (the existing
 * 1.5× markup over its code-derived value). Upgrades take no cargo space (not
 * in the hold), so only credits are validated before mutating.
 */
async function handleBuyUpgrade(
  player: Player,
  upgradeId: string,
  qtyArg: string | undefined,
): Promise<RenderFrame> {
  const requested = qtyArg === undefined ? 1 : toInt(qtyArg);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: buy <upgrade> [qty]  — qty must be a positive whole number.");
  }
  const qty = requested;
  const upgrade = getUpgrade(upgradeId);

  const unitCost = buyUnitCost(upgradeValue(upgradeId));
  const total = unitCost * qty;

  const fresh = (await world.getPlayerById(player.id)) ?? player;
  if (fresh.credits < total) {
    return errorFrame(
      `Not enough credits: ${qty} ${upgrade.name} costs ${total} cr (${unitCost}/u) and you have ${fresh.credits}.`,
    );
  }

  const owned = await world.addPlayerUpgrade(player.id, upgradeId, qty);
  const newBalance = await world.addPlayerCredits(player.id, -total);

  return frame([
    line([
      text(`Bought ${qty} ${upgrade.name} `, "success"),
      text(`for ${total} cr `, "accent"),
      text(`(${unitCost}/u). `, "muted"),
      text(`You now own ${owned}. Balance ${newBalance} cr.`, "accent"),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// who
// ---------------------------------------------------------------------------

async function handleWho(): Promise<RenderFrame> {
  const [topCredits, topDiscoveries] = await Promise.all([
    world.topByCredits(5),
    world.topByDiscoveries(5),
  ]);
  return renderWho({
    topCredits: topCredits.map((r) => ({ handle: r.handle, credits: r.credits })),
    topDiscoveries,
  });
}
