# Production & Bases

Load-bearing decisions extracted from `CLAUDE.md`, in build order.

### Load-bearing decisions from `bases-minerals`

- **Bases open the production track (P7): a base is a player's claim on a
  region, and OTHER players see it.** New `public.bases` table (migration
  `20260608100000_bases-minerals.sql`, forward-only/idempotent): `id uuid pk`,
  `owner_id → players(id) on delete cascade`, `region_key text` (the 6-seg
  `regionKey`; free-form coord, no FK — universe is procedural), `name text`,
  `created_at`, **unique (owner_id, region_key)** (one base per player per
  region; many players may base in the same region), index on `region_key`.
  RLS: **public read** (shared-world presence, like `world_deltas`/
  `discoveries`); **no** anon/authenticated write (service-role writes only).
  Buildings INSIDE bases (excavators/silos/production lines) are **P8**, which
  extends `build`'s structure domain beyond `base`.
- **`world.ts` base adapters**: `createBase(ownerId, regionKey, name?)` → `true`
  if inserted, `false` on the `(owner,region)` unique violation (`23505`; other
  errors throw); `basesInRegion(regionKey)` → `RegionBase[]` (`{ownerId, handle,
  name}`, handle resolved from the public `leaderboard` view, public-safe);
  `basesOwnedBy(playerId)` → `OwnedBase[]` (`{regionKey, name}`).
- **Base cost is a pure, tunable catalog** in `src/lib/game/bases.ts` (mirrors
  `upgrades.ts`/`materials.ts`): `BASE_BUILD_COST` is a `Record<string,number>`
  mixing the literal **`credits`** key with mineral ids (`{credits:500,
  titanium:2, iron:5}`); `BASE_BUILD_CREDITS`/`BASE_BUILD_MINERALS` split it;
  `canAffordBase(have, cost=BASE_BUILD_COST)` is true iff every cost line is met.
  Seeded contract: `base-cost.test.ts`.
- **`build base [name]`** (`handleBuild`, **DISEMBARKED_ONLY**, gated like
  `mine`): validates no-duplicate (via `basesOwnedBy`) + affordability (live
  credits + cargo) BEFORE mutating, consumes the cost atomically (minerals via
  `removeInventory`, then `addPlayerCredits(-credits)`), then `createBase`. A
  lost create race **refunds** the cost so nothing is consumed on failure.
  `build`'s arg-0 domain is just **`["base"]`** today (P8 grows it); the name is
  an opaque, case-preserved tail (`args.slice(1).join(" ")`). `build`+`bases`
  registered in `VERBS`+`USAGE` (help parity locked).
- **`bases`** (`handleBases`) lists your bases via `renderBases`
  (`describeRegionKey` parses the 6-seg key into a friendly coord label).
  **`scan`** shows bases in the current region (`ScanView.bases: ScanBase[]` =
  `{handle, name, mine}`; yours marked `(yours)`, others by `— <handle>`),
  fetched in `regionScanFrame` via `basesInRegion` — proving cross-player
  visibility.
- **More / biome-specific minerals.** `Resource` gained an optional
  **`biomes?: readonly Biome[]`** (type-only import from `types.ts` to avoid a
  runtime cycle): omitted/empty → GENERAL (anywhere, as the original 7);
  non-empty → BIOME-SPECIFIC (only regions of those biomes). New minerals:
  general `cobalt`; biome-specific `pyrite`(volcanic), `verdite`(jungle),
  `aquamarine`(ocean), `radium_salt`(irradiated/toxic), `prismatic_gem`
  (crystalline). Catalog (`resources.ts`) MUST match the DB seed in the
  migration (`insert ... on conflict do nothing` for both `resources` and the
  `global` `markets` price = `base_value`).
