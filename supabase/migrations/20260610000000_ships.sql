-- ships (Keystone 2a): buyable ships — the credit sink + cargo/hauling ladder.
--
-- A player now flies a SHIP, chosen from the code catalog (`src/lib/game/
-- ships.ts`). The ship is the single SOURCE of cargo capacity: buying one sets
-- BOTH `ship_id` AND `cargo_cap` (= the ship's cargoCap) in one write, so every
-- existing `player.cargoCap` cargo-space check keeps working unchanged.
--
-- `ship_id` defaults to the starter `'shuttle'`, whose catalog cargoCap (50)
-- equals the pre-existing `players.cargo_cap` default — so EXISTING players
-- become the starter ship with their cargo capacity unchanged, and NO cargo
-- migration is needed.
--
-- Forward-only / idempotent.

alter table players
  add column if not exists ship_id text not null default 'shuttle';
