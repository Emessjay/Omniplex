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
  type SystemCoord,
  type PlanetCoord,
} from "@/lib/universe";
import type { RenderFrame } from "@/lib/terminal/types";
import { frame, line, text } from "@/lib/terminal/helpers";
import { parseCommand } from "./parse";
import { getWorldSeed } from "./seed";
import {
  effectiveAbundance,
  fuelCost,
  miningYield,
  priceAfterSale,
  sellValue,
  DEPLETION_PER_UNIT,
  FUEL_PRICE_PER_UNIT,
} from "./rules";
import {
  renderHelp,
  renderScan,
  renderMap,
  renderInventory,
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

export async function dispatch(player: Player, input: string): Promise<RenderFrame> {
  const { verb, args } = parseCommand(input);
  const seed = getWorldSeed();

  switch (verb) {
    case "":
      return frame([line(text("Type `help` for commands.", "muted"))]);
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
    case "inv":
      return handleInventory(player);
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
  const [depletionMap, justDiscovered] = await Promise.all([
    world.getDepletionMap(planetKey(coord)),
    world.recordDiscovery(planetKey(coord), player.id),
  ]);
  return renderScan({ planet, system, depletionMap, justDiscovered });
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
  const [depletionMap, justDiscovered] = await Promise.all([
    world.getDepletionMap(planetKey(arrivalCoord)),
    world.recordDiscovery(planetKey(arrivalCoord), player.id),
  ]);

  const scan = renderScan({
    planet: planetAt(seed, arrivalCoord),
    system: destSystem,
    depletionMap,
    justDiscovered,
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
  if (idx !== player.planet) {
    await world.setPlanet(player.id, idx);
  }

  const planet = planetAt(seed, coord);
  const [depletionMap, justDiscovered] = await Promise.all([
    world.getDepletionMap(planetKey(coord)),
    world.recordDiscovery(planetKey(coord), player.id),
  ]);
  const scan = renderScan({ planet, system, depletionMap, justDiscovered });
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
  const deposit = planet.deposits.find((d) => d.resourceId === resourceId);
  if (!deposit) {
    return errorFrame(`No ${resourceId} deposit on ${planet.name}. Try \`scan\`.`);
  }

  const key = planetKey(coord);
  const depletionMap = await world.getDepletionMap(key);
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
// sell
// ---------------------------------------------------------------------------

async function handleSell(player: Player, args: string[]): Promise<RenderFrame> {
  const target = args[0]?.toLowerCase();
  if (!target) return errorFrame("Usage: sell <resource>  or  sell all");

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

// ---------------------------------------------------------------------------
// buy fuel [n]
// ---------------------------------------------------------------------------

async function handleBuy(player: Player, args: string[]): Promise<RenderFrame> {
  const what = args[0]?.toLowerCase();
  if (what !== "fuel") {
    return errorFrame("You can only `buy fuel [n]` for now.");
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
