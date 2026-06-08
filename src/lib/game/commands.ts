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
  planetAt,
  systemAt,
  systemKey,
  planetKey,
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
  renderScan,
  renderMap,
  renderInventory,
  renderUpgrades,
  renderWho,
  errorFrame,
  type MapNeighbor,
} from "./render";
import * as world from "./world";

/** Strict integer parse: returns null for missing/non-integer tokens. */
function toInt(token: string | undefined): number | null {
  if (token === undefined) return null;
  const n = Number(token);
  return Number.isInteger(n) ? n : null;
}

function locOf(player: Player): PlanetCoord {
  return { sector: player.sector, system: player.system, planet: player.planet };
}

/**
 * Command vocabulary for prefix abbreviation. The canonical verbs the
 * dispatcher switch understands (plus the `look` alias, which is a distinct
 * word; `inv` is omitted because it already resolves as a prefix of
 * `inventory`). Typing a unique prefix of any of these expands to the full
 * verb before dispatch.
 */
const VERBS = [
  "scan",
  "look",
  "map",
  "warp",
  "land",
  "mine",
  "inventory",
  "upgrades",
  "craft",
  "sell",
  "buy",
  "who",
  "help",
];

/**
 * The resource ids minable on the current planet right now — present deposits
 * whose effective (post-depletion) abundance is still > 0. These are the
 * candidate set for `mine`'s argument.
 */