- **Biome-aware deposit gen** (still pure & deterministic): `depositsFor(rng,
  hazard, biome)` draws its candidate pool from **`mineralsForBiome(biome)`**
  (general + that biome's specifics — exported from `universe/index.ts`), so a
  region can NEVER yield a mineral specific to a different biome; the
  hazard→rarity (`rarityWeight`) + rarity→abundance couplings still apply over
  the filtered pool. `regionAt` rolls the biome BEFORE deposits so the pool is a
  deterministic function of the region coord. Seeded contract:
  `biome-minerals.test.ts` (the old fixed-catalog-size assertion in
  `universe-gen.test.ts` was relaxed to `>= 7`, preserving coverage).

### Load-bearing decisions from `base-buildings`

- **P8a opens the production track INSIDE a base: silos (storage) + excavators
  (passive, time-based ore drain).** Two new tables (migration
  `20260608110000_base-buildings.sql`, forward-only/idempotent), both **public
  read** (bases are public, so their buildings/contents are too) with
  service-role-only writes:
  - `base_buildings` — `id uuid pk`, `base_id → bases(id) on delete cascade`,
    `kind text` (`'silo' | 'excavator'`; no DB enum so P8b kinds need no
    migration), `state jsonb default '{}'` (excavator: `{ lastCollectedAt:
    <iso> }`), `created_at`, index on `base_id`.
  - `base_storage` — `(base_id → bases, item_id text, qty int ≥0)`, pk
    `(base_id, item_id)`; `item_id` is a **resource id for now** (P8b extends to
    materials/advanced). Atomic `add_base_storage(p_base, p_item, p_delta)` RPC
    mirroring `add_inventory`/`add_player_material` (single statement,
    `greatest(0, …)` clamp). No FK on `item_id` (code catalog, like inventory).
- **`world.ts` adapters**: `getBaseInRegion(ownerId, regionKey) → {id, name}|null`
  (the `(owner,region)` unique key ⇒ ≤1), `getBaseBuildings(baseId) →
  BaseBuilding[]` (`{id, kind, state, createdAt}`), `createBaseBuilding(baseId,
  kind, state?)`, `setBuildingState(buildingId, state)`, `getBaseStorage(baseId)
  → StorageStack[]` (`{itemId, qty}`, qty>0), `addBaseStorage(baseId, itemId,
  delta) → newQty`.
- **Pure rules** (`rules.ts`, seeded contract `base-buildings.test.ts`):
  `SILO_CAPACITY = 1000` (units/silo); `EXCAVATOR_RATE_PER_MS = 1/360_000`
  (~10 units/hr per excavator at abundance 1.0 — "slowly drains over time");
  `baseCapacity(siloCount) = SILO_CAPACITY · siloCount`; `excavatorYield(
  abundance, elapsedMs, ratePerMs?) = floor(min(1,abundance) · elapsedMs ·
  ratePerMs)`, 0 when abundance≤0 or elapsed≤0, monotonic in both. Time is passed
  in (handler supplies `Date.now()`); these stay pure & deterministic.
- **Building costs are tunable code catalog** in `bases.ts` (mirrors
  `BASE_BUILD_COST`): `BUILDING_BUILD_COST: Record<StructureKind, costMap>` =
  `{ silo: {credits:300, iron:5}, excavator: {credits:400, titanium:3, iron:5} }`;
  `STRUCTURE_KINDS`/`isStructureKind`/`buildingCost(kind)` + the generic
  `creditsOf`/`mineralsOf` splitters. `canAffordBase(have, cost)` checks any cost
  map uniformly. `commands.ts` shares `consumeCost`/`refundCost`/`affordContext`
  for the base AND building build paths.
- **`build` structure domain is now `["base","silo","excavator"]`** (abbrev-
  resolvable). `build silo`/`build excavator` are **DISEMBARKED_ONLY** (like
  `build base`) AND require an owned base in the current region; charge their cost
  atomically (validate→consume; nothing consumed on failure), create the building
  row. Excavators start with `lastCollectedAt = now`.
- **`deposit <item> [qty]` / `withdraw <item> [qty]`** move resources between ship
  cargo and the current region's base storage — **ungated by embark state**
  ("it's your base"). Bounded by holdings, free cargo, and `baseCapacity(#silos)`;
  default qty = "as much as fits". Atomic (`add_inventory`/`add_base_storage`
  pair). Abbrev domains: `deposit` arg0 = held resource ids; `withdraw` arg0 =
  this base's stored item ids (loaded in `loadArgDomainContext`).
- **`collect`** (ungated): for each excavator and each region deposit, accrue
  `excavatorYield(effectiveAbundance, elapsedSinceLastCollected)`, **clamped to
  remaining storage capacity** (banked in deposit order). Banked ore is added to
  `base_storage` AND written back via `recordDepletion(regionKey, …, qty ·
  DEPLETION_PER_UNIT, …)` — so excavation drains the **same** per-region
  depletion model as manual `mine` (others see less; regen refills). All
  excavators' `lastCollectedAt` advance to `now` whenever there was room (no time
  lost). No elapsed ⇒ nothing accrues.
