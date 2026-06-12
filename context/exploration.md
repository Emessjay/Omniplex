# Exploration

Load-bearing decisions extracted from `CLAUDE.md`, in build order.

### Load-bearing decisions from `exploration-sites` (Keystone 3)

- **Exploration now pays in things you can't mine**: rare findable sites +
  `salvage` + a first-discovery bounty. (Cartography ranks + orbital derelicts =
  later 3b.)
- **Sites** (`gen.ts`, pure, exported via `index.ts`): `siteAt(seed, region) →
  Site | null` on a DISTINCT `"site"` RNG stream (so reading it NEVER perturbs
  `regionAt` — unit-asserted), ~5% of surface regions. `Site = { type:
  "derelict"|"ruin"|"anomaly"; lootTier }` (`SiteType` in `types.ts`). Gas
  giants have no regions ⇒ no sites. `siteLoot(seed, region, site) → {materials:
  {id,qty}[], credits}` on its own `"site-loot"` stream — uses EXISTING items
  (relics/rare materials) + a credit cache; higher tier ⇒ better.
- **`salvage`** (NEW verb, DISEMBARKED, gas/outpost guarded): if the region has
  an un-salvaged site, award `siteLoot` (`addPlayerMaterial` + `addPlayerCredits`)
  ONCE per player, then take the standard hazard roll (`rollHazardDamage` →
  `runDeath`). Tracked in `public.salvaged_sites` (migration
  `20260610010000_exploration-sites.sql`: `(player_id→players cascade, region_key
  text, salvaged_at, pk(player,region_key))`, **read-own RLS**, service-role
  writes; forward-only/idempotent). `world.ts`: `hasSalvaged`/`markSalvaged`.
  Registered in `VERBS`/`USAGE`/`applicability`.
- **First-discovery bounty**: `DISCOVERY_BOUNTY` (`rules.ts`) credits paid
  EXACTLY ONCE per planet, off the existing `recordDiscovery` first-discovery
  gate, reported in `scan`. `scan` (surface frame) surfaces a present site +
  P9b-red salvage state + the bounty line. Seeded: `exploration-sites.test.ts`
  (gen + game). 3b (cartography ranks) + orbital derelicts build on this.

### Load-bearing decisions from `cartography` (Keystone 3b)

- **Exploration progression: a `charted` count (worlds first-discovered) → a
  cartography RANK, shown on the public leaderboard.** Mirrors `faction-ranks`'s
  ladder pattern; gives "explorer" a path-identity.
- **`CARTO_RANKS`** (`src/lib/game/cartography.ts`, pure, ~6 tiers ascending by
  `minCharted` from 0): `cartographyRank(charted)` = highest rank with
  `minCharted ≤ charted` (clamps, monotonic); `MAX_CARTO_TIER`.
- **`players.charted integer default 0 check (charted>=0)`** (migration
  `20260610170504_cartography.sql`, forward-only/idempotent), carried on
  `Player`/`PlayerRow`/`rowToPlayer`. Incremented EXACTLY ONCE per planet inside
  the existing first-discovery gate (same gate as `DISCOVERY_BOUNTY` — never
  double-counts, never on re-scan). The `public.leaderboard` view was RECREATED
  to expose `charted` (public-safe, no `user_id`; forward-only, per the
  addressing-overhaul precedent).
- **`cartography`** (NEW verb, INFORMATIONAL/anywhere): charted count + rank +
  next-tier threshold. The first-discovery scan line shows the updated count/
  rank; `who`/leaderboard surface the cartography title. Seeded:
  `cartography.test.ts`. (3c: orbital derelicts, payout scaling by rank.)

### Load-bearing decisions from `orbital-derelicts` (Keystone 3c)

- **Orbital derelicts + rank-scaled discovery payouts.** NO migration (reuses
  `salvaged_sites`'s text key). `orbitalSiteAt(seed, planetCoord) → Site|null`
  (`gen.ts`, pure, distinct `"orbital-site"` RNG stream that does NOT perturb
  `planetAt`/`regionAt`/`siteAt`; ~4-8% of planets; per-PLANET; works for GAS
  GIANTS too — orbit, not surface). `orbitalSiteLoot` (own stream, richer than
  surface). **`salvage` now usable ORBITING (embarked && !landed) at an orbital
  derelict** — no hazard roll (you're aboard), tracked in `salvaged_sites` by the
  5-seg `planetKey` (surface sites use the 6-seg `regionKey`; same table, PK
  distinguishes) — OR on foot at a surface site (unchanged, hazard roll).
  Applicability: `salvage` applies when `!inCombat && ((embarked && !landed) ||
  !embarked)`. `discoveryBountyFor(cartoRankTier)` (`rules.ts`, pure): base
  bounty at tier 0, strictly increasing — first discovery pays the rank-scaled
  amount. Orbital scan surfaces the derelict + salvage hint (P9b red if cleaned).
  Seeded: `orbital-derelicts.test.ts`.
