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
  parseLocationKey,
  warpDistance,
  getResource,
  RESOURCES,
  type SystemCoord,
  type PlanetCoord,
} from "@/lib/universe";
import type { RenderFrame, RenderLine } from "@/lib/terminal/types";
import { action, frame, line, text } from "@/lib/terminal/helpers";
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
  canProduce,
  canLand,
  landingRequirement,
  rollHazardDamage,
  creditsAfterDeath,
  combatRound,
  exploreOutcome,
  healValue,
  excavatorYield,
  baseCapacity,
  PLAYER_BASE_ATTACK,
  MAX_HEALTH,
  DEPLETION_PER_UNIT,
  FUEL_PRICE_PER_UNIT,
} from "./rules";
import {
  UPGRADES,
  UPGRADE_IDS,
  isUpgradeId,
  getUpgrade,
  recipeOf,
  upgradeValue,
  canBuyFromSupply,
} from "./upgrades";
import {
  PARTS,
  PART_IDS,
  isPartId,
  getPart,
} from "./parts";
import {
  isMaterialId,
  getMaterial,
  materialValue,
  pickScavenge,
  isFoodId,
  FOOD_IDS,
  foodRecipeOf,
  healOf,
} from "./materials";
import {
  FLORA,
  FAUNA,
  getFauna,
  pickForBiome,
} from "./wildlife";
import {
  BASE_BUILD_COST,
  BASE_BUILD_CREDITS,
  BASE_BUILD_MINERALS,
  canAffordBase,
  isStructureKind,
  buildingCost,
  creditsOf,
  mineralsOf,
  type StructureKind,
} from "./bases";
import {
  renderHelp,
  renderCommandHelp,
  renderScan,
  renderRegions,
  renderMap,
  renderInventory,
  renderUpgrades,
  renderBases,
  renderStorage,
  renderWho,
  errorFrame,
  type MapNeighbor,
  type RegionListEntry,
  type CommandHelpSlotView,
  type CommandHelpGroup,
  type EncounterView,
  type ScanBase,
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
  const rKey = regionKey(region.coord);
  const [depletionMap, justDiscovered, owned, regionBases] = await Promise.all([
    world.getEffectiveDepletionMap(rKey),
    world.recordDiscovery(planetKey(coord), player.id),
    world.getOwnedUpgradeIds(player.id),
    world.basesInRegion(rKey),
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
    encounter: encounterView(player),
    // Shared-world presence: bases here, yours marked, others shown by handle.
    bases: regionBases.map((b): ScanBase => ({
      handle: b.handle,
      name: b.name,
      mine: b.ownerId === player.id,
    })),
  });
}

/**
 * Build the scan-side view of the player's active combat encounter (or null when
 * not fighting). Resolves the creature's catalog name + max HP for display.
 */
