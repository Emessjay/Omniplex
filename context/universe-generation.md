# Universe Generation

Load-bearing decisions extracted from `CLAUDE.md`, in build order.

### Load-bearing decisions from `temp-hazard`

- **Hazard is derived from temperature** (`hazardFor` in
  `src/lib/universe/gen.ts`), no longer uniform random. A comfort band
  (`TEMP_COMFORT_MID` 15°C ± `TEMP_COMFORT_BAND` 50°C) reads as ~0 hazard;
  beyond it, `(departure / TEMP_EXTREME_SCALE)^TEMP_HAZARD_POWER ×
  TEMP_HAZARD_WEIGHT` plus ≤`HAZARD_JITTER` random, clamped [0,1]. Still pure
  & deterministic (one `rng()` draw). Knock-on: extreme-temp worlds are
  high-hazard → (via `rarityWeight`) carry the rarest resources. Because the
  coldest stars bottom out ~−160°C but hot stars exceed +400°C, the very
  highest hazards (voidstone) skew toward scorching worlds.
- The universe-gen suite's "both calm AND savage planets exist" assertions are
  the guardrail against over-coupling — keep the random jitter so the
  distribution doesn't collapse.

### Load-bearing decisions from `planet-regions`

- **A planet is no longer a single place** — it has MANY regions, each with its
  own biome + deposits. Addressing gained a 4th integer: `RegionCoord =
  { sector, system, planet, region }` (in `src/lib/universe/types.ts`). The
  start location is `(0,0,0,0)`.
- **`Planet` reshape** (BREAKING — every call site updated in this change):
  REMOVED `biome` and `deposits`; ADDED `biomePalette: Biome[]` (a DISTINCT
  subset of `BIOMES`, size `[PALETTE_MIN, PALETTE_MAX]` = `[2, 4]`) and
  `regionCount: number` (integer in `[REGION_COUNT_MIN, REGION_COUNT_MAX]` =
  `[100, 100000]`, **log-uniform**: `round(10 ** randFloat(2,5))` clamped). The
  remaining planet fields (`temperature`, `hazard`, `gravity`, `atmosphere`,
  `name`, `coord`) still describe the whole world — the hazard/temperature/
  landing model stays PLANET-level.
- **`Region` + `regionAt(seed, planetCoord, regionIndex)`** (`gen.ts`): PURE &
  deterministic, its own RNG stream keyed by the full region coord
  (`makeRng(seed, "region", sector, system, planet, region)`) so a region
  reproduces without generating its (up to 100k) siblings. `biome` is `pick`ed
  from the planet's `biomePalette` (always a member); `deposits` use the
  existing hazard-coupled `depositsFor`, so savage→rare + rarity→abundance carry
  down to the region. `regionIndex` is NOT range-checked in gen — callers
  validate against `planet.regionCount`.
- **4-segment keys**: `regionKey(coord)` →
  `"<sector>:<system>:<planet>:<region>"`; `parseLocationKey` handles 2/3/4
  segments. **These region keys are the `world_deltas` depletion keys now** —
  depletion is PER-REGION. `world.ts` depletion adapters
  (`getDepletionMap`/`getEffectiveDepletionMap`/`recordDepletion`) take a
  generic `locationKey` and are fed `regionKey`. **Discoveries stay
  PLANET-level** (`planetKey`) — no per-region discovery rows.
- **`players.region`** (`integer not null default 0`, migration
  `20260608080000_player-region.sql`, forward-only/idempotent) carried on
  `Player`/`PlayerRow` + `rowToPlayer`. `warp` and `land` reset `region` to 0
  on arrival (handled inside `world.setFuelAndLocation`/`setPlanet`);
  `world.setRegion` is the `jump` mutator.
- **Commands**: `scan` describes the CURRENT region (biome + deposits) plus
  planet context (palette, region count, region index); `jump <n>` validates
  `0 ≤ n < regionCount` then re-scans (free, same planet, opaque numeric arg);
  `regions [page]` is a paged (~10/page) clickable `jump <n>` listing. `mine`
  works the current region's deposits and depletes per `regionKey`; its abbrev
  domain is the current REGION's minable resources. All region-scan output is
  built by the shared `regionScanFrame` helper in `commands.ts`.

### Load-bearing decisions from `addressing-overhaul`

- **Spatial addressing is now a SIX-tier hierarchy**: `galaxy → arm → cluster →
  system → planet → region`. `SystemCoord` (in `src/lib/universe/types.ts`) is
  `{ galaxy, arm, cluster, system }`; `PlanetCoord` adds `planet`; `RegionCoord`
  adds `region`. **`sector` was RENAMED to `cluster` everywhere** (code, schema,
  keys). The start location is `(0,0,0,0,0,0)`. `galaxy` is UNBOUNDED (≥ 0,
  effectively infinite outward — inter-galaxy travel is a LATER, condensate-gated
  phase; everyone stays in galaxy 0 for now). `cluster`/`system` ≥ 0.
- **`arm` is a RING within a galaxy**, canonical in `[0, armCount)`. Arm indices
  WRAP modulo the galaxy's `armCount` (so `warp 13 …` in a 12-arm galaxy lands on
  arm 1), and arm distance is symmetric around the ring.
- **`galaxyAt(seed, galaxy) → { index, name, armCount }`** (`gen.ts`): pure &
  deterministic; `armCount` is `randInt(ARM_COUNT_MIN, ARM_COUNT_MAX)` = `[2, 16]`
  and VARIES per galaxy. Callers get a galaxy's `armCount` from here.
- **Keys are 4/5/6-segment** (`gen.ts`): `systemKey` →
  `"galaxy:arm:cluster:system"`, `planetKey` → +`:planet`, `regionKey` →
  +`:region`. `parseLocationKey` returns `SystemCoord`/`PlanetCoord`/`RegionCoord`
  for 4/5/6 segments (old 2/3/4-seg data was migrated, so it no longer parses
  those). These remain the `world_deltas` (per-region, 6-seg) / `discoveries`
  (per-planet, 5-seg) keys.
