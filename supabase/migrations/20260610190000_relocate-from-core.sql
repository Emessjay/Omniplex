-- Relocate players sitting in radiation-shield-gated clusters (0..25, where
-- galacticRadiation > RADIATION_SHIELD_THRESHOLD=60) to the safe RIM starting
-- world, so the radiation-hazard deploy doesn't strand them on an un-landable
-- core world. The destination is startingWorld('omniplex-prod-1') under the
-- post-radiation rim spawn (SPAWN_CLUSTER = MAX_CLUSTERS_PER_ARM-1 = 63):
--   (galaxy 0, arm 0, cluster 63, system 3, planet 2, region 0)
-- SQL can't run the TS generator, so the coord + the cluster boundary (25) are
-- baked from the prod seed. Re-point both if a deployment uses a different
-- WORLD_SEED. Forward-only / runs once (schema_migrations-tracked).
update public.players
set galaxy = 0, arm = 0, cluster = 63, system = 3, planet = 2, region = 0,
    health = 100, embarked = true, landed = false, encounter = null
where cluster <= 25;
