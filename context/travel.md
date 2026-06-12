# Travel & Fuel

Load-bearing decisions extracted from `CLAUDE.md`, in build order.

### Load-bearing decisions from `fuel-orbital`

- **There are now TWO fuels (P2), with two cost models.** The existing `fuel`
  column/`Player.fuel` **is regular fuel**; a new `warp_fuel` column /
  `Player.warpFuel` is the second pool (migration
  `20260608130000_fuel-orbital.sql`, forward-only/idempotent `add column if not
  exists`, `default 100 check (warp_fuel >= 0)`; carried on `PlayerRow`/`Player`
  + `rowToPlayer`). RLS/leaderboard untouched (neither fuel is exposed there).
  - **WARP fuel** powers `warp` (system-and-larger jumps). Cost =
    `warpFuelCost(warpDistance(...))`, which scales **only with distance** (the
    old `fuelCost` renamed; identical `ceil(distance · WARP_FUEL_PER_DISTANCE)`
    contract — 0 at 0, non-decreasing, positive integer).
  - **REGULAR fuel** powers `land` (planet-to-planet WITHIN a system). Cost =
    `regularFuelCost(fromPlanet, toPlanet, Date.now())` = **takeoff +
    interplanetary**, the two ADDITIVE: `takeoffCost(atm, gravity)` =
    `(TAKEOFF_BASE + TAKEOFF_ATM_COEF · atmosphereDensity(atm)) · gravity`
    (additive in atmosphere density, multiplicative/linear in gravity) PLUS
    `INTERPLANETARY_FUEL_PER_DISTANCE · interplanetaryDistance(...)`, `ceil`'d to
    a positive integer. Region `jump` stays **free** (no interplanetary move).
- **Planets now have real, time-varying orbits.** `Planet` gained
  `orbitalRadius` (AU-ish, `[0.3, 40]`), `orbitalPeriod` (REAL-time ms,
  `[~6h, ~30d]`), `orbitalPhase` (`[0, 2π)`), all drawn deterministically in
  `generatePlanet` — appended **last** in the RNG stream so every pre-existing
  planet field stayed byte-identical. Position is the PURE
  `planetPosition(orbit, timeMs)` (circle: `angle = phase + 2π·timeMs/period`);
  `interplanetaryDistance(a, b, timeMs)` is the Euclidean separation (≥0,
  symmetric, **varies with time** as the two planets sweep at different rates).
  Gen NEVER touches `Date`; `timeMs` is a parameter (handlers pass `Date.now()`),
  so all of `rules.ts` stays pure & deterministic (seeded contract:
  `fuel-orbital.test.ts`).
- **Prices:** `REGULAR_FUEL_PRICE_PER_UNIT` (3, renamed from
  `FUEL_PRICE_PER_UNIT`) and `WARP_FUEL_PRICE_PER_UNIT` (9, **> regular** — warp
  fuel is the premium long-haul stuff). **`buy fuel [n]`** refills regular,
  **`buy warpfuel [n]`** refills warp; both embarked-only, share
  `handleBuyFuel(kind)`. `buy`'s arg domain is now
  `["fuel", "warpfuel", ...resources, ...upgrades]`; `tradeCategoryOf("warpfuel")
  = "fuel"` (so `help buy` groups it with fuel; pricing branches on the id).
- **World adapters:** `setWarpFuelAndLocation` (warp — warp_fuel + location,
  region→0; regular fuel untouched), `setFuelAndPlanet` (land — regular fuel +
  planet, region→0; warp fuel untouched), `setWarpFuel` (buy warpfuel), `setFuel`
  (buy fuel, unchanged). The old `setFuelAndLocation`/`setPlanet` were replaced
  by these fuel-aware mutators.
- **UI** shows BOTH fuels (`scan` fuel readout + per-sibling `land` fuel cost;
  `map` warp options show warp-fuel cost; `inventory` + boot banner). Affordability
  red reuses P9b's `disabled`-action convention: `map` warp tokens red when
  `warpFuelCost > warpFuel`; `scan` `land` siblings red when on foot OR
  `regularFuelCost > fuel` (`ScanView.siblingLand` carries the per-sibling cost +
  affordability the handler computed).
- **For P3 (galaxy jump):** consumes Hyperwarp Condensate and may also draw warp
  fuel; cross-galaxy `warpDistance` is `Infinity` so such warps are simply not
  offered until P3 adds the condensate path.

### Load-bearing decisions from `galaxy-jump`

