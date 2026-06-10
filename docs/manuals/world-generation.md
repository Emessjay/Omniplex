# Omniplex — World Generation Manual

> A catch-up reference for the procedural universe. Describes *what* the
> generator produces and the rules behind it. For the load-bearing
> implementation decisions (the "why it's built this way, don't break it"
> notes), see `CLAUDE.md` §"Conventions". For what players *do* with this
> world, see [`player-activities.md`](./player-activities.md).

---

## 1. Core philosophy: deterministic & seed-based

The universe is **infinite but unstored**. Every static property of a place
is a pure function of `hash(WORLD_SEED, coordinates)` — nothing about the
*shape* of the universe lives in the database. Only **mutable** state is
persisted (resource depletion, player-built bases, discoveries, market
prices/supply). This keeps the universe effectively infinite without storing
every star.

- **All generation lives in `src/lib/universe/`** (public API in `index.ts`).
  It is **pure & deterministic**: same inputs ⇒ byte-identical output. There
  is **no I/O, no `Date`, no `Math.random`** anywhere in this module — time
  and randomness are passed in or derived from the seed.
- **PRNG**: cyrb128 + sfc32 (`prng.ts`), seeded via `makeRng(seed, ...parts)`.
  Deterministic across JS engines, no dependencies. Each generation "stream"
  is keyed by a label + the full coordinate (e.g.
  `makeRng(seed, "region", galaxy, arm, cluster, system, planet, region)`),
  so any object reproduces without generating its siblings.
- The production seed is `WORLD_SEED` (env). Tests and analysis use
  `"omniplex-prod-1"`.

---

## 2. The six-tier address

Space is a six-level hierarchy. A full location is:

```
galaxy → arm → cluster → system → planet → region
```

| Tier    | Type / bounds | Notes |
|---------|---------------|-------|
| galaxy  | int ≥ 0, **unbounded** | Effectively infinite outward. Inter-galaxy travel is condensate-gated (`hyperwarp`). Everyone starts in galaxy 0. |
| arm     | int in `[0, armCount)` | A **ring** within a galaxy; indices **wrap** mod `armCount`. |
| cluster | int ≥ 0 | A finite cloud of stars (see §5). |
| system  | int in `[0, STARS_PER_CLUSTER)` = `[0, 1024)` | A star + its planets. The index is the canonical stored identity. |
| planet  | int in `[0, planetCount)` | Ordered innermost→outermost (see §6). |
| region  | int in `[0, regionCount)`, or **`-1`** = orbital outpost | A patch of surface with one biome (see §7). |

**Coordinate types** (`types.ts`): `SystemCoord {galaxy, arm, cluster,
system}`, `PlanetCoord` adds `planet`, `RegionCoord` adds `region`. The start
location is `(0,0,0,0,0,0)` — but new players actually spawn at
`startingWorld(seed)` (the first safe rocky world), not literally there.

**Location keys** are colon-delimited strings used as DB row keys:
- `systemKey` → `"galaxy:arm:cluster:system"` (4 segments) — markets, supply.
- `planetKey` → `+ ":planet"` (5 segments) — discoveries.
- `regionKey` → `+ ":region"` (6 segments) — depletion (`world_deltas`), bases.

`parseLocationKey` round-trips 4/5/6-segment keys back to the coord types.

---

## 3. Galaxies

`galaxyAt(seed, galaxy) → { index, name, armCount }`. `armCount` is
`randInt(ARM_COUNT_MIN, ARM_COUNT_MAX)` = `[2, 16]` and **varies per galaxy**.
Callers get a galaxy's arm count from here (e.g. to wrap arm indices or
compute warp distance).

---

## 4. Distance & the warp metric

`warpDistance(seed, a, b, armCount)` is the deterministic system-to-system
metric driving warp-fuel cost. (Note: **seed-first signature** since stars
have real positions now.)

```
different galaxy            → Infinity   (not a normal warp; needs hyperwarp)
same galaxy:
  armRing · ARM_SPAN
  + |Δcluster| · CLUSTER_SPAN
  + systemTerm
```
- `armRing = min(|Δarm|, armCount − |Δarm|)` — symmetric ring wrap.
- **`systemTerm`**: Euclidean distance between the two stars' `(x,y,z)`
  positions × `SYSTEM_SPAN` **only when a and b are in the same cluster**;
  **0 otherwise** (the cluster/arm terms capture inter-cluster distance —
  system indices have no cross-cluster spatial meaning).

**Span constants** (`gen.ts`), tuned so the hierarchy is coherent:
- `ARM_SPAN = CLUSTER_SPAN = 10 · STAR_CLUSTER_SIGMA = 100`. A cluster hop
  costs the same as a 10σ intra-cluster traversal; an arm hop equals a
  cluster hop **for now** (a deliberate placeholder — likely revisited).
