-- generic-existing-handles: neutralize email-derived player handles
-- ---------------------------------------------------------------------------
-- One-time: replace existing (email-derived) player handles with generic,
-- non-identifying callsigns derived from the player's uuid (unique, never from
-- email), so no real names remain in the public leaderboard/who/bases. Runs
-- ONCE (schema_migrations-tracked); new players already get generated callsigns
-- in code (neutral-handles).
update public.players
   set handle = 'pilot-' || left(replace(id::text, '-', ''), 10);