- **P3 closes the exploration track: `hyperwarp <galaxy>` is the ONLY command
  that changes `players.galaxy`.** Normal `warp` stays within-galaxy (cross-galaxy
  `warpDistance` is `Infinity`, so `map`/`warp` never offer it). Embarked-only
  (joined `EMBARKED_ONLY` alongside `warp`/`land`/`buy`/`sell`). **NO migration** —
  the `galaxy` column exists (P1) and the condensate lives in `player_materials`
  (no new table, no DB seed; material ids are free-text/code catalog).
- **Hyperwarp Condensate is a CONSUMABLE material** — a new
  `MaterialCategory: "consumable"` (`materials.ts`), id `hyperwarp_condensate`,
  stored in `player_materials` like food. It is **manual-`craft`** (the
  consumables — food, condensate — are manual-craft; parts/upgrades are
  production-line `produce`). **Excluded from `SCAVENGEABLE`** (alongside
  `animal`/`food`): crafted, never found/dropped. Sellable (value 6000, above its
  raw voidstone cost) but the point is the jump.
- **Recipe is voidstone, a mined RESOURCE in CARGO** — not a material. Pure rules
  live in `src/lib/game/galaxy-jump.ts`: `CONDENSATE_RECIPE = { voidstone: 10 }`
  (tunable, "significant"; voidstone is rarity-5 savage-world-only, gating galaxy
  travel behind deep exploration), `HYPERWARP_CONDENSATE_ID`, and
  `canHyperwarp(condensateOwned, fromGalaxy, toGalaxy)` →
  `{ok:true} | {ok:false, reason:"no-condensate"|"same-galaxy"}` (condensate check
  FIRST — the more actionable message). Module is PURE (no IO/`Date`/`Math.random`).
  Seeded contract: `galaxy-jump.test.ts`.
- **`craft hyperwarp_condensate`** (`handleCraftCondensate`): `craft`'s arg is
  opaque, so `handleCraft` resolves the prefix itself against
  `[...FOOD_IDS, HYPERWARP_CONDENSATE_ID]` (foods + condensate abbreviate
  handler-side; `craft hyp` works). Unlike cooking (consumes `player_materials`),
  this validates `canCraft(cargo, CONDENSATE_RECIPE)` against the CARGO hold, then
  `removeInventory(voidstone)` + `addPlayerMaterial(condensate, +1)`. Ungated by
  embark (like all crafting). Shortfall → clear error, nothing consumed.
- **`hyperwarp <galaxy>`** (`handleHyperwarp`, opaque numeric arg): validates
  `target ≥ 0`, reads the LIVE condensate count, gates via `canHyperwarp` BEFORE
  mutating. On success: `addPlayerMaterial(condensate, -1)` then the new
  `world.setGalaxyLocation(id, {galaxy, arm, cluster:0, system:0, planet:0})`
  (region→0) — the **fixed entry point** is arm `0 % destGalaxy.armCount` (always
  0), cluster/system/planet/region 0. **NO fuel charge** — the condensate IS the
  cost. `setGalaxyLocation` is the ONLY `galaxy`-changing mutator (mirrors
  `setWarpFuelAndLocation` minus fuel). Reports arrival (new galaxy name + arm
  count from `galaxyAt`) and scans the entry region.
