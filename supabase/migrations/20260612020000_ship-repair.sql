-- ============================================================================
-- ship condition + repair (Combat-2 stakes primitive). Forward-only, idempotent.
-- ============================================================================
-- Combat losses never DESTROY a ship: a defeated ship is towed to the nearest
-- station at a low "disabled" condition (rewiring the Combat-1b loss path —
-- which previously fully healed + charged a credit fine), where the player
-- `repair`s it (credits or mined metal, at a trade location). A disabled ship is
-- still flyable, so a broke player can limp out, mine, and repair — the ship is
-- never taken away and you're never stranded. This is the SHARED stakes layer
-- the upcoming raids (2a) + ship piracy (2b) also route their loss through.
--
-- This migration is purely ADDITIVE (one defaulted column on `players`; prod-
-- safe, like the notoriety/manifold columns): no new table, no RLS change, no
-- data rewrite. The column rides the existing `players` row (NOT exposed on the
-- public `leaderboard` view — ship condition isn't public).
-- ============================================================================

-- Ship condition: 0 = wreck, 100 = pristine. Default 100, range-checked. Existing
-- players start pristine (no backfill needed — the default applies to current
-- rows via `add column ... default`). A newly-acquired ship is set back to 100 by
-- the app (`world.setShip`); a combat defeat drops it to the disabled floor.
alter table public.players
  add column if not exists ship_condition integer not null default 100
    check (ship_condition between 0 and 100);
