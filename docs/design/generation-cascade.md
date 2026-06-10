# Generation Cascade — Omniplex's deterministic world pipeline

> The architecture vision for how a whole universe is generated from a seed,
> top (galactic) to bottom (biology), each tier constraining the next. This is
> the *what-flows-into-what* reference; the concrete near-term BUILD phases live
> in [`planetary-surface-plan.md`](./planetary-surface-plan.md), and the
> economic/progression layer in [`path-depth-roadmap.md`](./path-depth-roadmap.md).
> Status markers: ✅ built · ◖ planned (near-term) · ○ later.

## Principle

Everything is a pure function of `seed + coords`; **only player diffs are
stored** (depletion, bases, discoveries, salvages, market/supply, reputation).
Each tier **biases the probabilities** of the tier below it — not true
randomness, but *constrained* randomness within physically coherent bounds. So
the world is reproducible, effectively infinite, and feels like it has logic
because it does: a property three tiers down traces causally back to the seed.

## The cascade (top → bottom)

### 1. Galactic structure  ◖ (Phase 0)
- **In:** `galaxy` (unbounded) · `arm` · `cluster` · `system`.
- **Treats `arm`/`cluster` as polar `(r, θ)`:** `θ = arm·2π/armCount`,
  `r = (cluster+R₀)·CLUSTER_SPAN`; a cluster sits at `(r·cosθ, r·sinθ)`.
- **Finite disk:** clusters per arm are capped at `MAX_CLUSTERS_PER_ARM` (the
  galaxy's radius in rings), so a galaxy is large but FINITE (`armCount` ×
  `MAX_CLUSTERS_PER_ARM` × 1024 stars); the rim is a hard edge. The
  infinite-universe property lives at the **galaxy tier** (unbounded galaxy
  count), not inside one galaxy.
- **Determines:** warp distance (planar polar geometry + the intra-cluster star
  cloud ✅), and **galactic-center radiation `= f(r)`** (max at the core, decays
  outward to the rim at the cap). Emergent: arms converge coreward →
  dense/irradiated/rich core, sparse/safe rim. Radiation is the key *output that
  flows downward*.
- ✅ today: galaxy/arm/cluster/system coords; bounded Gaussian star clouds with
  `(x,y,z)` positions. ◖ planned: the polar geometry + radiation.

### 2. Stellar / system  ✅ (+◖)
- **In:** the system seed. **Determines:** star class (O–M ✅), planet count,
  per-planet orbital radius/period/phase ✅.
- Note: planet **temperature is currently derived from planet RADIUS**
  (Kopparapu size-class → cold/warm/hot zone distribution ✅), *not* from
  star-luminosity × distance (that physics was tried and dropped as too
  simplistic). The spatial climate variation comes in at tier 4.

### 3. Planetary  ✅ (+◖)
- **In:** radius/size-class, orbit, atmosphere, gravity, star. **Determines:**
  mean temperature (radius-derived ✅), hazard (temperature-coupled ✅ — and
  planned to also take a **radiation floor** from tier 1), atmosphere ✅,
  rocky-vs-gas ✅, biome palette ✅.
- ◖ planned: **axial tilt · length-of-day · eccentricity · rotation** (appended
  to the planet RNG stream so existing gen stays byte-identical) — these bias
  the *per-cell* climate at tier 4.

### 4. Local climate & geology  ◖ / ○
- **Surface as a lat×lon grid** (region index ↔ cell, bijection — no reset ◖).
  **Per-cell climate** = latitude band (hot equator → cold poles) modulated by
  the tier-3 planetary params + the tier-1 radiation, with coherent longitudinal
  variation → **biome bands** drawn from the planet's palette (replaces today's
  independent per-region palette draw ✅→◖). Explorable grid/polar (◖).
- ○ **Geology layer:** volcanic/impact/erosion history → caves, mineral seams,
  **region resource signatures** ("copper near old vents"). Filters on top of
  the climate grid.
- **Determines (the outputs biology consumes):** per-cell biome, temperature,
  hazard, radiation, resource signature.

### 5. Biology — the ecological web  ○
The payoff tier. Life is **generated in trophic order so it forms a coherent
food web**, each level grounded in the one below it and filtered by the tier-4
environment (biome · climate · hazard · radiation):

1. **Flora first (producers).** What plants the local climate/biome/radiation
   support — drawn from the flora genome, environment-filtered. The base of the
   web; everything above depends on what flora exist here.
2. **Prey next (herbivores), keyed to the flora.** Generated from the flora
   actually present (their food) + climate fitness. No flora → no herbivores of
   that kind. Their diet links to specific local flora.
3. **Predators last (carnivores), keyed to the prey.** Generated from the prey
   present (their food) + climate fitness. Predators only appear where their
   prey is sustainable — so "predators cluster where prey is dense" falls out of
   generation, not scripting. (Omnivores/scavengers slot in as cross-links.)

So a region's fauna is a **trophic web** (radiation-tolerant flora → herbivores
that eat it → predators that hunt them), all tracing back through climate to the
galactic position. Drawn from a finite **creature genome** (archetypes ×
adaptive traits, environment-filtered — the "tens of thousands of species"
schema) so it's diverse without live generation.

**Implication for the genome schema:** the trait dimensions MUST include a
**trophic role / diet** (producer · herbivore · carnivore · omnivore ·
scavenger) and a **food-source linkage**, so the web can be assembled by
referencing the level below. Climate/radiation traits (e.g. radiation-tolerant,
thermophilic) gate which archetypes/variants pass the environment filter. (The
genome is *not* a dependency of the Nimbus blurb writer — blurbs are
style-transfer over whatever scientific facts each generated species carries.)

## Status & suggested build order

| Tier | Status | Where |
|---|---|---|
| 1 Galactic structure (polar + radiation) | ◖ next | planetary-surface-plan **Phase 0** |
| 2 Stellar / system | ✅ | built |
| 3 Planetary (params: tilt/day/eccentricity) | ◖ | planetary-surface-plan |
| 4 Surface grid + climatic biomes + nav | ◖ | planetary-surface-plan **A/B** |
| 4b Geology (caves/seams/resource signatures) | ○ | later plan |
| 5 Creature genome + **ecological web** | ○ | later plan (this doc's tier 5) |

Build order top-down: **galactic structure → planetary params → surface
grid/biomes → geology → creature genome + ecological web.** Each tier's outputs
are the next tier's inputs, so building downward means every layer has real
inputs to filter on.

## Out of scope here

Creature ecology *behavior* (predator-prey hunting AT RUNTIME, migration,
clustering by player activity) is a separate concern from this *generation*
cascade — the web defines *which* species coexist in a region; behavior defines
how they act once you're there. Noted for a later plan.