- `SYSTEM_SPAN = 1` (the per-unit multiplier for the Euclidean term).
- Invariant locked in tests: `CLUSTER_SPAN > 2 · STAR_CLUSTER_MAX_RADIUS`, so
  a cluster step exceeds the cluster's diameter ⇒ **clusters never overlap**.

0 to self, symmetric, positive between distinct reachable systems.

---

## 5. Clusters & star positions

A **cluster is a finite cloud of exactly `STARS_PER_CLUSTER = 1024` stars**.
Each star has a real 3D position:

- `clusterStars(seed, cluster) → StarPosition[]` (length 1024), pure &
  deterministic (its own `"cluster-stars"` RNG stream). Each position is an
  **isotropic multivariate Gaussian** (mean 0, σ = `STAR_CLUSTER_SIGMA = 10`),
  rounded to **2 decimals**, drawn via Box–Muller over the PRNG.
- **Bounded extent** (clusters are not infinite): a truncated Gaussian —
  any sample beyond `STAR_CLUSTER_MAX_RADIUS = 40` (≈4σ) from the origin is
  rejected and resampled. So the cloud fills a finite sphere of radius 40.
- **Collision avoidance**: no two stars in a cluster share a rounded
  position (resample on duplicate). The resample loop is deterministic.
- `systemPosition(seed, systemCoord)` indexes into the cloud; a `StarSystem`
  carries its `position`. `systemFromPosition(seed, cluster, pos)` inverts it
  (exact 2-dp match → the system index, or `null` if unoccupied) — this is
  what powers warp-by-coordinate.

The `system` index `0..1023` remains the **canonical stored value** (DB
column, location keys). Positions are derived, never stored.

---

## 6. Systems & planets

`systemAt(seed, coord) → StarSystem { coord, name, starClass, planetCount,
planets[], position }`.
- `starClass` ∈ `STAR_CLASSES` = O/B/A/F/G/K/M (hottest→coolest).
- `planetCount` ∈ `[1, MAX_PLANETS=8]`.
- **Planets are ordered by orbital distance**: after generation they're
  sorted ascending by `orbitalRadius` (stable tiebreak on generation index)
  and re-indexed, so `planets[i].coord.planet === i` and **index 0 = innermost**.
- `planetAt(seed, coord)` returns `systemAt(...).planets[coord.planet]`
  (it regenerates the system, sorts, indexes — *not* O(1) anymore; throws on
  an out-of-range planet index).

### Planet attributes (`Planet`)

Grounded in Kopparapu (2018, ApJ 856) occurrence data.

- **`radius` (R⊕)** sampled from the paper's size occurrence → **`sizeClass`**:
  Rocky 0.5–1, Super-Earth 1–1.75, Sub-Neptune 1.75–3.5, Sub-Jovian 3.5–6,
  Jovian 6–14.3.
- **`isGas = radius ≥ GAS_RADIUS_THRESHOLD (1.75)`**. Population ≈ **49%
  rocky / 51% gas**.
  - **Gas giants are orbit-only**: `biomePalette = ["gas"]`, `regionCount =
    0`, **no surface, no regions, no deposits, nothing to mine, no bases**.
    You can `warp`/`scan`/orbit (and they may host an orbital outpost), but
    not land/disembark. `regionAt` *throws* on a gas planet (a loud guard).
  - **Rocky worlds** have the full biome/region/deposit model below.
- **`temperature` (°C)** derived from radius (the old orbital-distance physics
  was dropped). Each size class carries a normalized cold/warm/hot zone mix
  (Table 3), interpolated smoothly by `log10(radius)`, mapped through an
  inverse-CDF with breakpoints at **0°C and 100°C**. Bounded to
  `[TEMP_MIN(−160), TEMP_MAX(520)]`. Overall distribution ≈ **cold 77 /
  warm 8 / hot 15**; gas giants skew much colder than rocky worlds.
- **`hazard` [0,1]** couples to temperature extremity (`hazardFor`) — worlds
  far from the comfort band are more dangerous.
- **`atmosphere`** ∈ `ATMOSPHERES` (none/thin/breathable/toxic/corrosive/
  inert/dense). `atmosphereDensity(atm)` (in the universe layer) feeds both
  takeoff fuel cost and solar power output.
- **`gravity`** (0,10], **`name`**, **`coord`**.
- **Orbital mechanics** (for interplanetary `land` fuel): `orbitalRadius`
  (AU-ish [0.3,40]), `orbitalPeriod` (real-time ms ~6h–30d), `orbitalPhase`.
  `planetPosition(orbit, timeMs)` gives a planet's position on its circular
  orbit; `interplanetaryDistance(a, b, timeMs)` varies with time as planets
  sweep at different rates. (Time is passed in — gen stays pure.)