function encounterView(player: Player): EncounterView | null {
  if (!player.encounter) return null;
  const fauna = getFauna(player.encounter.faunaId);
  if (!fauna) return null;
  return {
    name: fauna.name,
    hp: player.encounter.hp,
    maxHp: fauna.maxHp,
    hostile: fauna.hostile,
  };
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
 * every upgrade id, and the material ids the player currently owns (so `sell ab`
 * / `sell prec` abbreviate; the handler validates you actually own each). Upgrade
 * ids are always included since they're code-priced; materials are listed only
 * when held so the abbreviation surface stays small.
 */
async function sellableHere(player: Player): Promise<string[]> {
  const [stacks, materials] = await Promise.all([
    world.getInventory(player.id),
    world.getPlayerMaterials(player.id),
  ]);
  return [
    ...stacks.map((s) => s.resourceId),
    "all",
    ...UPGRADE_IDS,
    ...materials.map((m) => m.materialId),
  ];
}

/**
 * The contextual candidate sets the resolver/help need for a verb's resolvable
 * arguments. Only `mine`/`sell` read world state; the rest are static, so we
 * skip the DB for them. Prefetched (the resolver's `argDomain` is synchronous).
 */
interface ArgDomainContext {
  mineCandidates: string[] | null;
  sellCandidates: string[] | null;
  /** Owned food ids — the `eat` arg domain (you can only eat what you carry). */
  eatCandidates: string[] | null;
  /** Held resource ids — the `deposit` arg domain (you can only deposit what you carry). */
  depositCandidates: string[] | null;
  /** Item ids in this region's base storage — the `withdraw` arg domain. */
  withdrawCandidates: string[] | null;
}

const EMPTY_ARG_CONTEXT: ArgDomainContext = {
  mineCandidates: null,
  sellCandidates: null,
  eatCandidates: null,
  depositCandidates: null,
  withdrawCandidates: null,
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
    return { ...EMPTY_ARG_CONTEXT, mineCandidates: await minableHere(player, seed) };
  }
  if (verb === "sell") {
    return { ...EMPTY_ARG_CONTEXT, sellCandidates: await sellableHere(player) };
  }
  if (verb === "eat") {
    const materials = await world.getPlayerMaterials(player.id);
    const owned = materials.map((m) => m.materialId).filter(isFoodId);
    return { ...EMPTY_ARG_CONTEXT, eatCandidates: owned };
  }
  if (verb === "deposit") {
    // You can only deposit resources you're carrying.
    const stacks = await world.getInventory(player.id);
    return { ...EMPTY_ARG_CONTEXT, depositCandidates: stacks.map((s) => s.resourceId) };
  }
  if (verb === "withdraw") {
    // You can only withdraw items your base here is storing — and only raw
    // resources (ship PARTS stay siloed as production intermediates; P9 wires
    // them out). Parts are filtered from the domain so abbrev/help never offer
    // an item the handler would reject.
    const base = await world.getBaseInRegion(player.id, regionKey(regionAt(seed, locOf(player), player.region).coord));
    const stored = base ? await world.getBaseStorage(base.id) : [];
    return {
      ...EMPTY_ARG_CONTEXT,
      withdrawCandidates: stored.map((s) => s.itemId).filter((id) => !isPartId(id)),
    };
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
      if (verb === "eat" && argIndex === 0) return ctx.eatCandidates;
      if (verb === "deposit" && argIndex === 0) return ctx.depositCandidates;
      if (verb === "withdraw" && argIndex === 0) return ctx.withdrawCandidates;
      // `build`'s structure domain: the base itself plus the in-base structures
      // (P8a silos/excavators, P8b production lines).
      if (verb === "build" && argIndex === 0) return ["base", "silo", "excavator", "production_line"];
      // `produce`'s domain: the ship parts a production line banks into storage,
      // PLUS the upgrades it manufactures (P9a — consuming siloed parts, granting
      // the upgrade to the player).
      if (verb === "produce" && argIndex === 0) return [...PART_IDS, ...UPGRADE_IDS];
      // `craft` now only cooks food (P9a — upgrades moved to `produce`). Its arg
      // is OPAQUE: `handleCraft` resolves a food prefix itself, so a fully-typed
      // upgrade id reaches the handler and gets a redirect to `produce` (rather
      // than a bare "no such" from the resolver). Foods abbreviate handler-side.
      if (verb === "craft" && argIndex === 0) return null;
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
 * Commands that require being ON FOOT in the region: surface work (mining and
 * the P5 exploration/combat loop). Attempting them from the ship is blocked with
 * a message naming the fix (`disembark`). `attack`/`flee` additionally require an
 * active encounter — their handlers check that after this gate.
 */
const DISEMBARKED_ONLY = new Set(["mine", "explore", "harvest", "attack", "flee", "build"]);

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
    return errorFrame("You must `disembark` onto the surface first.");
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
      return handleExplore(player, seed);
    case "harvest":
      return handleHarvest(player, seed);
    case "attack":
      return handleAttack(player);
    case "flee":
      return handleFlee(player);
    case "inventory":
      return handleInventory(player);
    case "upgrades":
      return handleUpgrades(player);
    case "craft":
      return handleCraft(player, args);
    case "eat":
      return handleEat(player, args);
    case "build":
      return handleBuild(player, seed, args);
    case "bases":
      return handleBases(player);
    case "base":
    case "storage":
      return handleStorage(player, seed);
    case "deposit":
      return handleDeposit(player, seed, args);
    case "withdraw":
      return handleWithdraw(player, seed, args);
    case "collect":
      return handleCollect(player, seed);
    case "produce":
      return handleProduce(player, seed, args);
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
    case "eat":
      return "no food on hand — `craft` a meal first";
    case "deposit":
      return "your hold is empty — `mine` something first";
    case "withdraw":
      return "this base is storing nothing — `deposit` or `collect` first";
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

  // Death: the shared sequence (lose 10% credits, restore HP, wake aboard).
  const deathLines = await runDeath(
    player,
    `You succumbed to ${planet.name} (hazard ${hazardPct}%). You wake aboard your ship, 10% of your gold lost.`,
  );
  return frame([mineLine, ...deathLines]);
}

/**
 * The shared death sequence (P4): lose `DEATH_GOLD_PENALTY` of credits (atomic
 * delta via the credits RPC, floored at 0 by `creditsAfterDeath`), clear any
 * active combat encounter, restore full health, and wake aboard the ship
 * (location unchanged). Returns the two report lines (a danger cause line + a
 * muted balance line); the caller prepends whatever action line preceded death.
 */
async function runDeath(player: Player, causeText: string): Promise<RenderLine[]> {
  const after = creditsAfterDeath(player.credits);
  const lost = player.credits - after;
  if (lost > 0) await world.addPlayerCredits(player.id, -lost);
  if (player.encounter) await world.setEncounter(player.id, null);
  await world.setHealthAndEmbarked(player.id, MAX_HEALTH, true);
  return [
    line(text(causeText, "danger")),
    line(text(`Lost ${lost} cr (balance ${after}). HP restored to ${MAX_HEALTH}.`, "muted")),
  ];
}

// ---------------------------------------------------------------------------
// explore / harvest / attack / flee — the on-foot wildlife & combat loop (P5).
// All disembarked-only (gated in `dispatchResolved`). `explore` rolls a scavenge
// / flora / fauna outcome then takes a hazard hit (it can kill you → death
// sequence); `harvest` collects a biome plant; `attack`/`flee` act on the
// current `encounter`. The math is pure (`rules.ts` / `wildlife.ts` / catalogs);
// these handlers supply the real `Math.random()` rolls and persist via `world`.
// ---------------------------------------------------------------------------

/**
 * `explore` — search the current region on foot. Rolls `exploreOutcome`:
 *  - scavenge → award a scavenged material (relics rare & valuable);
 *  - flora    → describe a biome plant and offer `harvest`;
 *  - fauna    → describe a biome creature; a hostile one starts an `encounter`
 *               (you must `attack`/`flee`), a placid one is merely attackable.
 * Then the surface hazard rolls (exploring is dangerous): on a hit, subtract
 * health, and run the death sequence if it reaches 0. Gated like `mine` — a
 * hostile (freezing/boiling) surface needs the matching upgrade.
 */
async function handleExplore(player: Player, seed: string): Promise<RenderFrame> {
  const coord = locOf(player);
  const planet = planetAt(seed, coord);

  // Same surface gate as `mine`/`land`: you can't safely roam a hostile world
  // without the matching upgrade. No state change when blocked.
  const owned = await world.getOwnedUpgradeIds(player.id);
  const gate = canLand(planet.temperature, owned);
  if (!gate.ok) {
    const up = getUpgrade(gate.required);
    const why = planet.temperature < 0 ? "freezing" : "boiling";
    return errorFrame(
      `${planet.name} is ${why} (${planet.temperature}°C) — exploring requires ${up.name}. \`craft\` or \`buy\` it first.`,
    );
  }

  const region = regionAt(seed, coord, player.region);
  const biome = region.biome;
  const outcome = exploreOutcome(Math.random());
  const lines: RenderLine[] = [];

  if (outcome === "scavenge") {
    const material = pickScavenge(Math.random());
    const qty = 1;
    await world.addPlayerMaterial(player.id, material.id, qty);
    const relic = material.category === "relic";
    lines.push(
      line([
        text(relic ? "You unearth a " : "You scavenge ", relic ? "success" : "default"),
        text(`${material.name}`, relic ? "accent" : "default"),
        text(relic ? "! A rare relic — worth a fortune." : ` (${material.category}).`, "muted"),
      ]),
    );
    lines.push(
      line([
        text(`+${qty} ${material.name}. `, "success"),
        text("`embark` then `sell` it at market.", "muted"),
      ]),
    );
  } else if (outcome === "flora") {
    const flora = pickForBiome(FLORA, biome, Math.random());
    if (flora) {
      lines.push(
        line([
          text("You find ", "default"),
          text(`${flora.name}`, "accent"),
          text(` growing across the ${biome}. `, "muted"),
          action("harvest", "harvest", { style: "link", title: `harvest ${flora.name}` }),
          text(" it.", "muted"),
        ]),
      );
    } else {
      lines.push(line(text(`Nothing worth harvesting in this ${biome}.`, "muted")));
    }
  } else {
    const fauna = pickForBiome(FAUNA, biome, Math.random());
    if (fauna) {
      // Setting the encounter for BOTH hostile and placid fauna gives `attack` a
      // target either way; only hostile creatures are framed as a forced fight.
      await world.setEncounter(player.id, { faunaId: fauna.id, hp: fauna.maxHp });
      if (fauna.hostile) {
        lines.push(
          line([
            text("A hostile ", "danger"),
            text(`${fauna.name}`, "accent"),
            text(` lunges at you! (HP ${fauna.maxHp}, attack ${fauna.attack})`, "muted"),
          ]),
        );
      } else {
        lines.push(
          line([
            text("You come across a ", "default"),
            text(`${fauna.name}`, "accent"),
            text(`. It eyes you warily but doesn't attack. (HP ${fauna.maxHp})`, "muted"),
          ]),
        );
      }
      lines.push(
        line([
          action("attack", "attack", { style: "link", title: `attack the ${fauna.name}` }),
          text(" it for its materials, or ", "muted"),
          action("flee", "flee", { style: "link", title: "break off" }),
          text(".", "muted"),
        ]),
      );
    } else {
      lines.push(line(text(`No creatures stir in this ${biome}.`, "muted")));
    }
  }

  // Surface hazard: exploring exposes you to harm exactly like mining does.
  const damage = rollHazardDamage(planet.hazard, Math.random(), Math.random());
  if (damage <= 0) return frame(lines);

  const hazardPct = Math.round(planet.hazard * 100);
  const newHealth = player.health - damage;
  if (newHealth > 0) {
    await world.setHealth(player.id, newHealth);
    lines.push(
      line(
        text(
          `${planet.name} wounds you for ${damage} (hazard ${hazardPct}%). HP ${newHealth}/${MAX_HEALTH}.`,
          "danger",
        ),
      ),
    );
    return frame(lines);
  }

  const deathLines = await runDeath(
    player,
    `You succumbed to ${planet.name} (hazard ${hazardPct}%). You wake aboard your ship, 10% of your gold lost.`,
  );
  return frame([...lines, ...deathLines]);
}

/**
 * `harvest` — collect a biome-appropriate plant from the current region and
 * award its `harvest` material. Re-rolls a region-valid flora (spec allows
 * harvesting the most-recent / a fresh biome plant); gentle — no hazard roll.
 */
async function handleHarvest(player: Player, seed: string): Promise<RenderFrame> {
  const coord = locOf(player);
  const region = regionAt(seed, coord, player.region);
  const flora = pickForBiome(FLORA, region.biome, Math.random());
  if (!flora) {
    return errorFrame(`No harvestable plants in this ${region.biome}. Try \`explore\`.`);
  }
  const mat = getMaterial(flora.harvest.materialId);
  const qty = flora.harvest.qty;
  await world.addPlayerMaterial(player.id, flora.harvest.materialId, qty);
  return frame([
    line([
      text(`You harvest ${flora.name} — `, "success"),
      text(`+${qty} ${mat.name}`, "accent"),
      text(`. \`embark\` then \`sell\` to cash it in.`, "muted"),
    ]),
  ]);
}

/**
 * `attack` — one simultaneous `combatRound` against the creature in the active
 * `encounter`, using `PLAYER_BASE_ATTACK` vs the creature's `attack`. Both take
 * damage at once. If the creature dies you take its `drop` and the encounter
 * ends; if you die the death sequence runs (and clears the encounter); otherwise
 * both HPs are reported and combat continues.
 */
async function handleAttack(player: Player): Promise<RenderFrame> {
  const enc = player.encounter;
  if (!enc) {
    return errorFrame("Nothing to attack — `explore` to find creatures.");
  }
  const fauna = getFauna(enc.faunaId);
  if (!fauna) {
    // Defensive: stale/unknown encounter id — clear it rather than throw.
    await world.setEncounter(player.id, null);
    return errorFrame("The creature is gone. `explore` to find another.");
  }

  const round = combatRound({
    playerHp: player.health,
    playerAtk: PLAYER_BASE_ATTACK,
    creatureHp: enc.hp,
    creatureAtk: fauna.attack,
  });

  const youHit = line([
    text(`You strike the ${fauna.name} for ${PLAYER_BASE_ATTACK}. `, "default"),
    text(
      fauna.attack > 0 ? `It hits back for ${fauna.attack}.` : "It doesn't fight back.",
      fauna.attack > 0 ? "danger" : "muted",
    ),
  ]);

  if (round.creatureDead) {
    // Victory: grant the drop and end the encounter. (If you ALSO died this
    // round, the death sequence below still runs — you slew it as you fell.)
    const mat = getMaterial(fauna.drop.materialId);
    await world.addPlayerMaterial(player.id, fauna.drop.materialId, fauna.drop.qty);
    await world.setEncounter(player.id, null);

    if (round.playerDead) {
      const deathLines = await runDeath(
        player,
        `You killed the ${fauna.name} but fell with it. You wake aboard your ship, 10% of your gold lost.`,
      );
      return frame([
        youHit,
        line([
          text(`The ${fauna.name} dies. `, "success"),
          text(`You loot +${fauna.drop.qty} ${mat.name}.`, "accent"),
        ]),
        ...deathLines,
      ]);
    }

    if (player.health !== round.playerHp) {
      await world.setHealth(player.id, round.playerHp);
    }
    return frame([
      youHit,
      line([
        text(`You slay the ${fauna.name}! `, "success"),
        text(`Loot: +${fauna.drop.qty} ${mat.name}. `, "accent"),
        text(`HP ${round.playerHp}/${MAX_HEALTH}.`, "muted"),
      ]),
    ]);
  }

  if (round.playerDead) {
    const deathLines = await runDeath(
      player,
      `The ${fauna.name} kills you. You wake aboard your ship, 10% of your gold lost.`,
    );
    return frame([youHit, ...deathLines]);
  }

  // Both survive: update the creature's HP and your health, fight continues.
  await world.setEncounter(player.id, { faunaId: enc.faunaId, hp: round.creatureHp });
  await world.setHealth(player.id, round.playerHp);
  return frame([
    youHit,
    line([
      text(`${fauna.name} HP ${round.creatureHp}/${fauna.maxHp}. `, "default"),
      text(`Your HP ${round.playerHp}/${MAX_HEALTH}. `, "muted"),
      action("attack", "attack", { style: "link", title: "strike again" }),
      text(" or ", "muted"),
      action("flee", "flee", { style: "link", title: "break off" }),
      text(".", "muted"),
    ]),
  ]);
}

/**
 * `flee` — break off the active encounter and clear it. Gentle: no parting hit.
 * Errors helpfully when you're not in combat.
 */
async function handleFlee(player: Player): Promise<RenderFrame> {
  const enc = player.encounter;
  if (!enc) {
    return errorFrame("You're not in combat. `explore` to find creatures.");
  }
  const fauna = getFauna(enc.faunaId);
  await world.setEncounter(player.id, null);
  return frame([
    line([
      text("You break off and slip away", "success"),
      text(fauna ? ` from the ${fauna.name}.` : ".", "muted"),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------

async function handleInventory(player: Player): Promise<RenderFrame> {
  const [stacks, prices, materials] = await Promise.all([
    world.getInventory(player.id),
    world.getMarketPrices(),
    world.getPlayerMaterials(player.id),
  ]);
  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const cargoUsed = stacks.reduce((sum, s) => sum + s.qty, 0);
  return renderInventory({
    stacks: stacks.map((s) => ({
      resourceId: s.resourceId,
      qty: s.qty,
      price: prices[s.resourceId] ?? null,
    })),
    // Materials are sellable but not in the cargo hold (no space cost), like
    // upgrades — listed with their fixed value so you know what they fetch.
    materials: materials.map((m) => ({
      materialId: m.materialId,
      qty: m.qty,
      name: getMaterial(m.materialId).name,
      value: materialValue(m.materialId),
      heal: getMaterial(m.materialId).heal,
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
  const [stacks, supplies] = await Promise.all([
    world.getPlayerUpgrades(player.id),
    world.getUpgradeSupplies(),
  ]);
  return renderUpgrades({
    owned: stacks.map((s) => ({ upgradeId: s.upgradeId, qty: s.qty })),
    // The shared, finite market supply per upgrade (P9a) — buyable while > 0.
    market: UPGRADES.map((u) => ({
      upgradeId: u.id,
      supply: supplies[u.id] ?? 0,
      price: buyUnitCost(upgradeValue(u.id)),
    })),
  });
}

// ---------------------------------------------------------------------------
// craft  (cook one food from materials; upgrades are now `produce`d — P9a)
// ---------------------------------------------------------------------------

async function handleCraft(player: Player, args: string[]): Promise<RenderFrame> {
  const target = args[0]?.toLowerCase();
  if (!target) return errorFrame("Usage: craft <food>  (see `inventory`; upgrades are `produce`d)");

  // P9a: ship upgrades are MANUFACTURED goods now — `produce` them at a base's
  // production line from siloed parts. Catch a (fully-typed) upgrade id here and
  // redirect, since `craft`'s arg is opaque (upgrades left its abbrev domain).
  if (isUpgradeId(target)) {
    const upgrade = getUpgrade(target);
    return errorFrame(
      `${upgrade.name} is manufactured, not crafted — \`produce ${target}\` at a base with a production line.`,
    );
  }

  // `craft` only cooks food now (from MATERIAL ingredients in player_materials).
  // The arg is opaque, so resolve a food id / unique prefix handler-side (foods
  // still abbreviate: `craft ber` → the berry dish).
  const fr = resolveToken(target, [...FOOD_IDS]);
  if (!fr.ok) {
    if (fr.reason === "ambiguous") {
      return errorFrame(`Ambiguous food '${target}' — did you mean: ${fr.matches.join(", ")}?`);
    }
    return errorFrame(`Can't craft "${target}". \`craft\` cooks food; upgrades are \`produce\`d.`);
  }
  return handleCookFood(player, fr.value);
}

/**
 * Cook one food from its material recipe (P6). Mirrors the upgrade-craft path
 * but reads/consumes from `player_materials` (the harvested/looted goods) rather
 * than the cargo hold: validate the recipe is fully covered with `canCraft`
 * BEFORE touching state, then consume each ingredient atomically via the
 * material RPC and grant one of the food. Cooking is allowed in either embark
 * state (it's not gated). `foodId` is already validated by `handleCraft`.
 */
async function handleCookFood(player: Player, foodId: string): Promise<RenderFrame> {
  const food = getMaterial(foodId);
  const recipe = foodRecipeOf(foodId);

  const stacks = await world.getPlayerMaterials(player.id);
  const have: Record<string, number> = {};
  for (const s of stacks) have[s.materialId] = s.qty;

  if (!canCraft(have, recipe)) {
    const missing = Object.entries(recipe)
      .filter(([mid, qty]) => (have[mid] ?? 0) < qty)
      .map(([mid, qty]) => `${getMaterial(mid).name} ${have[mid] ?? 0}/${qty}`);
    return errorFrame(`Can't cook ${food.name} — short on ${missing.join(", ")}.`);
  }

  // Consume ingredients atomically, then grant the cooked food.
  for (const [mid, qty] of Object.entries(recipe)) {
    await world.addPlayerMaterial(player.id, mid, -qty);
  }
  const owned = await world.addPlayerMaterial(player.id, foodId, 1);

  const consumed = Object.entries(recipe)
    .map(([mid, qty]) => `${qty} ${getMaterial(mid).name}`)
    .join(" + ");
  return frame([
    line([
      text(`Cooked ${food.name}. `, "success"),
      text(`Consumed ${consumed}. `, "muted"),
      text(`+${food.heal ?? 0} HP when eaten; you now hold ${owned}.`, "accent"),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// eat  (consume one food to restore health, capped at MAX_HEALTH)
// ---------------------------------------------------------------------------

/**
 * `eat <food>` — consume one owned food and restore health by its `heal`, never
 * overhealing past `MAX_HEALTH` (`healValue`). Validates ownership + edibility
 * before mutating: an inedible material or one you don't carry errors with no
 * state change. Allowed in either embark state (you take damage on foot, but a
 * snack aboard ship is fine too). Reports HP before→after.
 */
async function handleEat(player: Player, args: string[]): Promise<RenderFrame> {
  const target = args[0]?.toLowerCase();
  if (!target) return errorFrame("Usage: eat <food>  (see `inventory`)");
  if (!isFoodId(target)) {
    if (isMaterialId(target)) {
      return errorFrame(`${getMaterial(target).name} isn't edible. \`eat\` a cooked food.`);
    }
    return errorFrame(`Unknown food "${target}". \`craft\` a meal first.`);
  }

  const food = getMaterial(target);
  const stacks = await world.getPlayerMaterials(player.id);
  const ownedNow = stacks.find((s) => s.materialId === target)?.qty ?? 0;
  if (ownedNow <= 0) {
    return errorFrame(`You don't have any ${food.name} — \`craft\` one first.`);
  }

  // Read the freshest HP (other actions may have changed it) and heal off that.
  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const before = fresh.health;
  if (before >= MAX_HEALTH) {
    return errorFrame(`You're already at full health (${MAX_HEALTH}/${MAX_HEALTH}).`);
  }

  const heal = healOf(target);
  const after = healValue(before, heal, MAX_HEALTH);
  await world.addPlayerMaterial(player.id, target, -1);
  await world.setHealth(player.id, after);

  const remaining = ownedNow - 1;
  return frame([
    line([
      text(`You eat the ${food.name}. `, "success"),
      text(`HP ${before} → ${after}/${MAX_HEALTH}`, "accent"),
      text(`  (+${after - before}). ${remaining} left.`, "muted"),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// build / bases — establish a base in the current region (P7) and list yours.
// `build` is disembarked-only (surface infrastructure, gated like `mine`) and
// now accepts `base`, `silo` and `excavator` (P8a). The silo/excavator path,
// plus `deposit`/`withdraw`/`collect`/`storage`, live further below.
// ---------------------------------------------------------------------------

/**
 * `build <structure> [name]` — establish a base (`build base`) or add an in-base
 * structure (`build silo` / `build excavator`) in the player's current region.
 * Disembarked-only (gated in `dispatchResolved`). Routes to the base or building
 * path; an unknown structure errors without touching state.
 */
async function handleBuild(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const structure = args[0]?.toLowerCase();
  if (!structure) return errorFrame("Usage: build <base|silo|excavator|production_line> [name]");
  if (structure === "base") return handleBuildBase(player, seed, args);
  if (isStructureKind(structure)) return handleBuildStructure(player, seed, structure);
  return errorFrame(
    `Can't build "${structure}" — try \`base\`, \`silo\`, \`excavator\` or \`production_line\`.`,
  );
}

/**
 * Build the `have` map (credits + cargo) used to check a cost map's affordability.
 */
async function affordContext(player: Player): Promise<Record<string, number>> {
  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const stacks = await world.getInventory(player.id);
  const have: Record<string, number> = { credits: fresh.credits };
  for (const s of stacks) have[s.resourceId] = s.qty;
  return have;
}

/** Consume a build cost atomically: minerals from cargo, then credits. */
async function consumeCost(playerId: string, cost: Record<string, number>): Promise<void> {
  for (const [rid, qty] of Object.entries(mineralsOf(cost))) {
    await world.removeInventory(playerId, rid, qty);
  }
  const credits = creditsOf(cost);
  if (credits > 0) await world.addPlayerCredits(playerId, -credits);
}

/** Refund a previously-consumed cost (used when a create race loses). */
async function refundCost(playerId: string, cost: Record<string, number>): Promise<void> {
  for (const [rid, qty] of Object.entries(mineralsOf(cost))) {
    await world.addInventory(playerId, rid, qty);
  }
  const credits = creditsOf(cost);
  if (credits > 0) await world.addPlayerCredits(playerId, credits);
}

/** Render a cost map as a "5 Iron + 300 cr" cost summary. */
function costSummary(cost: Record<string, number>): string {
  return [
    ...Object.entries(mineralsOf(cost)).map(([rid, qty]) => `${qty} ${getResource(rid).name}`),
    ...(creditsOf(cost) > 0 ? [`${creditsOf(cost)} cr`] : []),
  ].join(" + ");
}

/**
 * `build base [name]` — establish a base in the player's current region. Charges
 * the tunable `BASE_BUILD_COST` (credits + mineral ingredients from the cargo
 * hold). Validates no existing base here and affordability BEFORE mutating; the
 * cost is consumed atomically and only then is the base created. A lost create
 * race (unique constraint) refunds the cost, so a failure never leaves you
 * charged without a base. Other players see the base via `scan` (public-read).
 */
async function handleBuildBase(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  // The (optional) name is a free-form, case-preserved opaque tail.
  const name = args.slice(1).join(" ").trim() || undefined;

  const coord = locOf(player);
  const region = regionAt(seed, coord, player.region);
  const rKey = regionKey(region.coord);
  const planet = planetAt(seed, coord);

  // No-duplicate: one base per region per player.
  const owned = await world.basesOwnedBy(player.id);
  if (owned.some((b) => b.regionKey === rKey)) {
    return errorFrame(
      `You already have a base in region ${player.region} of ${planet.name}.`,
    );
  }

  // Affordability: credits (live balance) + mineral ingredients (cargo hold).
  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const stacks = await world.getInventory(player.id);
  const have: Record<string, number> = { credits: fresh.credits };
  for (const s of stacks) have[s.resourceId] = s.qty;
  if (!canAffordBase(have, BASE_BUILD_COST)) {
    const short = Object.entries(BASE_BUILD_COST)
      .filter(([k, q]) => (have[k] ?? 0) < q)
      .map(([k, q]) =>
        k === "credits"
          ? `${q} cr (have ${have.credits ?? 0})`
          : `${q} ${getResource(k).name} (have ${have[k] ?? 0})`,
      );
    return errorFrame(`Can't build a base — short on ${short.join(", ")}.`);
  }

  // Consume the cost atomically (minerals from cargo, then credits), then build.
  await consumeCost(player.id, BASE_BUILD_COST);

  const created = await world.createBase(player.id, rKey, name);
  if (!created) {
    // Lost a race (a base appeared between our check and the insert): refund the
    // cost so nothing is consumed on this failure.
    await refundCost(player.id, BASE_BUILD_COST);
    return errorFrame(
      `You already have a base in region ${player.region} of ${planet.name}.`,
    );
  }

  const costParts = [
    ...Object.entries(BASE_BUILD_MINERALS).map(
      ([rid, qty]) => `${qty} ${getResource(rid).name}`,
    ),
    `${BASE_BUILD_CREDITS} cr`,
  ];
  return frame([
    line([
      text("Base established", "success"),
      text(name ? ` "${name}"` : "", "accent"),
      text(` in region ${player.region} of ${planet.name}. `, "default"),
      text(`Cost: ${costParts.join(" + ")}.`, "muted"),
    ]),
    line([
      text("Other pilots can see it here. ", "muted"),
      action("bases", "bases", { style: "link", title: "list your bases" }),
      text(" to review your bases.", "muted"),
    ]),
  ]);
}

/** `bases` — list the bases the player owns (region coords + name). */
async function handleBases(player: Player): Promise<RenderFrame> {
  const owned = await world.basesOwnedBy(player.id);
  return renderBases({
    bases: owned.map((b) => ({
      name: b.name,
      regionKey: b.regionKey,
      location: describeRegionKey(b.regionKey),
    })),
  });
}

/**
 * A friendly one-line label for a 6-segment region key, for the `bases` listing
 * — e.g. `galaxy 0 · arm 1 · cluster 2 · system 7 · planet 0 · region 42`. Falls
 * back to the raw key if it doesn't parse as a region coord.
 */
function describeRegionKey(key: string): string {
  try {
    const c = parseLocationKey(key);
    if ("region" in c) {
      return `galaxy ${c.galaxy} · arm ${c.arm} · cluster ${c.cluster} · system ${c.system} · planet ${c.planet} · region ${c.region}`;
    }
  } catch {
    /* fall through to the raw key */
  }
  return key;
}

// ---------------------------------------------------------------------------
// build silo / excavator — in-base structures (P8a). Disembarked-only (gated in
// `dispatchResolved`); additionally require owning a base in the current region.
// deposit / withdraw / collect / storage operate on that base's storage and
// excavators below.
// ---------------------------------------------------------------------------

/**
 * `build silo` / `build excavator` — add a structure to the base in the player's
 * current region. Requires a base here (helpful error otherwise) and charges the
 * structure's tunable cost (credits + minerals). Validates ownership +
 * affordability BEFORE mutating; the cost is consumed atomically, then the
 * building row is created (an excavator starts with `lastCollectedAt = now`, so
 * it accrues from the moment it's built).
 */
async function handleBuildStructure(
  player: Player,
  seed: string,
  kind: StructureKind,
): Promise<RenderFrame> {
  const coord = locOf(player);
  const region = regionAt(seed, coord, player.region);
  const rKey = regionKey(region.coord);
  const planet = planetAt(seed, coord);

  const base = await world.getBaseInRegion(player.id, rKey);
  if (!base) {
    return errorFrame(
      `No base here to build in — \`build base\` first (region ${player.region} of ${planet.name}).`,
    );
  }

  const cost = buildingCost(kind);
  const have = await affordContext(player);
  if (!canAffordBase(have, cost)) {
    const short = Object.entries(cost)
      .filter(([k, q]) => (have[k] ?? 0) < q)
      .map(([k, q]) =>
        k === "credits"
          ? `${q} cr (have ${have.credits ?? 0})`
          : `${q} ${getResource(k).name} (have ${have[k] ?? 0})`,
      );
    return errorFrame(`Can't build a ${kind} — short on ${short.join(", ")}.`);
  }

  await consumeCost(player.id, cost);
  const state = kind === "excavator" ? { lastCollectedAt: new Date().toISOString() } : {};
  await world.createBaseBuilding(base.id, kind, state);

  const buildings = await world.getBaseBuildings(base.id);
  const silos = buildings.filter((b) => b.kind === "silo").length;
  const excavators = buildings.filter((b) => b.kind === "excavator").length;
  const lines = buildings.filter((b) => b.kind === "production_line").length;
  const detail =
    kind === "silo"
      ? `Storage capacity is now ${baseCapacity(silos)} (${silos} silo${silos === 1 ? "" : "s"}).`
      : kind === "excavator"
        ? `${excavators} excavator${excavators === 1 ? "" : "s"} now draining this region — \`collect\` to funnel ore in.`
        : `${lines} production line${lines === 1 ? "" : "s"} ready — \`produce <part>\` to manufacture from siloed minerals.`;
  return frame([
    line([
      text(`Built a ${kind} `, "success"),
      text(`in region ${player.region} of ${planet.name}. `, "default"),
      text(`Cost: ${costSummary(cost)}.`, "muted"),
    ]),
    line(text(detail, "muted")),
  ]);
}

/**
 * Display name for an item in base storage. Storage holds both raw resources
 * (deposited / collected) and manufactured ship parts (`produce`d), so a plain
 * `getResource` would throw on a part id — resolve parts first, then resources.
 */
function storageItemName(itemId: string): string {
  if (isPartId(itemId)) return getPart(itemId).name;
  return getResource(itemId).name;
}

/** Resolve the base the player owns in their current region (or null). */
async function baseHere(
  player: Player,
  seed: string,
): Promise<{ id: string; name: string | null; rKey: string } | null> {
  const region = regionAt(seed, locOf(player), player.region);
  const rKey = regionKey(region.coord);
  const base = await world.getBaseInRegion(player.id, rKey);
  return base ? { id: base.id, name: base.name, rKey } : null;
}

/**
 * `storage` (alias `base`) — show the current region's base: its silo/excavator
 * counts, and its stored contents against the silo-derived capacity. Either
 * embark state is fine — it's your base.
 */
async function handleStorage(player: Player, seed: string): Promise<RenderFrame> {
  const base = await baseHere(player, seed);
  const planet = planetAt(seed, locOf(player));
  if (!base) {
    return errorFrame(
      `No base in region ${player.region} of ${planet.name}. \`disembark\` then \`build base\`.`,
    );
  }
  const [buildings, stored] = await Promise.all([
    world.getBaseBuildings(base.id),
    world.getBaseStorage(base.id),
  ]);
  const silos = buildings.filter((b) => b.kind === "silo").length;
  const excavators = buildings.filter((b) => b.kind === "excavator").length;
  const productionLines = buildings.filter((b) => b.kind === "production_line").length;
  const capacity = baseCapacity(silos);
  const used = stored.reduce((sum, s) => sum + s.qty, 0);
  return renderStorage({
    name: base.name,
    location: describeRegionKey(base.rKey),
    silos,
    excavators,
    productionLines,
    used,
    capacity,
    items: stored.map((s) => ({ itemId: s.itemId, qty: s.qty, name: storageItemName(s.itemId) })),
    // What a production line here can manufacture (only surfaced when one exists).
    producible:
      productionLines > 0
        ? PARTS.map((p) => ({
            id: p.id,
            name: p.name,
            recipe: Object.entries(p.recipe)
              .map(([rid, qty]) => `${qty} ${getResource(rid).name}`)
              .join(" + "),
          }))
        : [],
  });
}

/**
 * `deposit <item> [qty]` — move a resource from your ship cargo into this
 * region's base storage. Requires a base here; either embark state is fine.
 * Bounded by what you hold AND remaining storage capacity. With no `qty`,
 * deposits as much as fits. Atomic: `add_inventory(-)` then `add_base_storage(+)`.
 */
async function handleDeposit(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const itemId = args[0]?.toLowerCase();
  if (!itemId) return errorFrame("Usage: deposit <item> [qty]  (see `storage`)");

  const base = await baseHere(player, seed);
  const planet = planetAt(seed, locOf(player));
  if (!base) {
    return errorFrame(
      `No base in region ${player.region} of ${planet.name} to deposit into. \`build base\` first.`,
    );
  }

  const stacks = await world.getInventory(player.id);
  const held = stacks.find((s) => s.resourceId === itemId)?.qty ?? 0;
  if (held <= 0) return errorFrame(`You aren't carrying any ${itemId}.`);

  const [buildings, stored] = await Promise.all([
    world.getBaseBuildings(base.id),
    world.getBaseStorage(base.id),
  ]);
  const silos = buildings.filter((b) => b.kind === "silo").length;
  const capacity = baseCapacity(silos);
  const used = stored.reduce((sum, s) => sum + s.qty, 0);
  const remaining = capacity - used;
  if (remaining <= 0) {
    return errorFrame(
      silos === 0
        ? "This base has no silos — `build silo` to add storage first."
        : `Base storage is full (${used}/${capacity}). \`build silo\` for more.`,
    );
  }

  // Default (no qty): deposit as much as fits. Otherwise the requested amount,
  // bounded by holdings and remaining capacity.
  const requested = args[1] === undefined ? held : toInt(args[1]);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: deposit <item> [qty]  — qty must be a positive whole number.");
  }
  const move = Math.min(requested, held, remaining);
  if (move <= 0) return errorFrame("Nothing to deposit.");

  await world.removeInventory(player.id, itemId, move);
  const nowStored = await world.addBaseStorage(base.id, itemId, move);

  const res = getResource(itemId);
  return frame([
    line([
      text(`Deposited ${move} ${res.name} `, "success"),
      text(`into your base. `, "default"),
      text(`Storage ${used + move}/${capacity}.`, "muted"),
    ]),
    line(text(`  ${res.name} in store: ${nowStored}. ${held - move} left in cargo.`, "muted")),
  ]);
}

/**
 * `withdraw <item> [qty]` — the reverse of `deposit`: move a resource from this
 * region's base storage back into ship cargo. Bounded by what's stored AND your
 * free cargo space. With no `qty`, withdraws as much as fits. Atomic:
 * `add_base_storage(-)` then `add_inventory(+)`.
 */
async function handleWithdraw(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const itemId = args[0]?.toLowerCase();
  if (!itemId) return errorFrame("Usage: withdraw <item> [qty]  (see `storage`)");

  const base = await baseHere(player, seed);
  const planet = planetAt(seed, locOf(player));
  if (!base) {
    return errorFrame(
      `No base in region ${player.region} of ${planet.name} to withdraw from. \`build base\` first.`,
    );
  }

  // Ship parts are production intermediates — they stay in the silo (no cargo
  // slot / sell path yet; P9 wires them out). Only raw resources are withdrawable.
  if (isPartId(itemId)) {
    return errorFrame(
      `${getPart(itemId).name} is a ship part — it stays in the silo as a production intermediate.`,
    );
  }

  const stored = await world.getBaseStorage(base.id);
  const inStore = stored.find((s) => s.itemId === itemId)?.qty ?? 0;
  if (inStore <= 0) return errorFrame(`Your base here isn't storing any ${itemId}.`);

  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const used = await world.getCargoUsed(player.id);
  const cargoSpace = fresh.cargoCap - used;
  if (cargoSpace <= 0) return errorFrame("Cargo hold is full. `sell` or `deposit` something first.");

  const requested = args[1] === undefined ? inStore : toInt(args[1]);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: withdraw <item> [qty]  — qty must be a positive whole number.");
  }
  const move = Math.min(requested, inStore, cargoSpace);
  if (move <= 0) return errorFrame("Nothing to withdraw.");

  await world.addBaseStorage(base.id, itemId, -move);
  await world.addInventory(player.id, itemId, move);

  const res = getResource(itemId);
  return frame([
    line([
      text(`Withdrew ${move} ${res.name} `, "success"),
      text(`to your cargo. `, "default"),
      text(`Cargo ${used + move}/${fresh.cargoCap}.`, "muted"),
    ]),
    line(text(`  ${res.name} left in store: ${inStore - move}.`, "muted")),
  ]);
}

/**
 * `collect` — funnel the ore your excavators have accrued (since each one's
 * `lastCollectedAt`) into base storage. For each excavator and each deposit in
 * the current region, `excavatorYield(effectiveAbundance, elapsed)` units accrue
 * — clamped to the base's remaining storage capacity. The collected ore is added
 * to storage AND written back as per-region depletion (`recordDepletion`), so
 * excavation drains the SHARED region exactly like manual mining (others see
 * less; regen slowly refills). Each excavator's clock advances to now. Either
 * embark state is fine — it's your base.
 */
async function handleCollect(player: Player, seed: string): Promise<RenderFrame> {
  const coord = locOf(player);
  const planet = planetAt(seed, coord);
  const base = await baseHere(player, seed);
  if (!base) {
    return errorFrame(
      `No base in region ${player.region} of ${planet.name}. \`build base\` then \`build excavator\`.`,
    );
  }

  const region = regionAt(seed, coord, player.region);
  const rKey = regionKey(region.coord);
  const [buildings, stored, depletionMap] = await Promise.all([
    world.getBaseBuildings(base.id),
    world.getBaseStorage(base.id),
    world.getEffectiveDepletionMap(rKey),
  ]);

  const silos = buildings.filter((b) => b.kind === "silo").length;
  const excavators = buildings.filter((b) => b.kind === "excavator");
  if (excavators.length === 0) {
    return errorFrame("No excavators here — `build excavator` to start draining this region.");
  }

  const capacity = baseCapacity(silos);
  const used = stored.reduce((sum, s) => sum + s.qty, 0);
  let remaining = capacity - used;
  if (remaining <= 0) {
    return errorFrame(
      silos === 0
        ? "No silos to store the ore — `build silo` first."
        : `Base storage is full (${used}/${capacity}). \`withdraw\` or \`build silo\` first.`,
    );
  }

  // Accrue per-resource across all excavators using each one's elapsed time and
  // the deposit's current effective abundance. (Capacity clamping happens after.)
  const now = Date.now();
  const accrued: Record<string, number> = {};
  for (const exc of excavators) {
    const lastIso =
      typeof exc.state.lastCollectedAt === "string" ? exc.state.lastCollectedAt : exc.createdAt;
    const lastAt = Date.parse(lastIso);
    const elapsed = Number.isNaN(lastAt) ? 0 : Math.max(0, now - lastAt);
    for (const dep of region.deposits) {
      const eff = effectiveAbundance(dep.abundance, depletionMap[dep.resourceId] ?? 0);
      const y = excavatorYield(eff, elapsed);
      if (y > 0) accrued[dep.resourceId] = (accrued[dep.resourceId] ?? 0) + y;
    }
  }

  // Store what was accrued, in deposit order, up to the remaining capacity. The
  // stored amount is what we both bank and deplete the region by.
  const collected: { resourceId: string; qty: number }[] = [];
  for (const dep of region.deposits) {
    if (remaining <= 0) break;
    const want = accrued[dep.resourceId] ?? 0;
    if (want <= 0) continue;
    const take = Math.min(want, remaining);
    remaining -= take;
    collected.push({ resourceId: dep.resourceId, qty: take });
  }

  // Always advance the clocks (time accrued is "spent" whether or not it all
  // fit), then bank + deplete what was actually collected.
  for (const exc of excavators) {
    await world.setBuildingState(exc.id, { ...exc.state, lastCollectedAt: new Date(now).toISOString() });
  }

  if (collected.length === 0) {
    return frame([
      line(text("Excavators are still working — nothing to collect yet.", "muted")),
    ]);
  }

  for (const c of collected) {
    await world.addBaseStorage(base.id, c.resourceId, c.qty);
    await world.recordDepletion(rKey, c.resourceId, c.qty * DEPLETION_PER_UNIT, player.id);
  }

  const totalQty = collected.reduce((sum, c) => sum + c.qty, 0);
  const lines: RenderLine[] = [
    line([
      text(`Collected ${totalQty} units `, "success"),
      text(`from ${excavators.length} excavator${excavators.length === 1 ? "" : "s"}. `, "default"),
      text(`Storage ${used + totalQty}/${capacity}.`, "muted"),
    ]),
  ];
  for (const c of collected) {
    lines.push(line(text(`  • ${getResource(c.resourceId).name}: +${c.qty}`, "accent")));
  }
  if (remaining <= 0) {
    lines.push(line(text("Storage is now full — `build silo` for more, or `withdraw`.", "warning")));
  }
  return frame(lines);
}

// ---------------------------------------------------------------------------
// produce — manufacture ship parts from siloed raw minerals (P8b).
// ---------------------------------------------------------------------------

/**
 * `produce <part> [qty]` — manufacture a ship part at the current region's base.
 * Requires a base here with ≥1 production line; the part's raw-mineral recipe
 * must be present in THIS base's silo storage. Consumes the inputs from base
 * storage and banks the produced part(s) into the same storage, bounded by the
 * remaining `baseCapacity`. Validation (line exists, inputs siloed, capacity)
 * happens BEFORE any mutation, so a failed produce changes nothing. Either
 * embark state is fine — it's your base (matches `deposit`/`withdraw`/`collect`).
 *
 * Production is INSTANT for now (no timer). A future enhancement could meter it
 * over time like excavator drain (lastProducedAt + a per-ms rate).
 */
async function handleProduce(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const targetId = args[0]?.toLowerCase();
  if (!targetId) return errorFrame("Usage: produce <part|upgrade> [qty]  (see `storage`)");
  if (!isPartId(targetId) && !isUpgradeId(targetId)) {
    return errorFrame(`Can't produce "${targetId}". Try \`storage\` for the parts list.`);
  }

  const base = await baseHere(player, seed);
  const planet = planetAt(seed, locOf(player));
  if (!base) {
    return errorFrame(
      `No base in region ${player.region} of ${planet.name}. \`build base\` first.`,
    );
  }

  const [buildings, stored] = await Promise.all([
    world.getBaseBuildings(base.id),
    world.getBaseStorage(base.id),
  ]);
  const productionLines = buildings.filter((b) => b.kind === "production_line").length;
  if (productionLines === 0) {
    return errorFrame("No production line here — `build production_line` first.");
  }

  // P9a: an upgrade id manufactures the UPGRADE (consuming siloed PARTS, granting
  // ownership) rather than banking a part into storage. Distinct enough — and
  // capacity-free — to split out.
  if (isUpgradeId(targetId)) {
    return handleProduceUpgrade(player, base, stored, args[1], targetId);
  }

  const partId = targetId;
  const part = getPart(partId);
  const recipe = part.recipe;

  const requested = args[1] === undefined ? 1 : toInt(args[1]);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: produce <part> [qty]  — qty must be a positive whole number.");
  }

  // Siloed amounts (parts also live here, but recipes only reference resources).
  const siloed: Record<string, number> = {};
  for (const s of stored) siloed[s.itemId] = s.qty;

  // Inputs present? Surfaces every short line ("need 5 Titanium in the silo, have 2").
  if (!canProduce(siloed, recipe, requested)) {
    const short = Object.entries(recipe)
      .filter(([rid, perUnit]) => (siloed[rid] ?? 0) < perUnit * requested)
      .map(([rid, perUnit]) => `${perUnit * requested} ${getResource(rid).name} in the silo (have ${siloed[rid] ?? 0})`);
    return errorFrame(`Can't produce ${requested} ${part.name} — need ${short.join(", ")}.`);
  }

  // Capacity: consuming inputs frees space, banking parts uses it. Validate the
  // net result fits before mutating (defensive — inputs ≥ outputs in practice).
  const silos = buildings.filter((b) => b.kind === "silo").length;
  const capacity = baseCapacity(silos);
  const used = stored.reduce((sum, s) => sum + s.qty, 0);
  const inputsConsumed = Object.values(recipe).reduce((sum, q) => sum + q, 0) * requested;
  const usedAfter = used - inputsConsumed + requested;
  if (usedAfter > capacity) {
    return errorFrame(
      `Storage would overflow (${usedAfter}/${capacity}). \`build silo\` for more room.`,
    );
  }

  // Consume inputs, then bank the parts — all via the atomic storage RPC.
  for (const [rid, perUnit] of Object.entries(recipe)) {
    await world.addBaseStorage(base.id, rid, -(perUnit * requested));
  }
  const nowStored = await world.addBaseStorage(base.id, partId, requested);

  const consumed = Object.entries(recipe)
    .map(([rid, perUnit]) => `${perUnit * requested} ${getResource(rid).name}`)
    .join(" + ");
  return frame([
    line([
      text(`Manufactured ${requested} ${part.name}. `, "success"),
      text(`Consumed ${consumed}. `, "muted"),
      text(`Storage ${usedAfter}/${capacity}.`, "muted"),
    ]),
    line(text(`  ${part.name} in store: ${nowStored} (worth ${part.value} cr each).`, "accent")),
  ]);
}

/**
 * Manufacture a ship UPGRADE at the current region's production line (P9a). The
 * recipe is now ship PARTS (`upgrades.ts`), consumed from THIS base's silo
 * storage (`add_base_storage(-)`); the finished upgrade is granted to the player
 * (`add_player_upgrade(+)`) rather than banked into storage — so there's no
 * capacity check (upgrades don't sit in the silo). Validation (parts siloed)
 * happens BEFORE any mutation, so a failed produce changes nothing; consumption
 * + grant are atomic via the race-safe RPCs. The base/production-line checks
 * already ran in `handleProduce`.
 */
async function handleProduceUpgrade(
  player: Player,
  base: { id: string; name: string | null; rKey: string },
  stored: world.StorageStack[],
  qtyArg: string | undefined,
  upgradeId: string,
): Promise<RenderFrame> {
  const upgrade = getUpgrade(upgradeId);
  const recipe = recipeOf(upgradeId);

  const requested = qtyArg === undefined ? 1 : toInt(qtyArg);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: produce <upgrade> [qty]  — qty must be a positive whole number.");
  }

  // Siloed amounts. The recipe references PART ids (parts live in storage too).
  const siloed: Record<string, number> = {};
  for (const s of stored) siloed[s.itemId] = s.qty;

  if (!canProduce(siloed, recipe, requested)) {
    const short = Object.entries(recipe)
      .filter(([pid, perUnit]) => (siloed[pid] ?? 0) < perUnit * requested)
      .map(([pid, perUnit]) => `${perUnit * requested} ${getPart(pid).name} in the silo (have ${siloed[pid] ?? 0})`);
    return errorFrame(`Can't produce ${requested} ${upgrade.name} — need ${short.join(", ")}.`);
  }

  // Consume the part inputs from the silo, then grant the upgrade — atomic RPCs.
  for (const [pid, perUnit] of Object.entries(recipe)) {
    await world.addBaseStorage(base.id, pid, -(perUnit * requested));
  }
  const owned = await world.addPlayerUpgrade(player.id, upgradeId, requested);

  const consumed = Object.entries(recipe)
    .map(([pid, perUnit]) => `${perUnit * requested} ${getPart(pid).name}`)
    .join(" + ");
  return frame([
    line([
      text(`Manufactured ${requested} ${upgrade.name}. `, "success"),
      text(`Consumed ${consumed}. `, "muted"),
      text(`You now own ${owned}.`, "accent"),
    ]),
    line([
      text("`embark` then `sell` ", "muted"),
      text(`${upgradeId}`, "default"),
      text(" to put one on the market for other pilots.", "muted"),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// sell
// ---------------------------------------------------------------------------

async function handleSell(player: Player, args: string[]): Promise<RenderFrame> {
  const target = args[0]?.toLowerCase();
  if (!target) return errorFrame("Usage: sell <resource>  or  sell all");

  // Selling an upgrade or a material is code-priced (no market drift); resource
  // selling below is unchanged.
  if (isUpgradeId(target)) return handleSellUpgrade(player, target, args[1]);
  if (isMaterialId(target)) return handleSellMaterial(player, target, args[1]);

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
  // Selling puts the upgrade(s) on the shared market for others to `buy` — the
  // only way the finite buyable supply grows (P9a).
  const supply = await world.addUpgradeSupply(upgradeId, qty);

  return frame([
    line([
      text(`Sold ${qty} ${upgrade.name} `, "success"),
      text(`for ${total} cr `, "accent"),
      text(`(${unit}/u). `, "muted"),
      text(`${remaining} left. Balance ${newBalance} cr.`, "accent"),
    ]),
    line(text(`  ${supply} now on the market for other pilots to buy.`, "muted")),
  ]);
}

/**
 * Sell materials (scavenged/harvested/dropped goods) for `materialValue` per
 * unit — code-priced, no market drift, no cargo (mirrors `handleSellUpgrade`).
 * No `qty` arg sells the whole stack; a positive `qty` sells that many. Validates
 * ownership before mutating; you can't sell what you don't carry.
 */
async function handleSellMaterial(
  player: Player,
  materialId: string,
  qtyArg: string | undefined,
): Promise<RenderFrame> {
  const material = getMaterial(materialId);

  const stacks = await world.getPlayerMaterials(player.id);
  const ownedNow = stacks.find((s) => s.materialId === materialId)?.qty ?? 0;
  if (ownedNow <= 0) {
    return errorFrame(`You aren't carrying any ${material.name}.`);
  }

  let qty: number;
  if (qtyArg === undefined) {
    qty = ownedNow; // sell the whole stack by default
  } else {
    const requested = toInt(qtyArg);
    if (requested === null || requested <= 0) {
      return errorFrame("Usage: sell <material> [qty]  — qty must be a positive whole number.");
    }
    qty = requested;
  }
  if (ownedNow < qty) {
    return errorFrame(`You only own ${ownedNow} ${material.name} — can't sell ${qty}.`);
  }

  const unit = materialValue(materialId);
  const total = unit * qty;
  const remaining = await world.addPlayerMaterial(player.id, materialId, -qty);
  const newBalance = await world.addPlayerCredits(player.id, total);

  return frame([
    line([
      text(`Sold ${qty} ${material.name} `, "success"),
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

  // Finite supply gate (P9a): you can only buy what's currently on the market.
  // Validate supply BEFORE charging — manufacturing (`produce`) + selling are
  // the only ways stock appears.
  const supply = await world.getUpgradeSupply(upgradeId);
  if (!canBuyFromSupply(supply)) {
    return errorFrame(
      `${upgrade.name} is out of stock — none on the market; someone must manufacture and sell one.`,
    );
  }
  if (supply < qty) {
    return errorFrame(
      `Only ${supply} ${upgrade.name} on the market — can't buy ${qty}. Try a smaller quantity.`,
    );
  }

  const unitCost = buyUnitCost(upgradeValue(upgradeId));
  const total = unitCost * qty;

  const fresh = (await world.getPlayerById(player.id)) ?? player;
  if (fresh.credits < total) {
    return errorFrame(
      `Not enough credits: ${qty} ${upgrade.name} costs ${total} cr (${unitCost}/u) and you have ${fresh.credits}.`,
    );
  }

  // Take the unit(s) off the shared market, then grant + charge. The RPC is
  // clamped at 0; we validated supply >= qty above.
  const newSupply = await world.addUpgradeSupply(upgradeId, -qty);
  const owned = await world.addPlayerUpgrade(player.id, upgradeId, qty);
  const newBalance = await world.addPlayerCredits(player.id, -total);

  return frame([
    line([
      text(`Bought ${qty} ${upgrade.name} `, "success"),
      text(`for ${total} cr `, "accent"),
      text(`(${unitCost}/u). `, "muted"),
      text(`You now own ${owned}. Balance ${newBalance} cr.`, "accent"),
    ]),
    line(text(`  ${newSupply} left on the market.`, "muted")),
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
