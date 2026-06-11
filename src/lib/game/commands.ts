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
import { validateHandle } from "@/lib/players/handle";
import {
  galaxyAt,
  planetAt,
  regionAt,
  systemAt,
  systemKey,
  planetKey,
  regionKey,
  regionGrid,
  regionCoords,
  regionIndex,
  moveRegion,
  type Direction,
  parseLocationKey,
  warpDistance,
  clusterStars,
  clusterOf,
  systemFromPosition,
  STARS_PER_CLUSTER,
  MAX_CLUSTERS_PER_ARM,
  clusterRadius,
  galacticRadiation,
  RADIATION_MAX,
  getResource,
  hasSettlement,
  hasOutpost,
  systemOutpostPlanets,
  siteAt,
  siteLoot,
  orbitalSiteAt,
  orbitalSiteLoot,
  RESOURCES,
  SIZE_CLASS_LABELS,
  regionFlora,
  regionFauna,
  speciesDrop,
  speciesLabel,
  speciesArticle,
  type SystemCoord,
  type PlanetCoord,
  type StarPosition,
  type Region,
  type Planet,
  type Biome,
  type Site,
  type Species,
} from "@/lib/universe";
import type { RenderFrame, RenderLine, StatusBar } from "@/lib/terminal/types";
import { action, frame, line, text } from "@/lib/terminal/helpers";
import { parseCommand } from "./parse";
import { resolveCommandLine, resolveToken, type ResolveLineSpec } from "./resolve";
import { VERBS, USAGE, usageLine } from "./usage";
import { isApplicable, isEconomyVerb, type PlayerStateView } from "./applicability";
import { getWorldSeed } from "./seed";
import {
  effectiveAbundance,
  warpFuelCost,
  orbitFuelCost,
  launchFuelCost,
  miningYield,
  priceAfterSale,
  priceAfterPurchase,
  buyUnitCost,
  sellValue,
  canCraft,
  canProduce,
  canLand,
  landingRequirement,
  radiationShieldRequired,
  RADIATION_SHIELD_UPGRADE_ID,
  rollHazardDamage,
  creditsAfterDeath,
  combatRound,
  speciesCombatStats,
  exploreOutcome,
  healValue,
  excavatorYield,
  baseCapacity,
  baseTierMultiplier,
  baseTierPowerBonus,
  MAX_BASE_TIER,
  basePower,
  biofuelYield,
  interplanetaryDistance,
  distressCost,
  DISTRESS_FEE,
  cropMature,
  CROP_FARM_PLOTS,
  livestockCanBreed,
  feedAmount,
  breedOffspring,
  LIVESTOCK_PEN_CAPACITY,
  PLAYER_BASE_ATTACK,
  MAX_HEALTH,
  discoveryBountyFor,
  DEPLETION_PER_UNIT,
  REGULAR_FUEL_PRICE_PER_UNIT,
  WARP_FUEL_PRICE_PER_UNIT,
  UPGRADE_SUPPLY_BASELINE,
  PART_SUPPLY_BASELINE,
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
  partValue,
} from "./parts";
import {
  SHIPS,
  SHIP_IDS,
  STARTER_SHIP_ID,
  isShipId,
  getShip,
  shipTradeIn,
  isBuildableShip,
  shipRecipeOf,
} from "./ships";
import {
  INGOTS,
  INGOT_IDS,
  isIngotId,
  getIngot,
} from "./ingots";
import {
  isCropId,
  getCrop,
  cropsForBiome,
} from "./crops";
import {
  isFarmAnimalId,
  getFarmAnimal,
  farmAnimalsForBiome,
} from "./livestock";
import {
  FACTIONS,
  getFaction,
  factionAt,
  contractsAt,
  CONTRACT_ROTATION_MS,
  rankFor,
  RANKS,
  MAX_RANK_TIER,
  rivalOf,
  rivalRepPenalty,
  repPriceDiscount,
} from "./factions";
import { getSpecies, minorSpeciesAt, type Species as SapientSpecies } from "./species";
import {
  cartographyRank,
  nextCartoThreshold,
  MAX_CARTO_TIER,
} from "./cartography";
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
  CONDENSATE_RECIPE,
  HYPERWARP_CONDENSATE_ID,
  canHyperwarp,
  isValidInGalaxyTarget,
  isAdjacentGalaxy,
} from "./galaxy-jump";
import {
  BASE_BUILD_COST,
  BASE_BUILD_CREDITS,
  BASE_BUILD_MINERALS,
  canAffordBase,
  isStructureKind,
  buildingCost,
  creditsOf,
  mineralsOf,
  baseUpgradeCost,
  upgradeCredits,
  upgradeMinerals,
  type StructureKind,
} from "./bases";
import {
  renderHelp,
  renderCommandHelp,
  renderScan,
  renderRegions,
  renderMap,
  renderSurfaceMap,
  renderInventory,
  renderUpgrades,
  renderShipyard,
  renderBases,
  renderStorage,
  renderWho,
  renderStanding,
  renderContracts,
  renderCartography,
  renderGuide,
  renderPresence,
  presenceLines,
  errorFrame,
  type ContractEntry,
  type MapNeighbor,
  type RegionListEntry,
  type SurfaceMapCell,
  type CommandHelpSlotView,
  type CommandHelpGroup,
  type EncounterView,
  type ScanBase,
  type PlotSummary,
  type PlantHint,
  type HerdSummary,
  type RanchHint,
} from "./render";
import { groupTradeCandidates, creditLabel, type TradeCategory } from "./trade-help";
import { nextStep, type GuideSnapshot } from "./advisor";
import * as world from "./world";

/** Strict integer parse: returns null for missing/non-integer tokens. */
function toInt(token: string | undefined): number | null {
  if (token === undefined) return null;
  const n = Number(token);
  return Number.isInteger(n) ? n : null;
}

/**
 * Sentinel `player.region` value meaning "docked at the planet's orbital
 * outpost" rather than standing in a surface region (P11). Surface regions are
 * `0 .. regionCount-1`; `-1` is the orbital station, which is NOT a `regionAt`
 * region (it has no biome/deposits). Every place that derives a surface region
 * from `player.region` must treat this specially — there is no `regionAt(-1)`.
 */
const OUTPOST_REGION = -1;

/** True when the player is docked at the orbital outpost (not on a surface region). */
function atOutpost(player: Player): boolean {
  return player.region === OUTPOST_REGION;
}

/**
 * Whether the player is physically AT A TRADE LOCATION (P12a) — docked at the
 * planet's orbital outpost, or standing in a surface region that bears a
 * settlement. This is the gate for the economy commands (`buy`/`sell`): you can
 * only trade where there is actually a market. Embark state is irrelevant here
 * (you may trade aboard or on foot once you've arrived somewhere inhabited).
 */
function atTradeLocation(player: Player, seed: string): boolean {
  if (atOutpost(player)) return true;
  return hasSettlement(seed, { ...locOf(player), region: player.region });
}

/** The clear error for a surface-only action attempted at the orbital outpost. */
function outpostSurfaceError(): RenderFrame {
  return errorFrame(
    "You're docked at the orbital outpost — `jump <n>` to a surface region first.",
  );
}

/**
 * The clear error for a surface action attempted at a GAS GIANT (planet-taxonomy).
 * Gas giants are orbit-only — no surface to land on, mine, build on, or explore.
 * You can still `scan`/`map`/`warp` away, or `jump O` to its orbital outpost.
 */
function gasGiantError(planet: Planet): RenderFrame {
  const outpost = " (or `jump O` to its orbital outpost, if it has one)";
  return errorFrame(
    `${planet.name} is a gas giant — no surface to land on. \`scan\`/\`map\`/\`warp\` away${outpost}.`,
  );
}

/**
 * The ORBITAL scan frame (orbit-land): what you see while ABOARD and UP IN ORBIT
 * of a planet (any planet — rocky or gas giant). Describes the world (size,
 * radius, atmosphere, temp), your "in orbit" status, the in-system sibling
 * planets as clickable `orbit <n>` actions (with the distance-based
 * `orbitFuelCost` + P9b red when you can't afford the hop), and — on a ROCKY
 * world — a `land` action to descend (red, with the gear it needs, when the
 * freezing/boiling landing gate blocks you; a gas giant simply has no `land`).
 * Plus `jump O` (when an outpost exists) and a `map` hint. This SUPERSEDES the
 * old `gasGiantScanFrame` and the `land`-sibling list the surface scan used to
 * carry: siblings are reached by `orbit` now; only the planet you're orbiting
 * offers `land`.
 */
async function orbitalScanFrame(
  player: Player,
  seed: string,
  planet: Planet,
): Promise<RenderFrame> {
  const system = systemAt(seed, locOf(player));
  const now = Date.now();
  // Descent gate (orbit-land): freezing/boiling landing gear AND, in a coreward
  // (high-radiation) cluster, a radiation shield (cascade 0b). Fetch owned gear
  // whenever EITHER gate could apply; a gas giant has no surface at all.
  const tempReq = planet.isGas ? null : landingRequirement(planet.temperature);
  const radNeeded = !planet.isGas && planetRadiationShielded(planet);
  const owned =
    tempReq !== null || radNeeded
      ? await world.getOwnedUpgradeIds(player.id)
      : new Set<string>();
  const missingGear = planet.isGas ? [] : surfaceGateMissing(planet, owned);
  const canDescend = !planet.isGas && missingGear.length === 0;
  const lowHealth = player.health <= MAX_HEALTH * 0.3;
  // Orbital derelict (Keystone 3c): a RARE drifting wreck in this orbit (works on
  // gas giants too — orbit, not surface). Show whether the player has already
  // picked it clean so the `salvage` hint reads red (P9b).
  const orbitalSite = orbitalSiteAt(seed, planet.coord);
  const orbitalSalvaged = orbitalSite
    ? await world.hasSalvaged(player.id, planetKey(planet.coord))
    : false;
  // Co-located players (presence 3a): others orbiting THIS planet (region 0).
  const present = await world.playersHere({ id: player.id, ...planet.coord, region: 0 });

  const lines: RenderLine[] = [
    line([
      text(planet.name, "heading"),
      text(`  (${system.name}, class-${system.starClass})`, "muted"),
    ]),
    line([
      text("position ", "muted"),
      text(`(${system.position.x}, ${system.position.y}, ${system.position.z})`, "accent"),
    ]),
    line([
      text("HP ", "muted"),
      text(`${player.health}/${MAX_HEALTH}`, lowHealth ? "danger" : "default"),
      text("   ", "muted"),
      text("in orbit", "accent"),
    ]),
    line([
      text("fuel ", "muted"),
      text(`${player.fuel}`, "default"),
      text("   warp fuel ", "muted"),
      text(`${player.warpFuel}`, "default"),
    ]),
    line([
      text("size ", "muted"),
      text(`${SIZE_CLASS_LABELS[planet.sizeClass]}${planet.isGas ? " (gas giant)" : ""}`, "accent"),
      text("   radius ", "muted"),
      text(`${planet.radius} R⊕`, "default"),
    ]),
    line([
      text("atmosphere ", "muted"),
      text(planet.atmosphere, "accent"),
      text("   temp ", "muted"),
      text(`${planet.temperature}°C`, "default"),
      text("   gravity ", "muted"),
      text(`${planet.gravity}g`, "default"),
    ]),
  ];

  // Descend to the surface — rocky worlds only; the freezing/boiling landing
  // gate may block it (red, naming the gear). A gas giant has no surface.
  if (planet.isGas) {
    lines.push(line(text("A gas giant — no surface to land on. `orbit` a sibling or `warp` away.", "muted")));
  } else if (canDescend) {
    lines.push(
      line([
        action("land", "land", { style: "link", title: `descend to the surface of ${planet.name} (free)` }),
        text(" to descend to the surface (free).", "muted"),
      ]),
    );
  } else {
    const names = missingGear.map((id) => getUpgrade(id).name).join(" + ");
    const reason = missingGear.includes(RADIATION_SHIELD_UPGRADE_ID)
      ? missingGear.length > 1
        ? `hostile surface (${planet.temperature}°C) + lethal radiation`
        : "lethal stellar radiation"
      : `${planet.temperature < 0 ? "freezing" : "boiling"} surface (${planet.temperature}°C)`;
    lines.push(
      line([
        action("land", "land", { style: "link", title: `needs ${names} to land here`, disabled: true }),
        text(` — ${reason}, requires ${names}.`, "danger"),
      ]),
    );
  }

  // Sibling planets, reached by `orbit <n>` (distance fuel). Red when you can't
  // afford the (time-varying) orbit hop. Gas-giant siblings are reachable too.
  const siblings = system.planets.filter((sib) => sib.coord.planet !== planet.coord.planet);
  if (siblings.length > 0) {
    lines.push(line(text("Other planets in this system (`orbit <n>`):", "heading")));
    for (const sib of siblings) {
      const cost = orbitFuelCost(planet, sib, now);
      const affordable = player.fuel >= cost;
      const label = `${sib.name} (${SIZE_CLASS_LABELS[sib.sizeClass]}${sib.isGas ? " gas giant" : ""})`;
      const title = affordable ? `orbit ${sib.name}` : `not enough fuel (need ${cost})`;
      lines.push(
        line([
          text(`  ${sib.coord.planet}: `, "muted"),
          action(label, `orbit ${sib.coord.planet}`, { style: "link", title, disabled: !affordable }),
          text(`  fuel ${cost}`, affordable ? "muted" : "danger"),
        ]),
      );
    }
  }

  // A drifting orbital derelict — salvageable right here from orbit (no need to
  // land). The `salvage` action reads red once you've picked it clean (P9b).
  if (orbitalSite) {
    if (orbitalSalvaged) {
      lines.push(
        line([
          text(`A picked-clean ${siteLabel(orbitalSite.type)} drifts nearby — `, "muted"),
          action("salvage", "salvage", {
            style: "link",
            title: "already picked clean",
            disabled: true,
          }),
          text(" (nothing left).", "muted"),
        ]),
      );
    } else {
      lines.push(
        line([
          text(`A drifting ${siteLabel(orbitalSite.type)} hangs in orbit — `, "success"),
          action("salvage", "salvage", {
            style: "link",
            title: "strip the derelict for salvage",
          }),
          text(" it for a haul.", "muted"),
        ]),
      );
    }
  }

  // Co-located players sharing this orbit (presence 3a) — omitted when alone.
  lines.push(...presenceLines(present));

  if (hasOutpost(seed, locOf(player))) {
    lines.push(
      line([
        text("An orbital station hangs nearby — ", "muted"),
        action("jump O", "jump O", { style: "link", title: "dock at the orbital outpost" }),
        text(" to dock.", "muted"),
      ]),
    );
  }
  lines.push(
    line([
      action("map", "map", { style: "link", title: "show nearby systems" }),
      text(" to find another system.", "muted"),
    ]),
  );
  return frame(lines);
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
 * A friendly, human-readable label for the player's current location, drawn
 * deterministically from the procedural universe (system + planet names). Pure;
 * never throws — an out-of-range planet index or the orbital-outpost sentinel
 * (`region === -1`) degrade to a sensible label rather than crashing the HUD.
 */
function locationLabel(player: Player, seed: string): string {
  const system = systemAt(seed, systemOf(player));
  if (atOutpost(player)) return `${system.name} · orbital outpost`;
  const planet = system.planets[player.planet];
  const planetName = planet ? planet.name : `planet ${player.planet}`;
  return `${system.name} · ${planetName}`;
}

/**
 * Build the persistent HUD snapshot (credits / friendly location / fuel /
 * warpFuel / health+max / ship name) from the current player. PURE &
 * deterministic — a function of `(player, seed)` only — so it's unit-testable
 * and the dispatch path can attach it to the outgoing frame in ONE place.
 */
export function buildStatusBar(player: Player, seed: string): StatusBar {
  return {
    credits: player.credits,
    location: locationLabel(player, seed),
    fuel: player.fuel,
    warpFuel: player.warpFuel,
    health: player.health,
    maxHealth: MAX_HEALTH,
    ship: getShip(player.shipId).name,
  };
}

/**
 * The baseline a supply-market item reverts toward (P12b) — parts vs upgrades.
 * Used to resolve a lazy (rowless) system+item supply, which reads as the
 * baseline. Mirrors `world.supplyBaseline` (kept local so help can merge without
 * a DB round-trip per id).
 */
function supplyBaselineFor(itemId: string): number {
  return isPartId(itemId) ? PART_SUPPLY_BASELINE : UPGRADE_SUPPLY_BASELINE;
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
  regionIdx: number,
): Promise<RenderFrame> {
  const planet = planetAt(seed, coord);
  const system = systemAt(seed, coord);
  const region = regionAt(seed, coord, regionIdx);
  const rKey = regionKey(region.coord);
  // Lazy auto-accrual (P13): if the player owns a base here, its powered
  // excavators funnel accrued ore into the silos before we read/display the
  // region — so depletion shown below reflects what the excavators just drained.
  await maybeAccrueExcavators(player, region, planet);
  const [depletionMap, justDiscovered, owned, regionBases, ownBase, present] = await Promise.all([
    world.getEffectiveDepletionMap(rKey),
    world.recordDiscovery(planetKey(coord), player.id),
    world.getOwnedUpgradeIds(player.id),
    world.basesInRegion(rKey),
    world.getBaseInRegion(player.id, rKey),
    // Co-located players (shared-world presence 3a): OTHERS standing in THIS
    // region. Keyed by the scanned region (`regionIdx`), not `player.region`,
    // which may be stale (e.g. `jump` scans the new region pre-refresh).
    world.playersHere({ id: player.id, ...coord, region: regionIdx }),
  ]);
  // Crop plots at the player's OWN base here (if it has a crop farm): surface
  // their maturity + clickable `plant` hints (red when no free plot — P9b).
  let plots: PlotSummary[] | undefined;
  let plantHintList: PlantHint[] | undefined;
  let herds: HerdSummary[] | undefined;
  let ranchHintList: RanchHint[] | undefined;
  if (ownBase) {
    const [rawPlots, buildings, rawHerds] = await Promise.all([
      world.getBasePlots(ownBase.id),
      world.getBaseBuildings(ownBase.id),
      world.getBaseLivestock(ownBase.id),
    ]);
    const cropFarms = buildings.filter((b) => b.kind === "crop_farm").length;
    if (cropFarms > 0) {
      const capacity = CROP_FARM_PLOTS * cropFarms;
      plots = summarizePlots(rawPlots, Date.now());
      plantHintList = plantHints(region.biome, rawPlots.length < capacity);
    }
    const livestockPens = buildings.filter((b) => b.kind === "livestock_pen").length;
    if (livestockPens > 0) {
      const headCapacity = LIVESTOCK_PEN_CAPACITY * livestockPens;
      const totalHead = rawHerds.reduce((sum, h) => sum + h.count, 0);
      herds = summarizeHerds(rawHerds, Date.now(), totalHead, headCapacity);
      ranchHintList = ranchHints(region.biome, totalHead >= headCapacity);
    }
  }
  // First-discovery bounty (Keystone 3): `recordDiscovery` is the once-only gate
  // (its insert wins exactly once per planet), so `justDiscovered === true` here
  // means THIS player is the genuine first charter. Pay the flat bounty exactly
  // once (atomic credit RPC) and surface it in the frame. Re-scanning a planet
  // you already charted never re-pays.
  let chartedCount: number | undefined;
  let chartedRankTitle: string | undefined;
  let discoveryBountyPaid: number | undefined;
  if (justDiscovered) {
    // Rank-scaled bounty (Keystone 3c): the payout scales with the player's
    // CURRENT cartography rank (computed from `player.charted` BEFORE this
    // discovery bumps it), so a higher-ranked explorer earns more for the same
    // first find — the tangible payoff for ranking up.
    discoveryBountyPaid = discoveryBountyFor(cartographyRank(player.charted).tier);
    await world.addPlayerCredits(player.id, discoveryBountyPaid);
    // Cartography (Keystone 3b): bump the explorer's worlds-charted count inside
    // the SAME once-only gate, so it tracks the bounty exactly (once per planet,
    // never on re-scan). Surface the new count + rank in the discovery message.
    chartedCount = await world.incrementCharted(player.id);
    chartedRankTitle = cartographyRank(chartedCount).title;
  }
  // Exploration site present in this region (Keystone 3)? Sites are RARE,
  // deterministic, and surface-region-only — this is the surface frame (gas
  // giants short-circuit to the orbital frame upstream), so it's a valid place
  // to surface one. Show whether the player has already picked it clean so the
  // `salvage` hint can read red (P9b).
  const site = siteAt(seed, region.coord);
  const siteView = site
    ? { type: site.type, salvaged: await world.hasSalvaged(player.id, rKey) }
    : undefined;
  const requiredUpgrade = landingRequirement(planet.temperature);
  // Orbit-land: the surface scan no longer lists sibling planets as `land <n>`
  // (you must `launch` to orbit before flying anywhere — siblings live in the
  // ORBITAL frame as `orbit <n>` now). It carries `landed` so the renderer can
  // offer `launch`/`disembark` appropriately.
  // The region's grid cell (surface-nav): the region INDEX reinterpreted as a
  // (lat, lon) coordinate on the planet's lat×lon surface grid, so position is
  // legible in `scan` (and the surface `map`).
  const grid = regionGrid(planet);
  const cell = regionCoords(regionIdx, grid.rows, grid.cols);
  return renderScan({
    planet,
    system,
    position: system.position,
    region,
    gridCoord: { ...cell, rows: grid.rows, cols: grid.cols },
    settlement: hasSettlement(seed, region.coord),
    settlementSpecies: hasSettlement(seed, region.coord)
      ? inhabitingSpecies(seed, regionKey(region.coord)).name
      : undefined,
    site: siteView,
    depletionMap,
    justDiscovered,
    discoveryBounty: discoveryBountyPaid,
    chartedCount,
    chartedRankTitle,
    requiredUpgrade,
    hasRequiredUpgrade: requiredUpgrade === null || owned.has(requiredUpgrade),
    radiationRequired: planetRadiationShielded(planet),
    hasRadiationShield: owned.has(RADIATION_SHIELD_UPGRADE_ID),
    health: player.health,
    maxHealth: MAX_HEALTH,
    embarked: player.embarked,
    landed: player.landed,
    fuel: player.fuel,
    warpFuel: player.warpFuel,
    encounter: encounterView(player),
    // Shared-world presence: bases here, yours marked, others shown by handle.
    bases: regionBases.map((b): ScanBase => ({
      handle: b.handle,
      name: b.name,
      mine: b.ownerId === player.id,
    })),
    // Co-located players standing in this region (presence 3a).
    present,
    plots,
    plantHints: plantHintList,
    herds,
    ranchHints: ranchHintList,
  });
}

/**
 * Build the scan-side view of the player's active combat encounter (or null when
 * not fighting). Derives the creature's descriptive label + combat stats from
 * its generated species (cascade tier 5b).
 */
function encounterView(player: Player): EncounterView | null {
  if (!player.encounter) return null;
  const species = player.encounter.species;
  if (!species) return null; // defensive: stale pre-5b row shape
  const stats = speciesCombatStats(species);
  return {
    name: speciesLabel(species),
    hp: player.encounter.hp,
    maxHp: stats.maxHp,
    hostile: stats.hostile,
  };
}

/**
 * The resource ids minable in the player's CURRENT REGION right now — present
 * deposits whose effective (post-depletion) abundance is still > 0. These are
 * the candidate set for `mine`'s argument.
 */
async function minableHere(player: Player, seed: string): Promise<string[]> {
  // At the orbital outpost there is no surface region to mine — nothing minable.
  if (atOutpost(player)) return [];
  const coord = locOf(player);
  // A gas giant has no surface region either — nothing minable.
  if (planetAt(seed, coord).isGas) return [];
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
  const [stacks, materials, parts] = await Promise.all([
    world.getInventory(player.id),
    world.getPlayerMaterials(player.id),
    world.getPlayerParts(player.id),
  ]);
  return [
    ...stacks.map((s) => s.resourceId),
    "all",
    ...UPGRADE_IDS,
    // Owned ship parts are a tradeable commodity now (P12b) — listed when held so
    // `sell hull` abbreviates; the handler validates you actually carry each.
    ...parts.map((p) => p.partId),
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
  /** Crop ids valid for the current region's biome — the `plant` arg domain. */
  plantCandidates: string[] | null;
  /** Crop ids the player has RIPE plots of here — the `harvest <crop>` arg domain. */
  harvestCandidates: string[] | null;
  /** Animal ids valid for the current region's biome — the `ranch` arg domain. */
  ranchCandidates: string[] | null;
  /** Animal ids the player currently herds here — the `feed`/`slaughter` arg domain. */
  herdCandidates: string[] | null;
  /** Ship ids you can swap to — every catalog ship except the one you fly. */
  buyshipCandidates: string[] | null;
}

const EMPTY_ARG_CONTEXT: ArgDomainContext = {
  mineCandidates: null,
  sellCandidates: null,
  eatCandidates: null,
  depositCandidates: null,
  withdrawCandidates: null,
  plantCandidates: null,
  harvestCandidates: null,
  ranchCandidates: null,
  herdCandidates: null,
  buyshipCandidates: null,
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
    // You can deposit resources from your cargo hold OR ship parts from your
    // parts store (P12b — parts are a commodity now; deposit them into a silo).
    const [stacks, parts] = await Promise.all([
      world.getInventory(player.id),
      world.getPlayerParts(player.id),
    ]);
    return {
      ...EMPTY_ARG_CONTEXT,
      depositCandidates: [...stacks.map((s) => s.resourceId), ...parts.map((p) => p.partId)],
    };
  }
  if (verb === "withdraw") {
    // You can withdraw anything your base here is storing — raw resources AND
    // ship parts (P12b lifted the old parts-stay-siloed block; parts now move
    // back into the ship's parts store). No base/storage at the orbital outpost.
    if (atOutpost(player)) return { ...EMPTY_ARG_CONTEXT, withdrawCandidates: [] };
    // No surface region (and no base) on a gas giant.
    if (planetAt(seed, locOf(player)).isGas) return { ...EMPTY_ARG_CONTEXT, withdrawCandidates: [] };
    const base = await world.getBaseInRegion(player.id, regionKey(regionAt(seed, locOf(player), player.region).coord));
    const stored = base ? await world.getBaseStorage(base.id) : [];
    return {
      ...EMPTY_ARG_CONTEXT,
      withdrawCandidates: stored.map((s) => s.itemId),
    };
  }
  if (verb === "plant") {
    // You can only sow crops appropriate to the CURRENT region's biome — the
    // same gate the handler enforces. No surface (so no crops) at the orbital
    // outpost or on a gas giant.
    if (atOutpost(player)) return { ...EMPTY_ARG_CONTEXT, plantCandidates: [] };
    const coord = locOf(player);
    if (planetAt(seed, coord).isGas) return { ...EMPTY_ARG_CONTEXT, plantCandidates: [] };
    const region = regionAt(seed, coord, player.region);
    return { ...EMPTY_ARG_CONTEXT, plantCandidates: cropsForBiome(region.biome).map((c) => c.id) };
  }
  if (verb === "harvest") {
    // `harvest <crop>` targets the crops you have RIPE plots of at your base
    // here (so `harvest verd` abbreviates); bare `harvest` (no arg) is the wild-
    // flora path and needs no domain. No base / no surface ⇒ no crop candidates.
    const base = await baseHere(player, seed);
    if (!base) return { ...EMPTY_ARG_CONTEXT, harvestCandidates: [] };
    const plots = await world.getBasePlots(base.id);
    const now = Date.now();
    const ripe = new Set<string>();
    for (const p of plots) {
      if (isCropId(p.cropId) && cropMature(Date.parse(p.plantedAt), now, getCrop(p.cropId).growMs)) {
        ripe.add(p.cropId);
      }
    }
    return { ...EMPTY_ARG_CONTEXT, harvestCandidates: [...ripe] };
  }
  if (verb === "ranch") {
    // You can only ranch animals appropriate to the CURRENT region's biome — the
    // same gate the handler enforces. No surface (so no livestock) at the orbital
    // outpost or on a gas giant.
    if (atOutpost(player)) return { ...EMPTY_ARG_CONTEXT, ranchCandidates: [] };
    const coord = locOf(player);
    if (planetAt(seed, coord).isGas) return { ...EMPTY_ARG_CONTEXT, ranchCandidates: [] };
    const region = regionAt(seed, coord, player.region);
    return { ...EMPTY_ARG_CONTEXT, ranchCandidates: farmAnimalsForBiome(region.biome).map((a) => a.id) };
  }
  if (verb === "feed" || verb === "slaughter") {
    // `feed`/`slaughter <animal>` target the animals you currently herd at your
    // base here (so `feed jung` abbreviates). No base / no surface ⇒ none.
    const base = await baseHere(player, seed);
    if (!base) return { ...EMPTY_ARG_CONTEXT, herdCandidates: [] };
    const herds = await world.getBaseLivestock(base.id);
    return { ...EMPTY_ARG_CONTEXT, herdCandidates: herds.map((h) => h.animalId) };
  }
  if (verb === "buyship") {
    // You can swap to any catalog ship except the one you already fly (no point
    // re-buying it). Derived purely from the player row — no DB read needed.
    return { ...EMPTY_ARG_CONTEXT, buyshipCandidates: SHIP_IDS.filter((id) => id !== player.shipId) };
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
      // `plant`'s domain: the crops valid for the current region's biome.
      if (verb === "plant" && argIndex === 0) return ctx.plantCandidates;
      // `harvest`'s domain: the crops you have ripe plots of here. Empty/absent
      // (or no arg) falls through to the bare wild-flora harvest in the handler.
      if (verb === "harvest" && argIndex === 0) return ctx.harvestCandidates;
      // `ranch`'s domain: animals valid for the current region's biome.
      if (verb === "ranch" && argIndex === 0) return ctx.ranchCandidates;
      // `feed`/`slaughter`'s domain: the animals you currently herd here.
      if ((verb === "feed" || verb === "slaughter") && argIndex === 0) return ctx.herdCandidates;
      // `buyship`'s domain: every catalog ship except your current one.
      if (verb === "buyship" && argIndex === 0) return ctx.buyshipCandidates;
      // `build`'s structure domain: the base itself plus the in-base structures
      // (P8a silos/excavators, P8b production lines, P13 power plants, the
      // blast-furnace smelting tier, the crop-farming crop farm, and the
      // animal-husbandry livestock pen).
      if (verb === "build" && argIndex === 0)
        return ["base", "silo", "excavator", "production_line", "thermal_plant", "solar_array", "blast_furnace", "crop_farm", "livestock_pen"];
      // `upgrade`'s domain (Keystone 2c): just the base today — `upgrade base`
      // raises the base's tier (more storage capacity). Extensible later.
      if (verb === "upgrade" && argIndex === 0) return ["base"];
      // `move`'s direction domain (surface-nav): the four compass directions, so
      // `move n` abbreviates to `move north`. Static (no world state needed).
      if (verb === "move" && argIndex === 0) return ["north", "south", "east", "west"];
      // `produce`'s domain: the ingots a blast furnace smelts from siloed raw
      // metal, the ship parts a production line banks into storage, the upgrades
      // it manufactures (P9a — consuming siloed parts, granting the upgrade), PLUS
      // the BUILDABLE ships a production line constructs from siloed parts/ingots
      // (Keystone 2b — granted via `setShip`, not storage). One verb, four
      // building-gated branches.
      if (verb === "produce" && argIndex === 0)
        return [...INGOT_IDS, ...PART_IDS, ...UPGRADE_IDS, ...SHIP_IDS.filter(isBuildableShip)];
      // `craft` now only cooks food (P9a — upgrades moved to `produce`). Its arg
      // is OPAQUE: `handleCraft` resolves a food prefix itself, so a fully-typed
      // upgrade id reaches the handler and gets a redirect to `produce` (rather
      // than a bare "no such" from the resolver). Foods abbreviate handler-side.
      if (verb === "craft" && argIndex === 0) return null;
      if (verb === "buy" && argIndex === 0) {
        // P12b: ship parts are buyable from the per-system supply too.
        return ["fuel", "warpfuel", ...RESOURCES.map((r) => r.id), ...PART_IDS, ...UPGRADE_IDS];
      }
      return null; // opaque: warp coords, land index, buy/craft quantity, …
    },
  };
}