### Landing gate (planet-level)

`canLand`/`landingRequirement` (`rules.ts`, `FREEZING_C = 0` /
`BOILING_C = 100`, boundaries survivable): `land`/`mine` are blocked on a
world **below freezing** (needs **Antifreeze Tanks**) or **above boiling**
(needs **Ablative Shields**) unless you own the upgrade. `warp` is never
gated (you arrive in orbit, so you can't softlock).

---

## 7. Regions (rocky planets only)

A rocky planet is subdivided into many **regions** — `regionCount` is rolled
**log-uniformly** across `[REGION_COUNT_MIN, REGION_COUNT_MAX]` = `[100,
100000]`, so planets range from modest to enormous.

`regionAt(seed, planetCoord, regionIndex) → Region { coord, biome, deposits,
temperature, hazard }`, pure & deterministic (own RNG stream).

- **`biome`** is drawn from the planet's `biomePalette` (a temperature-coherent
  subset of the 10 `BIOMES`: barren, ocean, jungle, desert, tundra, volcanic,
  toxic, crystalline, gas, irradiated). Biome composition follows temperature
  (hot worlds downweight tundra, cold worlds downweight volcanic; no ocean or
  jungle on extreme worlds; gas is exclusive to gas giants).
- **Per-region temperature & hazard** vary around the planet mean by a
  biome offset, but are **band-clamped** so a region never crosses the
  planet's freezing/boiling category (the landing gate stays planet-level).
  Volcanic regions run hotter/more hazardous; tundra colder; etc.
- **`deposits`** (resource veins) use the region's hazard + biome. Higher
  hazard → rarer ore (the `rarityWeight` coupling). Mining depletes a region
  (`world_deltas` keyed by `regionKey`); depletion slowly regenerates.

---

## 8. Resources (minerals)

`RESOURCES` catalog (`src/lib/universe/resources.ts`) — the gen-side source
of truth, **must stay in lock-step with the SQL seed**. `getResource(id)`
throws on unknown ids.

**General** (can appear anywhere): iron (r1), silica (r1), copper (r2),
cobalt (r2), titanium (r3), iridium (r4), xenon (r4), voidstone (r5).
**Biome-specific** (only in regions of those biomes): pyrite (volcanic),
verdite (jungle), aquamarine (ocean), radium_salt (irradiated/toxic),
prismatic_gem (crystalline).

`rarity` 1–5 with rising `baseValue` (iron 5 → voidstone 500). Hazard→rarity
coupling means the rarest ore (voidstone, r5) is gated to savage,
high-hazard worlds — and `voidstone` is the input to Hyperwarp Condensate
(galaxy travel), so deep exploration gates the late game.

`depositsFor(rng, hazard, biome)` draws from `mineralsForBiome(biome)` (the
general pool + that biome's specifics), so a region can never yield a
mineral specific to a different biome.

---

## 9. Settlements & orbital outposts

Two kinds of inhabited place, both **generated, not stored** (pure flags):

- **Settlements** sit on the surface: `hasSettlement(seed, regionCoord)` is
  true only when the planet is temperate (0 < T < 100), the region's biome is
  in `HABITABLE_BIOMES` (ocean / jungle / desert), and a per-system ×
  per-planet density roll passes. Marked `⌂` in the `regions` list.
- **Orbital outposts** sit in orbit: `systemOutpostPlanets(seed, system)`
  picks ~2 planet indices per system; `hasOutpost(seed, planet)` is
  membership. Reached via **`jump O`** (sets `region = -1`, the orbital
  sentinel). A gas giant *can* host an orbital outpost (orbital ≠ surface).

Both are **trade locations** — `buy`/`sell` are only allowed at a settlement
region or an outpost (see player manual §economy). `region = -1` is guarded
everywhere a surface region would be derived (no `regionAt(-1)`).

---

## 10. Files & where to look

| Concern | File |
|---|---|
| Public API | `src/lib/universe/index.ts` |
| Generation (galaxies, systems, planets, regions, positions, distance) | `src/lib/universe/gen.ts` |
| Types, enums, constants (BIOMES, ATMOSPHERES, STAR_CLASSES, SIZE_CLASSES) | `src/lib/universe/types.ts` |
| PRNG | `src/lib/universe/prng.ts` |
| Mineral catalog | `src/lib/universe/resources.ts` |
| Seeded contracts | `src/lib/universe/*.test.ts` (planet-taxonomy, planet-distance-order, star-coordinates, settlements, biome-consistency, biome-minerals, addressing, universe-gen) |

**Invariants to never break**: gen is pure/deterministic (no `Date`/
`Math.random`/IO); the resource catalog matches the SQL seed; gas planets
have no surface (guard `isGas` before any region/deposit/landing path);
`system` stays the stored identity; clusters are 1024 stars and finite.
