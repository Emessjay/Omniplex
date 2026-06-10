# Plan — Planetary Surface (climatic biomes + grid/polar exploration)

> A FUTURE plan, to be fully spec'd and built **after the current roadmap is
> complete in all phases** (Keystones 1/2/3 + their tails). Captures the design
> agreed 2026-06. Companion to [`path-depth-roadmap.md`](./path-depth-roadmap.md).
> Decisions below are settled; the per-phase specs come at execution time.

## Problem

Today a planet is a **flat, unordered bag of N independent regions** (`regionCount`
∈ [100, 100k]). Region index 5 has no spatial relationship to 6; each region's
biome is an *independent palette draw*. So "exploration" = sampling random region
indices — no surface, no geography, no traversal, no climatic coherence. (See
[`path-depth-roadmap.md`](./path-depth-roadmap.md) and the manuals for the
current model.) Goal: make a planet a **coherent navigable surface** whose biomes
are shaped by **new planetary characteristics**, explorable in a **grid/polar**
pattern — the foundation the later geology + creature-genome layers build on.

## Galactic structure (the EARLY addition — astronomical tier)

> Build this **first** in the next arc — it's the top of the generation cascade
> (`astronomical → planetary → local climate/geology → biology`), so its outputs
> (radiation) feed everything below. It reworks `warpDistance` once more, cleanly
> **subsuming** the `cluster-span-retune` (the spans become the radial/angular
> scale).

**Treat `arm` and `cluster` as polar coordinates `(r, θ)` within a galaxy** — one
structure driving BOTH navigation distance AND galactic-center radiation:

- `θ(arm) = arm · (2π / armCount)` — `arm` already wraps mod `armCount`, so it's
  naturally an angle. `r(cluster) = (cluster + R₀) · CLUSTER_SPAN` — radial
  distance from the core (`R₀ > 0` so cluster 0 isn't a degenerate point where
  all arms collapse). A cluster's galactic-plane position is
  `P(arm,cluster) = (r·cosθ, r·sinθ)`.
- **Bound the galaxy to a finite disk:** cap clusters per arm at
  `MAX_CLUSTERS_PER_ARM` (a constant — the galaxy's radius in cluster-rings;
  ~32–128, tunable). So a galaxy = `armCount` arms × `MAX_CLUSTERS_PER_ARM`
  rings × `STARS_PER_CLUSTER` (1024) stars — large but FINITE (e.g. 16 × 64 ×
  1024 ≈ 1M stars). `cluster ∈ [0, MAX_CLUSTERS_PER_ARM)`; `warp`/addressing
  reject out-of-range clusters (the rim is a hard edge). **Galaxies remain
  unbounded in COUNT** — the infinite-universe property lives at the galaxy
  tier (far-future `hyperwarp` travel), not in an infinitely-wide single galaxy.
  Radiation `f(r)` then spans a known range (core → the rim at the cap).
- **Warp distance** = the planar distance between two systems' clusters,
  `|P(a) − P(b)| = √(rₐ² + r_b² − 2·rₐ·r_b·cos Δθ)` (law of cosines), PLUS the
  intra-cluster star-cloud Euclidean (from `star-coordinates`) as the fine term
  when in the same cluster. Different galaxy → `Infinity` (hyperwarp only). This
  replaces the weighted-sum spans (`ARM_SPAN`/`CLUSTER_SPAN`/`SYSTEM_SPAN`) with
  real geometry.
- **Emergent shape (the payoff):** angular separation is an arc (`r·Δθ`), so
  **arms converge toward the core and splay apart at the rim** — a spiral-galaxy
  shape for free. Near the core, hopping arms is cheap and everything's packed;
  the rim is sparse and arms are isolated.
- **Radiation** `galacticRadiation(cluster) = f(r)` — max at the core, decaying
  outward (e.g. `RADIATION_CORE / (1 + cluster/falloff)`). This is a galaxy-scale
  risk/reward gradient: **coreward = high radiation + dense + the rarest
  resources; rimward = safe + sparse + poor** — the savage→rare coupling lifted
  to galactic scale, giving long-range exploration a *direction*.
- **Cascade:** radiation → higher planet hazard floor → irradiated/toxic biomes
  more common → radiation-tolerant creature variants (a genome trait) →
  radiation-forged rare ore. And it wants a **radiation-shield** upgrade as the
  gate to operate in high-radiation clusters — a clean sibling to the
  Ablative/Antifreeze landing gear (`canLand`-style gate).
- **Design knobs to pin at spec time:** the core offset `R₀`; the radiation
  falloff shape + which clusters demand the shield; whether radiation is pure
  `f(r)` or carries a little per-system jitter.

## Settled decisions

