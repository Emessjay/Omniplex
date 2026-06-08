-- One-time reset of every GLOBAL market price back to its resource baseline.
--
-- The new gentle, volume-based stickiness model (PRICE_IMPACT in rules.ts)
-- replaces the old per-unit, ≥1-floored impact that let small trades swing
-- prices wildly. Prices already displaced under the old model are snapped back
-- to their `base_value` so the live economy starts from a clean baseline.
--
-- Forward-only and tracked in `schema_migrations`, so this runs EXACTLY ONCE:
-- it will not clobber organically-moved prices on any later deploy.
update public.markets m
   set price = r.base_value, updated_at = now()
  from public.resources r
 where m.resource_id = r.id
   and m.location_key = 'global';