- **`storage` (alias `base`)** shows the current region's base: silo/excavator
  counts + stored contents vs capacity (`renderStorage`/`StorageView` in
  `render.ts`). `base` is a `USAGE` alias (`alias:true`, skipped in the `help`
  list, like `look`→`scan`); both resolve to `handleStorage`.
- **For P8b**: production lines consume siloed raw → advanced materials (extend
  `base_buildings.kind`, the `build` domain, and `base_storage.item_id` beyond
  resource ids — no schema change needed for new kinds/items). P9 routes
  ship-upgrade manufacture through production lines.

### Load-bearing decisions from `production-lines`

- **P8b closes the production track: a production line turns siloed RAW minerals
  into advanced SHIP PARTS.** NO migration — `production_line` is just a new
  `base_buildings.kind` value (free-text column) and parts live in `base_storage`
  (free-text `item_id`), exactly as P8a anticipated. Reuses P8a's
  `base_buildings`/`base_storage`/`baseCapacity` + the `build`/cost machinery
  wholesale (no fork).
- **Ship-parts catalog (code)** is `src/lib/game/parts.ts`, mirroring
  `upgrades.ts`/`materials.ts`: `Part = { id, name, recipe: Record<resourceId,
  qty>, value }`; helpers `PARTS`/`PART_IDS`/`isPartId`/`getPart`/`partRecipeOf`/
  `partValue` (+ `partRawInputValue` = Σ qty × resource baseValue). Four starters
  (hull_plating, circuit_board, alloy_beam, sensor_array) built from GENERAL
  minerals so they're broadly producible early. **Invariant (unit-tested):** each
  `value` is strictly > its raw input value (manufacturing adds value); recipes
  reference only real `RESOURCES` ids. Parts are NOT in `markets` and (this phase)
  NOT sellable — they sit in storage as intermediates for P9.
- **`production_line` is now a `StructureKind`** (`bases.ts`): `STRUCTURE_KINDS =
  ["silo","excavator","production_line"]` (the P8a `base-buildings-cost.test.ts`
  exact-match assertion was updated to track this deliberate extension),
  `BUILDING_BUILD_COST.production_line = { credits:600, titanium:5, copper:5 }`.
  **`build production_line`** behaves exactly like other P8a structures
  (DISEMBARKED_ONLY, own a base in-region, atomic validate→consume→create via the
  shared `consumeCost`/`refundCost`/`affordContext`). `build`'s arg-0 domain is
  now `["base","silo","excavator","production_line"]`.
- **Pure rule** `canProduce(siloed, recipe, qty=1)` in `rules.ts` mirrors
  `canCraft` but scales the requirement by `qty` (the production-line analogue:
  inputs come from the SILO, not cargo). `qty<=0` is vacuously true (handler
  rejects non-positive separately). Seeded contract: `production-lines.test.ts`.
