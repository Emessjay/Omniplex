-- ============================================================================
-- planet-taxonomy — paper-based planet sizes (rocky/gas) + radius temperatures.
-- ============================================================================
-- Forward-only, runs EXACTLY ONCE (tracked in public.schema_migrations by the
-- migration runner). This is a PRAGMATIC RESET: planet generation was
-- fundamentally regrounded in the Kopparapu (2018) occurrence data — every
-- planet now has a physical radius/size class, ~half of all planets became
-- non-landable GAS GIANTS (no surface), and temperature was re-derived from
-- radius (orbital-distance physics dropped). Planet/region identity therefore
-- changed wholesale, so any state keyed to a planet or region (depletion,
-- discoveries, bases + their buildings/storage) is now meaningless and is
-- WIPED, and every player is RELOCATED to a deterministic safe starting world.
--
-- KEPT (systems are unchanged in identity; only planet-level detail changed):
--   * wallet + ship: credits, fuel, warp_fuel, cargo_cap
--   * cargo / inventory: inventory, player_materials, player_parts, player_upgrades
--   * identity: handle
--   * per-system economy: markets, system_supply
--
-- WIPED (planet/region-scoped, now stale):
--   * world_deltas (per-region depletion)
--   * discoveries (per-planet discovery log)
--   * bases (+ cascading base_buildings / base_storage)
--
-- The destination coordinate below is `startingWorld(WORLD_SEED)` — the first
-- rocky, moderate-temperature, low-hazard planet scanning outward from the
-- origin. It is computed FOR THE PRODUCTION SEED `omniplex-prod-1`
-- (galaxy 0 · arm 0 · cluster 0 · system 1 · planet 0 · region 0). New players
-- spawn at the seed-correct `startingWorld(seed)` at runtime (in
-- `getOrCreatePlayer`); this baked coordinate covers the one-time relocation of
-- EXISTING players. If a deployment runs a different WORLD_SEED, re-point this
-- coordinate before applying — the procedural universe lives in TypeScript, so
-- SQL cannot derive it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Wipe planet/region-scoped world state.
--    base_buildings / base_storage have ON DELETE CASCADE from bases, but we
--    delete them explicitly first so this is robust to FK ordering and obvious.
-- ----------------------------------------------------------------------------
delete from public.base_storage;
delete from public.base_buildings;
delete from public.bases;
delete from public.discoveries;
delete from public.world_deltas;

-- ----------------------------------------------------------------------------
-- 2. Relocate EVERY player to the safe starting world, fully healed and aboard
--    their ship, with any in-progress combat encounter cleared. Wallet, fuel,
--    cargo, materials, parts, upgrades, and handle are untouched.
-- ----------------------------------------------------------------------------
update public.players
set
  galaxy = 0,
  arm = 0,
  cluster = 0,
  system = 1,
  planet = 0,
  region = 0,
  embarked = true,
  health = 100,
  encounter = null;