- **`warpDistance(a, b, armCount)`** (`gen.ts`) now takes `armCount`: different
  galaxies → `Infinity` (not a warp); same galaxy → a weighted sum
  `armRing·ARM_SPAN + |Δcluster|·CLUSTER_SPAN + systemTerm` where
  `armRing = min(|Δarm|, armCount − |Δarm|)` (symmetric wrap). Exported spans:
  `CLUSTER_SPAN = ARM_SPAN = 10·STAR_CLUSTER_SIGMA = 100` (arm ≈ cluster cost
  for now, to be revisited); `SYSTEM_SPAN = 1`. 0-to-self, symmetric, positive
  between distinct same-galaxy coords. `map`/`warp` supply `armCount` via
  `galaxyAt(coord.galaxy).armCount`.
- **All gen RNG streams seed with the full coord** (`makeRng(seed, "...", galaxy,
  arm, cluster, system, …)`); the planet/region generation LOGIC (palette,
  regionCount, deposits, hazard/temperature) is otherwise UNCHANGED — just keyed
  richer, so different galaxy/arm ⇒ different worlds.
- **`players` schema** (migration `20260608090000_addressing-overhaul.sql`,
  forward-only): `sector` RENAMED to `cluster`; `galaxy`/`arm` ADDED (`integer
  not null default 0`). The migration also (a) recreates the public `leaderboard`
  view against the six-tier coords, and (b) prefixes existing
  `world_deltas.location_key` / `discoveries.planet_key` with `0:0:` so prior
  depletion/discoveries resolve under galaxy 0 / arm 0 (`markets='global'` left
  alone). Runs exactly once. `Player`/`PlayerRow` + `rowToPlayer` carry
  `galaxy`/`arm`/`cluster`.
- **This phase is the SPATIAL MODEL ONLY** — the single `fuel` and
  `fuelCost(warpDistance(...))` are unchanged. **`warp <arm> <cluster> <system>`**
  warps within the current galaxy (arm taken mod `armCount`, galaxy fixed);
  `map` lists arm/cluster/system neighbors + costs and shows the full location +
  arm count. The fuel split, orbital mechanics, and galaxy jumps are LATER
  phases. The roadmap (survival, production, fuel, galaxy travel) builds on this
  six-tier model.

### Load-bearing decisions from `biome-consistency`

- **Biome / temperature / hazard are now physically coherent.** All the new
  logic is PURE & deterministic in `src/lib/universe/gen.ts` (+ a `Region`
  reshape in `types.ts`) — **no schema/migration**; the only gameplay wiring is a
  damage-source + scan-render tweak in `commands.ts`/`render.ts`.
- **Temperature ← star brightness + orbital closeness** (`planetTemperatureFor(
  starClass, orbitalRadius, rng)`): `STAR_TEMP_BASE[starClass] + RADIUS_TEMP_COEF
  / orbitalRadius + jitter(±TEMP_JITTER)`. The deterministic part is MONOTONIC —
  hotter star ⇒ hotter, smaller radius ⇒ hotter (the `1/radius` insolation term).
  `RADIUS_TEMP_COEF = 120`, `TEMP_JITTER = 120`. **`orbitalRadius` is now drawn
  BEFORE temperature** in `generatePlanet` (the closeness term needs it); this
  replaced the old `STAR_TEMP_BASE + random`. Hazard is still `hazardFor(temp)`
  (temp-hazard coupling), computed off the new temperature — distribution is
  preserved (the `1/radius` term concentrates heat on rare close-in worlds, so
  the bulk stays star-driven and every existing universe test passes unmigrated).
- **Gas is exclusive (`["gas"]`).** `biomePaletteFor(rng, temperature)` rolls a
  `GAS_GIANT_CHANCE = 0.12` gas-giant up front (palette `["gas"]`); otherwise
  `gas` is filtered out of the candidate pool entirely. No planet is "part gas".
- **Palette SIZE ← temperature extremity.** `tempExtremity(temp)` ∈ [0,1] (0 when
  within ±`PALETTE_COMFORT`=40°C of the comfort mid 15°C, →1 over
  `PALETTE_EXTREME_SCALE`=130°C beyond). Size = `round(PALETTE_MAX −
  (PALETTE_MAX−PALETTE_MIN)·extremity + jitter)`, clamped to `[1, PALETTE_MAX]`.
  Moderate worlds reach 4; extreme worlds collapse toward 1. **`PALETTE_MIN` was
  lowered 2 → 1** (gas giants and extreme worlds are single-biome) — the existing
  `>= PALETTE_MIN` assertions still hold against the constant.
- **Palette COMPOSITION ← temperature affinity.** Each biome has a
  `BIOME_TEMP_AFFINITY` (+1 hot: volcanic/desert, −1 cold: tundra, 0 neutral);
  selection weight = `BIOME_WEIGHTS[b] · exp(AFFINITY_STRENGTH·affinity·tNorm)`
  (`AFFINITY_STRENGTH = 2.5`, `tNorm = (temp−15)/100`). Hot worlds downweight
  cold biomes / upweight hot, and vice-versa — so hot planets carry far fewer
  tundra regions than cold ones.