async function minableHere(player: Player, seed: string): Promise<string[]> {
  const coord = locOf(player);
  const planet = planetAt(seed, coord);
  const depletionMap = await world.getEffectiveDepletionMap(planetKey(coord));
  return planet.deposits
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

export async function dispatch(player: Player, input: string): Promise<RenderFrame> {
  const seed = getWorldSeed();
  const { verb: rawVerb } = parseCommand(input);
  if (rawVerb === "") {
    return frame([line(text("Type `help` for commands.", "muted"))]);
  }

  // Resolve the verb first so we know which contextual candidate sets to fetch
  // for argument resolution (the candidate sets come from authoritative state).
  const verbRes = resolveToken(rawVerb, VERBS);
  let mineCandidates: string[] | null = null;
  let sellCandidates: string[] | null = null;
  if (verbRes.ok && verbRes.value === "mine") {
    mineCandidates = await minableHere(player, seed);
  } else if (verbRes.ok && verbRes.value === "sell") {
    sellCandidates = await sellableHere(player);
  }

  const spec: ResolveLineSpec = {
    verbs: VERBS,
    argDomain: (verb, argIndex) => {
      if (verb === "mine" && argIndex === 0) return mineCandidates;
      if (verb === "sell" && argIndex === 0) return sellCandidates;
      if (verb === "craft" && argIndex === 0) return [...UPGRADE_IDS];
      if (verb === "buy" && argIndex === 0) {
        return ["fuel", ...RESOURCES.map((r) => r.id), ...UPGRADE_IDS];
      }
      return null; // opaque: warp coords, land index, buy/craft quantity, …
    },
  };

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

/** Dispatch an already-resolved (canonical verb, expanded args) command. */
async function dispatchResolved(
  player: Player,
  seed: string,
  verb: string,
  args: string[],
): Promise<RenderFrame> {
  switch (verb) {
    case "help":
      return renderHelp();
    case "scan":
    case "look":
      return handleScan(player, seed);
    case "map":
      return handleMap(player, seed);
    case "warp":
      return handleWarp(player, seed, args);
    case "land":
      return handleLand(player, seed, args);
    case "mine":
      return handleMine(player, seed, args);
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
// scan / look
// ---------------------------------------------------------------------------

async function handleScan(player: Player, seed: string): Promise<RenderFrame> {
  const coord = locOf(player);
  const planet = planetAt(seed, coord);
  const system = systemAt(seed, coord);
  const [depletionMap, justDiscovered, owned] = await Promise.all([
    world.getEffectiveDepletionMap(planetKey(coord)),
    world.recordDiscovery(planetKey(coord), player.id),
    world.getOwnedUpgradeIds(player.id),
  ]);
  const requiredUpgrade = landingRequirement(planet.temperature);
  return renderScan({
    planet,
    system,
    depletionMap,
    justDiscovered,
    requiredUpgrade,
    hasRequiredUpgrade: requiredUpgrade === null || owned.has(requiredUpgrade),
  });
}

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

/** Candidate system offsets around the current system, nearest-first after sort. */
function neighborCandidates(current: SystemCoord): SystemCoord[] {
  const out: SystemCoord[] = [];
  for (let ds = -1; ds <= 1; ds++) {
    for (let dsys = -3; dsys <= 3; dsys++) {
      if (ds === 0 && dsys === 0) continue;
      out.push({ sector: current.sector + ds, system: current.system + dsys });
    }
  }
  return out;
}

async function handleMap(player: Player, seed: string): Promise<RenderFrame> {
  const current: SystemCoord = { sector: player.sector, system: player.system };
  const discovered = await world.discoveredSystemKeys();
  const neighbors: MapNeighbor[] = neighborCandidates(current)
    .map((coord) => {
      const sys = systemAt(seed, coord);
      return {
        sector: coord.sector,
        system: coord.system,
        name: sys.name,
        distance: warpDistance(current, coord),
        discovered: discovered.has(systemKey(coord)),
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8);
  return renderMap(neighbors, player.fuel);
}

// ---------------------------------------------------------------------------
// warp
// ---------------------------------------------------------------------------

async function handleWarp(
  player: Player,
  seed: string,
  args: string[],
): Promise<RenderFrame> {
  const sector = toInt(args[0]);
  const system = toInt(args[1]);
  if (sector === null || system === null) {
    return errorFrame("Usage: warp <sector> <system>  (e.g. warp 0 1)");
  }
  const current: SystemCoord = { sector: player.sector, system: player.system };
  const dest: SystemCoord = { sector, system };
  if (dest.sector === current.sector && dest.system === current.system) {
    return errorFrame("You're already in that system. Try `map` for neighbors.");
  }

  const distance = warpDistance(current, dest);
  const cost = fuelCost(distance);
  if (cost > player.fuel) {
    return errorFrame(
      `Not enough fuel: warp needs ${cost}, you have ${player.fuel}. Try a closer system or \`buy fuel\`.`,
    );
  }

  const newFuel = player.fuel - cost;
  await world.setFuelAndLocation(player.id, newFuel, {
    sector: dest.sector,
    system: dest.system,
    planet: 0,
  });

  const arrivalCoord: PlanetCoord = { ...dest, planet: 0 };
  const destSystem = systemAt(seed, dest);
  const arrivalPlanet = planetAt(seed, arrivalCoord);
  const [depletionMap, justDiscovered, owned] = await Promise.all([
    world.getEffectiveDepletionMap(planetKey(arrivalCoord)),
    world.recordDiscovery(planetKey(arrivalCoord), player.id),
    world.getOwnedUpgradeIds(player.id),
  ]);

  // Warp is NOT gated — you always arrive in-system at planet 0. If that world
  // is hostile you simply can't `mine` it until you have the gear (or `land` a
  // survivable sibling), so this can never softlock you.
  const requiredUpgrade = landingRequirement(arrivalPlanet.temperature);
  const scan = renderScan({
    planet: arrivalPlanet,
    system: destSystem,
    depletionMap,
    justDiscovered,
    requiredUpgrade,
    hasRequiredUpgrade: requiredUpgrade === null || owned.has(requiredUpgrade),
  });
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

  const system = systemAt(seed, { sector: player.sector, system: player.system });
  if (idx < 0 || idx >= system.planetCount) {
    return errorFrame(
      `No planet ${idx} here — this system has ${system.planetCount} (0–${system.planetCount - 1}).`,
    );
  }

  const coord: PlanetCoord = {
    sector: player.sector,
    system: player.system,
    planet: idx,
  };
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

  if (idx !== player.planet) {
    await world.setPlanet(player.id, idx);
  }

  const requiredUpgrade = landingRequirement(planet.temperature);
  const [depletionMap, justDiscovered] = await Promise.all([
    world.getEffectiveDepletionMap(planetKey(coord)),
    world.recordDiscovery(planetKey(coord), player.id),
  ]);
  const scan = renderScan({
    planet,
    system,
    depletionMap,
    justDiscovered,
    requiredUpgrade,
    hasRequiredUpgrade: requiredUpgrade === null || owned.has(requiredUpgrade),
  });
  return frame([
    line(text(`Landed on ${planet.name}.`, "success")),
    ...scan.lines,
  ]);
}

// ---------------------------------------------------------------------------
// mine
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

  const deposit = planet.deposits.find((d) => d.resourceId === resourceId);
  if (!deposit) {
    return errorFrame(`No ${resourceId} deposit on ${planet.name}. Try \`scan\`.`);
  }

  const key = planetKey(coord);
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
  return frame([
    line([
      text(`Mined ${yield_} `, "success"),
      text(`${res.name}. `, "default"),
      text(`Cargo ${used + yield_}/${player.cargoCap} (${remaining} free).`, "muted"),
    ]),
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