- **`produce <part> [qty]`** (`handleProduce`, **ungated by embark state** — it's
  your base, like `deposit`/`withdraw`/`collect`): requires a base in the current
  region with ≥1 production line; validates line-exists + inputs-siloed +
  capacity-fits BEFORE mutating (clear errors: "No production line here", "need 5
  Titanium in the silo (have 2)", storage-overflow). Consumes recipe inputs from
  `base_storage` then banks the part(s) back into `base_storage`, all via the
  atomic `add_base_storage` RPC. Instant (no timer); a metered-over-time variant
  (lastProducedAt + per-ms rate, like excavators) is a noted future enhancement.
  `produce`'s arg-0 domain = `PART_IDS`.
- **Parts stay in the silo.** `withdraw` is RAW-resources-only: part ids are
  filtered from its abbrev domain AND the handler rejects a typed part id (no
  cargo slot / sell path yet — P9 wires parts out). The storage display name
  helper `storageItemName(itemId)` resolves parts before resources so a part in
  storage never trips `getResource`'s throw.
- **`storage`/`base` view** gained a production-line count and, once ≥1 line
  exists, a clickable **Producible:** list (`StorageView.productionLines` +
  `producible: {id,name,recipe}[]`, rendered in `renderStorage`); a `build
  production_line` hint sits alongside the silo/excavator hints.
- **For P9**: Ablative Shields / Antifreeze Tanks become production-line OUTPUTS
  (consuming parts), and parts gain a finite, player-grown market supply +
  on-market selling. Extend `parts.ts` / the upgrade recipes there; no schema
  change needed.

### Load-bearing decisions from `base-power`

- **Base infrastructure now needs POWER, and excavators run THEMSELVES (P13).**
  No migration — power plants are new `base_buildings.kind` values and auto-accrual
  reuses each excavator's existing `state.lastCollectedAt`. Built on P8a/P8b; the
  building/storage/cost machinery is reused wholesale (no fork).
- **Pure power model in `rules.ts`** (seeded contract `base-power.test.ts`):
  - `thermalOutput(temperature)` = `max(0, (temp − THERMAL_FLOOR_C) ·
    THERMAL_OUTPUT_PER_DEG)` (`THERMAL_FLOOR_C = −50`, `…PER_DEG = 0.05`) — rises
    with temperature, ≥0, monotonic. Cold worlds yield ~nothing; hot worlds a lot.
  - `solarOutput(atmosphere)` = `max(0, SOLAR_OUTPUT_MAX − SOLAR_OUTPUT_PER_DENSITY
    · atmosphereDensity(atm))` (`MAX = 10`, `PER_DENSITY = 4`) — rises as the
    atmosphere THINS (lower `atmosphereDensity` → more sunlight), ≥0, strictly
    higher under a thinner atmosphere. **Thermal favors hot worlds; solar favors
    thin-atmosphere worlds — siting is a real choice.**
  - Demands: `EXCAVATOR_POWER_DEMAND = 4`, `PRODUCTION_LINE_POWER_DEMAND = 6` (>0).
  - `basePower({thermalPlants, solarArrays, excavators, productionLines,
    temperature, atmosphere})` → `{supply, demand, powered}`; `supply = Σ plant
    outputs`, `demand = Σ consumer demands`, **`powered = supply ≥ demand`** —
    ALL-OR-NOTHING (no brownouts/batteries; out of scope). No consumers ⇒ demand 0
    ⇒ trivially powered. Pure (temperature/atmosphere passed in); designed to
    extend (new plant → a supply term, new consumer → a demand term).
- **`atmosphereDensity` MOVED to the universe layer** (`gen.ts`, exported from
  `@/lib/universe`) — it's a physical property of an atmosphere, used by both
  `takeoffCost` (fuel) and `solarOutput` (power). `rules.ts` imports it from
  `@/lib/universe` and RE-EXPORTS it (existing importers — `takeoffCost`,
  `fuel-orbital.test`, the new `base-power.test`'s `@/lib/universe` import — all
  keep working). Clean layering: universe doesn't import game.
- **Buildings**: `thermal_plant` + `solar_array` are new `StructureKind`s
  (`bases.ts`, `STRUCTURE_KINDS` extended — the P8a `base-buildings-cost.test.ts`
  exact-match assertion was updated to track this, per the production-lines
  precedent), `BUILDING_BUILD_COST.thermal_plant = {credits:500, iron:5, copper:5}`,
  `.solar_array = {credits:500, silica:5, copper:5}`. `build`'s arg-0 domain is now
  `["base","silo","excavator","production_line","thermal_plant","solar_array"]`.
  Same build rules (DISEMBARKED + own a base in-region + atomic validate→consume→
  create via the shared `consumeCost`/`affordContext`). The build-success line
  echoes the recomputed power balance.
- **A base's power** is `basePower(...)` over its building counts + the base
  REGION's `temperature` (`regionAt`) and the PLANET's `atmosphere` (`planetAt`).
  - **`produce` is power-gated**: `handleProduce` computes power after the
    production-line check and BEFORE any consumption; underpowered → an
    `Insufficient power (supply/demand) — build thermal_plant/solar_array` error,
    nothing consumed.
  - **`storage`/`base` view** shows a `power supply/demand` line — green `✓` when
    powered, RED when short (P9b convention) — plus a `plants` count and red-marked
    `build thermal_plant`/`build solar_array` hints (`StorageView.power`/
    `thermalPlants`/`solarArrays`/`buildable.thermal_plant`/`.solar_array`).
- **Automatic excavators — `collect` is GONE** (removed from `VERBS`/`USAGE`/
  `applicability`'s `DISEMBARKED_ACTIONS`/dispatch; help-parity + per-state
  applicability stay green). Replaced by **lazy, power-gated auto-accrual**
  (`accrueExcavators` in `commands.ts`): on any read of a base the player owns in
  the current region (`scan` at the base region via `maybeAccrueExcavators` in
  `regionScanFrame` / `storage` / `deposit` / `withdraw` / `produce`), each
  excavator's accrued ore is banked into the silos — the SAME math as old
  `collect` (per-deposit `excavatorYield(effectiveAbundance, now − lastCollectedAt)`,
  capacity-clamped in deposit order, banked amount written back via
  `recordDepletion`). No cron — realized on access, like price/supply reversion.
  - **Power gate**: if the base is `!powered`, accrue NOTHING and DON'T advance
    timestamps (so it resumes when power returns).
  - **No clock-reset starvation**: an excavator advances `lastCollectedAt` only
    once it has earned ≥1 whole unit. Because accrual now fires on EVERY base read
    (not a manual command), advancing on a sub-threshold (floored-to-0) read would
    reset the clock and starve a frequently-read base — so a 0-yield excavator's
    clock is left alone and time keeps accumulating until it crosses the floor.
- **Out of scope (extension points noted)**: no brownout/partial power, no
  batteries, no plant beyond thermal/solar — but `basePower` is shaped to add more
  supply/demand terms, and metered (over-time) production is still a noted future.

### Load-bearing decisions from `blast-furnace`

- **Industrial smelting tier + a deepened production chain: ore → ingot →
  part → upgrade.** NO migration — `blast_furnace` is a new free-text
  `base_buildings.kind`, and ingots are free-text `base_storage` items
  (silo-only intermediates: NOT carried in cargo, NOT traded, NOT in
  `deposit`/`withdraw` this phase). Built on P8a/P8b/P13; reuses the building/
  storage/cost/power machinery wholesale.
- **`INGOTS` catalog** (`src/lib/game/ingots.ts`, mirrors `parts.ts`):
  `Ingot = { id, name, recipe: Record<resourceId, qty>, value }`; helpers
  `INGOTS`/`INGOT_IDS`/`isIngotId`/`getIngot`/`ingotRecipeOf`/`ingotValue`/
  `ingotRawInputValue`. **One ingot per METAL** (iron/copper/cobalt/titanium/
  iridium — NOT silica/xenon/voidstone); recipe is raw metal → one ingot
  (`{iron:2}` etc). `value = round(ingotRawInputValue × SMELT_VALUE_MARKUP)`
  (`= 1.5`), so **ingotValue > raw input** (smelting adds value; unit-tested).
- **`blast_furnace` is a power-gated `StructureKind`** (`bases.ts`,
  `STRUCTURE_KINDS` extended — the `base-buildings-cost.test.ts` exact-match
  assertion was updated, per the production-line/base-power precedent),
  `BUILDING_BUILD_COST.blast_furnace` tunable. `BLAST_FURNACE_POWER_DEMAND = 6`
  (`rules.ts`); **`basePower` gained a `blastFurnaces` arg** (counts them as
  consumers); every call site passes the base's furnace count. Built like other
  structures (DISEMBARKED + own a base in-region + atomic consume).
- **`produce` is now THREE-branch** (`commands.ts`): `isIngotId` → smelt
  (requires a **blast_furnace** + power, consumes siloed raw metal → banks
  ingot into the silo, capacity-capped); `isPartId` → manufacture part
  (requires a **production_line**); `isUpgradeId` → manufacture upgrade. Arg-0
  domain is `[...INGOT_IDS, ...PART_IDS, ...UPGRADE_IDS]`. Validate-before-
  mutate, atomic via `add_base_storage`, power-gated. `storageItemName`
  resolves ingot ids; the `storage`/`base` view shows a furnace count + a
  clickable **Smeltable:** list (P9b red when inputs/power short).
- **Ship parts rewired onto ingots** (`parts.ts`): each part recipe now
  consumes INGOTS for its metal inputs (raw `silica` stays raw — no ingot).
  `partInputValue(id)` sums ingot items at `ingotValue` + raw items at
  `baseValue`; `partValue = round(partInputValue × PART_VALUE_MARKUP)` so
  **partValue > input** (every recipe references ≥1 ingot — the rewire is
  unit-tested). Knock-on: `upgrades` `recipeCost = Σ partValue` rose, so
  `upgradeValue = round(recipeCost × CRAFT_VALUE_MARKUP=1.2)` rose too
  (`ship-upgrades.test.ts` band re-evaluated, not weakened). The full chain is
  monotonic: ore < ingot < part < upgrade. Seeded contract:
  `src/lib/game/blast-furnace.test.ts`.
- **For the farming phases (crop-farming, animal-husbandry)**: same building/
  `build`/power pattern; biome-affined catalogs; active plant/tend/harvest +
  feed/breed/slaughter cycles (need `base_plots` / `base_livestock` tables).

### Load-bearing decisions from `crop-farming`

- **Agriculture (Phase 2): plant biome-affined crops at a base, grow over real
  time, harvest for crop materials.** Active plant→grow→harvest cycle. Mirrors
  the building/catalog/material patterns; reuses bases/buildings + the wildlife
  material loop. Crop materials are designed to feed livestock in Phase 3.
- **`crop_farm` is a non-power-gated `StructureKind`** (`bases.ts`,
  `STRUCTURE_KINDS` extended + `base-buildings-cost.test.ts` updated) — a
  deliberate contrast with the INDUSTRIAL buildings (excavator/production_line/
  blast_furnace are power-gated; agriculture is natural, not). Each `crop_farm`
  provides `CROP_FARM_PLOTS` (`rules.ts`) planting plots; a base's capacity =
  `CROP_FARM_PLOTS × (#crop_farm)`.
- **New `MaterialCategory: "crop"`** (`materials.ts`): the harvest outputs —
  sellable `{category:"crop"}` materials, some edible (`heal`). **EXCLUDED from
  `SCAVENGEABLE`** (crops are farmed, never found — like `food`/`animal`).
- **`CROPS` catalog** (`src/lib/game/crops.ts`, mirrors `wildlife.ts`):
  `Crop = { id, name, biomes: Biome[], growMs, yield: {materialId, qty} }`;
  helpers `CROPS`/`CROP_IDS`/`isCropId`/`getCrop`/`cropsForBiome`. 10 crops
  across 5 biomes (jungle/ocean/desert/tundra/volcanic, ≥2 each), grow times
  20–90 min. **Biome-affined** — a crop only plants in a region whose biome is
  in its `biomes`.
- **`base_plots` table** (migration `20260609010000_crop-farming.sql`,
  forward-only/idempotent): `(id, base_id→bases cascade, crop_id text [code
  catalog, no FK], planted_at, created_at)`, index on base_id, **RLS public
  read + service-role writes** (like `base_buildings`/`base_storage`). One row
  per sown plot. `world.ts`: `getBasePlots`/`plantCrop`/`removePlots` (plain
  service-role insert/delete — rows, not counters, so no atomic RPC).
- **Pure rule** `cropMature(plantedAtMs, nowMs, growMs)` (`rules.ts`,
  `now − planted ≥ grow`; time passed in). Seeded: `crop-farming.test.ts`.
- **Commands**: `plant <crop>` (NEW verb; DISEMBARKED + own base in-region +
  biome-valid + free plot + gas/outpost guards; arg domain =
  `cropsForBiome(regionBiome)`). `harvest <crop>` EXTENDS the existing
  `harvest`: with a crop arg → harvest your MATURE plots of it (award yield to
  `player_materials`, free the plots); bare `harvest` → wild flora (unchanged);
  its arg domain = crops with mature plots here. `scan`/`storage` surface plots
  + maturity (P9b red). Registered in `VERBS`/`USAGE`/`applicability`
  (DISEMBARKED).

### Load-bearing decisions from `animal-husbandry`

- **Ranching (Phase 3, COMPLETES the industrial/agricultural expansion): build
  a livestock pen, `ranch` biome-affined animals, `feed` them crops to breed
  the herd over time, `slaughter` for product materials.** Active
  ranch→feed/breed→slaughter cycle, mirroring `crop-farming`. **Closes the
  crops→feed loop**: every farm animal eats a Phase-2 crop.
- **`livestock_pen` is a non-power-gated `StructureKind`** (`bases.ts`,
  `STRUCTURE_KINDS` + `base-buildings-cost.test.ts` updated) — agricultural,
  like `crop_farm`. Each pen holds `LIVESTOCK_PEN_CAPACITY` (`rules.ts`, 20)
  head; base capacity = `× #livestock_pen` across all animal types.
- **`FARM_ANIMALS` catalog** (`src/lib/game/livestock.ts`, mirrors `crops.ts`):
  `FarmAnimal = { id, name, biomes, feed: {cropId, qtyPerHead}, breedMs,
  product: {materialId, qty}, acquireCost }`; helpers `FARM_ANIMALS`/
  `FARM_ANIMAL_IDS`/`isFarmAnimalId`/`getFarmAnimal`/`farmAnimalsForBiome`.
  8 animals across 5 biomes; **`feed.cropId` is always a real `CROPS` id**.
  Products are 8 new `category:"animal"` materials (poultry_meat, tender_loin,
  shellfish_meat, woolly_fleece, etc.), sellable like the wild animal drops.
- **`base_livestock` table** (migration `20260609020000_animal-husbandry.sql`,
  forward-only/idempotent): `(base_id→bases cascade, animal_id text [no FK],
  count int ≥0 check, last_bred_at, pk (base_id, animal_id))`, index on base_id,
  **RLS public-read + service-role writes**. Atomic clamped RPC
  `add_livestock(p_base, p_animal, p_delta)` (`greatest(0, …)`, mirrors
  `add_inventory`/`add_base_storage`). `world.ts`: `getBaseLivestock`/
  `addLivestock`/`setLivestockBred`.
- **Pure rules** (`rules.ts`): `livestockCanBreed(lastBredAtMs, nowMs, breedMs)`,
  `feedAmount(count, qtyPerHead)` (= count × perHead, 0 at empty), `breedOffspring(
  count)` (≥1 for non-empty, capped to capacity at the call site). Time/inputs
  passed in. Seeded: `animal-husbandry.test.ts`.
- **Commands** (NEW verbs, DISEMBARKED, own base in-region, gas/outpost guards;
  `VERBS`/`USAGE`/`applicability`): `ranch <animal>` (acquire a head for
  `acquireCost`; biome + capacity + affordability checks), `feed <animal>`
  (consume `feedAmount` of the feed crop from `player_materials`; breed when
  `livestockCanBreed` + capacity), `slaughter <animal> [n]` (head → product
  materials). scan/storage surface herds + breed-readiness (P9b red hints).

### Load-bearing decisions from `base-tiers` (Keystone 2c)

- **Bases have a TIER (1..`MAX_BASE_TIER`) that multiplies storage capacity** —
  the ongoing production sink. `bases.tier integer default 1 check (tier>=1)`
  (migration `20260610020000_base-tiers.sql`, forward-only/idempotent; existing
  bases → tier 1, no behavior change), carried on base reads.
- **Pure tier math** (`rules.ts`/`bases.ts`): `baseTierMultiplier(tier)` (1 at
  tier 1, strictly increasing), `baseCapacity(siloCount, tier) = SILO_CAPACITY ×
  siloCount × baseTierMultiplier(tier)` (the tier arg threaded through EVERY
  capacity check — deposit/withdraw/produce/excavator accrual),
  `baseUpgradeCost(currentTier)` (credits + PART/INGOT ids, scaling up per tier;
  `upgradeCredits`/`upgradeMinerals` splitters).
- **`upgrade base`** (NEW verb `upgrade`, arg domain `["base"]`; DISTINCT from
  the ship-`upgrades` screen / `produce`-d upgrades; DISEMBARKED, own a base
  in-region, gas/outpost guarded): validate `< MAX_BASE_TIER` + affordable
  (credits + siloed parts/ingots), then atomically consume + increment tier.
  `storage` shows tier + capacity + next-tier cost (P9b red). Seeded:
  `base-tiers.test.ts`. (2c-cont: power/throughput/slot tiers, orbital stations.)

### Load-bearing decisions from `base-power-tiers` (2c-cont)

- **Base tier ALSO boosts power supply** (extends `base-tiers`, which gave
  capacity). NO migration (reuses `bases.tier`). `baseTierPowerBonus(tier)`
  (`rules.ts`, pure): 0 at tier 1, strictly increasing per tier (~one extra
  production line's worth each). `basePower` gained a `tier` arg; `supply +=
  baseTierPowerBonus(tier)` (every call site — produce gate, excavator accrual,
  build echo, storage — passes the base tier). So leveling a base runs more
  industry without more plants. `storage` shows the tier power contribution.
  Seeded: `base-power-tiers.test.ts`.