export async function dispatch(player: Player, input: string): Promise<RenderFrame> {
  const seed = getWorldSeed();
  const { verb: rawVerb } = parseCommand(input);
  if (rawVerb === "") {
    return { ...frame([line(text("Type `help` for commands.", "muted"))]), status: buildStatusBar(player, seed) };
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

  // Attach the persistent status header (AC#2): one central attach point.
  // Re-read the player so the HUD reflects whatever mutations the handler made
  // (the in-hand `player` is the pre-command snapshot); fall back to it if the
  // read fails so the header still renders.
  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const status = buildStatusBar(fresh, seed);

  // Echo the expanded form when abbreviation changed what was typed, so the
  // player learns the canonical command.
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();
  if (canonical !== normalized) {
    return { ...frame([line(text(`» ${canonical}`, "muted")), ...result.lines]), status };
  }
  return { ...result, status };
}

/** The minimal player-state slice the unified applicability model reads. */
function playerState(player: Player, seed: string): PlayerStateView {
  return {
    embarked: player.embarked,
    landed: player.landed,
    inCombat: player.encounter != null,
    atTradeLocation: atTradeLocation(player, seed),
  };
}

/**
 * The contextual reason a (resolved, non-applicable) verb can't run right now —
 * derived from the SAME state buckets `isApplicable` uses, so the message always
 * matches why help omitted it. Combat is checked first (it overrides
 * everything); then the combat-only verbs out of combat; then the no-op embark
 * toggles; finally the embark-state split.
 */
function inapplicableReason(verb: string, state: PlayerStateView): string {
  if (state.inCombat) {
    return "You're in combat — `attack`, `flee`, or `eat` your way out.";
  }
  if (verb === "attack" || verb === "flee") {
    return "Nothing to fight here — `explore` to find creatures.";
  }
  if (isEconomyVerb(verb)) {
    return "You can only trade at a settlement or orbital outpost — find one and `jump O` to dock, or `jump`/`land` to a settlement region.";
  }
  // Embark/surface toggles (orbit-land three-state machine).
  if (verb === "embark") return "You're already aboard your ship.";
  if (verb === "disembark") {
    return state.embarked
      ? "You're in orbit — `land` on the surface first, then `disembark`."
      : "You're already on the surface.";
  }
  if (verb === "launch") {
    return state.embarked
      ? "You're already in orbit — nothing to launch from."
      : "You must `embark` your ship first.";
  }
  // Long jumps need to be in orbit already (they don't auto-launch).
  if (verb === "warp" || verb === "hyperwarp") {
    if (!state.embarked) return "You must `embark` and `launch` to orbit first.";
    return "You must `launch` to orbit first."; // landed
  }
  // `orbit`/`land` work in either aboard state (from the surface they chain a
  // launch), so they're only inapplicable when you're on foot.
  if (verb === "orbit" || verb === "land") {
    return "You must `embark` your ship first.";
  }
  // Salvage spans orbiting + on-foot; the only excluded aboard state is landed.
  if (verb === "salvage") {
    return "You're landed — `disembark` to salvage a surface site, or `launch` to reach an orbital wreck.";
  }
  // Remaining (surface/base) actions need you ON FOOT.
  if (state.embarked) {
    return state.landed
      ? "You must `disembark` onto the surface first."
      : "You must `land` and `disembark` onto the surface first.";
  }
  return "You must `disembark` onto the surface first.";
}

/** Dispatch an already-resolved (canonical verb, expanded args) command. */
async function dispatchResolved(
  player: Player,
  seed: string,
  verb: string,
  args: string[],
): Promise<RenderFrame> {
  // Unified applicability gate: informational commands are usable in every
  // state; everything else must be applicable in the player's current state
  // (embark + combat). The set rejected here is EXACTLY the set the no-arg
  // `help` omits — both consult `isApplicable`, so "shown" ⇔ "usable". The
  // older finer errors (e.g. `attack` with no encounter) still live in the
  // handlers and stay consistent with this gate.
  const state = playerState(player, seed);
  if (!isApplicable(verb, state)) {
    return errorFrame(inapplicableReason(verb, state));
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
    case "hyperwarp":
      return handleHyperwarp(player, seed, args);
    case "orbit":
      return handleOrbit(player, seed, args);
    case "land":
      return handleLand(player, seed, args);
    case "launch":
      return handleLaunch(player, seed);
    case "jump":
      return handleJump(player, seed, args);
    case "move":
      return handleMove(player, seed, args);
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
    case "salvage":
      return handleSalvage(player, seed);
    case "harvest":
      return handleHarvest(player, seed, args);
    case "plant":
      return handlePlant(player, seed, args);
    case "ranch":
      return handleRanch(player, seed, args);
    case "feed":
      return handleFeed(player, seed, args);
    case "slaughter":
      return handleSlaughter(player, seed, args);
    case "attack":
      return handleAttack(player);
    case "flee":
      return handleFlee(player);
    case "inventory":
      return handleInventory(player, seed);
    case "upgrades":
      return handleUpgrades(player);
    case "craft":
      return handleCraft(player, args);
    case "eat":
      return handleEat(player, args);
    case "build":
      return handleBuild(player, seed, args);
    case "upgrade":
      return handleUpgrade(player, seed, args);
    case "bases":
      return handleBases(player);
    case "base":
    case "storage":
      return handleStorage(player, seed);
    case "deposit":
      return handleDeposit(player, seed, args);
    case "withdraw":
      return handleWithdraw(player, seed, args);
    case "produce":
      return handleProduce(player, seed, args);
    case "sell":
      return handleSell(player, seed, args);
    case "buy":
      return handleBuy(player, seed, args);
    case "shipyard":
      return handleShipyard(player, seed);
    case "buyship":
      return handleBuyship(player, args);
    case "standing":
      return handleStanding(player);
    case "contracts":
      return handleContracts(player, seed);
    case "fulfill":
      return handleFulfill(player, seed, args);
    case "cartography":
      return handleCartography(player);
    case "who":
      return handleWho();
    case "here":
      return handleHere(player, seed);
    case "rename":
      return handleRename(player, args);
    case "distress":
      return handleDistress(player, seed);
    case "guide":
      return handleGuide(player, seed);
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
      return "this base is storing nothing — `deposit`, or wait for your excavators";
    case "plant":
      return "nothing grows in this biome — try a region with a different biome";
    case "harvest":
      return "no ripe crops here — `plant` some, or wait for them to grow";
    case "ranch":
      return "no livestock can be ranched in this biome — try a region with a different biome";
    case "feed":
    case "slaughter":
      return "you herd no animals here — `ranch` one first";
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
  // No-arg `help` is now CONTEXT-AWARE: list only the verbs applicable in the
  // player's current state (the same predicate the dispatch gate uses).
  const state = playerState(player, seed);
  if (args.length === 0) return renderHelp(state);

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
  // per-system market prices once (the candidate SET still comes from `argDomain`).
  const isTrade = verb === "buy" || verb === "sell";
  const sysKey = systemKey(systemOf(player));
  const prices = isTrade ? await world.getMarketPrices(sysKey) : null;
  // `help buy` additionally marks candidates the player can't perform RIGHT NOW
  // (can't afford, or — for upgrades/parts — out of stock) red, using the same
  // checks `handleBuy*` enforce. The supply is per-system now (P12b); rowless
  // items default to baseline (in stock), so `buyDisabled` merges baselines.
  // `sell` candidates are things you already own, so none are "unperformable";
  // only fetch the affordability inputs for `buy`.
  const buyCtx =
    verb === "buy"
      ? {
          credits: ((await world.getPlayerById(player.id)) ?? player).credits,
          supplies: await world.getSystemSupplies(sysKey),
        }
      : null;

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
        ? tradeSlotGroups(verb as "buy" | "sell", domain, prices, clickable, buyCtx)
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

  const helpFrame = renderCommandHelp({ verb, usage: usageLine(verb), desc: usage.desc, slots });
  // `help <command>` still fully describes the command, but notes when it isn't
  // usable right now (and why) — consistent with the no-arg list omitting it.
  if (!isApplicable(verb, state)) {
    return frame([...helpFrame.lines, line(text(`  (${inapplicableReason(verb, state)})`, "muted"))]);
  }
  return helpFrame;
}

/**
 * Build the labeled, price-annotated groups for a `buy`/`sell` argument from its
 * (already `argDomain`-sourced) candidate ids. Grouping is the pure
 * `groupTradeCandidates`; this layers the live prices on top:
 *   - buy: fuel = `REGULAR_FUEL_PRICE_PER_UNIT` / warpfuel =
 *     `WARP_FUEL_PRICE_PER_UNIT`; minerals = `buyUnitCost(price)`;
 *     upgrades = `buyUnitCost(upgradeValue)`.
 *   - sell: minerals = current market price; upgrades = `upgradeValue`; the
 *     `all` token carries no price.
 */
function tradeSlotGroups(
  verb: "buy" | "sell",
  domain: string[],
  prices: Record<string, number>,
  clickable: boolean,
  buyCtx: { credits: number; supplies: Record<string, number> } | null,
): CommandHelpGroup[] {
  return groupTradeCandidates(domain).map((g) => ({
    label: g.category,
    candidates: g.ids.map((id) => ({
      label: id,
      command: clickable ? `${verb} ${id}` : null,
      annotation: tradeAnnotation(verb, id, g.category, prices),
      disabled: buyCtx ? buyDisabled(id, g.category, prices, buyCtx) : false,
    })),
  }));
}

/**
 * Whether a `buy` candidate is currently unperformable — reusing the exact gates
 * the buy handlers enforce: can't afford the per-unit cost, or (upgrades) the
 * shared market supply is exhausted. Marks the help token red.
 */
function buyDisabled(
  id: string,
  category: TradeCategory,
  prices: Record<string, number>,
  ctx: { credits: number; supplies: Record<string, number> },
): boolean {
  switch (category) {
    case "everything":
      return false; // `all` is sell-only; never a buy candidate
    case "fuel":
      return ctx.credits < (id === "warpfuel" ? WARP_FUEL_PRICE_PER_UNIT : REGULAR_FUEL_PRICE_PER_UNIT);
    case "upgrades": {
      // Per-system supply (P12b): a rowless system defaults to the baseline.
      const supply = ctx.supplies[id] ?? supplyBaselineFor(id);
      if (!canBuyFromSupply(supply)) return true; // out of stock
      return ctx.credits < buyUnitCost(upgradeValue(id));
    }
    case "parts": {
      // Ship parts are buyable from the per-system supply (P12b); same gates.
      const supply = ctx.supplies[id] ?? supplyBaselineFor(id);
      if (!canBuyFromSupply(supply)) return true; // out of stock
      return ctx.credits < buyUnitCost(partValue(id));
    }
    case "minerals": {
      const price = prices[id] ?? getResource(id).baseValue;
      return ctx.credits < buyUnitCost(price);
    }
  }
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
      return creditLabel(id === "warpfuel" ? WARP_FUEL_PRICE_PER_UNIT : REGULAR_FUEL_PRICE_PER_UNIT);
    case "upgrades": {
      const value = upgradeValue(id);
      return creditLabel(verb === "buy" ? buyUnitCost(value) : value);
    }
    case "parts": {
      // Parts are code-priced (like upgrades): buy at the markup, sell at value.
      const value = partValue(id);
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
  if (atOutpost(player)) return outpostScanFrame(player, seed);
  const planet = planetAt(seed, locOf(player));
  // Orbit-land: ORBITING (or a gas giant, which can only be orbited) → the
  // orbital frame; LANDED / ON-FOOT on a rocky surface → the region detail.
  if (!player.landed || planet.isGas) return orbitalScanFrame(player, seed, planet);
  return regionScanFrame(player, seed, locOf(player), player.region);
}

/**
 * Scan frame for the orbital outpost (`player.region === -1`): the station in
 * orbit of the current planet. It has no biome / deposits / surface — it's a
 * trade hub (actual trade arrives in P12). Offers `jump <n>` (or `regions`) to
 * drop down to a surface region.
 */
async function outpostScanFrame(player: Player, seed: string): Promise<RenderFrame> {
  const planet = planetAt(seed, locOf(player));
  const system = systemAt(seed, locOf(player));
  // Co-located players (presence 3a): others docked at THIS outpost (region -1).
  const present = await world.playersHere({
    id: player.id,
    ...planet.coord,
    region: OUTPOST_REGION,
  });
  const lines: RenderLine[] = [
    line([
      text(`${planet.name} — Orbital Outpost`, "heading"),
      text("  (in orbit)", "muted"),
    ]),
    line([
      text("position ", "muted"),
      text(`(${system.position.x}, ${system.position.y}, ${system.position.z})`, "accent"),
    ]),
    line([
      text("HP ", "muted"),
      text(`${player.health}/${MAX_HEALTH}`, player.health <= MAX_HEALTH * 0.3 ? "danger" : "default"),
      text("   ", "muted"),
      text("docked at station", "accent"),
    ]),
    line([
      text("fuel ", "muted"),
      text(`${player.fuel}`, "default"),
      text("   warp fuel ", "muted"),
      text(`${player.warpFuel}`, "default"),
    ]),
    line(text("A station hangs in orbit of the planet — a trade hub.", "default")),
    line([
      text("⌂ ", "success"),
      text(`a ${inhabitingSpecies(seed, hubKeyOf(player)).name} trade outpost`, "accent"),
      text(" — you can feel whose space you're in.", "muted"),
    ]),
    line(text("No surface here: no biome, no deposits, no mining.", "muted")),
    line([
      text("Its market is open — you can ", "muted"),
      action("buy", "buy", { style: "link", title: "buy at the outpost market" }),
      text(" / ", "muted"),
      action("sell", "sell", { style: "link", title: "sell at the outpost market" }),
      text(" here.", "muted"),
    ]),
    // Keystone 1a: the outpost is a faction trade hub — surface its contracts.
    line([
      text("Its faction posts ", "muted"),
      action("contracts", "contracts", { style: "link", title: "see the faction's goods contracts" }),
      text(" — deliver goods for credits + reputation.", "muted"),
    ]),
    line([
      action("regions", "regions", { style: "link", title: "list the planet's surface regions" }),
      text(" or ", "muted"),
      text("jump <n>", "default"),
      text(" to drop to a surface region.", "muted"),
    ]),
  ];
  // Docked at the outpost you ARE orbiting (embarked + !landed), so the in-system
  // `orbit <n>` navigation belongs here too (orbit-land — the same nav the
  // orbital frame offers, fixing the omission the old gas/outpost frames had).
  const siblings = system.planets.filter((sib) => sib.coord.planet !== planet.coord.planet);
  if (siblings.length > 0) {
    const now = Date.now();
    lines.push(line(text("Other planets in this system (`orbit <n>`):", "heading")));
    for (const sib of siblings) {
      const cost = orbitFuelCost(planet, sib, now);
      const affordable = player.fuel >= cost;
      const label = `${sib.name} (${SIZE_CLASS_LABELS[sib.sizeClass]}${sib.isGas ? " gas giant" : ""})`;
      const title = affordable ? `orbit ${sib.name}` : `not enough fuel (need ${cost})`;
      lines.push(
        line([
          text(`  ${sib.coord.planet}: `, "muted"),
          action(label, `orbit ${sib.coord.planet}`, { style: "link", title, disabled: !affordable }),
          text(`  fuel ${cost}`, affordable ? "muted" : "danger"),
        ]),
      );
    }
  }
  // Co-located players docked at this outpost (presence 3a) — omitted when alone.
  lines.push(...presenceLines(present));
  return frame(lines);
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
  const coord = locOf(player);
  const planet = planetAt(seed, coord);

  // `jump O` (or `o`) docks at the planet's orbital outpost — only when it has
  // one. The outpost is the `region = -1` sentinel (not a surface region).
  const raw = args[0]?.trim().toLowerCase();
  if (raw === "o") {
    if (!hasOutpost(seed, coord)) {
      return errorFrame(`${planet.name} has no orbital outpost. \`jump <n>\` to a surface region.`);
    }
    if (player.region !== OUTPOST_REGION) await world.setRegion(player.id, OUTPOST_REGION);
    // Scan with the updated region so presence (and any region-derived view)
    // reflects being docked, not the surface region we just left.
    const scan = await outpostScanFrame({ ...player, region: OUTPOST_REGION }, seed);
    return frame([line(text(`Docked at the ${planet.name} orbital outpost.`, "success")), ...scan.lines]);
  }

  const n = toInt(args[0]);
  if (n === null) return errorFrame("Usage: jump <region|O>  (see `regions`)");

  // A gas giant has no surface regions to jump to (only `jump O`, handled above).
  if (planet.isGas) return gasGiantError(planet);

  if (n < 0 || n >= planet.regionCount) {
    return errorFrame(
      `No region ${n} on ${planet.name} — it has ${planet.regionCount} (0–${planet.regionCount - 1}). Try \`regions\`.`,
    );
  }

  if (n !== player.region) await world.setRegion(player.id, n);

  const scan = await regionScanFrame(player, seed, coord, n);
  return frame([line(text(`Jumped to region ${n}.`, "success")), ...scan.lines]);
}

/** The four compass directions, for validating/normalizing the `move` arg. */
const DIRECTIONS: readonly Direction[] = ["north", "south", "east", "west"];

/** True iff `s` is one of the four compass directions (after the resolver expands it). */
function isDirection(s: string): s is Direction {
  return (DIRECTIONS as readonly string[]).includes(s);
}

/**
 * `move <direction>` — walk one cell across the planet's lat×lon surface
 * (surface-nav). FREE, like region `jump` (no fuel). North/south step toward the
 * poles and CLAMP there; east/west wrap the globe. Server-authoritative: rejects
 * when you're not standing on a surface — in orbit (`land` first), at the orbital
 * outpost, or on a gas giant (no surface at all) — BEFORE mutating, then sets the
 * new region and re-renders it (its now climate-banded biome + deposits).
 */
async function handleMove(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  // Gas/outpost/orbit guards up front (mirrors `handleJump`'s own guards). You
  // can only walk a surface you're standing on.
  if (atOutpost(player)) {
    return errorFrame(
      "You're docked at the orbital outpost — `jump <n>` down to a surface region first.",
    );
  }
  const coord = locOf(player);
  const planet = planetAt(seed, coord);
  if (planet.isGas) return gasGiantError(planet);
  if (!player.landed) {
    return errorFrame(
      `You're in orbit above ${planet.name} — \`land\` on the surface before you can walk it.`,
    );
  }

  // The resolver expands `move n` → `move north` (its arg domain is the four
  // directions), so a valid line arrives canonicalized; guard defensively anyway.
  const dir = args[0]?.toLowerCase() ?? "";
  if (!isDirection(dir)) {
    return errorFrame("Usage: move <north|south|east|west>");
  }

  const grid = regionGrid(planet);
  const dest = moveRegion(player.region, dir, grid.rows, grid.cols);
  if (dest === null) {
    // N/S off the top/bottom row — you're at a pole (E/W never clamp).
    const pole = dir === "north" ? "north" : "south";
    return errorFrame(
      `You're at ${planet.name}'s ${pole} pole — can't go further ${pole}. \`move\` east/west to round the globe, or back the other way.`,
    );
  }

  if (dest !== player.region) await world.setRegion(player.id, dest);
  const scan = await regionScanFrame(player, seed, coord, dest);
  return frame([line(text(`Moved ${dir}.`, "success")), ...scan.lines]);
}

/**
 * `regions [page]` — a paged, clickable window of this planet's regions (a
 * planet can have up to 100,000, so we never list them all). Each row is a
 * `jump <n>` action labeled by that region's biome.
 */
function handleRegions(player: Player, seed: string, args: string[]): RenderFrame {
  const coord = locOf(player);
  const planet = planetAt(seed, coord);

  // A gas giant has no surface regions (planet-taxonomy) — describe it as such,
  // and offer its orbital outpost when one exists.
  if (planet.isGas) {
    const lines: RenderLine[] = [
      line([
        text(planet.name, "heading"),
        text(`  (${SIZE_CLASS_LABELS[planet.sizeClass]} gas giant)`, "muted"),
      ]),
      line(text("A gas giant — no surface regions to explore.", "muted")),
    ];
    if (hasOutpost(seed, coord)) {
      lines.push(
        line([
          action("jump O", "jump O", { style: "link", title: "dock at the orbital outpost" }),
          text(" to dock at its orbital outpost.", "muted"),
        ]),
      );
    }
    return frame(lines);
  }

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
    entries.push({
      index: i,
      biome: region.biome,
      current: i === player.region,
      settlement: hasSettlement(seed, { ...coord, region: i }),
    });
  }

  return renderRegions({
    planetName: planet.name,
    regionCount: planet.regionCount,
    page,
    pageCount,
    entries,
    // An orbital outpost is shown as a separate `O` entry (only on page 1, since
    // it isn't a numbered surface region). Marked current when docked there.
    hasOutpost: hasOutpost(seed, coord),
    atOutpost: atOutpost(player),
  });
}

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

/**
 * Cross-cluster / cross-arm neighbor systems around the current one (the
 * intra-cluster neighbors are now the nearest STARS by Euclidean distance, built
 * separately in `handleMap`). Walks arm ±1 and cluster ±1, holding the `system`
 * index at the current one (a representative star of that other cloud), so each
 * is a `warp <arm> <cluster> <system>` hop one tier out. Arm wraps into
 * `[0, armCount)`; cluster never goes negative; galaxy is fixed.
 */
function neighborCandidates(current: SystemCoord, armCount: number): SystemCoord[] {
  const out: SystemCoord[] = [];
  const seen = new Set<string>();
  // A representative star index in the neighbor cloud — keep the current index
  // when it's valid (clusters are finite now), else fall back to star 0.
  const system = current.system < STARS_PER_CLUSTER ? current.system : 0;
  for (let da = -1; da <= 1; da++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (da === 0 && dc === 0) continue; // same cluster → handled by the star list
      const cluster = current.cluster + dc;
      // Stay inside the finite disk: no ring below the core or past the rim
      // (galactic-structure). `map` only offers reachable clusters.
      if (cluster < 0 || cluster >= MAX_CLUSTERS_PER_ARM) continue;
      // Arm wraps around the ring and is canonicalized into [0, armCount).
      const arm = ((current.arm + da) % armCount + armCount) % armCount;
      const coord: SystemCoord = { galaxy: current.galaxy, arm, cluster, system };
      const key = systemKey(coord);
      if (key === systemKey(current) || seen.has(key)) continue;
      seen.add(key);
      out.push(coord);
    }
  }
  return out;
}

/** Number of nearest in-cluster stars `map` lists. */
const MAP_NEAR_STARS = 10;

/**
 * The LOCAL SURFACE MAP (surface-nav): the player's `(lat, lon)` on the planet's
 * lat×lon grid, a 3×3 neighborhood of nearby cells (each labeled by its biome,
 * the current cell bracketed), clickable `move <dir>` actions (pole-blocked N/S
 * read red — P9b), plus `regions`/`jump` fast-travel and a `launch` hint. Built
 * for a ROCKY surface region only (callers branch on orbit/outpost/gas first).
 */
function surfaceMapFrame(player: Player, seed: string, planet: Planet): RenderFrame {
  const coord = locOf(player);
  const grid = regionGrid(planet);
  const { lat, lon } = regionCoords(player.region, grid.rows, grid.cols);
  // 3×3 neighborhood, north (top row) → south (bottom row). Latitude clamps at
  // the poles (off-grid rows are `null`); longitude wraps (cyclic globe).
  const cells: (SurfaceMapCell | null)[][] = [];
  for (let dr = -1; dr <= 1; dr++) {
    const r = lat + dr;
    const row: (SurfaceMapCell | null)[] = [];
    for (let dc = -1; dc <= 1; dc++) {
      if (r < 0 || r >= grid.rows) {
        row.push(null); // off the pole — no cell there
        continue;
      }
      const c = (lon + dc + grid.cols) % grid.cols;
      const idx = regionIndex(r, c, grid.cols);
      row.push({ biome: regionAt(seed, coord, idx).biome, current: dr === 0 && dc === 0 });
    }
    cells.push(row);
  }
  return renderSurfaceMap({
    planetName: planet.name,
    lat,
    lon,
    rows: grid.rows,
    cols: grid.cols,
    cells,
    // North/south are blocked at the poles (E/W always wrap).
    canNorth: lat > 0,
    canSouth: lat < grid.rows - 1,
  });
}

async function handleMap(player: Player, seed: string): Promise<RenderFrame> {
  // Context-aware (surface-nav): standing on a surface region (landed, not the
  // orbital outpost, not a gas giant) → the LOCAL SURFACE map. Otherwise (in
  // orbit / docked at the outpost / a gas giant in orbit) → the galactic/system
  // navigation map below. Reuses the orbit-land surface/orbit state — no fork.
  if (!atOutpost(player) && player.landed) {
    const here = planetAt(seed, locOf(player));
    if (!here.isGas) return surfaceMapFrame(player, seed, here);
  }

  const current = systemOf(player);
  const galaxy = galaxyAt(seed, current.galaxy);
  const [discovered, materials] = await Promise.all([
    world.discoveredSystemKeys(),
    world.getPlayerMaterials(player.id),
  ]);
  // Condensate count drives the `hyperwarp` affordance (red when you have none).
  const condensate =
    materials.find((m) => m.materialId === HYPERWARP_CONDENSATE_ID)?.qty ?? 0;

  // Nearest stars WITHIN the current cluster, by real (Euclidean) distance — the
  // primary `map` listing now that stars have positions. Each carries its
  // `(x,y,z)` so a player can `warp <arm> <cluster> <x,y,z>` from the display.
  const stars = clusterStars(seed, clusterOf(current));
  const herePos = stars[current.system]!;
  const nearStars: MapNeighbor[] = stars
    .map((position, idx) => ({ idx, position }))
    .filter((s) => s.idx !== current.system)
    .map((s) => ({
      ...s,
      d: Math.hypot(
        s.position.x - herePos.x,
        s.position.y - herePos.y,
        s.position.z - herePos.z,
      ),
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAP_NEAR_STARS)
    .map((s) => {
      const coord: SystemCoord = { ...current, system: s.idx };
      return {
        arm: coord.arm,
        cluster: coord.cluster,
        system: coord.system,
        name: systemAt(seed, coord).name,
        distance: warpDistance(seed, current, coord, galaxy.armCount),
        position: s.position,
        discovered: discovered.has(systemKey(coord)),
      };
    });

  // Plus the cross-cluster / cross-arm neighbors (one tier out), so `map` still
  // shows how to leave this cluster.
  const farNeighbors: MapNeighbor[] = neighborCandidates(current, galaxy.armCount)
    .map((coord) => {
      const sys = systemAt(seed, coord);
      return {
        arm: coord.arm,
        cluster: coord.cluster,
        system: coord.system,
        name: sys.name,
        distance: warpDistance(seed, current, coord, galaxy.armCount),
        discovered: discovered.has(systemKey(coord)),
      };
    })
    .sort((a, b) => a.distance - b.distance);

  const neighbors: MapNeighbor[] = [...nearStars, ...farNeighbors];
  // `map` lists `warp` targets, which burn WARP fuel — affordability is checked
  // against the warp-fuel pool.
  const here = planetAt(seed, locOf(player));
  return renderMap(neighbors, player.warpFuel, {
    galaxyName: galaxy.name,
    armCount: galaxy.armCount,
    galaxy: current.galaxy,
    arm: current.arm,
    cluster: current.cluster,
    system: current.system,
    position: herePos,
    planet: player.planet,
    region: player.region,
    condensate,
    // Polar disk context (galactic-structure): the player's radius from the
    // core, the local center-radiation level, and the finite-disk rim cap.
    radiusFromCore: clusterRadius(current.cluster),
    radiation: galacticRadiation(current.cluster),
    radiationMax: RADIATION_MAX,
    maxClusters: MAX_CLUSTERS_PER_ARM,
    planetSize: SIZE_CLASS_LABELS[here.sizeClass],
    planetRadius: here.radius,
    planetIsGas: here.isGas,
  });
}

// ---------------------------------------------------------------------------
// warp
// ---------------------------------------------------------------------------

/**
 * Resolve a `warp` coordinate token (`"x,y,z"`) to a star index in the
 * destination cluster (star-coordinates). Parses three finite floats, rounds to
 * 2 dp (matching the stored star precision), and looks up the EXACT star via
 * `systemFromPosition`. On a miss it names the NEAREST star's coords + index, so
 * the player can re-aim. No fuzzy/nearest-match warp — the coordinate must hit a
 * star exactly.
 */
function resolveWarpCoord(
  seed: string,
  cluster: { galaxy: number; arm: number; cluster: number },
  token: string,
): { ok: true; system: number } | { ok: false; error: string } {
  const parts = token.split(",");
  if (parts.length !== 3) {
    return { ok: false, error: "Coordinates must be three numbers: x,y,z (e.g. 3.27,-1.04,0.88)." };
  }
  const nums = parts.map((p) => Number(p.trim()));
  if (nums.some((n) => !Number.isFinite(n))) {
    return { ok: false, error: `Bad coordinates "${token}" — use three numbers x,y,z.` };
  }
  const pos: StarPosition = { x: nums[0]!, y: nums[1]!, z: nums[2]! };
  const found = systemFromPosition(seed, cluster, pos);
  if (found !== null) return { ok: true, system: found };

  // No star exactly there — point at the nearest one to help the player re-aim.
  const stars = clusterStars(seed, cluster);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i]!;
    const d = Math.hypot(s.x - pos.x, s.y - pos.y, s.z - pos.z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const np = stars[best]!;
  return {
    ok: false,
    error: `No star at (${pos.x}, ${pos.y}, ${pos.z}). Nearest is #${best} at (${np.x}, ${np.y}, ${np.z}).`,
  };
}

async function handleWarp(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const armArg = toInt(args[0]);
  const cluster = toInt(args[1]);
  const systemToken = args[2];
  if (armArg === null || cluster === null || systemToken === undefined) {
    return errorFrame(
      "Usage: warp <arm> <cluster> <system|x,y,z>  (e.g. warp 0 0 1 or warp 0 0 3.27,-1.04,0.88)",
    );
  }
  if (cluster < 0) {
    return errorFrame("Cluster must be 0 or greater.");
  }
  // The galaxy is a FINITE disk: cluster ∈ [0, MAX_CLUSTERS_PER_ARM). The rim is
  // a hard edge — there is nothing beyond it to warp to (galactic-structure).
  if (cluster >= MAX_CLUSTERS_PER_ARM) {
    return errorFrame(
      `Cluster ${cluster} is beyond the galactic rim (outermost ring is ${MAX_CLUSTERS_PER_ARM - 1}). The disk ends there.`,
    );
  }

  const current = systemOf(player);
  // Arm is taken modulo the CURRENT galaxy's arm count — it's a ring, so e.g.
  // `warp 13 …` in a 12-arm galaxy lands on arm 1. Negative inputs wrap too.
  const { armCount } = galaxyAt(seed, current.galaxy);
  const arm = ((armArg % armCount) + armCount) % armCount;
  const destCluster = { galaxy: current.galaxy, arm, cluster };

  // The third arg is EITHER a star index OR an `x,y,z` coordinate triple
  // (star-coordinates). A comma marks the coordinate form.
  let system: number;
  if (systemToken.includes(",")) {
    const resolved = resolveWarpCoord(seed, destCluster, systemToken);
    if (!resolved.ok) return errorFrame(resolved.error);
    system = resolved.system;
  } else {
    const idx = toInt(systemToken);
    if (idx === null || idx < 0 || idx >= STARS_PER_CLUSTER) {
      return errorFrame(
        `System must be an index 0–${STARS_PER_CLUSTER - 1} or an x,y,z coordinate. Try \`map\`.`,
      );
    }
    system = idx;
  }

  // Galaxy is unchanged this phase (inter-galaxy travel is later).
  const dest: SystemCoord = { galaxy: current.galaxy, arm, cluster, system };
  if (
    dest.arm === current.arm &&
    dest.cluster === current.cluster &&
    dest.system === current.system
  ) {
    return errorFrame("You're already in that system. Try `map` for neighbors.");
  }

  const distance = warpDistance(seed, current, dest, armCount);
  // Warp burns WARP fuel, scaling only with distance (P2).
  const cost = warpFuelCost(distance);
  if (cost > player.warpFuel) {
    return errorFrame(
      `Not enough warp fuel: warp needs ${cost}, you have ${player.warpFuel}. Try a closer system or \`buy warpfuel\`.`,
    );
  }

  const newWarpFuel = player.warpFuel - cost;
  await world.setWarpFuelAndLocation(player.id, newWarpFuel, {
    galaxy: dest.galaxy,
    arm: dest.arm,
    cluster: dest.cluster,
    system: dest.system,
    planet: 0,
  });

  // Warp is NOT gated — you always arrive IN ORBIT of planet 0 (orbit-land);
  // you must `land` to descend. If that world is hostile you simply can't land/
  // mine it until you have the gear (or `orbit` a survivable sibling), so this
  // can never softlock you.
  const arrivalCoord: PlanetCoord = { ...dest, planet: 0 };
  const destSystem = systemAt(seed, dest);
  const arrived: Player = {
    ...player,
    galaxy: dest.galaxy, arm: dest.arm, cluster: dest.cluster, system: dest.system,
    planet: 0, region: 0, warpFuel: newWarpFuel, landed: false,
  };
  const scan = await orbitalScanFrame(arrived, seed, planetAt(seed, arrivalCoord));
  return frame([
    line([
      text(`Warped to ${destSystem.name}. `, "success"),
      text(`−${cost} warp fuel (${newWarpFuel} left).`, "muted"),
    ]),
    ...scan.lines,
  ]);
}

// ---------------------------------------------------------------------------
// hyperwarp — the long-haul fast-travel tier, and the ONLY command that changes
// `galaxy`. Consumes ONE Hyperwarp Condensate to jump either ANYWHERE in the
// current galaxy (`<arm> <cluster> <system>`) or to an ADJACENT galaxy's rim
// (`<galaxy>`). Embarked + orbiting only (gated in `dispatchResolved`). Normal
// warp-fuel `warp` is the local tier; hyperwarp is how you cross arms / reach the
// core or rim / hop galaxies. This REPLACES the old fixed-core-entry jump.
// ---------------------------------------------------------------------------

/**
 * `hyperwarp` — long-haul jump for ONE Hyperwarp Condensate. The arg count
 * disambiguates the two forms:
 *
 *  - `hyperwarp <arm> <cluster> <system>` (3 args) → fast-travel to that system
 *    in the CURRENT galaxy. `cluster ∈ [0, MAX_CLUSTERS_PER_ARM)`, `system ∈
 *    [0, STARS_PER_CLUSTER)`; arm is taken modulo the galaxy's `armCount` (a
 *    ring, like `warp`). NO warp-fuel/distance cost — flat 1 condensate.
 *  - `hyperwarp <galaxy>` (1 arg) → jump to an ADJACENT galaxy (`|Δ| === 1`,
 *    galaxy ≥ 0) and arrive at its RIM (cluster `MAX_CLUSTERS_PER_ARM − 1`, arm
 *    0, system 0). Flat 1 condensate.
 *
 * Both gate on owning ≥1 condensate and validate the destination BEFORE mutating
 * (an invalid destination consumes nothing and leaves the player put). On success
 * one condensate is consumed and the player relocates, arriving IN ORBIT of
 * planet 0, region 0 (orbit-land: `embarked` stays true, `landed=false`). Reuses
 * `world.setGalaxyLocation` (galaxy + full coords + region 0 + landed false) as
 * the single-write mover for both forms.
 */
async function handleHyperwarp(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  // Read the LIVE condensate count and gate on it FIRST — the most actionable
  // message when empty-handed, regardless of which destination form was typed.
  const materials = await world.getPlayerMaterials(player.id);
  const owned = materials.find((m) => m.materialId === HYPERWARP_CONDENSATE_ID)?.qty ?? 0;
  const gate = canHyperwarp(owned);
  if (!gate.ok) {
    return errorFrame(
      "You need a Hyperwarp Condensate to hyperwarp — `craft hyperwarp_condensate` from voidstone first.",
    );
  }

  // Resolve + validate the destination coord (no mutation yet).
  let arrivalCoord: PlanetCoord;
  let banner: RenderLine;
  const remaining = owned - 1;

  if (args.length >= 3) {
    // In-galaxy form: hyperwarp <arm> <cluster> <system>.
    const armArg = toInt(args[0]);
    const cluster = toInt(args[1]);
    const system = toInt(args[2]);
    if (armArg === null || cluster === null || system === null) {
      return errorFrame(
        "Usage: hyperwarp <arm> <cluster> <system>  (whole numbers; see `map`).",
      );
    }
    const { armCount } = galaxyAt(seed, player.galaxy);
    if (!isValidInGalaxyTarget(armArg, cluster, system, armCount)) {
      return errorFrame(
        `Out of range: cluster must be 0–${MAX_CLUSTERS_PER_ARM - 1} (the rim) and system 0–${STARS_PER_CLUSTER - 1}.`,
      );
    }
    const arm = ((armArg % armCount) + armCount) % armCount;
    const dest: SystemCoord = { galaxy: player.galaxy, arm, cluster, system };
    arrivalCoord = { ...dest, planet: 0 };
    const destSystem = systemAt(seed, dest);
    banner = line([
      text(`Hyperwarp engaged — you fold space to ${destSystem.name}. `, "success"),
      text(`arm ${arm} · cluster ${cluster} · system ${system}. `, "default"),
      text(`Condensate spent (${remaining} left).`, "muted"),
    ]);
  } else {
    // Adjacent-galaxy form: hyperwarp <galaxy> → arrive at that galaxy's rim.
    const target = toInt(args[0]);
    if (target === null) {
      return errorFrame(
        "Usage: hyperwarp <galaxy>  or  hyperwarp <arm> <cluster> <system>.",
      );
    }
    if (!isAdjacentGalaxy(player.galaxy, target)) {
      return errorFrame(
        `You can only hyperwarp to an ADJACENT galaxy (${player.galaxy === 0 ? "1" : `${player.galaxy - 1} or ${player.galaxy + 1}`}). For longer hops, chain jumps galaxy by galaxy.`,
      );
    }
    const destGalaxy = galaxyAt(seed, target);
    const arm = 0 % destGalaxy.armCount; // always 0 — explicit about the ring wrap.
    arrivalCoord = {
      galaxy: target,
      arm,
      cluster: MAX_CLUSTERS_PER_ARM - 1, // arrive at the rim
      system: 0,
      planet: 0,
    };
    banner = line([
      text(`Hyperwarp engaged — you breach into ${destGalaxy.name}. `, "success"),
      text(`Galaxy ${target} (${destGalaxy.armCount} arms), arriving at the rim. `, "default"),
      text(`Condensate spent (${remaining} left).`, "muted"),
    ]);
  }

  // Validated — consume exactly one condensate, then relocate in a single write
  // (region 0, landed false → you arrive ORBITING planet 0). No fuel charge.
  await world.addPlayerMaterial(player.id, HYPERWARP_CONDENSATE_ID, -1);
  await world.setGalaxyLocation(player.id, arrivalCoord);

  const arrived: Player = {
    ...player,
    galaxy: arrivalCoord.galaxy,
    arm: arrivalCoord.arm,
    cluster: arrivalCoord.cluster,
    system: arrivalCoord.system,
    planet: 0,
    region: 0,
    landed: false,
  };
  const scan = await orbitalScanFrame(arrived, seed, planetAt(seed, arrivalCoord));
  return frame([banner, ...scan.lines]);
}

// ---------------------------------------------------------------------------
// orbit / land / launch — the three-state per-planet travel machine (orbit-land).
//
//   ORBITING  (embarked, !landed)  →  aboard, above a planet
//   LANDED    (embarked,  landed)  →  aboard, on the surface (rocky only)
//   ON-FOOT   (!embarked)          →  disembarked on the surface (always landed)
//
// `orbit <planet>` flies you to ORBIT another planet (distance fuel; any planet,
// gas giants included). `land` DESCENDS to the surface of the planet you're
// orbiting (FREE; rocky only, landing gate applies). `land <planet>` is the
// orbit-then-descend combo. `launch` lifts you back to orbit (atmosphere fuel —
// the climb out). `disembark`/`embark` toggle the on-foot survival state, both
// from the LANDED state.
// ---------------------------------------------------------------------------

/**
 * Whether `planet`'s cluster is lethally irradiated (cascade 0b) — the
 * radiation-shield gate, mirroring the freezing/boiling temperature gate.
 * Per-cluster (radiation is `galacticRadiation(cluster)`).
 */
function planetRadiationShielded(planet: Planet): boolean {
  return radiationShieldRequired(galacticRadiation(planet.coord.cluster));
}

/**
 * The combined HARD surface gate: the freezing/boiling landing gear (`canLand`)
 * AND the radiation shield for a coreward (high-radiation) cluster. Returns the
 * missing upgrade ids (empty ⇒ clear to operate). Server-authoritative; composes
 * the two gates so a coreward freezing/boiling world can demand BOTH. Reused by
 * every surface action (`land`/`mine`/`explore`/`salvage`) and the scan
 * surfacing, so "shown blocked" ⇔ "would be rejected".
 */
function surfaceGateMissing(planet: Planet, owned: Set<string>): string[] {
  const missing: string[] = [];
  const tempGate = canLand(planet.temperature, owned);
  if (!tempGate.ok) missing.push(tempGate.required);
  if (planetRadiationShielded(planet) && !owned.has(RADIATION_SHIELD_UPGRADE_ID)) {
    missing.push(RADIATION_SHIELD_UPGRADE_ID);
  }
  return missing;
}

/**
 * The error frame explaining why `action` (e.g. "landing", "mining") onto
 * `planet`'s surface is blocked, or `null` when it's allowed. Combines the
 * freezing/boiling and radiation gates with clear, specific reasons.
 */
function surfaceGateError(
  planet: Planet,
  owned: Set<string>,
  action: string,
): RenderFrame | null {
  const missing = surfaceGateMissing(planet, owned);
  if (missing.length === 0) return null;
  const reasons: string[] = [];
  for (const id of missing) {
    const up = getUpgrade(id);
    if (id === RADIATION_SHIELD_UPGRADE_ID) {
      reasons.push(`lethal stellar radiation — equip a ${up.name}`);
    } else {
      const why = planet.temperature < 0 ? "freezing" : "boiling";
      reasons.push(`${why} surface (${planet.temperature}°C) requires ${up.name}`);
    }
  }
  return errorFrame(
    `${planet.name}: ${action} blocked — ${reasons.join("; ")}. \`produce\` or \`buy\` the gear first.`,
  );
}

/**
 * Why a descent onto `planet`'s surface is blocked, as an error frame — or
 * `null` when it's allowed. Gas giants have no surface; a freezing/boiling world
 * needs the matching landing upgrade; a coreward cluster needs a radiation
 * shield. Shared by `land` (descend) and the `land <planet>` combo so both gate
 * identically.
 */
async function landBlockedReason(
  player: Player,
  planet: Planet,
): Promise<RenderFrame | null> {
  // Gas giants have no surface to land on (planet-taxonomy) — but you can still
  // `orbit` them, so the model stays honest.
  if (planet.isGas) return gasGiantError(planet);
  const owned = await world.getOwnedUpgradeIds(player.id);
  return surfaceGateError(planet, owned, "landing");
}

/**
 * Regular-fuel surcharge for taking off when you issue an in-system move from the
 * SURFACE: the atmosphere climb (`launchFuelCost`, ceil'd) of the planet you're
 * leaving, or 0 when you're already in orbit. This is what lets `orbit`/`land`
 * CHAIN a launch from the surface so ordinary planet-to-planet travel doesn't
 * force an explicit `launch`. (The long jumps `warp`/`hyperwarp` never chain —
 * they require being in orbit already.)
 */
function launchSurcharge(player: Player, fromPlanet: Planet): number {
  if (!player.landed) return 0;
  return Math.max(1, Math.ceil(launchFuelCost(fromPlanet.atmosphere, fromPlanet.gravity)));
}

/**
 * `orbit <planet>` — fly to ORBIT another planet in this system (orbit-land).
 * Burns DISTANCE fuel (`orbitFuelCost`, time-varying) — NO descent term. Reaches
 * ANY planet, gas giants included (that's the whole point: gas giants are
 * orbit-only but no longer unreachable). When issued from the SURFACE it CHAINS a
 * launch first, so the cost is takeoff + flight. Validates index + (combined)
 * fuel before mutating; arrives Orbiting (landed=false, region nominal 0).
 */
async function handleOrbit(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const idx = toInt(args[0]);
  if (idx === null) return errorFrame("Usage: orbit <planet index>  (see `scan`)");

  const system = systemAt(seed, systemOf(player));
  if (idx < 0 || idx >= system.planetCount) {
    return errorFrame(
      `No planet ${idx} here — this system has ${system.planetCount} (0–${system.planetCount - 1}).`,
    );
  }

  const coord: PlanetCoord = { ...systemOf(player), planet: idx };
  const target = planetAt(seed, coord);
  const fromPlanet = planetAt(seed, locOf(player));
  // From the surface, orbiting first lifts off (atmosphere climb), then flies.
  const launchCost = launchSurcharge(player, fromPlanet);
  const hopCost = orbitFuelCost(fromPlanet, target, Date.now());
  const cost = launchCost + hopCost;
  if (cost > player.fuel) {
    const breakdown = launchCost > 0 ? " (launch + flight)" : "";
    return errorFrame(
      `Not enough fuel: orbiting ${target.name} needs ${cost}${breakdown}, you have ${player.fuel}. \`buy fuel\` (or \`craft biofuel\`) first.`,
    );
  }

  const newFuel = player.fuel - cost;
  await world.setFuelPlanetLanded(player.id, newFuel, idx, false);

  const arrived: Player = { ...player, planet: idx, region: 0, fuel: newFuel, landed: false };
  const scan = await orbitalScanFrame(arrived, seed, target);
  const prefix = launchCost > 0 ? "Launched and flew — " : "";
  return frame([
    line([
      text(`${prefix}now orbiting ${target.name}. `, "success"),
      text(`−${cost} fuel (${newFuel} left).`, "muted"),
    ]),
    ...scan.lines,
  ]);
}

/**
 * `land` (no arg) — DESCEND to the surface of the planet you're orbiting. FREE
 * (no fuel; the atmosphere is billed on `launch`). Rocky worlds only; the
 * freezing/boiling landing gate applies. Bare `land` requires being in ORBIT —
 * while already Landed it's a friendly no-op error (you're already down). `land
 * <planet>` is the combo (orbit there + descend; chains a launch from a surface).
 */
async function handleLand(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  // `land <planet>`: fly to ORBIT that planet (distance fuel, +launch if landed)
  // then descend free.
  if (args.length > 0) return handleLandCombo(player, seed, args);

  // Bare `land` requires being in orbit (descend the planet you're orbiting).
  if (player.landed) {
    const planet = planetAt(seed, locOf(player));
    return errorFrame(
      `You're already on the surface of ${planet.name}. \`launch\` to return to orbit, or \`land <planet>\` to fly elsewhere.`,
    );
  }

  // `land`: free descent onto the planet you're currently orbiting.
  const coord = locOf(player);
  const planet = planetAt(seed, coord);
  const blocked = await landBlockedReason(player, planet);
  if (blocked) return blocked;

  await world.setLandedDescent(player.id);
  const landed: Player = { ...player, region: 0, landed: true };
  const scan = await regionScanFrame(landed, seed, coord, 0);
  return frame([
    line([
      text(`Descended to the surface of ${planet.name}. `, "success"),
      text("Free descent — `disembark` to step out, or `launch` to return to orbit.", "muted"),
    ]),
    ...scan.lines,
  ]);
}

/**
 * `land <planet>` — the convenience combo: orbit that planet (distance fuel) then
 * descend free (`land`), in one. From the SURFACE it also CHAINS a launch first
 * (so the cost is takeoff + flight; descent stays free). Rocky target only;
 * gated + fuel-checked before any mutation so a blocked combo consumes nothing.
 * Arrives Landed (region 0).
 */
async function handleLandCombo(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const idx = toInt(args[0]);
  if (idx === null) {
    return errorFrame(
      "Usage: land [planet]  — omit to descend where you're orbiting, or give a planet # to fly there and land (see `scan`).",
    );
  }

  const system = systemAt(seed, systemOf(player));
  if (idx < 0 || idx >= system.planetCount) {
    return errorFrame(
      `No planet ${idx} here — this system has ${system.planetCount} (0–${system.planetCount - 1}).`,
    );
  }

  const coord: PlanetCoord = { ...systemOf(player), planet: idx };
  const target = planetAt(seed, coord);
  // Gate the DESCENT first (rocky + landing gear) so we never burn fuel flying
  // somewhere we can't land. No mutation on a blocked combo.
  const blocked = await landBlockedReason(player, target);
  if (blocked) return blocked;

  // Fuel = launch (only if leaving a surface) + the orbit hop; the descent is free.
  const fromPlanet = planetAt(seed, locOf(player));
  const launchCost = launchSurcharge(player, fromPlanet);
  const hopCost = orbitFuelCost(fromPlanet, target, Date.now());
  const cost = launchCost + hopCost;
  if (cost > player.fuel) {
    const breakdown = launchCost > 0 ? " (launch + flight)" : "";
    return errorFrame(
      `Not enough fuel: flying to ${target.name} needs ${cost}${breakdown}, you have ${player.fuel}. \`buy fuel\` first.`,
    );
  }

  const newFuel = player.fuel - cost;
  await world.setFuelPlanetLanded(player.id, newFuel, idx, true);

  const landed: Player = { ...player, planet: idx, region: 0, fuel: newFuel, landed: true };
  const scan = await regionScanFrame(landed, seed, coord, 0);
  const prefix = launchCost > 0 ? "Launched, flew" : "Flew";
  return frame([
    line([
      text(`${prefix} to ${target.name} and landed. `, "success"),
      text(`−${cost} fuel (${newFuel} left); descent free.`, "muted"),
    ]),
    ...scan.lines,
  ]);
}

/**
 * `launch` — lift off the surface back into orbit (orbit-land). Burns the
 * ATMOSPHERE climb (`launchFuelCost`, ceil'd) — NO distance term. Applicability
 * guarantees we're Landed (embarked + on a surface). Validates fuel before
 * mutating; if short, a clear error (and `craft biofuel` works on the surface,
 * so an empty tank on the ground is never a hard softlock).
 */
async function handleLaunch(player: Player, seed: string): Promise<RenderFrame> {
  const planet = planetAt(seed, locOf(player));
  const cost = Math.max(1, Math.ceil(launchFuelCost(planet.atmosphere, planet.gravity)));
  if (cost > player.fuel) {
    return errorFrame(
      `Not enough fuel: launching off ${planet.name} needs ${cost}, you have ${player.fuel}. \`buy fuel\` or \`craft biofuel\` first.`,
    );
  }

  const newFuel = player.fuel - cost;
  await world.setLaunch(player.id, newFuel);

  const arrived: Player = { ...player, fuel: newFuel, region: 0, landed: false };
  const scan = await orbitalScanFrame(arrived, seed, planet);
  return frame([
    line([
      text(`Launched off ${planet.name} into orbit. `, "success"),
      text(`−${cost} fuel (${newFuel} left).`, "muted"),
    ]),
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
  // There is no surface to step onto while docked in orbit.
  if (atOutpost(player)) {
    return errorFrame(
      "You're docked at the orbital outpost — `jump <n>` down to a surface region before you disembark.",
    );
  }
  const coord = locOf(player);
  const planet = planetAt(seed, coord);
  // A gas giant has no surface to step onto.
  if (planet.isGas) return gasGiantError(planet);
  await world.setEmbarked(player.id, false);

  const region = regionAt(seed, coord, player.region);
  // Hazard is per-region now — you're standing in THIS region, so its hazard
  // (not the planet mean) is what threatens you.
  const hazardPct = Math.round(region.hazard * 100);
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
      text("You're on the surface — `launch` to return to orbit.", "muted"),
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
  // No surface to work while docked at the orbital outpost.
  if (atOutpost(player)) {
    return errorFrame(
      "You're docked at the orbital outpost — `jump <n>` to a surface region to mine.",
    );
  }

  const resourceId = args[0]?.toLowerCase();
  if (!resourceId) return errorFrame("Usage: mine <resource>  (see `scan`)");

  const coord = locOf(player);
  const planet = planetAt(seed, coord);

  // A gas giant has no surface to mine (planet-taxonomy).
  if (planet.isGas) return gasGiantError(planet);

  // Same gate as `land`: you can't work a hostile surface without the gear
  // (freezing/boiling landing gear AND a radiation shield in a coreward cluster).
  const owned = await world.getOwnedUpgradeIds(player.id);
  const blocked = surfaceGateError(planet, owned, "mining");
  if (blocked) return blocked;

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

  // Surface hazard: a successful mine exposes you to harm. The roll uses the
  // REGION's hazard (you're standing in it) so a volcanic region wounds you more
  // than a calm one on the same planet. Two real rolls feed the pure
  // `rollHazardDamage`; the result is subtracted from health (floored at 0 by
  // the death branch). The ore is yours either way — you struck it before the
  // hazard hit.
  const damage = rollHazardDamage(region.hazard, Math.random(), Math.random());
  if (damage <= 0) {
    return frame([mineLine]);
  }

  const hazardPct = Math.round(region.hazard * 100);
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
// current `encounter`. The flora/fauna are GENERATED per region by the genome
// (`universe/genome.ts`: `regionFlora`/`regionFauna`/`speciesDrop`), and combat
// stats come from `speciesCombatStats` (`rules.ts`); these handlers supply the
// real `Math.random()` rolls and persist via `world`.
// ---------------------------------------------------------------------------

/**
 * Pick one element of a generated species list from a roll in `[0, 1)`, or
 * `null` when the list is empty. The handler supplies a real `Math.random()`;
 * this keeps the wild draw as a thin, pure index (the genome already filtered the
 * list to the region's environment).
 */
function pickSpecies(list: readonly Species[], roll: number): Species | null {
  if (list.length === 0) return null;
  const r = roll < 0 ? 0 : roll >= 1 ? 0.999999 : roll;
  return list[Math.floor(r * list.length)]!;
}

/** A descriptive creature label with its indefinite article — "a venomous stalker". */
function labelWithArticle(species: Species): string {
  const label = speciesLabel(species);
  return `${speciesArticle(label)} ${label}`;
}

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
  if (atOutpost(player)) return outpostSurfaceError();
  const coord = locOf(player);
  const planet = planetAt(seed, coord);

  // A gas giant has no surface to explore (planet-taxonomy).
  if (planet.isGas) return gasGiantError(planet);

  // Same surface gate as `mine`/`land`: you can't safely roam a hostile world
  // without the matching upgrade (landing gear AND a radiation shield coreward).
  // No state change when blocked.
  const owned = await world.getOwnedUpgradeIds(player.id);
  const blocked = surfaceGateError(planet, owned, "exploring");
  if (blocked) return blocked;

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
    // Generated flora for THIS region (env-fit; the base of its food web).
    const flora = pickSpecies(regionFlora(seed, region.coord), Math.random());
    if (flora) {
      const label = speciesLabel(flora);
      lines.push(
        line([
          text("You find ", "default"),
          text(label, "accent"),
          text(` growing across the ${biome}. `, "muted"),
          action("harvest", "harvest", { style: "link", title: `harvest the ${label}` }),
          text(" it.", "muted"),
        ]),
      );
    } else {
      lines.push(line(text(`Nothing worth harvesting in this ${biome}.`, "muted")));
    }
  } else {
    // Generated fauna for THIS region (the food web from 5a).
    const fauna = pickSpecies(regionFauna(seed, region.coord), Math.random());
    if (fauna) {
      const stats = speciesCombatStats(fauna);
      const label = speciesLabel(fauna);
      // Storing the encounter for BOTH hostile and placid fauna gives `attack` a
      // target either way; only hostile creatures are framed as a forced fight.
      await world.setEncounter(player.id, { species: fauna, hp: stats.maxHp });
      if (stats.hostile) {
        lines.push(
          line([
            text(`A hostile ${label}`, "danger"),
            text(` lunges at you! (HP ${stats.maxHp}, attack ${stats.attack})`, "muted"),
          ]),
        );
      } else {
        lines.push(
          line([
            text(`You come across ${labelWithArticle(fauna)}`, "default"),
            text(`. It eyes you warily but doesn't attack. (HP ${stats.maxHp})`, "muted"),
          ]),
        );
      }
      lines.push(
        line([
          action("attack", "attack", { style: "link", title: `attack the ${label}` }),
          text(" it for its materials, or ", "muted"),
          action("flee", "flee", { style: "link", title: "break off" }),
          text(".", "muted"),
        ]),
      );
    } else {
      lines.push(line(text(`No creatures stir in this ${biome}.`, "muted")));
    }
  }

  // Surface hazard: exploring exposes you to harm exactly like mining does,
  // off the REGION's hazard (you're standing in it).
  const damage = rollHazardDamage(region.hazard, Math.random(), Math.random());
  if (damage <= 0) return frame(lines);

  const hazardPct = Math.round(region.hazard * 100);
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
 * `salvage` (Keystone 3 / 3c) — strip a site for the loot you can't mine
 * (relics, rare materials, a credit cache). Works in TWO contexts, branched on
 * the player's orbit/surface state (applicability admits orbiting OR on-foot):
 *
 *  - ORBITING (`embarked && !landed`) → an ORBITAL DERELICT (`orbitalSiteAt`, one
 *    per PLANET incl. gas giants). Salvaged from the safety of your ship — NO
 *    hazard roll. Tracked in `salvaged_sites` keyed by the 5-seg `planetKey`.
 *  - ON FOOT (`!embarked`) → a SURFACE site (`siteAt`, per-region). Takes the
 *    standard region hazard roll afterward (can wound/kill, like `mine`).
 *    Tracked by the 6-seg `regionKey`. (planetKey and regionKey are both just
 *    text keys; the `(player_id, key)` PK distinguishes them — no schema change.)
 *
 * Once per player per site either way. Validate-before-mutate: refuse when
 * there's no site in the current context or you've already picked it clean,
 * BEFORE granting anything. Gas/outpost guarded for the surface path.
 */
async function handleSalvage(player: Player, seed: string): Promise<RenderFrame> {
  // No salvage while docked at the orbital outpost (you're at the station, not
  // free-orbiting a derelict; surface salvage has no surface here either).
  if (atOutpost(player)) return outpostSurfaceError();

  const coord = locOf(player);
  const planet = planetAt(seed, coord);

  // ORBITING → orbital derelict (no surface gate, no hazard, works on gas giants).
  if (player.embarked && !player.landed) {
    return handleOrbitalSalvage(player, seed, coord, planet);
  }

  // ON FOOT → surface site. A gas giant has no surface (but you can't be on foot
  // at one anyway — disembark is blocked there); guard defensively.
  if (planet.isGas) return gasGiantError(planet);

  // Same surface gate as `mine`/`explore`: a hostile (freezing/boiling) surface,
  // or a coreward irradiated one, needs the matching upgrade before you can work
  // it. No state change when blocked.
  const owned = await world.getOwnedUpgradeIds(player.id);
  const blocked = surfaceGateError(planet, owned, "salvaging");
  if (blocked) return blocked;

  const region = regionAt(seed, coord, player.region);
  const site = siteAt(seed, region.coord);
  if (!site) {
    return errorFrame("Nothing to salvage here. `explore` other regions to find a site.");
  }

  const rKey = regionKey(region.coord);
  if (await world.hasSalvaged(player.id, rKey)) {
    return errorFrame("You've already picked this site clean.");
  }

  // Award the deterministic loot: each material + the credit cache. Atomic per
  // RPC; then mark it salvaged so it can't be picked twice.
  const loot = siteLoot(seed, region.coord, site);
  for (const m of loot.materials) {
    await world.addPlayerMaterial(player.id, m.id, m.qty);
  }
  if (loot.credits > 0) await world.addPlayerCredits(player.id, loot.credits);
  await world.markSalvaged(player.id, rKey);

  const lines: RenderLine[] = [];
  lines.push(
    line([
      text("You comb the ", "default"),
      text(siteLabel(site.type), "accent"),
      text(" for anything of value.", "muted"),
    ]),
  );
  for (const m of loot.materials) {
    const mat = getMaterial(m.id);
    lines.push(
      line([
        text(`+${m.qty} ${mat.name}`, mat.category === "relic" ? "success" : "default"),
        text(mat.category === "relic" ? "  — a rare relic!" : ` (${mat.category})`, "muted"),
      ]),
    );
  }
  if (loot.credits > 0) {
    lines.push(line(text(`+${loot.credits} cr (a stashed credit cache).`, "success")));
  }

  // Surface hazard: picking through a site exposes you to the region's hazard,
  // exactly like `mine`/`explore`. The loot is already yours — you grabbed it
  // before the hazard hit.
  const damage = rollHazardDamage(region.hazard, Math.random(), Math.random());
  if (damage <= 0) return frame(lines);

  const hazardPct = Math.round(region.hazard * 100);
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
 * The ORBITING branch of `salvage` (Keystone 3c): strip a drifting orbital
 * derelict (`orbitalSiteAt`, one per planet) for its richer haul. NO hazard roll
 * — you work it from aboard your ship. Once per player per planet, keyed by the
 * 5-seg `planetKey` in `salvaged_sites`. Validate-before-mutate: refuse when
 * there's no wreck here or it's already picked clean, BEFORE granting anything.
 */
async function handleOrbitalSalvage(
  player: Player,
  seed: string,
  coord: PlanetCoord,
  planet: Planet,
): Promise<RenderFrame> {
  const site = orbitalSiteAt(seed, coord);
  if (!site) {
    return errorFrame(
      "Nothing to salvage here — no derelict drifts in this orbit. `orbit` other planets to find one.",
    );
  }

  const pKey = planetKey(coord);
  if (await world.hasSalvaged(player.id, pKey)) {
    return errorFrame("You've already picked this derelict clean.");
  }

  // Award the deterministic loot atomically (each material + the credit cache),
  // then mark it salvaged so it can't be picked twice.
  const loot = orbitalSiteLoot(seed, coord, site);
  for (const m of loot.materials) {
    await world.addPlayerMaterial(player.id, m.id, m.qty);
  }
  if (loot.credits > 0) await world.addPlayerCredits(player.id, loot.credits);
  await world.markSalvaged(player.id, pKey);

  const lines: RenderLine[] = [];
  lines.push(
    line([
      text("You match velocity with the drifting ", "default"),
      text(siteLabel(site.type), "accent"),
      text(` orbiting ${planet.name} and strip it for salvage.`, "muted"),
    ]),
  );
  for (const m of loot.materials) {
    const mat = getMaterial(m.id);
    lines.push(
      line([
        text(`+${m.qty} ${mat.name}`, mat.category === "relic" ? "success" : "default"),
        text(mat.category === "relic" ? "  — a rare relic!" : ` (${mat.category})`, "muted"),
      ]),
    );
  }
  if (loot.credits > 0) {
    lines.push(line(text(`+${loot.credits} cr (a stashed credit cache).`, "success")));
  }
  // No hazard roll — you never left your ship.
  return frame(lines);
}

/** Human-readable noun for a site type, for `salvage` / `scan` output. */
function siteLabel(type: Site["type"]): string {
  switch (type) {
    case "derelict":
      return "derelict ship";
    case "ruin":
      return "ancient ruin";
    case "anomaly":
      return "strange anomaly";
  }
}

/**
 * `harvest` — two paths:
 *   - `harvest` (no arg): collect a biome-appropriate WILD plant from the
 *     current region and award its `harvest` material (unchanged). Gentle — no
 *     hazard roll.
 *   - `harvest <crop>` (crop-farming): gather your RIPE plots of that crop at
 *     the current region's base — delete those plot rows and award the crop's
 *     `yield` × the number matured. Validate-before-mutate; a clear error when
 *     there's no base / nothing ripe.
 * The arg, when present, is resolved against the ripe-crops-here domain, so it
 * arrives as a canonical crop id.
 */
async function handleHarvest(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  if (atOutpost(player)) return outpostSurfaceError();
  const coord = locOf(player);
  // A gas giant has no surface to harvest from (planet-taxonomy).
  const planet = planetAt(seed, coord);
  if (planet.isGas) return gasGiantError(planet);

  const target = args[0]?.toLowerCase();
  if (target) return handleHarvestCrop(player, seed, target);

  const region = regionAt(seed, coord, player.region);
  // Generated flora for this region — its drop is a bounded `MATERIALS` id.
  const flora = pickSpecies(regionFlora(seed, region.coord), Math.random());
  if (!flora) {
    return errorFrame(`No harvestable plants in this ${region.biome}. Try \`explore\`.`);
  }
  const drop = speciesDrop(flora);
  const mat = getMaterial(drop.materialId);
  await world.addPlayerMaterial(player.id, drop.materialId, drop.qty);
  return frame([
    line([
      text(`You harvest the ${speciesLabel(flora)} — `, "success"),
      text(`+${drop.qty} ${mat.name}`, "accent"),
      text(`. \`embark\` then \`sell\` to cash it in.`, "muted"),
    ]),
  ]);
}

/**
 * `harvest <crop>` — gather the player's RIPE plots of `cropId` at the base in
 * the current region. Validates the crop, an owned base here, and that at least
 * one plot of it is mature (`cropMature`) BEFORE mutating; then removes those
 * plot rows and awards `yield.materialId × yield.qty × (#matured)` to
 * `player_materials`. Unripe / unplanted crops yield nothing (a clear error).
 */
async function handleHarvestCrop(
  player: Player,
  seed: string,
  cropId: string,
): Promise<RenderFrame> {
  if (!isCropId(cropId)) {
    return errorFrame(`"${cropId}" isn't a crop. \`plant\` a crop at your farm first.`);
  }
  const crop = getCrop(cropId);

  const base = await baseHere(player, seed);
  if (!base) {
    return errorFrame(
      `No base in region ${player.region} of ${planetAt(seed, locOf(player)).name} — \`build base\` then \`build crop_farm\` to farm.`,
    );
  }

  const plots = await world.getBasePlots(base.id);
  const now = Date.now();
  const ripe = plots.filter(
    (p) => p.cropId === cropId && cropMature(Date.parse(p.plantedAt), now, crop.growMs),
  );
  if (ripe.length === 0) {
    const planted = plots.filter((p) => p.cropId === cropId).length;
    return errorFrame(
      planted > 0
        ? `Your ${crop.name} isn't ripe yet (${planted} still growing). Check \`storage\`.`
        : `You have no ${crop.name} planted here. \`plant ${cropId}\` first.`,
    );
  }

  // Free the harvested plots, then award the yield — consume-then-grant, the
  // same ordering `produce`/`deposit` use (so a retry can't double-harvest the
  // same plots). Validation above guarantees there's something to take.
  const total = crop.yield.qty * ripe.length;
  const mat = getMaterial(crop.yield.materialId);
  await world.removePlots(ripe.map((p) => p.id));
  await world.addPlayerMaterial(player.id, crop.yield.materialId, total);

  return frame([
    line([
      text(`Harvested ${ripe.length} ripe ${crop.name} plot${ripe.length === 1 ? "" : "s"} — `, "success"),
      text(`+${total} ${mat.name}`, "accent"),
      text(`. \`embark\` then \`sell\` to cash it in.`, "muted"),
    ]),
    line(text(`  ${ripe.length} plot${ripe.length === 1 ? "" : "s"} freed for replanting.`, "muted")),
  ]);
}

/**
 * `plant <crop>` (crop-farming) — sow a biome-appropriate crop into a free plot
 * at the current region's crop farm. Disembarked-only (a surface/base action,
 * gated in `dispatchResolved`). Validates BEFORE mutating: not at the outpost /
 * on a gas giant, owns a base here, the base has ≥1 crop farm (plot capacity),
 * the crop grows in THIS region's biome, and a free plot exists. Then inserts a
 * plot row (its `planted_at` starts the growth clock).
 */
async function handlePlant(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  if (atOutpost(player)) return outpostSurfaceError();
  const coord = locOf(player);
  const planet = planetAt(seed, coord);
  if (planet.isGas) return gasGiantError(planet);

  const target = args[0]?.toLowerCase();
  if (!target) return errorFrame("Usage: plant <crop>  (see `scan` for what grows here)");

  const region = regionAt(seed, coord, player.region);
  const biomeCrops = cropsForBiome(region.biome);

  if (!isCropId(target)) {
    const grows = biomeCrops.map((c) => c.id).join(", ") || "nothing";
    return errorFrame(`"${target}" isn't a crop. This ${region.biome} grows: ${grows}.`);
  }
  const crop = getCrop(target);
  if (!crop.biomes.includes(region.biome)) {
    const grows = biomeCrops.map((c) => c.id).join(", ") || "nothing";
    return errorFrame(
      `${crop.name} won't grow in this ${region.biome}. Here you can plant: ${grows}.`,
    );
  }

  const base = await baseHere(player, seed);
  if (!base) {
    return errorFrame(
      `No base in region ${player.region} of ${planet.name} — \`build base\` then \`build crop_farm\` first.`,
    );
  }

  const [buildings, plots] = await Promise.all([
    world.getBaseBuildings(base.id),
    world.getBasePlots(base.id),
  ]);
  const cropFarms = buildings.filter((b) => b.kind === "crop_farm").length;
  if (cropFarms === 0) {
    return errorFrame("No crop farm here — `build crop_farm` first to get planting plots.");
  }
  const capacity = CROP_FARM_PLOTS * cropFarms;
  if (plots.length >= capacity) {
    return errorFrame(
      `All ${capacity} plots are in use. \`harvest\` ripe crops, or \`build crop_farm\` for more.`,
    );
  }

  await world.plantCrop(base.id, target);

  const used = plots.length + 1;
  const growMin = Math.round(crop.growMs / 60_000);
  return frame([
    line([
      text(`Planted ${crop.name} `, "success"),
      text(`in region ${player.region} of ${planet.name}. `, "default"),
      text(`Ripe in ~${growMin} min. `, "muted"),
      text(`Plots ${used}/${capacity}.`, "muted"),
    ]),
    line([
      text("`harvest ", "muted"),
      text(`${target}`, "default"),
      text("` once it's ripe (check `storage`).", "muted"),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// ranch / feed / slaughter (animal-husbandry) — the livestock loop at a base's
// pen. All three are DISEMBARKED-only (surface/base actions, gated in
// `dispatchResolved`) and additionally require owning a base with ≥1 livestock
// pen in the current region. Biome-affined like crops: `ranch` only accepts
// animals appropriate to this region's biome. Validate-before-mutate; head
// counts move through the atomic clamped `add_livestock` RPC, products through
// `add_player_material`. Not power-gated (agriculture, like the crop farm).
// ---------------------------------------------------------------------------

/**
 * Resolve the player's base here plus its livestock context: the pen count,
 * total head capacity, and current herds. Returns null when there's no surface,
 * no base, or no pen (with a caller-formatted error). Shared by all three
 * livestock handlers so the base/pen gates stay identical.
 */
async function livestockContext(
  player: Player,
  seed: string,
): Promise<
  | { ok: true; base: { id: string; name: string | null; rKey: string }; pens: number; capacity: number; herds: world.Herd[]; totalHead: number }
  | { ok: false; frame: RenderFrame }
> {
  if (atOutpost(player)) return { ok: false, frame: outpostSurfaceError() };
  const planet = planetAt(seed, locOf(player));
  if (planet.isGas) return { ok: false, frame: gasGiantError(planet) };
  const base = await baseHere(player, seed);
  if (!base) {
    return {
      ok: false,
      frame: errorFrame(
        `No base in region ${player.region} of ${planet.name} — \`build base\` then \`build livestock_pen\` first.`,
      ),
    };
  }
  const [buildings, herds] = await Promise.all([
    world.getBaseBuildings(base.id),
    world.getBaseLivestock(base.id),
  ]);
  const pens = buildings.filter((b) => b.kind === "livestock_pen").length;
  if (pens === 0) {
    return {
      ok: false,
      frame: errorFrame("No livestock pen here — `build livestock_pen` first to ranch animals."),
    };
  }
  const capacity = LIVESTOCK_PEN_CAPACITY * pens;
  const totalHead = herds.reduce((sum, h) => sum + h.count, 0);
  return { ok: true, base, pens, capacity, herds, totalHead };
}

/**
 * `ranch <animal>` — acquire a starter head of a biome-appropriate animal into
 * the current region's livestock pen for the animal's `acquireCost` credits.
 * Validates the animal id, that it can live in THIS region's biome, a base with
 * a pen here, free pen capacity, and affordability BEFORE mutating; then charges
 * credits and adds one head (its `last_bred_at` defaults to now).
 */
async function handleRanch(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  if (atOutpost(player)) return outpostSurfaceError();
  const coord = locOf(player);
  const planet = planetAt(seed, coord);
  if (planet.isGas) return gasGiantError(planet);

  const target = args[0]?.toLowerCase();
  if (!target) return errorFrame("Usage: ranch <animal>  (see `scan` for what you can ranch here)");

  const region = regionAt(seed, coord, player.region);
  const biomeAnimals = farmAnimalsForBiome(region.biome);
  if (!isFarmAnimalId(target)) {
    const list = biomeAnimals.map((a) => a.id).join(", ") || "nothing";
    return errorFrame(`"${target}" isn't a farm animal. This ${region.biome} supports: ${list}.`);
  }
  const animal = getFarmAnimal(target);
  if (!animal.biomes.includes(region.biome)) {
    const list = biomeAnimals.map((a) => a.id).join(", ") || "nothing";
    return errorFrame(
      `${animal.name} can't be ranched in this ${region.biome}. Here you can ranch: ${list}.`,
    );
  }

  const ctx = await livestockContext(player, seed);
  if (!ctx.ok) return ctx.frame;
  if (ctx.totalHead >= ctx.capacity) {
    return errorFrame(
      `Pen full (${ctx.totalHead}/${ctx.capacity} head). \`slaughter\` some, or \`build livestock_pen\` for more.`,
    );
  }

  const fresh = (await world.getPlayerById(player.id)) ?? player;
  if (fresh.credits < animal.acquireCost) {
    return errorFrame(
      `Can't afford ${animal.name} — costs ${animal.acquireCost} cr (have ${fresh.credits}).`,
    );
  }

  await world.addPlayerCredits(player.id, -animal.acquireCost);
  const newCount = await world.addLivestock(ctx.base.id, animal.id, 1);
  // Start (or restart, if re-stocking a slaughtered-out herd whose count-0 row
  // kept a stale timestamp) the breed cycle from now — a starter head shouldn't
  // be able to breed instantly off an old clock.
  if (newCount === 1) await world.setLivestockBred(ctx.base.id, animal.id, new Date().toISOString());

  return frame([
    line([
      text(`Ranched a ${animal.name} `, "success"),
      text(`in region ${player.region} of ${planet.name}. `, "default"),
      text(`Cost: ${animal.acquireCost} cr. `, "muted"),
      text(`Herd: ${newCount}. Pen ${ctx.totalHead + 1}/${ctx.capacity}.`, "muted"),
    ]),
    line([
      text("`feed ", "muted"),
      text(`${animal.id}`, "default"),
      text(`` + "` it ", "muted"),
      text(`${getCrop(animal.feed.cropId).name}`, "default"),
      text(" to breed it over time.", "muted"),
    ]),
  ]);
}

/**
 * `feed <animal>` — feed your herd of `animal` here its crop to breed it. Feeding
 * is only worthwhile once the breed cycle has elapsed, so this REJECTS early
 * (consuming nothing) when the herd isn't ready to breed or the pen is full —
 * feed is never wasted. When ready + room: consumes `feedAmount(count,
 * qtyPerHead)` of the animal's `feed.cropId` from `player_materials` (rejects, no
 * consumption, if short), adds `breedOffspring(count)` head (capped to remaining
 * capacity), and stamps the breed clock. Requires a herd of ≥1 head.
 */
async function handleFeed(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const target = args[0]?.toLowerCase();
  if (!target) return errorFrame("Usage: feed <animal>  (see `scan` for your herds)");
  if (!isFarmAnimalId(target)) {
    return errorFrame(`"${target}" isn't a farm animal. \`ranch\` one first.`);
  }
  const animal = getFarmAnimal(target);

  const ctx = await livestockContext(player, seed);
  if (!ctx.ok) return ctx.frame;
  const herd = ctx.herds.find((h) => h.animalId === animal.id);
  if (!herd || herd.count < 1) {
    return errorFrame(`You herd no ${animal.name} here. \`ranch ${animal.id}\` first.`);
  }

  // Breeding is the only effect of feeding (no upkeep/decay this phase), so don't
  // burn feed before the cycle has elapsed — reject early, consuming nothing.
  const now = Date.now();
  if (!livestockCanBreed(Date.parse(herd.lastBredAt), now, animal.breedMs)) {
    const remainMin = Math.max(1, Math.ceil((animal.breedMs - (now - Date.parse(herd.lastBredAt))) / 60_000));
    return errorFrame(
      `Your ${animal.name} aren't ready to breed yet (~${remainMin} min to go). Feeding now would be wasted.`,
    );
  }
  const room = ctx.capacity - ctx.totalHead;
  if (room <= 0) {
    return errorFrame(
      `Pen full (${ctx.totalHead}/${ctx.capacity} head) — no room to breed. \`slaughter\` some, or \`build livestock_pen\`.`,
    );
  }

  // Validate feed-on-hand BEFORE consuming.
  const feedNeed = feedAmount(herd.count, animal.feed.qtyPerHead);
  const crop = getMaterial(animal.feed.cropId);
  const materials = await world.getPlayerMaterials(player.id);
  const haveFeed = materials.find((m) => m.materialId === animal.feed.cropId)?.qty ?? 0;
  if (haveFeed < feedNeed) {
    return errorFrame(
      `Need ${feedNeed} ${crop.name} to feed ${herd.count} head (have ${haveFeed}). \`harvest\`/\`buy\` more.`,
    );
  }

  const offspring = Math.min(breedOffspring(herd.count), room);
  await world.addPlayerMaterial(player.id, animal.feed.cropId, -feedNeed);
  const newCount = await world.addLivestock(ctx.base.id, animal.id, offspring);
  await world.setLivestockBred(ctx.base.id, animal.id, new Date(now).toISOString());

  return frame([
    line([
      text(`Fed ${herd.count} ${animal.name} `, "success"),
      text(`${feedNeed} ${crop.name}. `, "muted"),
      text(`The herd bred +${offspring} — now ${newCount}. `, "accent"),
      text(`Pen ${ctx.totalHead + offspring}/${ctx.capacity}.`, "muted"),
    ]),
  ]);
}

/**
 * `slaughter <animal> [n]` — slaughter `n` head (default: the whole herd) of
 * `animal` from your pen here, yielding `product.qty × n` of its product
 * material into `player_materials`. Rejects if you herd fewer than `n`.
 * Validate-before-mutate; head removed via `add_livestock(-n)`, product granted
 * via `add_player_material(+)`.
 */
async function handleSlaughter(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const target = args[0]?.toLowerCase();
  if (!target) return errorFrame("Usage: slaughter <animal> [n]  (see `scan` for your herds)");
  if (!isFarmAnimalId(target)) {
    return errorFrame(`"${target}" isn't a farm animal. \`ranch\` one first.`);
  }
  const animal = getFarmAnimal(target);

  const ctx = await livestockContext(player, seed);
  if (!ctx.ok) return ctx.frame;
  const herd = ctx.herds.find((h) => h.animalId === animal.id);
  if (!herd || herd.count < 1) {
    return errorFrame(`You herd no ${animal.name} here. Nothing to slaughter.`);
  }

  const requested = toInt(args[1]);
  if (args[1] !== undefined && (requested === null || requested <= 0)) {
    return errorFrame("How many? `slaughter <animal> <n>` with a positive whole number.");
  }
  const n = requested ?? herd.count; // default: the whole herd
  if (n > herd.count) {
    return errorFrame(`You only herd ${herd.count} ${animal.name} — can't slaughter ${n}.`);
  }

  const award = animal.product.qty * n;
  const product = getMaterial(animal.product.materialId);
  await world.addLivestock(ctx.base.id, animal.id, -n);
  await world.addPlayerMaterial(player.id, animal.product.materialId, award);

  const remaining = herd.count - n;
  return frame([
    line([
      text(`Slaughtered ${n} ${animal.name} `, "success"),
      text(`→ ${award} ${product.name}. `, "accent"),
      text(`${remaining} head left in the pen.`, "muted"),
    ]),
    line([
      text("`sell ", "muted"),
      text(`${product.id}`, "default"),
      text("` at a settlement/outpost market.", "muted"),
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
  const species = enc.species;
  if (!species) {
    // Defensive: a stale pre-5b encounter shape — clear it rather than throw.
    await world.setEncounter(player.id, null);
    return errorFrame("The creature is gone. `explore` to find another.");
  }
  const stats = speciesCombatStats(species);
  const label = speciesLabel(species);
  const drop = speciesDrop(species);

  const round = combatRound({
    playerHp: player.health,
    playerAtk: PLAYER_BASE_ATTACK,
    creatureHp: enc.hp,
    creatureAtk: stats.attack,
  });

  const youHit = line([
    text(`You strike the ${label} for ${PLAYER_BASE_ATTACK}. `, "default"),
    text(
      stats.attack > 0 ? `It hits back for ${stats.attack}.` : "It doesn't fight back.",
      stats.attack > 0 ? "danger" : "muted",
    ),
  ]);

  if (round.creatureDead) {
    // Victory: grant the drop and end the encounter. (If you ALSO died this
    // round, the death sequence below still runs — you slew it as you fell.)
    const mat = getMaterial(drop.materialId);
    await world.addPlayerMaterial(player.id, drop.materialId, drop.qty);
    await world.setEncounter(player.id, null);

    if (round.playerDead) {
      const deathLines = await runDeath(
        player,
        `You killed the ${label} but fell with it. You wake aboard your ship, 10% of your gold lost.`,
      );
      return frame([
        youHit,
        line([
          text(`The ${label} dies. `, "success"),
          text(`You loot +${drop.qty} ${mat.name}.`, "accent"),
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
        text(`You slay the ${label}! `, "success"),
        text(`Loot: +${drop.qty} ${mat.name}. `, "accent"),
        text(`HP ${round.playerHp}/${MAX_HEALTH}.`, "muted"),
      ]),
    ]);
  }

  if (round.playerDead) {
    const deathLines = await runDeath(
      player,
      `The ${label} kills you. You wake aboard your ship, 10% of your gold lost.`,
    );
    return frame([youHit, ...deathLines]);
  }

  // Both survive: update the creature's HP and your health, fight continues.
  await world.setEncounter(player.id, { species, hp: round.creatureHp });
  await world.setHealth(player.id, round.playerHp);
  return frame([
    youHit,
    line([
      text(`${label} HP ${round.creatureHp}/${stats.maxHp}. `, "default"),
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
  const label = enc.species ? speciesLabel(enc.species) : null;
  await world.setEncounter(player.id, null);
  return frame([
    line([
      text("You break off and slip away", "success"),
      text(label ? ` from the ${label}.` : ".", "muted"),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------

async function handleInventory(player: Player, seed: string): Promise<RenderFrame> {
  const here = planetAt(seed, locOf(player));
  const [stacks, prices, materials, parts] = await Promise.all([
    world.getInventory(player.id),
    // Prices are per-system now — show the prices of the system you're in.
    world.getMarketPrices(systemKey(systemOf(player))),
    world.getPlayerMaterials(player.id),
    world.getPlayerParts(player.id),
  ]);
  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const cargoUsed = stacks.reduce((sum, s) => sum + s.qty, 0);
  return renderInventory({
    stacks: stacks.map((s) => ({
      resourceId: s.resourceId,
      qty: s.qty,
      price: prices[s.resourceId] ?? null,
    })),
    // Ship parts ride in a separate parts store (no cargo cost); tradeable +
    // depositable into a base silo (P12b). Listed with their fixed sell value.
    parts: parts.map((p) => ({
      partId: p.partId,
      qty: p.qty,
      name: getPart(p.partId).name,
      value: partValue(p.partId),
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
    shipName: getShip(fresh.shipId).name,
    credits: fresh.credits,
    fuel: fresh.fuel,
    warpFuel: fresh.warpFuel,
    health: fresh.health,
    maxHealth: MAX_HEALTH,
    embarked: fresh.embarked,
    planet: {
      name: here.name,
      size: SIZE_CLASS_LABELS[here.sizeClass],
      radius: here.radius,
      isGas: here.isGas,
    },
  });
}

// ---------------------------------------------------------------------------
// upgrades  (owned ship upgrades + their active capability)
// ---------------------------------------------------------------------------

async function handleUpgrades(player: Player): Promise<RenderFrame> {
  // Supply is per-system now (P12b) — show THIS system's stock (rowless = baseline).
  const sysKey = systemKey(systemOf(player));
  const [stacks, supplies] = await Promise.all([
    world.getPlayerUpgrades(player.id),
    world.getSystemSupplies(sysKey),
  ]);
  return renderUpgrades({
    owned: stacks.map((s) => ({ upgradeId: s.upgradeId, qty: s.qty })),
    // The per-system, self-reverting finite market supply per upgrade (P9a/P12b)
    // — buyable while > 0; a system never traded here reads as the baseline.
    market: UPGRADES.map((u) => ({
      upgradeId: u.id,
      supply: supplies[u.id] ?? UPGRADE_SUPPLY_BASELINE,
      price: buyUnitCost(upgradeValue(u.id)),
    })),
    // Credits drive the unaffordable→red marking on the buy actions above.
    credits: player.credits,
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

  // `craft` cooks food (from MATERIAL ingredients in player_materials), crafts
  // Hyperwarp Condensate (from voidstone in CARGO — P3), and refines biofuel
  // (flora/animal materials → regular fuel — P12a anti-softlock). The arg is
  // opaque, so resolve a food / condensate / `biofuel` id / unique prefix
  // handler-side (these still abbreviate: `craft ber` → the dish, `craft hyp` →
  // the condensate, `craft bio` → biofuel).
  const fr = resolveToken(target, [...FOOD_IDS, HYPERWARP_CONDENSATE_ID, "biofuel"]);
  if (!fr.ok) {
    if (fr.reason === "ambiguous") {
      return errorFrame(`Ambiguous item '${target}' — did you mean: ${fr.matches.join(", ")}?`);
    }
    return errorFrame(
      `Can't craft "${target}". \`craft\` cooks food, makes Hyperwarp Condensate, or refines biofuel; upgrades are \`produce\`d.`,
    );
  }
  if (fr.value === "biofuel") return handleCraftBiofuel(player, args[1], args[2]);
  if (fr.value === HYPERWARP_CONDENSATE_ID) return handleCraftCondensate(player);
  return handleCookFood(player, fr.value);
}

/**
 * `craft biofuel <material> [qty]` — the anti-softlock conversion (P12a): refine
 * a plant (`flora`) or animal material you carry into REGULAR fuel so an empty
 * tank in deep space (where `buy fuel` is gated to settlements/outposts) can
 * never strand you for good. Deliberately LOSSY (`biofuelYield`): the fuel is
 * worth strictly less than the materials, so it's a last resort, not an economy.
 *
 * Resolves the material against the player's OWNED flora/animal stacks (so it
 * abbreviates and only offers what you can actually refine). A non-bio material,
 * an unowned one, or a bad quantity errors with NO state change. On success it
 * consumes the materials and adds the fuel. Ungated by embark state and by
 * location — `craft` works anywhere.
 */
async function handleCraftBiofuel(
  player: Player,
  materialArg: string | undefined,
  qtyArg: string | undefined,
): Promise<RenderFrame> {
  if (!materialArg) {
    return errorFrame(
      "Usage: craft biofuel <material> [qty]  — refine a plant/animal material into regular fuel.",
    );
  }

  const stacks = await world.getPlayerMaterials(player.id);
  // Only flora/animal materials qualify; the candidate set is what you OWN of
  // those, so resolution abbreviates against your actual bio stock.
  const bioOwned = stacks
    .map((s) => s.materialId)
    .filter((id) => {
      const c = getMaterial(id).category;
      return c === "flora" || c === "animal";
    });

  const mr = resolveToken(materialArg.toLowerCase(), bioOwned);
  if (!mr.ok) {
    const typed = materialArg.toLowerCase();
    if (isMaterialId(typed)) {
      const cat = getMaterial(typed).category;
      if (cat !== "flora" && cat !== "animal") {
        return errorFrame(
          `${getMaterial(typed).name} can't be refined into biofuel — only plant (flora) and animal materials qualify.`,
        );
      }
      return errorFrame(`You aren't carrying any ${getMaterial(typed).name} to refine.`);
    }
    if (mr.reason === "ambiguous") {
      return errorFrame(`Ambiguous material '${materialArg}' — did you mean: ${mr.matches.join(", ")}?`);
    }
    return errorFrame(
      `No plant/animal material '${materialArg}' on hand to refine — \`harvest\` plants or hunt fauna first.`,
    );
  }
  const materialId = mr.value;
  const material = getMaterial(materialId);
  const ownedNow = stacks.find((s) => s.materialId === materialId)?.qty ?? 0;

  // Quantity: default the whole stack; a supplied value must be a positive int.
  let qty: number;
  if (qtyArg === undefined) {
    qty = ownedNow;
  } else {
    const requested = toInt(qtyArg);
    if (requested === null || requested <= 0) {
      return errorFrame("Usage: craft biofuel <material> [qty]  — qty must be a positive whole number.");
    }
    qty = requested;
  }
  if (ownedNow < qty) {
    return errorFrame(`You only own ${ownedNow} ${material.name} — can't refine ${qty}.`);
  }

  const fuelUnits = biofuelYield(materialValue(materialId), qty);
  if (fuelUnits <= 0) {
    return errorFrame(
      `That isn't enough ${material.name} to yield any fuel — refine more at once.`,
    );
  }

  // Validate done; consume the materials and add the fuel (read fresh fuel).
  const fresh = (await world.getPlayerById(player.id)) ?? player;
  await world.addPlayerMaterial(player.id, materialId, -qty);
  const newFuel = fresh.fuel + fuelUnits;
  await world.setFuel(player.id, newFuel);

  return frame([
    line([
      text(`Refined ${qty} ${material.name} into ${fuelUnits} fuel. `, "success"),
      text(`Fuel ${newFuel}.`, "muted"),
    ]),
    line(text("  Biofuel is lossy — buy fuel at a settlement when you can afford to.", "muted")),
  ]);
}

/**
 * Craft one Hyperwarp Condensate (P3) — the consumable that powers `hyperwarp`.
 * Unlike cooking (which draws on `player_materials`), its recipe is voidstone, a
 * mined RESOURCE that lives in the ship's CARGO hold — so this validates
 * `CONDENSATE_RECIPE` against the inventory with `canCraft` BEFORE mutating, then
 * consumes the voidstone from cargo (`removeInventory`) and grants one condensate
 * into `player_materials` (`addPlayerMaterial(+1)`). A shortfall errors with
 * nothing consumed. Ungated by embark state, like all crafting.
 */
async function handleCraftCondensate(player: Player): Promise<RenderFrame> {
  const recipe = CONDENSATE_RECIPE;

  const stacks = await world.getInventory(player.id);
  const have: Record<string, number> = {};
  for (const s of stacks) have[s.resourceId] = s.qty;

  if (!canCraft(have, recipe)) {
    const missing = Object.entries(recipe)
      .filter(([rid, qty]) => (have[rid] ?? 0) < qty)
      .map(([rid, qty]) => `${getResource(rid).name} ${have[rid] ?? 0}/${qty}`);
    return errorFrame(
      `Can't craft Hyperwarp Condensate — short on ${missing.join(", ")}. Mine voidstone on savage worlds.`,
    );
  }

  // Consume voidstone from cargo, then grant the condensate.
  for (const [rid, qty] of Object.entries(recipe)) {
    await world.removeInventory(player.id, rid, qty);
  }
  const owned = await world.addPlayerMaterial(player.id, HYPERWARP_CONDENSATE_ID, 1);

  const consumed = Object.entries(recipe)
    .map(([rid, qty]) => `${qty} ${getResource(rid).name}`)
    .join(" + ");
  return frame([
    line([
      text("Crafted Hyperwarp Condensate. ", "success"),
      text(`Consumed ${consumed}. `, "muted"),
      text(`You now hold ${owned}.`, "accent"),
    ]),
    line([
      text("`embark` then `hyperwarp <galaxy>` ", "muted"),
      text("to jump to another galaxy (one condensate per jump).", "muted"),
    ]),
  ]);
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
// accepts `base`, the in-base structures (silo/excavator/production_line) and
// the P13 power plants (thermal_plant/solar_array). The structure path, plus
// `deposit`/`withdraw`/`storage` and the automatic excavator accrual, live below.
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
  if (atOutpost(player)) return outpostSurfaceError();
  // A gas giant has no surface to build on (planet-taxonomy).
  const here = planetAt(seed, locOf(player));
  if (here.isGas) return gasGiantError(here);
  const structure = args[0]?.toLowerCase();
  if (!structure) {
    return errorFrame("Usage: build <base|silo|excavator|production_line|thermal_plant|solar_array|blast_furnace|crop_farm|livestock_pen> [name]");
  }
  if (structure === "base") return handleBuildBase(player, seed, args);
  if (isStructureKind(structure)) return handleBuildStructure(player, seed, structure);
  return errorFrame(
    `Can't build "${structure}" — try \`base\`, \`silo\`, \`excavator\`, \`production_line\`, \`thermal_plant\`, \`solar_array\`, \`blast_furnace\`, \`crop_farm\` or \`livestock_pen\`.`,
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
// build silo / excavator / production_line / power plant — in-base structures
// (P8a/P8b/P13). Disembarked-only (gated in `dispatchResolved`); additionally
// require owning a base in the current region. deposit / withdraw / storage
// operate on that base's storage; excavators accrue ore automatically below.
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
  const blastFurnaces = buildings.filter((b) => b.kind === "blast_furnace").length;
  const thermalPlants = buildings.filter((b) => b.kind === "thermal_plant").length;
  const solarArrays = buildings.filter((b) => b.kind === "solar_array").length;
  const cropFarms = buildings.filter((b) => b.kind === "crop_farm").length;
  const livestockPens = buildings.filter((b) => b.kind === "livestock_pen").length;
  // Recompute the base's power so the player learns immediately whether the new
  // consumer is powered (or the new plant fixed an underpowered base).
  const power = basePower({
    thermalPlants,
    solarArrays,
    excavators,
    productionLines: lines,
    blastFurnaces,
    temperature: region.temperature,
    atmosphere: planet.atmosphere,
    tier: base.tier,
  });
  const powerNote = power.powered
    ? `Power ${Math.round(power.supply)}/${power.demand} ✓.`
    : `Power ${Math.round(power.supply)}/${power.demand} — underpowered; build a thermal_plant or solar_array.`;
  let detail: string;
  switch (kind) {
    case "silo":
      detail = `Storage capacity is now ${baseCapacity(silos, base.tier)} (${silos} silo${silos === 1 ? "" : "s"}, tier ${base.tier}).`;
      break;
    case "excavator":
      detail = `${excavators} excavator${excavators === 1 ? "" : "s"} draining this region automatically (no \`collect\` needed). ${powerNote}`;
      break;
    case "production_line":
      detail = `${lines} production line${lines === 1 ? "" : "s"} ready — \`produce <part>\` from siloed minerals. ${powerNote}`;
      break;
    case "thermal_plant":
      detail = `Thermal plant online — power rises with this region's heat. ${powerNote}`;
      break;
    case "solar_array":
      detail = `Solar array online — power rises as the atmosphere thins. ${powerNote}`;
      break;
    case "blast_furnace":
      detail = `${blastFurnaces} blast furnace${blastFurnaces === 1 ? "" : "s"} ready — \`produce <ingot>\` to smelt siloed raw metal. ${powerNote}`;
      break;
    case "crop_farm": {
      // Not power-gated (agriculture is natural) — report plot capacity instead.
      const plots = CROP_FARM_PLOTS * cropFarms;
      detail = `${cropFarms} crop farm${cropFarms === 1 ? "" : "s"} — ${plots} planting plot${plots === 1 ? "" : "s"}. \`plant <crop>\` a biome-appropriate crop (no power needed).`;
      break;
    }
    case "livestock_pen": {
      // Not power-gated (agriculture is natural) — report head capacity instead.
      const heads = LIVESTOCK_PEN_CAPACITY * livestockPens;
      detail = `${livestockPens} livestock pen${livestockPens === 1 ? "" : "s"} — room for ${heads} head. \`ranch <animal>\` a biome-appropriate animal (no power needed).`;
      break;
    }
  }
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
 * `upgrade base` (Keystone 2c) — raise the current region's base by one tier,
 * multiplying its storage capacity (`baseTierMultiplier`/`baseCapacity`). The
 * cost is credits (from the wallet) + siloed PARTS/INGOTS (from `base_storage`),
 * scaling UP with the current tier — an ongoing production sink. Disembarked-only
 * (a surface/base action, gated in `dispatchResolved`); gas/outpost guarded like
 * the other base commands. Validates max-tier + affordability BEFORE mutating;
 * consumes credits + siloed inputs atomically, then increments `bases.tier`.
 *
 * The arg domain is just `["base"]` today (extensible later). `handleBuild`'s
 * cost machinery isn't reused verbatim because the inputs come from the SILO
 * (`add_base_storage(-)`), not the cargo hold (`removeInventory`).
 */
async function handleUpgrade(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  if (atOutpost(player)) return outpostSurfaceError();
  const planet = planetAt(seed, locOf(player));
  if (planet.isGas) return gasGiantError(planet);

  const target = args[0]?.toLowerCase();
  if (target !== "base") {
    return errorFrame("Usage: upgrade base  — raise your base's tier for more storage capacity.");
  }

  const base = await baseHere(player, seed);
  if (!base) {
    return errorFrame(
      `No base in region ${player.region} of ${planet.name} to upgrade. \`build base\` first.`,
    );
  }

  if (base.tier >= MAX_BASE_TIER) {
    return errorFrame(`Your base is already at the maximum tier (${MAX_BASE_TIER}).`);
  }

  const cost = baseUpgradeCost(base.tier);
  const credits = upgradeCredits(base.tier);
  const inputs = upgradeMinerals(base.tier);

  // Affordability: credits from the live wallet + the part/ingot inputs from the
  // SILO (base_storage), not the cargo hold.
  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const stored = await world.getBaseStorage(base.id);
  const siloed: Record<string, number> = {};
  for (const s of stored) siloed[s.itemId] = s.qty;
  const have: Record<string, number> = { credits: fresh.credits, ...siloed };
  if (!canAffordBase(have, cost)) {
    const short = Object.entries(cost)
      .filter(([k, q]) => (have[k] ?? 0) < q)
      .map(([k, q]) =>
        k === "credits"
          ? `${q} cr (have ${have.credits ?? 0})`
          : `${q} ${storageItemName(k)} in the silo (have ${siloed[k] ?? 0})`,
      );
    return errorFrame(`Can't upgrade to tier ${base.tier + 1} — short on ${short.join(", ")}.`);
  }

  // Consume atomically: siloed inputs via the storage RPC, then credits.
  for (const [itemId, qty] of Object.entries(inputs)) {
    await world.addBaseStorage(base.id, itemId, -qty);
  }
  if (credits > 0) await world.addPlayerCredits(player.id, -credits);
  const newTier = base.tier + 1;
  await world.setBaseTier(base.id, newTier);

  // Recompute capacity off the new tier for the report.
  const buildings = await world.getBaseBuildings(base.id);
  const silos = buildings.filter((b) => b.kind === "silo").length;
  const newCapacity = baseCapacity(silos, newTier);
  const powerGain = baseTierPowerBonus(newTier) - baseTierPowerBonus(base.tier);
  const consumed = [
    ...Object.entries(inputs).map(([itemId, qty]) => `${qty} ${storageItemName(itemId)}`),
    `${credits} cr`,
  ].join(" + ");

  return frame([
    line([
      text(`Upgraded your base to tier ${newTier}. `, "success"),
      text(`Consumed ${consumed}. `, "muted"),
    ]),
    line(
      text(
        `Storage capacity is now ${newCapacity} (${silos} silo${silos === 1 ? "" : "s"} × ${baseTierMultiplier(newTier)}); power supply +${powerGain} (now +${baseTierPowerBonus(newTier)} from tier).`,
        "accent",
      ),
    ),
  ]);
}

/**
 * Display name for an item in base storage. Storage holds both raw resources
 * (deposited / collected) and manufactured ship parts (`produce`d), so a plain
 * `getResource` would throw on a part id — resolve parts first, then resources.
 */
function storageItemName(itemId: string): string {
  if (isPartId(itemId)) return getPart(itemId).name;
  if (isIngotId(itemId)) return getIngot(itemId).name;
  return getResource(itemId).name;
}

/**
 * Summarize a base's plots for display: group by crop, count ripe vs growing.
 * Pure (time passed in). Sorted by crop id for stable output. Unknown crop ids
 * (a since-removed catalog entry) are skipped defensively.
 */
function summarizePlots(plots: world.Plot[], now: number): PlotSummary[] {
  const byId = new Map<string, { ripe: number; growing: number }>();
  for (const p of plots) {
    if (!isCropId(p.cropId)) continue;
    const e = byId.get(p.cropId) ?? { ripe: 0, growing: 0 };
    if (cropMature(Date.parse(p.plantedAt), now, getCrop(p.cropId).growMs)) e.ripe++;
    else e.growing++;
    byId.set(p.cropId, e);
  }
  return [...byId.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cropId, e]) => ({ cropId, name: getCrop(cropId).name, ripe: e.ripe, growing: e.growing }));
}

/**
 * Clickable `plant <crop>` hints for the current region's biome. Each is marked
 * red (disabled) when there's no free plot (or no crop farm) — the P9b
 * unperformable→red convention. Empty when nothing grows in this biome.
 */
function plantHints(biome: Biome, hasFreePlot: boolean): PlantHint[] {
  return cropsForBiome(biome).map((c) => ({
    cropId: c.id,
    name: c.name,
    disabled: !hasFreePlot,
  }));
}

/**
 * Summarize a base's livestock herds for display (animal-husbandry): per-herd
 * count, breed-readiness, and feed needed. Pure (time + capacity passed in).
 * Sorted by animal id for stable output. Unknown animal ids (a since-removed
 * catalog entry) are skipped defensively. A herd is `ready` only when its breed
 * cycle has elapsed AND the pen has room (`feed` would otherwise be wasted).
 */
function summarizeHerds(
  herds: world.Herd[],
  now: number,
  totalHead: number,
  capacity: number,
): HerdSummary[] {
  const room = capacity - totalHead;
  return herds
    .filter((h) => isFarmAnimalId(h.animalId) && h.count > 0)
    .sort((a, b) => a.animalId.localeCompare(b.animalId))
    .map((h) => {
      const animal = getFarmAnimal(h.animalId);
      const elapsed = now - Date.parse(h.lastBredAt);
      const cycleReady = livestockCanBreed(Date.parse(h.lastBredAt), now, animal.breedMs);
      const ready = cycleReady && room > 0;
      const feedNeed = feedAmount(h.count, animal.feed.qtyPerHead);
      const feedSummary = `feed ${feedNeed} ${getMaterial(animal.feed.cropId).name}`;
      let note: string;
      if (!cycleReady) {
        const remainMin = Math.max(1, Math.ceil((animal.breedMs - elapsed) / 60_000));
        note = `breeding — ~${remainMin} min`;
      } else if (room <= 0) {
        note = "ready, but pen full";
      } else {
        note = "ready to breed";
      }
      return {
        animalId: h.animalId,
        name: animal.name,
        count: h.count,
        ready,
        note,
        feedSummary,
        feedDisabled: !ready,
      };
    });
}

/**
 * Clickable `ranch <animal>` hints for the current region's biome (each with its
 * acquire cost). Marked red (disabled) when the pen is full — the P9b
 * unperformable→red convention. Empty when nothing can be ranched in this biome.
 */
function ranchHints(biome: Biome, penFull: boolean): RanchHint[] {
  return farmAnimalsForBiome(biome).map((a) => ({
    animalId: a.id,
    name: a.name,
    cost: a.acquireCost,
    disabled: penFull,
  }));
}

/** Resolve the base the player owns in their current region (or null). */
async function baseHere(
  player: Player,
  seed: string,
): Promise<{ id: string; name: string | null; rKey: string; tier: number } | null> {
  // No base/region at the orbital outpost — there is no surface here.
  if (atOutpost(player)) return null;
  // A gas giant has no surface region, so no base can exist there.
  if (planetAt(seed, locOf(player)).isGas) return null;
  const region = regionAt(seed, locOf(player), player.region);
  const rKey = regionKey(region.coord);
  const base = await world.getBaseInRegion(player.id, rKey);
  return base ? { id: base.id, name: base.name, rKey, tier: base.tier } : null;
}

/**
 * `storage` (alias `base`) — show the current region's base: its silo/excavator
 * counts, and its stored contents against the silo-derived capacity. Either
 * embark state is fine — it's your base.
 */
async function handleStorage(player: Player, seed: string): Promise<RenderFrame> {
  if (atOutpost(player)) {
    return errorFrame(
      "You're docked at the orbital outpost — there's no base here. `jump <n>` to a surface region.",
    );
  }
  const planet = planetAt(seed, locOf(player));
  // A gas giant has no surface — no base can exist there.
  if (planet.isGas) {
    return errorFrame(`${planet.name} is a gas giant — no surface, so no base here.`);
  }
  const base = await baseHere(player, seed);
  if (!base) {
    return errorFrame(
      `No base in region ${player.region} of ${planet.name}. \`disembark\` then \`build base\`.`,
    );
  }
  // Realize any pending excavator output BEFORE reading the silos, so what we
  // display already includes the ore the (powered) excavators just funneled in.
  const region = regionAt(seed, locOf(player), player.region);
  await accrueExcavators(player, base.id, base.rKey, region, planet, base.tier);

  const [buildings, stored, have, rawPlots, rawHerds, cargoUsed] = await Promise.all([
    world.getBaseBuildings(base.id),
    world.getBaseStorage(base.id),
    affordContext(player),
    world.getBasePlots(base.id),
    world.getBaseLivestock(base.id),
    world.getCargoUsed(player.id),
  ]);
  const silos = buildings.filter((b) => b.kind === "silo").length;
  const excavators = buildings.filter((b) => b.kind === "excavator").length;
  const productionLines = buildings.filter((b) => b.kind === "production_line").length;
  const blastFurnaces = buildings.filter((b) => b.kind === "blast_furnace").length;
  const thermalPlants = buildings.filter((b) => b.kind === "thermal_plant").length;
  const solarArrays = buildings.filter((b) => b.kind === "solar_array").length;
  const cropFarms = buildings.filter((b) => b.kind === "crop_farm").length;
  const livestockPens = buildings.filter((b) => b.kind === "livestock_pen").length;
  const capacity = baseCapacity(silos, base.tier);
  // Crop plots (crop-farming): summary + capacity + clickable plant hints (red
  // when no free plot — P9b). Only surfaced once a crop farm exists.
  const plotCapacity = CROP_FARM_PLOTS * cropFarms;
  const plotSummary = cropFarms > 0 ? summarizePlots(rawPlots, Date.now()) : [];
  const plantHintList = cropFarms > 0 ? plantHints(region.biome, rawPlots.length < plotCapacity) : [];
  // Livestock pen (animal-husbandry): head capacity + per-herd breed-readiness +
  // clickable feed/slaughter/ranch hints. Only surfaced once a pen exists.
  const headCapacity = LIVESTOCK_PEN_CAPACITY * livestockPens;
  const totalHead = rawHerds.reduce((sum, h) => sum + h.count, 0);
  const herdSummary = livestockPens > 0 ? summarizeHerds(rawHerds, Date.now(), totalHead, headCapacity) : [];
  const ranchHintList = livestockPens > 0 ? ranchHints(region.biome, totalHead >= headCapacity) : [];
  const used = stored.reduce((sum, s) => sum + s.qty, 0);

  // Power balance (P13): plant supply vs consumer demand, sited by this region's
  // temperature + the planet's atmosphere. Surfaced (red when short) so the
  // player knows whether the excavators/lines/furnaces are actually running.
  const power = basePower({
    thermalPlants,
    solarArrays,
    excavators,
    productionLines,
    blastFurnaces,
    temperature: region.temperature,
    atmosphere: planet.atmosphere,
    tier: base.tier,
  });

  // Siloed amounts for the producible-affordability check (`produce` consumes
  // recipe inputs from the silo, not cargo) — same `canProduce` the handler uses.
  const siloed: Record<string, number> = {};
  for (const s of stored) siloed[s.itemId] = s.qty;

  // Tier upgrade (Keystone 2c): the next tier's cost (credits + siloed
  // parts/ingots) and the capacity it unlocks, plus affordability (credits from
  // the wallet + inputs from the silo). Absent at the max tier.
  const nextUpgrade =
    base.tier < MAX_BASE_TIER
      ? (() => {
          const cost = baseUpgradeCost(base.tier);
          const upgradeHave: Record<string, number> = { credits: have.credits ?? 0, ...siloed };
          return {
            tier: base.tier + 1,
            cost: [
              ...Object.entries(upgradeMinerals(base.tier)).map(
                ([itemId, qty]) => `${qty} ${storageItemName(itemId)}`,
              ),
              `${upgradeCredits(base.tier)} cr`,
            ].join(" + "),
            capacity: baseCapacity(silos, base.tier + 1),
            powerBonus: baseTierPowerBonus(base.tier + 1) - baseTierPowerBonus(base.tier),
            affordable: canAffordBase(upgradeHave, cost),
          };
        })()
      : undefined;

  return renderStorage({
    name: base.name,
    location: describeRegionKey(base.rKey),
    tier: base.tier,
    nextUpgrade,
    silos,
    excavators,
    productionLines,
    blastFurnaces,
    thermalPlants,
    solarArrays,
    cropFarms,
    livestockPens,
    power: {
      supply: power.supply,
      demand: power.demand,
      powered: power.powered,
      tierBonus: baseTierPowerBonus(base.tier),
    },
    // Crop-farming: plot usage + per-crop maturity + clickable plant hints.
    plotsUsed: rawPlots.length,
    plotCapacity,
    plots: plotSummary,
    plantHints: plantHintList,
    // Animal-husbandry: head usage + per-herd breed-readiness + ranch hints.
    headUsed: totalHead,
    headCapacity,
    herds: herdSummary,
    ranchHints: ranchHintList,
    used,
    capacity,
    items: stored.map((s) => ({ itemId: s.itemId, qty: s.qty, name: storageItemName(s.itemId) })),
    // What a production line here can manufacture (only surfaced when one exists).
    // A part is disabled (red) when its recipe isn't fully siloed, or the base is
    // underpowered (the production line can't run either way).
    producible:
      productionLines > 0
        ? PARTS.map((p) => ({
            id: p.id,
            name: p.name,
            recipe: Object.entries(p.recipe)
              .map(([rid, qty]) => `${qty} ${storageItemName(rid)}`)
              .join(" + "),
            disabled: !power.powered || !canProduce(siloed, p.recipe, 1),
          }))
        : [],
    // What a blast furnace here can smelt (only surfaced when one exists). An
    // ingot is disabled (red) when its raw metal isn't fully siloed, or the base
    // is underpowered (P9b red convention).
    smeltable:
      blastFurnaces > 0
        ? INGOTS.map((i) => ({
            id: i.id,
            name: i.name,
            recipe: Object.entries(i.recipe)
              .map(([rid, qty]) => `${qty} ${getResource(rid).name}`)
              .join(" + "),
            disabled: !power.powered || !canProduce(siloed, i.recipe, 1),
          }))
        : [],
    // Ships a production line here can BUILD (Keystone 2b). Disabled (red) when
    // the base is underpowered, the recipe isn't fully siloed, it's already your
    // ship, or your current cargo wouldn't fit the new hold (an overflow
    // downgrade) — the same gates `handleProduceShip` enforces.
    buildableShips:
      productionLines > 0
        ? SHIPS.filter((s) => isBuildableShip(s.id)).map((s) => {
            const recipe = shipRecipeOf(s.id)!;
            return {
              id: s.id,
              name: s.name,
              recipe: Object.entries(recipe)
                .map(([itemId, qty]) => `${qty} ${storageItemName(itemId)}`)
                .join(" + "),
              disabled:
                !power.powered
                || !canProduce(siloed, recipe, 1)
                || s.id === player.shipId
                || cargoUsed > s.cargoCap,
            };
          })
        : [],
    // Per-structure affordability (credits + cargo minerals) → red build hints.
    buildable: {
      silo: canAffordBase(have, buildingCost("silo")),
      excavator: canAffordBase(have, buildingCost("excavator")),
      production_line: canAffordBase(have, buildingCost("production_line")),
      thermal_plant: canAffordBase(have, buildingCost("thermal_plant")),
      solar_array: canAffordBase(have, buildingCost("solar_array")),
      blast_furnace: canAffordBase(have, buildingCost("blast_furnace")),
      crop_farm: canAffordBase(have, buildingCost("crop_farm")),
      livestock_pen: canAffordBase(have, buildingCost("livestock_pen")),
    },
  });
}

/**
 * `deposit <item> [qty]` — move a resource from your ship cargo into this
 * region's base storage. Requires a base here; disembarked-only (a surface/base
 * action, gated in `dispatchResolved` via the unified applicability model).
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
  // Realize pending excavator output first so the capacity math below sees it.
  await accrueExcavators(player, base.id, base.rKey, regionAt(seed, locOf(player), player.region), planet, base.tier);

  // Items deposit from the resource cargo hold (`inventory`) OR — for ship parts
  // (P12b) — the ship's parts store (`player_parts`). Either way they land in the
  // base silo (`base_storage`); the source is what differs.
  const isPart = isPartId(itemId);
  const itemName = storageItemName(itemId);
  const held = isPart
    ? (await world.getPlayerParts(player.id)).find((p) => p.partId === itemId)?.qty ?? 0
    : (await world.getInventory(player.id)).find((s) => s.resourceId === itemId)?.qty ?? 0;
  if (held <= 0) return errorFrame(`You aren't carrying any ${itemName}.`);

  const [buildings, stored] = await Promise.all([
    world.getBaseBuildings(base.id),
    world.getBaseStorage(base.id),
  ]);
  const silos = buildings.filter((b) => b.kind === "silo").length;
  const capacity = baseCapacity(silos, base.tier);
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

  if (isPart) await world.addPlayerPart(player.id, itemId, -move);
  else await world.removeInventory(player.id, itemId, move);
  const nowStored = await world.addBaseStorage(base.id, itemId, move);

  return frame([
    line([
      text(`Deposited ${move} ${itemName} `, "success"),
      text(`into your base. `, "default"),
      text(`Storage ${used + move}/${capacity}.`, "muted"),
    ]),
    line(text(`  ${itemName} in store: ${nowStored}. ${held - move} left in cargo.`, "muted")),
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
  // Realize pending excavator output first so you can withdraw what just accrued.
  await accrueExcavators(player, base.id, base.rKey, regionAt(seed, locOf(player), player.region), planet, base.tier);

  // P12b: ship parts are a commodity now — withdraw moves them from the silo back
  // into the ship's parts store (`player_parts`), which is uncapped (separate
  // from the resource cargo hold). Raw resources withdraw into `inventory` and
  // are bounded by free cargo space, as before.
  const isPart = isPartId(itemId);
  const itemName = storageItemName(itemId);

  const stored = await world.getBaseStorage(base.id);
  const inStore = stored.find((s) => s.itemId === itemId)?.qty ?? 0;
  if (inStore <= 0) return errorFrame(`Your base here isn't storing any ${itemName}.`);

  if (isPart) {
    const requested = args[1] === undefined ? inStore : toInt(args[1]);
    if (requested === null || requested <= 0) {
      return errorFrame("Usage: withdraw <item> [qty]  — qty must be a positive whole number.");
    }
    const move = Math.min(requested, inStore);
    if (move <= 0) return errorFrame("Nothing to withdraw.");

    await world.addBaseStorage(base.id, itemId, -move);
    const owned = await world.addPlayerPart(player.id, itemId, move);

    return frame([
      line([
        text(`Withdrew ${move} ${itemName} `, "success"),
        text(`to your parts store. `, "default"),
        text(`You now carry ${owned}.`, "muted"),
      ]),
      line(text(`  ${itemName} left in store: ${inStore - move}.`, "muted")),
    ]);
  }

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

// ---------------------------------------------------------------------------
// Automatic, power-gated excavator accrual (P13 — replaces the manual `collect`).
//
// Excavators funnel accrued ore into the base's silos ON THEIR OWN. There is no
// command and no cron: accrual is computed from elapsed time and REALIZED lazily
// whenever a base the player owns is read (scan at the base region / storage /
// deposit / withdraw / produce), exactly like price & supply mean-reversion.
//
// The banking math is identical to the old `collect`: per excavator, per region
// deposit, `excavatorYield(effectiveAbundance, elapsed)` units accrue, clamped to
// the base's remaining storage capacity (banked in deposit order), and the banked
// amount is written back as per-region depletion (`recordDepletion`) so excavation
// drains the SHARED region exactly like manual mining (others see less; regen
// refills). The two differences from `collect`: it is GATED by power (an
// underpowered base accrues nothing and leaves its clocks alone, so it resumes
// when power returns), and a clock advances only once its excavator has earned
// ≥1 whole unit — because accrual now fires on every read, advancing on a
// sub-threshold (floored-to-0) read would reset the clock and starve a
// frequently-read base.
// ---------------------------------------------------------------------------

/**
 * Realize any pending excavator output for a base the player owns. Pure-math via
 * `rules.ts`; persists banked ore + depletion + advanced clocks via `world`. A
 * no-op when the base has no excavators, is underpowered, or has no free storage.
 */
async function accrueExcavators(
  player: Player,
  baseId: string,
  rKey: string,
  region: Region,
  planet: Planet,
  tier: number,
): Promise<void> {
  const buildings = await world.getBaseBuildings(baseId);
  const excavators = buildings.filter((b) => b.kind === "excavator");
  if (excavators.length === 0) return; // nothing draining

  // Power gate: consumers run only when the base's plants supply enough power.
  const power = basePower({
    thermalPlants: buildings.filter((b) => b.kind === "thermal_plant").length,
    solarArrays: buildings.filter((b) => b.kind === "solar_array").length,
    excavators: excavators.length,
    productionLines: buildings.filter((b) => b.kind === "production_line").length,
    blastFurnaces: buildings.filter((b) => b.kind === "blast_furnace").length,
    temperature: region.temperature,
    atmosphere: planet.atmosphere,
    tier,
  });
  if (!power.powered) return; // underpowered: accrue nothing, don't advance clocks

  const [stored, depletionMap] = await Promise.all([
    world.getBaseStorage(baseId),
    world.getEffectiveDepletionMap(rKey),
  ]);
  const silos = buildings.filter((b) => b.kind === "silo").length;
  const capacity = baseCapacity(silos, tier);
  const used = stored.reduce((sum, s) => sum + s.qty, 0);
  let remaining = capacity - used;
  if (remaining <= 0) return; // no room: don't advance (accrued time is preserved)

  // Accrue per excavator off its own elapsed time; track which earned ≥1 unit.
  const now = Date.now();
  const accrued: Record<string, number> = {};
  const toAdvance: world.BaseBuilding[] = [];
  for (const exc of excavators) {
    const lastIso =
      typeof exc.state.lastCollectedAt === "string" ? exc.state.lastCollectedAt : exc.createdAt;
    const lastAt = Date.parse(lastIso);
    const elapsed = Number.isNaN(lastAt) ? 0 : Math.max(0, now - lastAt);
    let produced = 0;
    for (const dep of region.deposits) {
      const eff = effectiveAbundance(dep.abundance, depletionMap[dep.resourceId] ?? 0);
      const y = excavatorYield(eff, elapsed);
      if (y > 0) {
        accrued[dep.resourceId] = (accrued[dep.resourceId] ?? 0) + y;
        produced += y;
      }
    }
    if (produced > 0) toAdvance.push(exc);
  }

  // Bank up to the remaining capacity, in deposit order; deplete only the banked
  // amount (same clamp as the old `collect`).
  const banked: { resourceId: string; qty: number }[] = [];
  for (const dep of region.deposits) {
    if (remaining <= 0) break;
    const want = accrued[dep.resourceId] ?? 0;
    if (want <= 0) continue;
    const take = Math.min(want, remaining);
    remaining -= take;
    banked.push({ resourceId: dep.resourceId, qty: take });
  }
  for (const b of banked) {
    await world.addBaseStorage(baseId, b.resourceId, b.qty);
    await world.recordDepletion(rKey, b.resourceId, b.qty * DEPLETION_PER_UNIT, player.id);
  }
  // Advance only the clocks of excavators that produced (see header note).
  for (const exc of toAdvance) {
    await world.setBuildingState(exc.id, {
      ...exc.state,
      lastCollectedAt: new Date(now).toISOString(),
    });
  }
}

/**
 * Run `accrueExcavators` for the player's base in `region` if they own one there.
 * Cheap no-op (one base lookup) when they don't. The scan/base read paths call
 * this before displaying the region so silos reflect the drained ore.
 */
async function maybeAccrueExcavators(
  player: Player,
  region: Region,
  planet: Planet,
): Promise<void> {
  const rKey = regionKey(region.coord);
  const base = await world.getBaseInRegion(player.id, rKey);
  if (base) await accrueExcavators(player, base.id, rKey, region, planet, base.tier);
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
 * happens BEFORE any mutation, so a failed produce changes nothing.
 * Disembarked-only (a surface/base action, gated in `dispatchResolved`, like
 * `deposit`/`withdraw`). Additionally requires the base to be POWERED (P13) — an
 * underpowered production line manufactures nothing.
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
  if (!targetId) return errorFrame("Usage: produce <ingot|part|upgrade|ship> [qty]  (see `storage`)");
  if (!isIngotId(targetId) && !isPartId(targetId) && !isUpgradeId(targetId) && !isBuildableShip(targetId)) {
    return errorFrame(`Can't produce "${targetId}". Try \`storage\` for the ingot/parts/ship list.`);
  }

  const base = await baseHere(player, seed);
  const planet = planetAt(seed, locOf(player));
  if (!base) {
    return errorFrame(
      `No base in region ${player.region} of ${planet.name}. \`build base\` first.`,
    );
  }
  // Realize pending excavator output first (a base read), then read the silos.
  const region = regionAt(seed, locOf(player), player.region);
  await accrueExcavators(player, base.id, base.rKey, region, planet, base.tier);

  const [buildings, stored] = await Promise.all([
    world.getBaseBuildings(base.id),
    world.getBaseStorage(base.id),
  ]);
  const productionLines = buildings.filter((b) => b.kind === "production_line").length;
  const blastFurnaces = buildings.filter((b) => b.kind === "blast_furnace").length;
  const silos = buildings.filter((b) => b.kind === "silo").length;

  // Required building, per branch — the more specific error comes before the
  // shared power gate. Ingots smelt at a blast furnace; parts/upgrades at a
  // production line.
  if (isIngotId(targetId)) {
    if (blastFurnaces === 0) {
      return errorFrame("No blast furnace here — `build blast_furnace` first.");
    }
  } else if (productionLines === 0) {
    return errorFrame("No production line here — `build production_line` first.");
  }

  // Power gate (P13): a production line / blast furnace only runs when the base's
  // plants supply enough power. Validate BEFORE any consumption — an underpowered
  // base produces nothing and is told how to fix it.
  const power = basePower({
    thermalPlants: buildings.filter((b) => b.kind === "thermal_plant").length,
    solarArrays: buildings.filter((b) => b.kind === "solar_array").length,
    excavators: buildings.filter((b) => b.kind === "excavator").length,
    productionLines,
    blastFurnaces,
    temperature: region.temperature,
    atmosphere: planet.atmosphere,
    tier: base.tier,
  });
  if (!power.powered) {
    return errorFrame(
      `Insufficient power (${Math.round(power.supply)}/${power.demand}) — \`build thermal_plant\` or \`build solar_array\` to power the base.`,
    );
  }

  // Smelting branch (blast furnace): raw metal in the silo → ingot in the silo.
  if (isIngotId(targetId)) {
    return handleProduceIngot(base, stored, args[1], targetId, silos, base.tier);
  }

  // P9a: an upgrade id manufactures the UPGRADE (consuming siloed PARTS, granting
  // ownership) rather than banking a part into storage. Distinct enough — and
  // capacity-free — to split out.
  if (isUpgradeId(targetId)) {
    return handleProduceUpgrade(player, base, stored, args[1], targetId);
  }

  // Keystone 2b: a buildable ship id BUILDS the ship (consuming siloed PARTS +
  // INGOTS, swapping the player to it via `setShip` — no storage banking, no
  // credit cost). Mirrors the upgrade branch but grants a ship instead.
  if (isBuildableShip(targetId)) {
    return handleProduceShip(player, base, stored, args[1], targetId);
  }

  const partId = targetId;
  const part = getPart(partId);
  const recipe = part.recipe;

  const requested = args[1] === undefined ? 1 : toInt(args[1]);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: produce <part> [qty]  — qty must be a positive whole number.");
  }

  // Siloed amounts. The recipe references ingot ids (+ any raw silica); ingots and
  // parts both live in storage, keyed by their item id.
  const siloed: Record<string, number> = {};
  for (const s of stored) siloed[s.itemId] = s.qty;

  // Inputs present? Surfaces every short line ("need 4 Iron Ingot in the silo, have 2").
  if (!canProduce(siloed, recipe, requested)) {
    const short = Object.entries(recipe)
      .filter(([rid, perUnit]) => (siloed[rid] ?? 0) < perUnit * requested)
      .map(([rid, perUnit]) => `${perUnit * requested} ${storageItemName(rid)} in the silo (have ${siloed[rid] ?? 0})`);
    return errorFrame(`Can't produce ${requested} ${part.name} — need ${short.join(", ")}.`);
  }

  // Capacity: consuming inputs frees space, banking parts uses it. Validate the
  // net result fits before mutating (defensive — inputs ≥ outputs in practice).
  const capacity = baseCapacity(silos, base.tier);
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
    .map(([rid, perUnit]) => `${perUnit * requested} ${storageItemName(rid)}`)
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
 * Smelt raw metal into ingots at the current region's blast furnace (the
 * smelting tier). The recipe is raw METAL ore (`ingots.ts`), consumed from THIS
 * base's silo storage; the finished ingot(s) are banked back into the same
 * storage (silo-only intermediates that feed the production lines). Bounded by
 * the remaining `baseCapacity`. Validation (inputs siloed, capacity) happens
 * BEFORE any mutation, so a failed smelt changes nothing; consumption + banking
 * are atomic via `add_base_storage`. The base / blast-furnace / power checks
 * already ran in `handleProduce`.
 */
async function handleProduceIngot(
  base: { id: string; name: string | null; rKey: string; tier: number },
  stored: world.StorageStack[],
  qtyArg: string | undefined,
  ingotId: string,
  silos: number,
  tier: number,
): Promise<RenderFrame> {
  const ingot = getIngot(ingotId);
  const recipe = ingot.recipe;

  const requested = qtyArg === undefined ? 1 : toInt(qtyArg);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: produce <ingot> [qty]  — qty must be a positive whole number.");
  }

  // Siloed amounts (raw metal lives here, deposited or excavated).
  const siloed: Record<string, number> = {};
  for (const s of stored) siloed[s.itemId] = s.qty;

  if (!canProduce(siloed, recipe, requested)) {
    const short = Object.entries(recipe)
      .filter(([rid, perUnit]) => (siloed[rid] ?? 0) < perUnit * requested)
      .map(([rid, perUnit]) => `${perUnit * requested} ${getResource(rid).name} in the silo (have ${siloed[rid] ?? 0})`);
    return errorFrame(`Can't smelt ${requested} ${ingot.name} — need ${short.join(", ")}.`);
  }

  // Capacity: consuming raw frees space, banking ingots uses it. Validate the net
  // fits before mutating (raw inputs ≥ ingot outputs in practice).
  const capacity = baseCapacity(silos, tier);
  const used = stored.reduce((sum, s) => sum + s.qty, 0);
  const inputsConsumed = Object.values(recipe).reduce((sum, q) => sum + q, 0) * requested;
  const usedAfter = used - inputsConsumed + requested;
  if (usedAfter > capacity) {
    return errorFrame(
      `Storage would overflow (${usedAfter}/${capacity}). \`build silo\` for more room.`,
    );
  }

  // Consume the raw metal, then bank the ingot(s) — all via the atomic storage RPC.
  for (const [rid, perUnit] of Object.entries(recipe)) {
    await world.addBaseStorage(base.id, rid, -(perUnit * requested));
  }
  const nowStored = await world.addBaseStorage(base.id, ingotId, requested);

  const consumed = Object.entries(recipe)
    .map(([rid, perUnit]) => `${perUnit * requested} ${getResource(rid).name}`)
    .join(" + ");
  return frame([
    line([
      text(`Smelted ${requested} ${ingot.name}. `, "success"),
      text(`Consumed ${consumed}. `, "muted"),
      text(`Storage ${usedAfter}/${capacity}.`, "muted"),
    ]),
    line(text(`  ${ingot.name} in store: ${nowStored} (worth ${ingot.value} cr each — feeds your production lines).`, "accent")),
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

/**
 * Build a SHIP at the current region's production line (Keystone 2b — the
 * materials-not-cash alternative to `buyship`). The recipe is ship PARTS +
 * INGOTS (`ships.ts`), consumed from THIS base's silo storage
 * (`add_base_storage(-)`); on success the player is SWAPPED to the new ship via
 * `setShip` (sets `ship_id` + `cargo_cap`, the same single-write swap `buyship`
 * uses) — the ship doesn't sit in storage, so there's no capacity check. There is
 * NO credit cost (you paid in materials). You build exactly ONE ship (qty>1 is
 * rejected). Validation (qty, not-already-your-ship, cargo fits the new hold,
 * inputs siloed) happens BEFORE any mutation, so a failed build changes nothing;
 * consumption + swap are atomic via the race-safe RPCs. The base/production-line/
 * power checks already ran in `handleProduce`.
 */
async function handleProduceShip(
  player: Player,
  base: { id: string; name: string | null; rKey: string },
  stored: world.StorageStack[],
  qtyArg: string | undefined,
  shipId: string,
): Promise<RenderFrame> {
  const ship = getShip(shipId);
  const recipe = shipRecipeOf(shipId)!; // buildable ⇒ non-null

  // You build ONE ship (a ship is a single hull, like `buyship`). A bare
  // `produce <ship>` is fine; an explicit qty must be exactly 1.
  if (qtyArg !== undefined) {
    const requested = toInt(qtyArg);
    if (requested === null || requested <= 0) {
      return errorFrame("Usage: produce <ship>  — you build one ship (no quantity).");
    }
    if (requested > 1) {
      return errorFrame(`You build one ship at a time — \`produce ${shipId}\` (no quantity).`);
    }
  }

  // Read fresh ship + cargo so a concurrent swap/load can't slip past the gates.
  const fresh = (await world.getPlayerById(player.id)) ?? player;
  if (fresh.shipId === shipId) {
    return errorFrame(`You already fly the ${ship.name}.`);
  }
  const cargoUsed = await world.getCargoUsed(player.id);
  if (cargoUsed > ship.cargoCap) {
    return errorFrame(
      `The ${ship.name} holds only ${ship.cargoCap} cargo, but you're carrying ${cargoUsed}. `
      + "Unload (sell/deposit) first.",
    );
  }

  // Siloed amounts. The recipe references PART + INGOT ids (both live in storage).
  const siloed: Record<string, number> = {};
  for (const s of stored) siloed[s.itemId] = s.qty;

  if (!canProduce(siloed, recipe, 1)) {
    const short = Object.entries(recipe)
      .filter(([itemId, qty]) => (siloed[itemId] ?? 0) < qty)
      .map(([itemId, qty]) => `${qty} ${storageItemName(itemId)} in the silo (have ${siloed[itemId] ?? 0})`);
    return errorFrame(`Can't build the ${ship.name} — need ${short.join(", ")}.`);
  }

  // Consume the recipe inputs from the silo, then swap the player to the new ship
  // (ship_id + cargo_cap in one write) — all via the atomic RPCs. No credit cost.
  for (const [itemId, qty] of Object.entries(recipe)) {
    await world.addBaseStorage(base.id, itemId, -qty);
  }
  await world.setShip(player.id, ship.id, ship.cargoCap);

  const current = getShip(fresh.shipId);
  const consumed = Object.entries(recipe)
    .map(([itemId, qty]) => `${qty} ${storageItemName(itemId)}`)
    .join(" + ");
  return frame([
    line([
      text(`Built the ${ship.name}. `, "success"),
      text(`Consumed ${consumed}. `, "muted"),
      text(`No credits spent — you built it.`, "accent"),
    ]),
    line(text(`  Retired the ${current.name}; cargo capacity now ${ship.cargoCap}.`, "muted")),
  ]);
}

// ---------------------------------------------------------------------------
// sell
// ---------------------------------------------------------------------------

async function handleSell(player: Player, seed: string, args: string[]): Promise<RenderFrame> {
  const target = args[0]?.toLowerCase();
  if (!target) return errorFrame("Usage: sell <resource>  or  sell all");

  // Rank trade perk (1c): high standing with this hub's faction boosts payouts.
  const disc = await hubTradeDiscount(player, seed);

  // Selling an upgrade, a part, or a material is code-priced (no market drift);
  // resource selling below is unchanged.
  if (isUpgradeId(target)) return handleSellUpgrade(player, target, args[1], disc);
  if (isPartId(target)) return handleSellPart(player, target, args[1], disc);
  if (isMaterialId(target)) return handleSellMaterial(player, target, args[1], disc);

  const stacks = await world.getInventory(player.id);
  if (stacks.length === 0) return errorFrame("Nothing to sell — your hold is empty.");

  let toSell = stacks;
  if (target !== "all") {
    toSell = stacks.filter((s) => s.resourceId === target);
    if (toSell.length === 0) {
      return errorFrame(`You aren't carrying any ${target}.`);
    }
  }

  // Per-system market: read + write only the current system's price rows.
  const sysKey = systemKey(systemOf(player));
  const prices = await world.getMarketPrices(sysKey);
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
    // Rank perk (1c): boost the payout by the hub discount (round, integer-safe).
    const gain = Math.round(sellValue(price, stack.qty) * (1 + disc.discount));
    totalGain += gain;
    const newPrice = priceAfterSale(price, stack.qty);
    await world.setMarketPrice(sysKey, stack.resourceId, newPrice);
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
  const footer = discountLine(disc);
  return frame([
    line([
      text(`Sold for ${totalGain} cr. `, "success"),
      text(`Balance: ${newBalance} cr.`, "accent"),
    ]),
    ...soldLines,
    ...(footer ? [footer] : []),
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
  disc: HubDiscount,
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

  const unit = bonusedSellUnit(upgradeValue(upgradeId), disc.discount);
  const total = unit * qty;
  const remaining = await world.addPlayerUpgrade(player.id, upgradeId, -qty);
  const newBalance = await world.addPlayerCredits(player.id, total);
  // Selling puts the upgrade(s) on THIS system's market for others to `buy` —
  // a way the finite per-system supply grows (P12b). Read the reverted supply,
  // then persist it + the increment (apply-on-read, persist-on-write).
  const sysKey = systemKey(systemOf(player));
  const current = await world.getSystemSupply(sysKey, upgradeId);
  const supply = await world.setSystemSupply(sysKey, upgradeId, current + qty);

  const footer = discountLine(disc);
  return frame([
    line([
      text(`Sold ${qty} ${upgrade.name} `, "success"),
      text(`for ${total} cr `, "accent"),
      text(`(${unit}/u). `, "muted"),
      text(`${remaining} left. Balance ${newBalance} cr.`, "accent"),
    ]),
    line(text(`  ${supply} now on the market for other pilots to buy.`, "muted")),
    ...(footer ? [footer] : []),
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
  disc: HubDiscount,
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

  const unit = bonusedSellUnit(materialValue(materialId), disc.discount);
  const total = unit * qty;
  const remaining = await world.addPlayerMaterial(player.id, materialId, -qty);
  const newBalance = await world.addPlayerCredits(player.id, total);

  const footer = discountLine(disc);
  return frame([
    line([
      text(`Sold ${qty} ${material.name} `, "success"),
      text(`for ${total} cr `, "accent"),
      text(`(${unit}/u). `, "muted"),
      text(`${remaining} left. Balance ${newBalance} cr.`, "accent"),
    ]),
    ...(footer ? [footer] : []),
  ]);
}

/**
 * Sell `qty` ship parts from the ship's parts store (`player_parts`) for
 * `partValue` per unit — code-priced, no market drift (like upgrades/materials).
 * Selling RAISES this system's part supply so other pilots can `buy` it (P12b),
 * read+persisted with reversion (apply-on-read, persist-on-write). No `qty` sells
 * the whole stack; a positive `qty` sells that many. Validates ownership before
 * mutating. Economy-gated (only usable at a trade location, via the `sell`
 * dispatch gate).
 */
async function handleSellPart(
  player: Player,
  partId: string,
  qtyArg: string | undefined,
  disc: HubDiscount,
): Promise<RenderFrame> {
  const part = getPart(partId);

  const stacks = await world.getPlayerParts(player.id);
  const ownedNow = stacks.find((s) => s.partId === partId)?.qty ?? 0;
  if (ownedNow <= 0) {
    return errorFrame(`You aren't carrying any ${part.name}.`);
  }

  let qty: number;
  if (qtyArg === undefined) {
    qty = ownedNow; // sell the whole stack by default
  } else {
    const requested = toInt(qtyArg);
    if (requested === null || requested <= 0) {
      return errorFrame("Usage: sell <part> [qty]  — qty must be a positive whole number.");
    }
    qty = requested;
  }
  if (ownedNow < qty) {
    return errorFrame(`You only own ${ownedNow} ${part.name} — can't sell ${qty}.`);
  }

  const unit = bonusedSellUnit(partValue(partId), disc.discount);
  const total = unit * qty;
  const remaining = await world.addPlayerPart(player.id, partId, -qty);
  const newBalance = await world.addPlayerCredits(player.id, total);
  // Grow this system's buyable part supply by what we sold (persist reverted + qty).
  const sysKey = systemKey(systemOf(player));
  const current = await world.getSystemSupply(sysKey, partId);
  const supply = await world.setSystemSupply(sysKey, partId, current + qty);

  const footer = discountLine(disc);
  return frame([
    line([
      text(`Sold ${qty} ${part.name} `, "success"),
      text(`for ${total} cr `, "accent"),
      text(`(${unit}/u). `, "muted"),
      text(`${remaining} left. Balance ${newBalance} cr.`, "accent"),
    ]),
    line(text(`  ${supply} now on this system's market for other pilots to buy.`, "muted")),
    ...(footer ? [footer] : []),
  ]);
}

// ---------------------------------------------------------------------------
// buy fuel [n]  |  buy <resource> [qty]  |  buy <upgrade> [qty]
// ---------------------------------------------------------------------------

async function handleBuy(player: Player, seed: string, args: string[]): Promise<RenderFrame> {
  const what = args[0]?.toLowerCase();
  if (!what) return errorFrame("Usage: buy fuel [n]  |  buy warpfuel [n]  |  buy <resource> [qty]");
  // Fuel is code-fixed (not a faction-hub commodity), so no rank discount there.
  if (what === "fuel") return handleBuyFuel(player, "regular", args[1]);
  if (what === "warpfuel") return handleBuyFuel(player, "warp", args[1]);
  // Rank trade perk (1c): high standing with this hub's faction lowers prices.
  const disc = await hubTradeDiscount(player, seed);
  if (isUpgradeId(what)) return handleBuyUpgrade(player, what, args[1], disc);
  if (isPartId(what)) return handleBuyPart(player, what, args[1], disc);
  return handleBuyResource(player, what, args[1], disc);
}

/**
 * `buy fuel [n]` / `buy warpfuel [n]` — refill a fuel pool at its per-unit
 * price. Regular fuel (`REGULAR_FUEL_PRICE_PER_UNIT`) feeds `land`; warp fuel
 * (`WARP_FUEL_PRICE_PER_UNIT`, pricier) feeds `warp`. With no `n`, buys as much
 * as credits allow. Validates credits before charging; both are embarked-only
 * (gated in `dispatchResolved`).
 */
async function handleBuyFuel(
  player: Player,
  kind: "regular" | "warp",
  nArg: string | undefined,
): Promise<RenderFrame> {
  const isWarp = kind === "warp";
  const label = isWarp ? "warp fuel" : "fuel";
  const command = isWarp ? "buy warpfuel" : "buy fuel";
  const price = isWarp ? WARP_FUEL_PRICE_PER_UNIT : REGULAR_FUEL_PRICE_PER_UNIT;

  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const maxAffordable = Math.floor(fresh.credits / price);
  const requested = toInt(nArg);
  if (nArg !== undefined && (requested === null || requested <= 0)) {
    return errorFrame(`Usage: ${command} [n]  — n must be a positive whole number.`);
  }
  const want = requested ?? maxAffordable;
  const buy = Math.min(want, maxAffordable);

  if (buy <= 0) {
    return errorFrame(
      `Not enough credits: ${label} is ${price} cr/unit and you have ${fresh.credits}.`,
    );
  }

  const cost = buy * price;
  const current = isWarp ? fresh.warpFuel : fresh.fuel;
  const newFuel = current + buy;
  await world.addPlayerCredits(player.id, -cost);
  if (isWarp) await world.setWarpFuel(player.id, newFuel);
  else await world.setFuel(player.id, newFuel);

  return frame([
    line([
      text(`Bought ${buy} ${label} for ${cost} cr. `, "success"),
      text(`${isWarp ? "Warp fuel" : "Fuel"} ${newFuel}, credits ${fresh.credits - cost}.`, "muted"),
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
  disc: HubDiscount,
): Promise<RenderFrame> {
  // Parse quantity (default 1; must be a positive whole number when supplied).
  const requested = qtyArg === undefined ? 1 : toInt(qtyArg);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: buy <resource> [qty]  — qty must be a positive whole number.");
  }
  const qty = requested;

  // Per-system market: this system's price (defaults to base_value if untraded).
  const sysKey = systemKey(systemOf(player));
  const price = await world.getMarketPrice(sysKey, resourceId);
  if (price == null) {
    return errorFrame(`No market for ${resourceId} right now.`);
  }

  const res = getResource(resourceId);
  const unitCost = discountedBuyUnit(buyUnitCost(price), disc.discount);
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
  await world.setMarketPrice(sysKey, resourceId, newPrice);

  return frame([
    line([
      text(`Bought ${qty} `, "success"),
      text(`${res.name} `, "default"),
      text(`for ${total} cr `, "accent"),
      text(`(${unitCost}/u). `, "muted"),
      text(`Balance ${newBalance} cr.`, "accent"),
    ]),
    line(text(`  price ${price}→${newPrice}`, "muted")),
    ...(discountLine(disc) ? [discountLine(disc)!] : []),
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
  disc: HubDiscount,
): Promise<RenderFrame> {
  const requested = qtyArg === undefined ? 1 : toInt(qtyArg);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: buy <upgrade> [qty]  — qty must be a positive whole number.");
  }
  const qty = requested;
  const upgrade = getUpgrade(upgradeId);

  // Finite, per-system supply gate (P9a/P12b): you can only buy what's currently
  // on THIS system's market. Read the reverted supply (rowless = baseline) and
  // validate BEFORE charging — manufacturing (`produce`) + selling are the only
  // ways stock appears beyond the self-reverting baseline.
  const sysKey = systemKey(systemOf(player));
  const supply = await world.getSystemSupply(sysKey, upgradeId);
  if (!canBuyFromSupply(supply)) {
    return errorFrame(
      `${upgrade.name} is out of stock here — none on this system's market; someone must manufacture and sell one.`,
    );
  }
  if (supply < qty) {
    return errorFrame(
      `Only ${supply} ${upgrade.name} on this system's market — can't buy ${qty}. Try a smaller quantity.`,
    );
  }

  const unitCost = discountedBuyUnit(buyUnitCost(upgradeValue(upgradeId)), disc.discount);
  const total = unitCost * qty;

  const fresh = (await world.getPlayerById(player.id)) ?? player;
  if (fresh.credits < total) {
    return errorFrame(
      `Not enough credits: ${qty} ${upgrade.name} costs ${total} cr (${unitCost}/u) and you have ${fresh.credits}.`,
    );
  }

  // Take the unit(s) off this system's market (persist reverted supply − qty),
  // then grant + charge. We validated supply >= qty above.
  const newSupply = await world.setSystemSupply(sysKey, upgradeId, supply - qty);
  const owned = await world.addPlayerUpgrade(player.id, upgradeId, qty);
  const newBalance = await world.addPlayerCredits(player.id, -total);

  const footer = discountLine(disc);
  return frame([
    line([
      text(`Bought ${qty} ${upgrade.name} `, "success"),
      text(`for ${total} cr `, "accent"),
      text(`(${unitCost}/u). `, "muted"),
      text(`You now own ${owned}. Balance ${newBalance} cr.`, "accent"),
    ]),
    line(text(`  ${newSupply} left on this system's market.`, "muted")),
    ...(footer ? [footer] : []),
  ]);
}

/**
 * Buy `qty` ship parts from THIS system's finite, self-reverting supply (P12b) at
 * `buyUnitCost(partValue)` per unit. Validates the system's part supply (≥ qty)
 * and credits BEFORE mutating; bought parts land in the ship's parts store
 * (`player_parts`), not the resource cargo hold, so there's no cargo-space check
 * (like upgrades/materials). Economy-gated to a trade location by the `buy`
 * dispatch gate. `partId` is already abbrev-resolved by the dispatcher.
 */
async function handleBuyPart(
  player: Player,
  partId: string,
  qtyArg: string | undefined,
  disc: HubDiscount,
): Promise<RenderFrame> {
  const requested = qtyArg === undefined ? 1 : toInt(qtyArg);
  if (requested === null || requested <= 0) {
    return errorFrame("Usage: buy <part> [qty]  — qty must be a positive whole number.");
  }
  const qty = requested;
  const part = getPart(partId);

  // Per-system supply gate (rowless = baseline). Validate BEFORE charging.
  const sysKey = systemKey(systemOf(player));
  const supply = await world.getSystemSupply(sysKey, partId);
  if (!canBuyFromSupply(supply)) {
    return errorFrame(
      `${part.name} is out of stock here — none on this system's market; someone must manufacture and sell one.`,
    );
  }
  if (supply < qty) {
    return errorFrame(
      `Only ${supply} ${part.name} on this system's market — can't buy ${qty}. Try a smaller quantity.`,
    );
  }

  const unitCost = discountedBuyUnit(buyUnitCost(partValue(partId)), disc.discount);
  const total = unitCost * qty;

  const fresh = (await world.getPlayerById(player.id)) ?? player;
  if (fresh.credits < total) {
    return errorFrame(
      `Not enough credits: ${qty} ${part.name} costs ${total} cr (${unitCost}/u) and you have ${fresh.credits}.`,
    );
  }

  // Take the unit(s) off this system's market (persist reverted supply − qty),
  // then grant into the parts store + charge. We validated supply >= qty above.
  const newSupply = await world.setSystemSupply(sysKey, partId, supply - qty);
  const owned = await world.addPlayerPart(player.id, partId, qty);
  const newBalance = await world.addPlayerCredits(player.id, -total);

  return frame([
    line([
      text(`Bought ${qty} ${part.name} `, "success"),
      text(`for ${total} cr `, "accent"),
      text(`(${unitCost}/u). `, "muted"),
      text(`You now carry ${owned}. Balance ${newBalance} cr.`, "accent"),
    ]),
    line([
      text(`  ${newSupply} left on this system's market. `, "muted"),
      text("`deposit ", "muted"),
      text(`${partId}`, "default"),
      text("` at a base to use it in production.", "muted"),
    ]),
    ...(discountLine(disc) ? [discountLine(disc)!] : []),
  ]);
}

// ---------------------------------------------------------------------------
// shipyard  |  buyship <id>   (Keystone 2a — the credit sink + cargo ladder)
// ---------------------------------------------------------------------------

/**
 * `shipyard` — browse the ship catalog (INFORMATIONAL, usable anywhere). Shows
 * the player's current ship, each other ship's net cost after trade-in, marks
 * unbuyable ships RED (off-hub / unaffordable / a downgrade that wouldn't fit
 * current cargo), and notes the must-be-at-a-hub rule when off a trade location.
 */
async function handleShipyard(player: Player, seed: string): Promise<RenderFrame> {
  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const cargoUsed = await world.getCargoUsed(player.id);
  const atHub = atTradeLocation(player, seed);
  const tradeIn = shipTradeIn(fresh.shipId);

  return renderShipyard({
    currentShipId: fresh.shipId,
    tradeIn,
    cargoUsed,
    credits: fresh.credits,
    atTradeLocation: atHub,
    ships: SHIPS.map((s) => {
      const isCurrent = s.id === fresh.shipId;
      const netCost = s.price - tradeIn;
      const cargoOverflow = cargoUsed > s.cargoCap;
      // Red when the purchase would be rejected by `handleBuyship`: off-hub, too
      // expensive, or a downgrade your current cargo wouldn't fit. The current
      // ship carries no buy action so its `disabled` is irrelevant.
      const disabled = !isCurrent && (!atHub || fresh.credits < netCost || cargoOverflow);
      return {
        id: s.id,
        name: s.name,
        cargoCap: s.cargoCap,
        price: s.price,
        blurb: s.blurb,
        isCurrent,
        netCost,
        cargoOverflow,
        disabled,
      };
    }),
  });
}

/**
 * `buyship <id>` — purchase & swap to another ship (ECONOMY: at a settlement /
 * outpost, out of combat — gated in `dispatchResolved`). Server-authoritative,
 * validate-before-mutate: the id must be a real, DIFFERENT ship; the net cost
 * (`price − trade-in of your current ship`) must be affordable; and your current
 * cargo must fit the new hold (a downgrade that would overflow is refused —
 * unload first). Then atomically charge the net cost and set BOTH `ship_id` and
 * `cargo_cap` (= the new ship's cargoCap) in one write, so every cargo-space
 * check keeps reading the right capacity. `id` is already abbrev-resolved.
 */
async function handleBuyship(player: Player, args: string[]): Promise<RenderFrame> {
  const id = args[0]?.toLowerCase();
  if (!id || !isShipId(id)) {
    return errorFrame("Usage: buyship <id>  — see `shipyard` for available ships.");
  }
  if (id === player.shipId) {
    return errorFrame(`You already fly the ${getShip(id).name}.`);
  }
  const target = getShip(id);

  const fresh = (await world.getPlayerById(player.id)) ?? player;
  const current = getShip(fresh.shipId);
  const tradeIn = shipTradeIn(fresh.shipId);
  const netCost = target.price - tradeIn;

  // A downgrade that wouldn't fit your current load is refused (no silent cargo
  // loss) — check BEFORE charging.
  const cargoUsed = await world.getCargoUsed(player.id);
  if (cargoUsed > target.cargoCap) {
    return errorFrame(
      `The ${target.name} holds only ${target.cargoCap} cargo, but you're carrying ${cargoUsed}. Unload (sell/`
      + `deposit) first.`,
    );
  }

  if (fresh.credits < netCost) {
    return errorFrame(
      `Not enough credits: the ${target.name} costs ${netCost} cr net of your ${current.name} trade-in `
      + `(${tradeIn} cr) and you have ${fresh.credits}.`,
    );
  }

  // Atomic: charge the net cost, then swap ship + cargo capacity together.
  const newBalance = await world.addPlayerCredits(player.id, -netCost);
  await world.setShip(player.id, target.id, target.cargoCap);

  return frame([
    line([
      text(`Traded the ${current.name} for the ${target.name}. `, "success"),
      text(`Net ${netCost} cr `, "accent"),
      text(`(trade-in ${tradeIn} cr). `, "muted"),
      text(`Balance ${newBalance} cr.`, "accent"),
    ]),
    line(text(`  Cargo capacity now ${target.cargoCap}.`, "muted")),
  ]);
}

// ---------------------------------------------------------------------------
// Factions — standing / contracts / fulfill (Keystone 1a). NPC factions are
// anchored at trade hubs (settlement regions + orbital outposts); they post
// procedurally-generated, rotating goods contracts that pay a credit PREMIUM
// over the market plus faction reputation. `standing`/`contracts` are
// informational; `fulfill` is economy-gated (at the hub, out of combat).
// ---------------------------------------------------------------------------

/**
 * The location key of the trade hub the player is at — the 6-segment region key
 * including the current region. For a settlement that's `region ≥ 0`; for the
 * orbital outpost it's the `-1` sentinel, so each hub (settlement OR outpost)
 * has a distinct, stable key. `factionAt`/`contractsAt` key off this.
 */
function hubKeyOf(player: Player): string {
  return regionKey({ ...locOf(player), region: player.region });
}

/**
 * The sapient species that INHABITS the trade hub at `hubKey` (sapient-species):
 * the dominant/founding species of the hub's aligned faction (`factionAt` →
 * faction → `species`), so a faction hub is peopled by its empire's species.
 * Deterministic — same hub ⇒ same inhabitants. (Every hub is faction-aligned
 * today; if a key ever resolved no faction, the minor-species generator
 * `minorSpeciesAt(seed, hubKey)` is the fallback the spec calls for.)
 */
function inhabitingSpecies(seed: string, hubKey: string): SapientSpecies {
  const factionId = factionAt(seed, hubKey);
  const faction = FACTIONS.find((f) => f.id === factionId);
  return faction ? getSpecies(faction.species) : minorSpeciesAt(seed, hubKey);
}

/** The current contract rotation bucket (the only place `Date.now()` enters). */
function currentContractBucket(): number {
  return Math.floor(Date.now() / CONTRACT_ROTATION_MS);
}

/** The rank trade perk active at the player's current hub (Keystone 1c). */
interface HubDiscount {
  /** Fraction off (`repPriceDiscount`), 0 when off-hub / no standing. */
  discount: number;
  /** The hub faction's name (empty off-hub). */
  factionName: string;
  /** The player's rank title with the hub faction (empty off-hub). */
  rankTitle: string;
}

/**
 * The rank-based trade discount the player gets at their CURRENT hub: the
 * faction controlling this hub (`factionAt`), the player's rank with them
 * (`rankFor`), and the resulting `repPriceDiscount`. Off a trade hub it's 0 (a
 * defensive default — `buy`/`sell` are economy-gated to a hub anyway). One rep
 * read + pure math; applied to resource/material/part/upgrade trades, never to
 * code-fixed fuel or the distress fee.
 */
async function hubTradeDiscount(player: Player, seed: string): Promise<HubDiscount> {
  if (!atTradeLocation(player, seed)) {
    return { discount: 0, factionName: "", rankTitle: "" };
  }
  const factionId = factionAt(seed, hubKeyOf(player));
  const faction = getFaction(factionId);
  const rep = await world.getReputation(player.id).then(
    (reps) => reps.find((r) => r.factionId === factionId)?.rep ?? 0,
  );
  const rank = rankFor(rep);
  return { discount: repPriceDiscount(rank.tier), factionName: faction.name, rankTitle: rank.title };
}

/** Discounted buy unit cost: `floor(base × (1 − discount))`, never below 1 cr. */
function discountedBuyUnit(unitCost: number, discount: number): number {
  return Math.max(1, Math.floor(unitCost * (1 - discount)));
}

/** Bonus-adjusted sell unit payout: `round(base × (1 + discount))`. */
function bonusedSellUnit(unit: number, discount: number): number {
  return Math.round(unit * (1 + discount));
}

/**
 * A muted footer line surfacing the active hub discount (Keystone 1c) — e.g.
 * "−9% (Partner standing with the Iron Vanguard)". Returns `null` (no line) when
 * there's no discount, so callers can spread it conditionally.
 */
function discountLine(disc: HubDiscount): RenderLine | null {
  if (disc.discount <= 0) return null;
  const pct = Math.round(disc.discount * 100);
  return line(
    text(
      `  −${pct}% (${disc.rankTitle} standing with the ${disc.factionName})`,
      "success",
    ),
  );
}

/** Display name for a demandable good (resource / part / material). */
function goodName(itemId: string): string {
  if (RESOURCES.some((r) => r.id === itemId)) return getResource(itemId).name;
  if (isPartId(itemId)) return getPart(itemId).name;
  if (isMaterialId(itemId)) return getMaterial(itemId).name;
  return itemId;
}

/** How many of `itemId` the player holds in the appropriate store (0 if none). */
async function heldQuantity(player: Player, itemId: string): Promise<number> {
  if (RESOURCES.some((r) => r.id === itemId)) {
    const stacks = await world.getInventory(player.id);
    return stacks.find((s) => s.resourceId === itemId)?.qty ?? 0;
  }
  if (isPartId(itemId)) {
    const parts = await world.getPlayerParts(player.id);
    return parts.find((p) => p.partId === itemId)?.qty ?? 0;
  }
  if (isMaterialId(itemId)) {
    const mats = await world.getPlayerMaterials(player.id);
    return mats.find((m) => m.materialId === itemId)?.qty ?? 0;
  }
  return 0;
}

/** Consume `qty` of `itemId` from the player's appropriate store (atomic RPC). */
async function consumeGood(player: Player, itemId: string, qty: number): Promise<void> {
  if (RESOURCES.some((r) => r.id === itemId)) {
    await world.removeInventory(player.id, itemId, qty);
    return;
  }
  if (isPartId(itemId)) {
    await world.addPlayerPart(player.id, itemId, -qty);
    return;
  }
  if (isMaterialId(itemId)) {
    await world.addPlayerMaterial(player.id, itemId, -qty);
    return;
  }
}

/**
 * The reputation needed to reach the NEXT rank above `rep` — `null` once the
 * player is at the top of the ladder (`MAX_RANK_TIER`). Pure helper off `RANKS`.
 */
function nextRankRep(rep: number): number | null {
  const tier = rankFor(rep).tier;
  if (tier >= MAX_RANK_TIER) return null;
  return RANKS[tier + 1]!.minRep;
}

/**
 * `standing` — the player's reputation, rank title, and next-tier threshold with
 * each faction. Rank is a pure function of stored rep (`rankFor`); no stored rank.
 */
async function handleStanding(player: Player): Promise<RenderFrame> {
  const reps = await world.getReputation(player.id);
  const byId = new Map(reps.map((r) => [r.factionId, r.rep]));
  return renderStanding({
    factions: FACTIONS.map((f) => {
      const rep = byId.get(f.id) ?? 0;
      const rivalId = rivalOf(f.id);
      return {
        name: f.name,
        blurb: f.blurb,
        rep,
        rankTitle: rankFor(rep).title,
        nextRep: nextRankRep(rep),
        rivalName: getFaction(rivalId).name,
        rivalRep: byId.get(rivalId) ?? 0,
      };
    }),
  });
}

/**
 * `contracts` — the hub faction's current goods contracts. Informational: at a
 * trade hub it lists the faction + each contract's wanted item/qty, reward, and
 * state (fulfillable / completed / short — short reads red); off-hub it returns
 * a clear "find a settlement or outpost" note.
 */
async function handleContracts(player: Player, seed: string): Promise<RenderFrame> {
  if (!atTradeLocation(player, seed)) {
    return renderContracts({ atHub: false });
  }
  const hubKey = hubKeyOf(player);
  const factionId = factionAt(seed, hubKey);
  const faction = getFaction(factionId);
  const rep = await world.getReputation(player.id).then(
    (reps) => reps.find((r) => r.factionId === factionId)?.rep ?? 0,
  );
  const rank = rankFor(rep);
  const contracts = contractsAt(seed, hubKey, factionId, currentContractBucket(), rank.tier);
  const [inv, mats, parts, completed] = await Promise.all([
    world.getInventory(player.id),
    world.getPlayerMaterials(player.id),
    world.getPlayerParts(player.id),
    world.getCompletedContractKeys(player.id, contracts.map((c) => c.key)),
  ]);
  // One lookup over all three stores (resource/material/part ids never collide).
  const held = new Map<string, number>();
  for (const s of inv) held.set(s.resourceId, s.qty);
  for (const m of mats) held.set(m.materialId, m.qty);
  for (const p of parts) held.set(p.partId, p.qty);

  const entries: ContractEntry[] = contracts.map((c, i) => {
    const have = held.get(c.want.itemId) ?? 0;
    const state: ContractEntry["state"] = completed.has(c.key)
      ? "completed"
      : have >= c.want.qty
        ? "fulfillable"
        : "short";
    return {
      index: i + 1,
      itemName: goodName(c.want.itemId),
      qty: c.want.qty,
      haveQty: have,
      rewardCredits: c.rewardCredits,
      rewardRep: c.rewardRep,
      state,
    };
  });
  return renderContracts({
    atHub: true,
    factionName: faction.name,
    factionBlurb: faction.blurb,
    rep,
    rankTitle: rank.title,
    nextRep: nextRankRep(rep),
    discount: repPriceDiscount(rank.tier),
    contracts: entries,
  });
}

/**
 * `fulfill <n>` — deliver the goods for the n-th contract at this hub. Economy-
 * gated (at the hub, out of combat — enforced by the dispatch applicability
 * gate). Validates server-authoritatively BEFORE mutating: a real current-bucket
 * contract, not already completed, and the player HOLDS `want.qty` in the right
 * store. Then atomically consumes the goods + awards credits + reputation + marks
 * the contract complete (the `completed_contracts` PK makes a double-fulfill of
 * the same key a no-op).
 */
async function handleFulfill(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const n = toInt(args[0]);
  if (n === null || n < 1) {
    return errorFrame("Usage: fulfill <n>  — n is a contract # from `contracts`.");
  }
  const hubKey = hubKeyOf(player);
  const factionId = factionAt(seed, hubKey);
  const faction = getFaction(factionId);
  const rep = await world.getReputation(player.id).then(
    (reps) => reps.find((r) => r.factionId === factionId)?.rep ?? 0,
  );
  const contracts = contractsAt(seed, hubKey, factionId, currentContractBucket(), rankFor(rep).tier);
  const contract = contracts[n - 1];
  if (!contract) {
    return errorFrame(`No contract #${n} here — see \`contracts\`.`);
  }

  // Already fulfilled? (idempotent against double-fulfill within a bucket.)
  const done = await world.getCompletedContractKeys(player.id, [contract.key]);
  if (done.has(contract.key)) {
    return errorFrame("That contract is already fulfilled — check back after it rotates.");
  }

  const { itemId, qty } = contract.want;
  const name = goodName(itemId);
  const have = await heldQuantity(player, itemId);
  if (have < qty) {
    return errorFrame(`You need ${qty} ${name} (have ${have}).`);
  }

  // Validated — consume the goods, then reward + mark complete.
  await consumeGood(player, itemId, qty);
  const newBalance = await world.addPlayerCredits(player.id, contract.rewardCredits);
  const newRep = await world.addReputation(player.id, factionId, contract.rewardRep);
  // Faction politics (1c): pleasing this faction angers its rival. Award first,
  // then penalize the rival by `rivalRepPenalty(rewardRep)` (the RPC clamps ≥ 0).
  const rivalId = rivalOf(factionId);
  const rivalFaction = getFaction(rivalId);
  const penalty = rivalRepPenalty(contract.rewardRep);
  const newRivalRep =
    penalty > 0 ? await world.addReputation(player.id, rivalId, -penalty) : undefined;
  await world.markContractComplete(player.id, contract.key);

  const lines: RenderFrame["lines"] = [
    line([
      text(`Delivered ${qty} ${name} to the ${faction.name}.`, "success"),
    ]),
    line([
      text(`+${contract.rewardCredits} cr `, "accent"),
      text(`(balance ${newBalance} cr)   `, "muted"),
      text(`+${contract.rewardRep} rep `, "success"),
      text(`(${faction.name}: ${newRep})`, "muted"),
    ]),
  ];
  if (newRivalRep !== undefined) {
    lines.push(
      line([
        text(`-${penalty} rep `, "danger"),
        text(`with their rivals the ${rivalFaction.name} (${newRivalRep}).`, "muted"),
      ]),
    );
  }
  return frame(lines);
}

// ---------------------------------------------------------------------------
// who
// ---------------------------------------------------------------------------

async function handleWho(): Promise<RenderFrame> {
  const [topCredits, topExplorers] = await Promise.all([
    world.topByCredits(5),
    world.topByCharted(5),
  ]);
  return renderWho({
    topCredits: topCredits.map((r) => ({ handle: r.handle, credits: r.credits })),
    // Top explorers ranked by worlds CHARTED, each with their cartography title
    // (Keystone 3b) — derived purely from the public `charted` count.
    topExplorers: topExplorers.map((r) => ({
      handle: r.handle,
      charted: r.charted,
      rankTitle: cartographyRank(r.charted).title,
    })),
  });
}

// ---------------------------------------------------------------------------
// here  (who else is co-located with you — shared-world presence, foundation 3a)
// ---------------------------------------------------------------------------

/**
 * `here` — a dedicated readout of the OTHER players sharing your exact location
 * (same surface region, same-planet orbit, or same outpost). Informational and
 * usable in every state. Public-safe: shows each present player's handle + ship
 * + orbit/surface state (never identity). Polled — reflects DB state at command
 * time (no live push yet; 3b adds Supabase Realtime). Alone ⇒ an "alone" notice.
 */
async function handleHere(player: Player, seed: string): Promise<RenderFrame> {
  const present = await world.playersHere({
    id: player.id,
    ...locOf(player),
    region: player.region,
  });
  return renderPresence({ location: locationLabel(player, seed), present });
}

// ---------------------------------------------------------------------------
// cartography  (your exploration progression: worlds charted + rank — Keystone 3b)
// ---------------------------------------------------------------------------

/**
 * `cartography` — the explorer's progression readout (the analogue of `standing`
 * for traders). Shows worlds charted, the current cartography rank/title, and how
 * many more worlds to the next tier. Informational; usable anywhere.
 */
async function handleCartography(player: Player): Promise<RenderFrame> {
  const charted = player.charted;
  const rank = cartographyRank(charted);
  const nextThreshold = nextCartoThreshold(charted);
  return renderCartography({
    charted,
    rankTitle: rank.title,
    tier: rank.tier,
    maxTier: MAX_CARTO_TIER,
    nextThreshold,
    toNext: nextThreshold === null ? null : nextThreshold - charted,
  });
}

// ---------------------------------------------------------------------------
// rename  (set your PUBLIC handle — shown on leaderboards, `who` and bases)
// ---------------------------------------------------------------------------

async function handleRename(
  player: Player,
  args: string[],
): Promise<RenderFrame> {
  const requested = args.join(" ").trim();
  if (requested.length === 0) {
    return errorFrame("Usage: `rename <username>` — pick a public handle.");
  }

  // Validate shape first (pure rules; never lets an email/space/'@' through).
  const validation = validateHandle(requested);
  if (!validation.ok) {
    return errorFrame(validation.reason);
  }
  const next = validation.value;

  // No-op if it's already your handle (validation lowercases, so compare lower).
  if (next === player.handle) {
    return frame([
      line(text(`Your handle is already "${next}".`, "muted")),
    ]);
  }

  // Persist — the UNIQUE constraint rejects a name another player holds.
  const ok = await world.setHandle(player.id, next);
  if (!ok) {
    return errorFrame(`"${next}" — that username is taken. Try another.`);
  }

  return frame([
    line([
      text("Handle updated: ", "success"),
      text(player.handle, "muted"),
      text(" → ", "muted"),
      text(next, "success"),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// guide / distress — player assistance (player-guidance).
//
// `guide` is the soft-tutorial advisor: it reads live state into a pure
// `GuideSnapshot` and asks `nextStep` for the single best thing to do next.
// Informational — usable in EVERY state (incl. combat). `distress` is the
// anti-softlock safety net: an always-affordable (yet expensive) emergency
// rescue that teleports you to the nearest in-system orbital station, healed.
// ---------------------------------------------------------------------------

/**
 * `guide` — advise the player's single immediate next step. Builds the snapshot
 * from authoritative state (embark/surface, holdings, base ownership, combat),
 * then renders the pure `nextStep` advice with a clickable command. Read-only:
 * no mutation. Usable in every state; in combat it advises `attack`/`flee`.
 */
async function handleGuide(player: Player, seed: string): Promise<RenderFrame> {
  const planet = planetAt(seed, locOf(player));
  const [stacks, materials, parts, base, ownedBases] = await Promise.all([
    world.getInventory(player.id),
    world.getPlayerMaterials(player.id),
    world.getPlayerParts(player.id),
    baseHere(player, seed),
    world.basesOwnedBy(player.id),
  ]);
  const hasOreInCargo = stacks.length > 0;
  const hasAnyGoods = hasOreInCargo || materials.length > 0 || parts.length > 0;
  // Whether cargo holds every mineral a base build needs, in the required
  // amounts — the STABLE gate on the build-base milestone (not generic ore), so
  // the advice doesn't flip-flop with each haul.
  const onHand = new Map(stacks.map((s) => [s.resourceId, s.qty]));
  const hasBaseMinerals = Object.entries(BASE_BUILD_MINERALS).every(
    ([id, need]) => (onHand.get(id) ?? 0) >= need,
  );

  const snapshot: GuideSnapshot = {
    embarked: player.embarked,
    landed: player.landed,
    onFoot: !player.embarked,
    currentPlanetIsGas: planet.isGas,
    atTradeLocation: atTradeLocation(player, seed),
    inCombat: player.encounter != null,
    credits: player.credits,
    hasAnyBase: ownedBases.length > 0,
    hasBaseHere: base != null,
    hasOreInCargo,
    hasAnyGoods,
    hasBaseMinerals,
    shipIsStarter: player.shipId === STARTER_SHIP_ID,
    fuel: player.fuel,
    warpFuel: player.warpFuel,
  };
  return renderGuide(nextStep(snapshot));
}

/**
 * `distress` — call emergency services. Always succeeds: charges
 * `distressCost(credits) = min(credits, DISTRESS_FEE)` (never drives credits
 * negative, yet stings the wealthy), then teleports the player to the NEAREST
 * orbital outpost in their CURRENT system — picked by `interplanetaryDistance`
 * to the planet they're at (tiebreak lowest index) — docking them there
 * (`region = -1`, embarked, not landed), fully healed, combat cleared. Stays
 * in-system, so it can't be abused as free long-haul travel. Validate the
 * destination before mutating; charge + relocate atomically (two writes, both
 * commutative and idempotent in effect).
 */
async function handleDistress(player: Player, seed: string): Promise<RenderFrame> {
  const system = systemOf(player);
  const outposts = systemOutpostPlanets(seed, system);
  // Every system has ≥ 1 outpost, but guard defensively — never strand a rescue.
  if (outposts.length === 0) {
    return errorFrame(
      "No orbital station could be reached from here. (No outpost in this system — try `warp`ing to a neighbour.)",
    );
  }

  // Nearest outpost to the planet we're at, by interplanetary distance now;
  // deterministic tiebreak on the lower planet index. (If we're already at an
  // outpost planet, its distance is 0 → it wins, and the rescue just re-docks.)
  const here = planetAt(seed, locOf(player));
  const now = Date.now();
  let best = outposts[0]!;
  let bestDist = interplanetaryDistance(here, planetAt(seed, { ...system, planet: best }), now);
  for (const idx of outposts.slice(1)) {
    const dist = interplanetaryDistance(here, planetAt(seed, { ...system, planet: idx }), now);
    if (dist < bestDist) {
      best = idx;
      bestDist = dist;
    }
  }

  const destPlanet = planetAt(seed, { ...system, planet: best });
  const cost = distressCost(player.credits);

  // Charge first (atomic, clamped ≥ 0), then relocate + heal in one write.
  if (cost > 0) await world.addPlayerCredits(player.id, -cost);
  await world.setDistressLocation(player.id, best, MAX_HEALTH);

  const remaining = Math.max(0, player.credits - cost);
  const feeNote =
    cost < DISTRESS_FEE
      ? `Emergency services took everything you had (${cost} cr).`
      : `Emergency services billed you ${cost} cr.`;
  return frame([
    line(text("Distress beacon answered.", "success")),
    line([
      text("A rescue tug hauls you to the orbital station above ", "default"),
      text(destPlanet.name, "accent"),
      text(", patches your hull, and tops up your med-bay.", "default"),
    ]),
    line([
      text(feeNote + " ", "muted"),
      text(`Balance ${remaining} cr. `, "muted"),
      text(`HP restored to ${MAX_HEALTH}.`, "success"),
    ]),
    line([
      text("You're docked — ", "muted"),
      action("scan", "scan", { style: "link", title: "look around the station" }),
      text(" the station, or ", "muted"),
      action("buy fuel", "buy fuel", { style: "link", title: "refuel here" }),
      text(" to get moving again.", "muted"),
    ]),
  ]);
}