- **Surfacing** (P9b red-action convention): `map` gained a "Galaxy jump" section
  showing the condensate count and a `hyperwarp <galaxy+1>` action that reads RED
  (`disabled`) when the player holds none — clicking it still returns the helpful
  "craft one from voidstone" error. `MapLocation.condensate` carries the count
  (`handleMap` fetches `getPlayerMaterials`). Condensate count is also visible in
  `inventory` automatically (it's a material). `help`/abbrev/usage parity intact
  (`hyperwarp` in `VERBS`+`USAGE`, opaque `<galaxy>` slot).
- **This COMPLETES the exploration/survival/production mega-roadmap.**

### Load-bearing decisions from `orbit-land`

- **Travel is now a 3-state machine per planet, separating ORBITING from
  LANDED with two fuel models** (fixes gas giants being unreachable, and makes
  distance-vs-atmosphere fuel honest):
  - **Orbiting** (`embarked && !landed`) — aboard, above the planet.
  - **Landed** (`embarked && landed`) — aboard on the surface (ROCKY only).
  - **On foot** (`!embarked`, always landed) — disembarked on the surface.
  - **INVARIANT `!embarked ⇒ landed`** (no on-foot-in-orbit). New `players.landed
    boolean default false` (migration `20260609040000_orbit-land.sql`,
    forward-only/idempotent; sets `landed=true` where `embarked=false` to keep
    existing players valid) carried on `Player`/`PlayerRow`/`rowToPlayer`.
- **Fuel split** (`rules.ts`, pure): `orbitFuelCost(from, to, timeMs)` =
  DISTANCE only (`INTERPLANETARY_FUEL_PER_DISTANCE × interplanetaryDistance`,
  0-to-self, time-varying); `launchFuelCost(atmosphere, gravity)` = ATMOSPHERE
  only (`takeoffCost`); **descent (`land`) is FREE — the atmosphere cost is
  billed on LAUNCH** (the climb out). The old combined `regularFuelCost` is no
  longer charged as one piece.
- **Verbs**: `orbit <planet>` (fly to ANY planet incl. gas giants — distance
  fuel), `land` (descend current, ROCKY only, free, landing-gate applies),
  `launch` (surface→orbit, atmosphere fuel), `land <planet>` combo (go + land).
  **`orbit`/`land` CHAIN an implicit `launch` when issued from a surface**
  (charge `launchFuelCost(currentPlanet) + orbitFuelCost`, validate combined
  fuel before mutating); the long jumps `warp`/`hyperwarp` NEVER chain — they're
  Orbiting-only (force an explicit `launch`). `disembark` now requires Landed;
  bare `land` while Landed is a no-op error.
- **Applicability** (`applicability.ts`, the single source — `PlayerStateView`
  gained `landed`): `ABOARD_TRAVEL {orbit, land}` applicable in EITHER aboard
  state (they chain launch); `ORBITING_ONLY {warp, hyperwarp}`; `SURFACE_ABOARD
  {launch, disembark}`; on-foot/economy/combat/informational unchanged.
  `inapplicableReason` updated ("`launch` to orbit first" / "`land` first").
- **Scan reworked into orbital-vs-surface frames** (`render.ts`/`commands.ts`):
  Orbiting (or any gas giant) → an ORBITAL frame (planet info + in-system
  siblings as `orbit <n>` with `orbitFuelCost` + P9b red + a `land` action when
  rocky / "no surface" when gas); Landed/On-foot → the surface `regionScanFrame`
  (+ a `launch` hint). **This SUPERSEDES `gasGiantScanFrame` and the
  `gas-scan-siblings` land-list** (siblings are `orbit <n>` now). The outpost
  scan also gained `orbit <n>` sibling nav. Seeded: `orbit-land.test.ts`.

### Load-bearing decisions from `warp-galaxy-tune` + `hyperwarp-anywhere`

- **Two-tier galactic travel.** Warp fuel = LOCAL roaming (expensive at galactic
  scale by design); hyperwarp/condensate = the LONG-HAUL tier.
- **`warp-galaxy-tune`** (constants only, no migration): `WARP_FUEL_PER_DISTANCE
  ÷3` (→ a core→rim crossing ≈ 20 tanks; galaxies feel vast) and `ARM_COUNT_MIN
  2→8` (`armCount ∈ [8,16]` — denser arms, so adjacent-arm-at-rim isn't as far
  as crossing the whole galaxy). Validated by sampling (core→rim ~21 tanks,
  within-cluster ~11% tank, radiation core 100→rim 2).
- **`hyperwarp-anywhere`** (no migration): hyperwarp is now the 1-condensate
  long-haul fast-travel. **`hyperwarp <arm> <cluster> <system>`** (3 args) jumps
  ANYWHERE in the current galaxy; **`hyperwarp <galaxy>`** (1 arg) jumps to an
  ADJACENT galaxy's rim (`cluster = MAX_CLUSTERS_PER_ARM-1`). Flat 1 condensate
  each (no warp-fuel/distance cost), arrive ORBITING planet 0 region 0
  (orbit-land invariant). Pure validators `isValidInGalaxyTarget(arm,cluster,
  system,armCount)` + `isAdjacentGalaxy(from,to)`; `canHyperwarp` simplified to
  the condensate-only gate (same-galaxy is now valid; back-compat args retained
  for the old `galaxy-jump` test). Replaces the old fixed-core-entry jump.
  `setGalaxyLocation` reused; `ORBITING_ONLY` applicability unchanged; `map`
  shows both forms (P9b red when no condensate). Seeded:
  `hyperwarp-anywhere.test.ts`. Progression: bootstrap locally on warp fuel →
  mine voidstone → craft condensate → roam the galaxy freely.