1. **Region model = index↔grid bijection (NO universe reset).** Reinterpret the
   region INDEX as a cell on a lat×lon grid:
   - Derive grid dims from `regionCount`: `rows × cols ≈ regionCount`, ~1:2
     lat:lon ratio (like a real map). Bigger planets ⇒ finer grids ⇒ more to
     explore.
   - `index ↔ (latRow, lonCol)` via divmod (`index = latRow × cols + lonCol`) —
     the same bijection trick as cluster star positions. **The index is
     preserved**, so `world_deltas` (depletion), `salvaged_sites`, `bases`, and
     `players.region` stay index-keyed — **no reset**. The index just gains a
     spatial *interpretation*.
   - Caveat to handle at spec time: existing region-keyed gen-dependent data
     (sites via `siteAt`, biome-derived expectations) shifts because biome is
     now position-derived; depletion is biome-agnostic (just a number) so it's
     fine. Decide then whether a light re-roll of sites is warranted (likely
     acceptable to leave; flag it).
2. **Biome becomes a function of position + climate (not a random draw).**
   Latitude sets a temperature band (hot equator → cold poles); longitude adds
   coherent low-frequency variation (continents / wet-dry bands via deterministic
   low-freq noise); the biome is chosen from the planet's existing **palette**
   weighted by the local climate. Result: biomes form **bands/regions** across
   the surface (poles tundra/ice, equator desert/jungle) — coherent + explorable.
   The palette still constrains *which* biomes appear; this changes their
   *placement*. **Scope: biomes only, for now** (geology/creatures later).
3. **New planetary characteristics** (drawn deterministically per planet,
   APPENDED to the planet RNG stream so existing gen stays byte-identical — the
   `fuel-orbital`/orbital-params precedent), each **biasing the per-cell climate**
   that picks the biome:
   - **Axial tilt** → strength of the equator-to-pole temperature gradient (+
     seasonality).
   - **Length of day** → day/night temperature swing (long day → harsher
     extremes, e.g. Mercury).
   - **Eccentricity** → global seasonal temperature shift.
   - **Rotation speed** → wind/Coriolis → the wet/dry banding across longitude.
   Two planets with the same palette but different tilt/day-length should feel
   distinct (crisp climate bands vs uniform extreme).
4. **Navigation = directional + polar (keep `jump <n>` fast-travel).**
   `north`/`south`/`east`/`west` step to the adjacent grid cell (E/W **wraps**
   the globe; N/S runs to the **poles**, clamp or pole-wrap — decide at spec
   time). A "polar run" = head N/S to a pole; a "grid sweep" = systematic
   traversal. Add a local surface **`map`** showing the player's lat/lon + the
   neighboring cells' biomes. `jump <n>` stays as teleport/fast-travel. Surface
   movement is free (on foot / rover), like region `jump` today.

## Likely phase breakdown (refine at execution time)

- **Phase 0 — galactic structure (EARLY, build first)**: `arm`/`cluster` as
  polar `(r, θ)`; rework `warpDistance` to planar polar geometry (subsuming the
  span constants); `galacticRadiation(cluster) = f(r)` + a radiation-shield
  upgrade gate; radiation feeds the planetary hazard floor. (Astronomical tier —
  upstream of everything below.)
- **Phase A — surface grid + climatic biomes**: planetary params (tilt/day/
  eccentricity/rotation) on `Planet` (appended RNG draws); `regionAt` biome
  derived from `(lat, lon)` + climate instead of an independent palette draw;
  the index↔grid helpers. (Pure gen; the heavy lift.)
- **Phase B — directional/polar navigation + surface map**: `north`/`south`/
  `east`/`west` verbs over the grid, the local `map` view; `jump <n>` retained.
- (Both could be one phase if scoped tightly; split if it gets large.)

## Out of scope (later, separate plans)

- **Geology layer** (volcanic/impact/erosion → caves/seams, region resource
  *signatures*) — the next atmospheric layer, filters on top of the surface grid.
- **Creature genome** (archetype × adaptive traits, environment-filtered) — the
  big "alive" upgrade + the hook for the blurb-writing system; filters on the
  per-cell climate/geology.
- **Creature ecology/behavior** (predator-prey, clustering by activity).
- Weather / live day-night cycle effects on play.

## How exploration develops from here

Post-current-patch exploration is "jump to a region index, scan, extract value
(mine/explore/salvage), get a discovery bounty + cartography rank." This plan
turns that into **traversing a coherent climatic surface** (walk the bands, run
to a pole, map the terrain). The later geology + creature-genome layers then make
each cell *deep* (caves, resource signatures, ecologically-filtered alien life
with generated blurbs). Net arc: flat region bag → navigable climatic world →
geologically + biologically alive world.

## Constraints (carried into the specs)

- Pure & deterministic gen (no `Date`/`Math.random`; params appended to the
  planet stream; biome a deterministic function of coord + params). Index
  preserved → no reset; region keys unchanged. Reuse the bijection pattern from
  star positions. TS strict; theme parity; one applicability source; help-parity;
  P9b red. Keep `jump <n>` working.