- **No oceans (or jungle) on extreme worlds.** When `temp > BOILING_C` (100) or
  `temp < FREEZING_C` (0), `ocean` AND `jungle` (the liquid/life biomes) are
  excluded from the candidate pool. (`gas` always excluded — it's the giant gate.)
- **Per-region temperature + hazard** (`Region` gained `temperature` and
  `hazard`): `region.temperature = clampRegionTemp(round1(planet.temperature +
  biomeTempOffset(biome)), planet.temperature)`; `region.hazard =
  clamp01(planet.hazard + biomeHazardOffset(biome))`. **`clampRegionTemp` keeps a
  region on the SAME side of 0/100 as its planet** (boiling planet → regions
  `> 100` via a `BAND_MARGIN`=0.1 push that survives 1-decimal rounding; freezing
  → `< 0`; moderate → `[0,100]`), so region variation can NEVER flip the
  planet-level landing category — the **landing gate stays planet-level**.
  Exported **`biomeTempOffset(biome)` / `biomeHazardOffset(biome)`** (from
  `@/lib/universe`) order extreme biomes above calm: volcanic↑ & tundra↓ temp;
  volcanic/irradiated/toxic ≥ 0 hazard; barren/gas neutral.
- **Deposits use the REGION's hazard** now (`depositsFor(rng, region.hazard,
  biome)` in `regionAt`) — the savage→rare rarity coupling bites per-region, so a
  volcanic region carries rarer ore than a calm one alongside it (biome rolled
  before temp/hazard/deposits so all three are deterministic per region coord).
- **Disembarked damage uses region hazard.** `mine`/`explore`/`disembark` in
  `commands.ts` roll `rollHazardDamage(region.hazard, …)` (was `planet.hazard`),
  and `scan` (`renderScan`) shows a `region temp / region hazard` line alongside
  the planet's mean — so "volcanic regions are more dangerous" actually bites.
- **Seeded contract**: `src/lib/universe/biome-consistency.test.ts` (gas
  exclusivity, temp monotone in star+radius, cold-biome-vs-temp, palette-size-vs-
  extremity, no-ocean-on-extreme, region band + offset ordering). The existing
  universe suites (universe-gen, planet-regions, biome-minerals, addressing)
  needed NO migration — the new distributions preserved their thresholds.

### Load-bearing decisions from `settlements`

- **The universe now has two kinds of inhabited place (P11): SETTLEMENTS on the
  surface and ORBITAL OUTPOSTS in orbit.** All gen is PURE & deterministic in
  `src/lib/universe/gen.ts` (exported via `index.ts`) — NO migration, NO schema
  change. Trade at these places is **P12**; this phase is generation + region-list
  display + navigation only (no buy/sell changes).
- **`HABITABLE_BIOMES`** (exported, `["ocean", "jungle", "desert"]`): the liveable
  biomes a settlement can sit in. Deliberately EXCLUDES the harsh biomes
  (`volcanic`/`toxic`/`irradiated`/`gas`) and lifeless `barren`.
- **`hasSettlement(seed, region: RegionCoord): boolean`** — true ONLY when all
  hold: (a) the PLANET is temperate (`planet.temperature` strictly inside
  `FREEZING_C`(0)…`BOILING_C`(100) — gen keeps its own local copies of those
  band lines, mirroring `rules.ts`), (b) the REGION's biome ∈ `HABITABLE_BIOMES`,
  and (c) a roll `rng() < systemDensity × planetDensity` passes. The two density
  factors (`systemSettlementDensity` / `planetSettlementDensity`) are independent
  HIGH-variance uniforms in [0,1] keyed by the system / planet coord, so
  settlement frequency varies heavily across BOTH tiers (some systems/planets
  bustling, others empty). The settlement RNG stream (`"settlement"`) is DISTINCT
  from `regionAt`'s, so reading the flag never perturbs region generation.
- **`systemOutpostPlanets(seed, system: SystemCoord): number[]`** — the planet
  indices in a system that host an orbital outpost: **~2 per system** (`randInt(1,3)`
  capped at the system's planet count), distinct, sorted, picked by a partial
  Fisher–Yates over the planet indices. Mean ≈ 1.85 across the sampled grid (the
  cap on tiny systems pulls it just under 2). **`hasOutpost(seed, planet:
  PlanetCoord): boolean`** = membership. Outposts are ORBITAL — no biome /
  deposits / `regionAt` row; gen only decides WHICH planet indices have one.
- **Outpost = the `region = -1` sentinel** on `players.region` (a plain int —
  NO migration). Surface regions are `0 .. regionCount-1`; `-1` means "docked at
  the orbital outpost". The game layer (`commands.ts`) centralizes this:
  `OUTPOST_REGION = -1`, `atOutpost(player)`, and `outpostSurfaceError()`. **Every
  place that derives a surface region from `player.region` guards `-1`** so there
  is NEVER a `regionAt(-1)` / phantom region: `minableHere` + the `withdraw`
  arg-domain return `[]`; `baseHere` returns null; `handleScan` branches to
  `outpostScanFrame`; `mine`/`explore`/`harvest`/`disembark`/`build`/`collect`/
  `storage` early-return the outpost error. (The disembarked base actions are
  also gated by the P10 applicability model, since you stay embarked at the
  outpost — `disembark` is refused there — but the explicit guards keep gen
  bulletproof regardless of embark state.)
- **Navigation**: `jump O` (or `o`) docks at the outpost (sets `region = -1`),
  allowed ONLY when `hasOutpost` (else a clear error); `jump <n>` (n ≥ 0) is the
  unchanged surface path (validates `0 ≤ n < regionCount`). `jump`'s numeric arg
  stays OPAQUE — the handler resolves the `O` literal itself (no new verb; help
  parity + applicability unchanged, `jump` is still `ANYTIME_OUT_OF_COMBAT`).
  `warp`/`land`/`hyperwarp` reset `region` to 0 on arrival as before, so you never
  arrive stranded at `-1`.
- **Display** (`render.ts`): the `regions` list marks settlement regions with a
  `⌂` tag + "— settlement" note in the `success` style (`RegionListEntry.settlement`)
  and shows a separate **`O` → `jump O`** entry at the top of page 1 when the
  planet `hasOutpost` (`RegionsView.hasOutpost`/`atOutpost`). `scan` at a
  settlement region adds "⌂ There is a settlement here." (`ScanView.settlement`);
  `scan` at the outpost (`outpostScanFrame`) describes the orbital station (a
  trade hub, no biome/deposits) and offers `regions`/`jump <n>` back to the
  surface.
- **For P12**: gate buy/sell to being at a settlement region OR the outpost, and
  make markets per-system. The hooks are `hasSettlement(seed, region.coord)` and
  `atOutpost(player)` (both already computed in the scan path).
- **Seeded contract**: `src/lib/universe/settlements.test.ts` (temperate+habitable
  gating, per-system/per-planet frequency variance, ~2 outposts/system,
  determinism). Existing suites needed NO change — `region = -1` is a new value
  on an existing plain-int column.

### Load-bearing decisions from `planet-taxonomy`

- **Planets now have a PHYSICAL SIZE, grounded in Kopparapu (2018, ApJ 856), and
  the rocky/gas split + temperature both follow from it.** This SUPERSEDES
  `biome-consistency`'s temperature source (star brightness + orbital closeness)
  AND its gas-as-a-random-biome-roll. All gen stays PURE & deterministic in
  `src/lib/universe/gen.ts` (planet RNG stream; no `Date`/`Math.random`).
- **`Planet` gained `radius` (R⊕), `sizeClass`, `isGas`** (`types.ts`; exported
  `SIZE_CLASSES`/`SizeClass`/`SIZE_CLASS_LABELS`/`GAS_RADIUS_THRESHOLD = 1.75`).
  `sampleSize(rng)` picks a size class weighted by the paper's occurrence `share`,
  then a radius LOG-uniform within the class's `[rLo,rHi]` band: Rocky 0.5–1,
  Super-Earth 1–1.75, Sub-Neptune 1.75–3.5, Sub-Jovian 3.5–6, Jovian 6–14.3.
  **`isGas = radius >= 1.75`** ⇒ population ≈ **49% rocky / 51% gas**.
- **Temperature is derived from RADIUS (orbital-distance physics DROPPED).** Each
  size class carries a normalized cold/warm/hot zone mix (Table 3); a planet's mix
  is interpolated smoothly by `log10(radius)` between per-class anchors (the band
  geometric means), and a uniform draw `u` is mapped through an inverse-CDF with
  breakpoints at **0°C and 100°C** (`u<c → [TEMP_MIN,0)`, `[c,c+w) → [0,100)`,
  else `(100,TEMP_MAX]`), linear within each segment — so realized zone
  proportions match the mix exactly while temperature stays smooth + bounded to
  **`[TEMP_MIN(-160), TEMP_MAX(520)]`** (both exported from `@/lib/universe`).
  Overall ≈ cold 77 / warm 8 / hot 15; gas giants skew much colder than rocky.
  Hazard still couples to temperature extremity (`hazardFor`), now off the new
  temperature. `orbitalRadius`/period/phase are KEPT (interplanetary `land` fuel,
  P2) but no longer drive temperature, so a system's temps are not a distance
  gradient. (Planets ARE re-sorted by orbital radius so index = distance — see
  `planet-distance-order` below, which superseded this phase's generation-order
  indexing.)
- **Gas giants are ORBIT-ONLY: no surface.** `biomePalette` is exactly `["gas"]`,
  `regionCount` is **0**, and **`regionAt` THROWS on a gas planet** (a loud guard;
  callers branch on `planet.isGas` first). `biomePaletteFor` is now rocky-only and
  never yields `gas`. `hasSettlement` returns false for gas (no surface
  settlement) — but `hasOutpost`/`systemOutpostPlanets` are unchanged, so a gas
  giant MAY still host an ORBITAL outpost. Rocky worlds keep the full
  biome-consistency palette + planet-regions deposits, now off the new temperature.
- **Gameplay (commands.ts): every surface path guards `planet.isGas`.**
  `disembark`/`mine`/`explore`/`harvest`/`build`/`land <n>`/`jump <n>` are rejected
  with `gasGiantError` ("X is a gas giant — no surface to land on…"); `scan` of a
  gas giant uses `gasGiantScanFrame` (size class, radius, temp, atmosphere, no
  deposits) and `warp`/`hyperwarp` arrival use the gas-aware `planetScanFrame`
  (arrive in orbit at a gas planet 0, region nominally 0 — never passed to
  `regionAt`). `jump O` to a gas giant's orbital outpost still works. The
  regionAt-calling helpers (`minableHere`, `baseHere`, the `withdraw` arg domain)
  also short-circuit on gas. `scan`/`map`/`inventory` surface the planet's size
  class + radius (gas siblings in the `land` list read RED via the P9b
  `disabled`-action convention).
- **Safe starting world (`startingWorld(seed)`, pure):** scans systems outward
  from the origin (galaxy 0 · arm 0 · cluster 0 · system 0,1,2…) for the FIRST
  rocky, moderate-temperature (`0 < T < 100`), low-hazard planet, returning its
  `PlanetCoord`. Shared by BOTH new-player spawn (`getOrCreatePlayer` now sets the
  spawn location explicitly instead of the old hardcoded `(0,0,0,0,0,0)`, which
  could be a gas giant) AND the reset migration.
- **Migration `20260609000000_planet-taxonomy.sql` is a PRAGMATIC RESET**
  (forward-only, runs once): the universe was fundamentally reshaped (new sizes,
  ~half non-landable, planet/region identity changed), so it WIPES planet/region-
  scoped state (`world_deltas`, `discoveries`, `bases` + cascading
  `base_buildings`/`base_storage`) and RELOCATES every player to the safe starting
  world, fully healed + aboard + encounter cleared. **KEEPS** wallet (credits/fuel/
  warp_fuel), cargo (`inventory`/`player_materials`/`player_parts`/
  `player_upgrades`), `handle`, and per-system `markets`/`system_supply` (systems
  are unchanged in identity). SQL can't run the TS generator, so the relocate
  coordinate is `startingWorld("omniplex-prod-1")` baked in (the production seed,
  matching the test SEED); new players are seed-correct at runtime. Re-point the
  baked coord if a deployment runs a different `WORLD_SEED`. (After
  `planet-distance-order` re-sorted planets, this baked coord is `(0,0,0,1,3,0)` —
  the starting world's planet moved to sorted index 3.)

### Load-bearing decisions from `planet-distance-order`

- **Planets within a system are ordered by orbital distance — index 0 = innermost
  (closest), highest index = outermost.** This REVERSED `planet-taxonomy`'s
  generation-order indexing (the prior "planets are NOT re-sorted" note is void).
  The reorder is the same set of planets relabeled by distance — sizes, temps,
  biomes, deposits all unchanged, only the `planet` index changes.
- **`systemAt` sorts after generation**: it generates the `planetCount` planets
  (each from its generation-index RNG stream, as before), then **sorts ascending
  by `orbitalRadius` with a STABLE tiebreak on the original generation index** (so
  ties are reproducible), then reassigns each planet's `coord.planet` to its
  sorted position ⇒ `planets[i].coord.planet === i`. A planet's ATTRIBUTES still
  come from its generation stream (orbitalRadius must exist before we can sort by
  it); only its public index changes. `regionAt` keys regions by the planet coord,
  i.e. the stable sorted index — consistent because the sort is deterministic.
- **`planetAt` no longer O(1)**: it now DELEGATES to
  `systemAt(seed, systemOf(coord)).planets[coord.planet]` (regenerate the system —
  ≤ `MAX_PLANETS` planets — sort, index), so it agrees exactly with the system's
  list. It **THROWS on an out-of-range planet index** (no longer total over the
  integers); all navigation callers (`warp`/`land`/`scan`/`map`) already validate
  `planet < planetCount`, so in-range is guaranteed in normal play.
- **`startingWorld` + the reset migration follow the sort**: `startingWorld` scans
  the now-sorted `systemAt(...).planets`, so the production seed's starting world
  is `(0,0,0,1,3,0)` (planet at sorted index 3). The `planet-taxonomy` reset
  migration's baked relocation coord was updated to match (editing that
  unapplied-everywhere migration was an explicit auditor decision, not landed-
  history rewriting). `map`/`scan`/the `land` sibling list now read innermost→
  outermost naturally.

### Load-bearing decisions from `star-coordinates`

- **A cluster is now a FINITE 3D CLOUD of exactly `STARS_PER_CLUSTER = 1024`
  stars**, each with a real floating-point `(x, y, z)` position — no longer an
  open-ended ribbon addressed by a linear `system` index. The `system` index is
  canonical in `[0, STARS_PER_CLUSTER)` and simply indexes into the cloud; the
  `cluster` index itself stays unbounded (`cluster >= 0`). Existing stored
  `system` identities (DB column, `markets`/`system_supply` location keys) are
  UNAFFECTED — clusters just became finite. All gen stays PURE & deterministic in
  `src/lib/universe/gen.ts`; NO migration, NO schema change.
- **`StarPosition { x, y, z }` + `ClusterCoord { galaxy, arm, cluster }`** (new
  types in `types.ts`, exported from `index.ts`). `StarSystem` gained a required
  **`position: StarPosition`** field (`systemAt` fills it from
  `systemPosition(seed, coord)`).
- **`clusterStars(seed, cluster) -> StarPosition[]`** is the cloud generator: its
  own RNG stream (`makeRng(seed, "cluster-stars", galaxy, arm, cluster)`), each
  star's three components isotropic-Gaussian (Box-Muller over two PRNG uniforms,
  NO `Math.random`; sigma = `STAR_CLUSTER_SIGMA = 10`), **rounded to 2 dp**,
  TRUNCATED to a finite sphere of radius `STAR_CLUSTER_MAX_RADIUS = 40` (~4 sigma).
  A single deterministic **reject-and-resample** loop covers BOTH out-of-sphere
  AND duplicate rounded positions, so every returned position is distinct AND
  in-sphere, reproducible byte-for-byte. `systemPosition(seed, coord)` indexes the
  cloud (THROWS on `system` outside `[0, 1024)`); `systemFromPosition(seed,
  cluster, pos)` is the inverse — rounds the query to 2 dp and returns the EXACT-
  match star index or `null` (positions are unique, so unambiguous). `clusterOf`
  drops `system` from a `SystemCoord`.
- **`warpDistance` is SEED-FIRST: `warpDistance(seed, a, b, armCount)`**
  (BREAKING — all three callers in `commands.ts` updated). The SYSTEM term is
  GEOMETRIC when `a`/`b` share galaxy AND arm AND cluster — the EUCLIDEAN distance
  between star positions × `SYSTEM_SPAN` (hence the seed); across different
  clusters/arms the system term is **0** (positions are not comparable; the
  cluster/arm terms fully capture the gap). `CLUSTER_SPAN = ARM_SPAN =
  10·STAR_CLUSTER_SIGMA = 100` (cluster spacing 10σ > cluster diameter 8σ → no
  spatial overlap; arm ≈ cluster cost for now, to be revisited); `SYSTEM_SPAN =
  1`. Still 0-to-self, symmetric, positive between distinct same-galaxy coords;
  different galaxies → `Infinity`. PURE (positions derived from seed).
- **`warp <arm> <cluster> <system|x,y,z>`** — the third arg is EITHER a star index
  (0–1023) OR an `x,y,z` coordinate triple (a comma marks the coordinate form;
  `jump`-style opaque arg, resolved handler-side). `resolveWarpCoord` parses three
  finite floats, rounds to 2 dp, and looks up the EXACT star via
  `systemFromPosition`; NO fuzzy/nearest warp — a miss errors and NAMES the
  nearest star's coords + index so the player can re-aim. `usage.ts` `warp`
  system-slot hint updated.
- **`map` lists the nearest `MAP_NEAR_STARS = 10` in-cluster stars by real
  Euclidean distance** (primary listing, each with its `(x,y,z)` so you can warp
  by coordinate), PLUS the cross-cluster/cross-arm neighbors one tier out
  (`neighborCandidates` simplified to walk arm +/-1 / cluster +/-1 holding the
  `system` index — same-cluster is now the star list's job). `scan`/`map`/the
  outpost & gas-giant scan frames show the current star's `(x,y,z)` position
  (`ScanView.position`/`MapNeighbor.position`/`MapLocation.position`, all optional;
  `starPositionLabel` formats it). P9b red-marking + affordability unchanged.
- **Seeded contract**: `src/lib/universe/star-coordinates.test.ts` (12 tests:
  round-trip, Euclidean distance, finiteness, determinism). The
  `addressing.test.ts`/`universe-gen.test.ts` `warpDistance` cases were updated to
  the seed-first signature and STRENGTHENED (symmetry via `toBeCloseTo`, geometric
  system term asserted positive), not weakened.

### Load-bearing decisions from `cluster-span-retune`

- **The warp-distance hierarchy is coherent: a cluster hop = a 10σ
  intra-cluster traversal, and clusters never overlap.** `CLUSTER_SPAN =
  ARM_SPAN = 10 · STAR_CLUSTER_SIGMA = 100` (was `CLUSTER_SPAN = 10`,
  `ARM_SPAN = 100`); `SYSTEM_SPAN = 1` (the Euclidean-position multiplier).
  Arm hop == cluster hop **for now** (a deliberate placeholder — to be
  revisited). Since the star cloud's max diameter is `2·STAR_CLUSTER_MAX_RADIUS`
  = 8σ (80) and a cluster step is 10σ (100), cluster spacing exceeds the
  cluster diameter ⇒ no spatial overlap. Locked in `addressing.test.ts`:
  `CLUSTER_SPAN === 10·STAR_CLUSTER_SIGMA` and `CLUSTER_SPAN > 2·STAR_CLUSTER_MAX_RADIUS`.
- **The cross-cluster `|Δsystem|` term was DROPPED.** `warpDistance`'s system
  term is the Euclidean position distance × `SYSTEM_SPAN` ONLY when a and b are
  in the same galaxy+arm+cluster; **0 otherwise**. (System indices are just
  labels for Gaussian positions — they have no cross-cluster spatial meaning,
  and the old fallback let a cluster jump's cost depend on the destination's
  arbitrary index, up to ~1000.) So a cluster hop costs a flat `CLUSTER_SPAN`
  regardless of source/destination system index.
- **Known follow-up**: cluster hops became ~10× more expensive in warp fuel
  (cluster distance 10→100), so warp-fuel supply/pricing may want a tuning pass
  — parked with the arm-cost conversation.

### Load-bearing decisions from `random-spawn`

- **New players now spawn on a RANDOM habitable world in cluster 0**, not the
  single deterministic `startingWorld`. `randomStartingWorld(seed, rand)`
  (`gen.ts`, exported) picks a random rocky + temperate (0<T<100) + low-hazard
  planet in galaxy 0 · arm 0 · cluster 0 via bounded random retry (falls back to
  `startingWorld(seed)` if the budget is exhausted). `rand` is INJECTED (gen
  stays pure/no-`Math.random`); `getOrCreatePlayer` passes `Math.random` at the
  impure boundary, only on the INSERT path (existing players keep their
  location). `startingWorld(seed)` is UNCHANGED — the reset migration's
  deterministic relocation still uses it. Seeded: `random-spawn.test.ts`.

### Load-bearing decisions from `galactic-structure` (cascade Phase 0)

- **The galaxy is now a polar (r, θ) disk** (see `docs/design/generation-cascade.md`
  tier 1): `arm` = angle, `cluster` = radius. NO migration (coords unchanged;
  everything derived/validation). SUBSUMES `cluster-span-retune` (the spans
  became the radial scale).
- **Polar helpers** (`gen.ts`): `armAngle(arm, armCount) = arm·2π/armCount`;
  `clusterRadius(cluster) = (cluster + CLUSTER_R0) · CLUSTER_RING_SPAN`
  (`CLUSTER_RING_SPAN > 2·STAR_CLUSTER_MAX_RADIUS` so rings don't overlap);
  `clusterCenter(arm, cluster, armCount) = (r·cosθ, r·sinθ)`.
- **`warpDistance(seed, a, b, armCount)` reworked to planar polar geometry**:
  cross-galaxy → `Infinity`; same cluster → intra-cluster star Euclidean ×
  `SYSTEM_SPAN` (the `star-coordinates` term, preserved); different cluster →
  `|clusterCenter(a) − clusterCenter(b)|` (law of cosines). Replaced the
  `armRing·ARM_SPAN + |Δcluster|·CLUSTER_SPAN + system` sum (those flat spans are
  gone). 0-to-self, symmetric, `Infinity` across galaxies — and the **emergent
  arms-converge-at-the-core** property (fixed Δarm costs far less near the core
  than the rim: ~200 vs ~6400 at cl1 vs cl63). `addressing.test.ts` migrated +
  strengthened to the polar contract.
- **Finite galaxy disk**: `MAX_CLUSTERS_PER_ARM` (= 64) caps the radius;
  `handleWarp` rejects clusters `<0` or `≥ MAX` ("beyond the rim"); `map` only
  offers in-range neighbors. Infinite-universe property lives at the (unbounded)
  galaxy tier.
- **`galacticRadiation(cluster)`** ∈ [0, RADIATION_MAX], max at the core
  (cluster 0), monotonically decaying to ~0 at the rim — **value + `map` display
  only this phase** (band + radius + rim). NO hazard/gameplay coupling yet
  (deliberately deferred to **0b**: radiation→hazard floor + a radiation-shield
  upgrade gate). Seeded: `galactic-structure.test.ts`.

### Load-bearing decisions from `radiation-hazard` (cascade 0b)

- **Galactic radiation now has teeth: coreward = lethal + rich, rim = calm +
  poor.** NO migration in this phase (but see the player-relocation follow-up).
  `radiationHazardFloor(radiation)` (`rules.ts`, pure, 0 → `RAD_HAZARD_FLOOR_MAX
  = 0.55`, monotonic); **planet hazard = `max(hazardFor(temp),
  radiationHazardFloor(galacticRadiation(cluster)))`** — the rim stays
  temperature-driven (floor ≈0), the core is floored high. Via the existing
  hazard→rarity (`rarityWeight`) + hazard→damage couplings, this makes coreward
  planets rarer-ore'd and more dangerous for free. Verified gradient: cluster 0
  mean hazard ~0.59 → cluster 63 ~0.36.
- **`radiation_shield` upgrade** (`upgrades.ts`): real parts recipe, `value >
  cost`, produced/traded via the existing UPGRADE machinery (no fork).
  `radiationShieldRequired(radiation)` = `radiation > RADIATION_SHIELD_THRESHOLD
  (60)`; landing/`disembark`/`mine`/`explore`/`salvage` on a high-rad surface
  require owning it, composed with the temperature gate via a shared
  `surfaceGateMissing`/`surfaceGateError` helper; `scan` surfaces it (P9b red).
- **Spawn moved to the RIM**: `SPAWN_CLUSTER = MAX_CLUSTERS_PER_ARM − 1`
  (`gen.ts`); `randomStartingWorld`/`startingWorld` scan the safe outer rim
  (cluster-0 core floor 0.55 > the low-hazard spawn bar + would need a shield =
  new-player softlock). New players start safe + poor at the rim and journey
  coreward for riches — an emergent progression. The universe-gen/biome/
  temp-hazard suites were re-sampled across the full cluster range (calm@rim /
  savage@core). Seeded: `radiation-hazard.test.ts`.

### Load-bearing decisions from `surface-grid` (cascade Phase A)

- **A planet's surface is now a lat/lon grid with climatic biome BANDS** (was a
  flat bag of independent palette draws). NO migration / NO reset — the region
  INDEX is preserved, just reinterpreted as a grid cell.
- **Bijection** (`gen.ts`, exported): `regionGrid(planet) → {rows, cols}`
  (`rows = round(sqrt(regionCount/2))`, `cols = 2·rows`, ~1:2 lat:lon; the
  planet's effective `regionCount` becomes `rows×cols`); `regionCoords(index,
  rows, cols) → {lat, lon}` (divmod) + `regionIndex(lat, lon, cols)` (inverse).
  Index canonical → `world_deltas`/`salvaged_sites`/`bases`/`players.region` keys
  unchanged. `lat` row 0 / `rows-1` = poles, middle = equator; `lon` wraps.
- **4 planetary params on `Planet`** (`types.ts`): `axialTilt`, `dayLength`,
  `eccentricity`, `rotationSpeed` — drawn **APPENDED LAST** in the planet RNG
  stream so every pre-existing planet field (radius/sizeClass/temperature/hazard/
  biomePalette/orbital*) stays byte-identical.
- **`regionAt` derives climatic temperature** from the planet mean (radius-
  derived, unchanged) + an **axial-tilt-scaled latitude gradient** (warm equator
  → cold poles) + **rotation-banded longitude** variation + day-length jitter +
  eccentricity shift, then **weights the palette-bound biome by it** → latitude
  bands (cold biomes poleward, warmer/varied at the equator). Biomes still ⊆ the
  planet palette (placement changed, not membership).
- **The `biome-consistency` per-region band-clamp (`clampRegionTemp`/BAND_MARGIN)
  was REMOVED** — latitude variation may push polar regions below freezing /
  equatorial above boiling even on a temperate planet (real climate range); the
  **landing gate stays PLANET-level** (`canLand` by planet mean temp), so no
  softlocks. `biome-consistency`'s rule-6 test migrated to the latitude-band
  invariant (gradient + cross-the-line, coverage preserved). Verified sampling:
  a cold planet shows poles ~-145°C (all tundra) → equator ~+5°C (varied).
  Seeded: `surface-grid.test.ts`. Phase B adds directional/polar nav + surface map.

### Load-bearing decisions from `surface-nav` (cascade Phase B — completes the planetary-surface plan)

- **Planet surfaces are now walkable** via directional movement over the Phase-A
  lat/lon grid. NO migration. `moveRegion(index, direction, rows, cols) → number
  | null` (`gen.ts`, pure): `north`=lat−1 / `south`=lat+1 **clamp at the poles**
  (return `null` off the top/bottom row); `east`/`west` **wrap longitude** mod
  cols (never null). Round-trips; deterministic.
- **`move <direction>` verb** (NEW): one verb + a resolvable direction arg
  (`["north","south","east","west"]`, so `move n` → north) — NOT bare `n/s/e/w`
  (those collide with `scan`/`sell`/`eat`/`warp`… in the abbrev system). FREE
  (like `jump`), re-renders the new region; gas-giant/outpost/orbit guards +
  ANYTIME_OUT_OF_COMBAT (rejected in combat / when not on a surface — "land
  first"). Pole moves error clearly; `jump <n>` (fast-travel by index) unchanged.
- **`map` is now context-aware**: on a surface (landed/on-foot rocky) it shows a
  **local surface map** — your `(lat,lon)`, a 3×3 biome neighborhood, clickable
  `move <dir>` (P9b red on pole-blocked dirs), `regions`/`jump`/`launch` hints;
  orbiting / at the outpost it shows the unchanged galactic/system nav map
  (reuses orbit-land's surface-vs-orbit state). `scan` shows the `(lat,lon)`.
  Seeded: `surface-nav.test.ts` (+ worker's `surface-map-render.test.ts`).
- **This COMPLETES the planetary-surface plan** (Phase 0 galactic → A surface
  grid + climatic biomes → B directional nav). Remaining cascade tiers: geology
  (caves/seams/resource signatures) + the creature genome / ecological web (the
  biology tier — which also activates the Science pillar's breeding) — and, per
  the pillars doc, the sapient-species + species-empire foundation.

### Load-bearing decisions from `geology` (cascade tier 4b)

- **Regions now have a geological FORMATION, and deposits correlate with it** — a
  learnable resource map (vents→metals, craters→rare/exotic, plains→sparse),
  layered on the Phase-A climate grid (biome = climate; formation = geology,
  independent). NO migration (region keys/index unchanged; formation derived).
- **Planet geology profile** on `Planet` (`gen.ts`, APPENDED last in the planet
  RNG stream so all pre-existing fields incl. Phase-A params stay byte-identical):
  `volcanism`/`impactDensity`/`erosion`/`tectonics` ∈ [0,1], **cascade-coupled**
  — `volcanism` rises with `eccentricity` (tidal), `erosion` with `rotationSpeed`
  (wind), impacts a draw.
- **`RegionFormation`** (`types.ts` enum: `volcanic_vent`/`impact_crater`/
  `sedimentary_basin`/`cave_system`/`tectonic_ridge`/`plains`) on `Region`,
  chosen per lat/lon cell on a **distinct RNG sub-stream** that leaves the
  Phase-A climate/biome draw byte-identical; its distribution **tracks the planet
  profile** (high-volcanism ⇒ more vents, high-impact ⇒ more craters).
- **`depositsFor` is formation-aware** — formation sets the resource SIGNATURE
  (which minerals + abundance), layered OVER the preserved `biome-minerals`
  pool gate (biome-specific ore only in its biome) + `rarityWeight` hazard→rarity.
  Verified: vent regions metal-rich (~1.1 avg metal abundance) vs plains sparse
  (~0.14), craters rare-rich. `scan` shows the formation + resource tendency.
  Seeded: `geology.test.ts`. **Tier 5 (creature genome + ecological web) is the
  last cascade tier**; sapient-species + shared-presence foundations are parallel.

### Load-bearing decisions from `creature-genome` (cascade tier 5a — generation only)

- **Procedural species genome + ecological web** — the "alive" layer, GENERATION
  ONLY (additive; no gameplay rewired, no migration). `src/lib/universe/genome.ts`:
  **38 role-tagged archetypes** (producer/herbivore/carnivore/…) × **7 trait
  dimensions** (≥4 options each: size/locomotion/defense/diet/temperament/
  environment-adaptation/…) → tens of thousands of distinct `Species`
  (`{archetype, traits, trophicRole}` — the archetype+traits are the "facts" the
  future Nimbus blurb writer consumes).
- **`regionFlora(seed, region)` / `regionFauna(seed, region)`** (exported, pure,
  deterministic) on **distinct `genome-flora`/`genome-fauna` RNG streams** that
  leave `regionAt` byte-identical. **Environment-filtered** (cold/hot/irradiated/
  desert adaptation + biome/formation weighting) and generated in **trophic
  order** — flora (producers fitting biome/temp/hazard/radiation/geology) → prey
  (herbivores keyed to flora present) → predators (carnivores keyed to prey) — so
  every region's fauna is a **closed food web** (no orphan levels, by
  construction). Verified: pole vs equator yield distinct adapted ecologies;
  ~100% distinct species across a sample.
- **`speciesDrop(species) → {materialId, qty}`** maps each species to a real
  bounded `MATERIALS` id by trait — encounter VARIETY explodes, the economy
  stays bounded. Seeded: `creature-genome.test.ts`.
- **5a is additive**: `explore`/`harvest`/`attack`/`ranch` still use the fixed
  `wildlife.ts` catalogs. **5b** swaps gameplay onto the genome (encounter state,
  drops, codex); Science breeding + the blurb writer build on these pure functions.

### Load-bearing decisions from `genome-wildlife` (cascade tier 5b — COMPLETES the genome + the cascade)

- **Wild flora/fauna gameplay is now genome-driven.** `explore`/`harvest`/
  `attack`/`flee` draw from `regionFlora`/`regionFauna`/`speciesDrop` (5a) instead
  of fixed catalogs — different, environment-fit, food-web creatures region to
  region. **The fixed `FLORA`/`FAUNA` + `src/lib/game/wildlife.ts` are REMOVED**
  (no dangling imports); **`FARM_ANIMALS` (ranch) kept** curated (a future phase
  may ranch genome species). NO migration.
- **`speciesCombatStats(species) → {maxHp, attack, hostile}`** (pure, `rules.ts`):
  size/role/defense → hp/attack, temperament → hostile (placid still attackable);
  reuses the existing `combatRound`/`runDeath`/hazard machinery. Verified:
  grazers ~22hp/5atk, predators ~52hp/20atk-hostile.
- **`players.encounter` jsonb reshaped to `{species, hp}`** (the generated
  `Species` blob + hp; no migration — jsonb; defensive stale-row handling).
  Creatures shown by a **descriptive `speciesLabel`** (archetype + key traits,
  e.g. "a large armored grazer") — placeholder until the Nimbus blurb writer.
  Drops bounded to real `MATERIALS` (5a's `speciesDrop`). Old wildlife/
  wildlife-catalog tests migrated to the genome, coverage preserved. Seeded:
  `genome-wildlife.test.ts`.
- **The generation cascade is now COMPLETE**: galaxy (polar + radiation) →
  planetary (taxonomy + params) → surface (climate biomes + nav) → geology
  (formations + resource signatures) → biology (genome + ecological web, lived
  via explore/harvest/attack). Next foundations (per `pillars.md`): sapient
  species + species-empires, then shared presence; codex + breeding (Science) +
  the blurb writer build on the genome.

### Load-bearing decisions from `creature-blurbs` (deterministic blurb assembly)

- **Procedural creatures now get Omniplex-voice blurbs assembled DETERMINISTICALLY
  at runtime from a STATIC, pre-written component library — ZERO model/API calls.**
  The library is authored OFFLINE by the Nimbus `compose-batch` tool (committed as
  `src/lib/game/blurbs/creature-library.json`); this module is the runtime
  assembler. NO migration (pure code + a committed JSON).
- **`src/lib/game/blurbs/index.ts`** (pure): `assembleBlurb(library, species,
  biome, seedParts) → string | null` (takes the library as an ARG — pure, testable;
  `makeRng` variant pick, no `Date`/`Math.random`). Grammar: `[biome opener, ]` +
  archetype SPINE clause + up to `MAX_TRAIT_CLAUSES`(2) trait clauses (fixed
  `TRAIT_PRIORITY`, "none"-values skipped), comma-joined with a final "and",
  capitalized, period-terminated. **`blurbOf(species, biome, ...seedParts)`** =
  `assembleBlurb(LIBRARY, …) ?? speciesLabel(species)` (imports the committed
  library).
- **Component-key scheme (FIXED — the library is keyed by it; `compose-batch`
  authors to it)**: `archetype.<archetypeId>#<n>` (the SPINE — missing ⇒ blurb is
  `null` ⇒ fallback), `trait.<dimensionId>.<value>#<n>`, `biome.<biome>#<n>`; **3
  variants** each (`#1`/`#2`/`#3`); fragments lowercase, no trailing punctuation.
- **Partial-library tolerance is LOAD-BEARING** (the library fills asynchronously):
  `pickFragment` chooses ONLY among variants that actually exist in the library, so
  a missing key/variant never leaks `#n`/`undefined`; a missing biome opener or
  trait clause is omitted; only a missing archetype spine yields `null` (→
  `speciesLabel`). Ships + works against an EMPTY/partial library, lighting up as
  it fills. The full 255-fragment library is dropped in by a separate lightweight
  once the offline `compose-batch` run completes.
- **Wiring**: `blurbOf(species, regionBiome, <stable per-occurrence seed parts>)`
  replaces the bare `speciesLabel` at the genome-wildlife encounter sites
  (explore/attack) in `commands.ts`; `speciesLabel` retained as the fallback +
  terse form. Deterministic per occurrence.
- **REUSE**: this assembler pattern (static library + grammar + seeded variant
  pick + `speciesLabel`-style fallback) is the template for future blurb targets —
  exploration sites, sapient species, planets — each a new key namespace authored
  by `compose-batch`, never a runtime API call. See Nimbus `COMPOSE.md`
  §"Batching a component LIBRARY".
