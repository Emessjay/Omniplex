-- orbit-land: separate ORBITING from LANDED (orbit-land).
--
-- A planet is now a three-state machine per player:
--   Orbiting  (embarked, !landed)  — aboard, above the planet
--   Landed    (embarked,  landed)  — aboard, on the surface (rocky only)
--   On-foot   (!embarked)          — disembarked on the surface (always landed)
--
-- INVARIANT: `!embarked ⇒ landed` (you can't be on foot up in orbit). The new
-- `landed` column carries the orbit-vs-surface dimension; `orbit` burns DISTANCE
-- fuel, `land` (descent) is free, `launch` bills the ATMOSPHERE climb back to
-- orbit. New players spawn Orbiting (landed=false); warp/hyperwarp arrive Orbiting.
--
-- Forward-only / idempotent.

alter table players
  add column if not exists landed boolean not null default false;

-- Keep existing players in a VALID state. On-foot players (embarked=false) are,
-- by the invariant, on the surface — mark them landed. Embarked players default
-- to Orbiting (landed=false, the column default) and simply re-`land` as needed.
update players set landed = true where embarked = false;
