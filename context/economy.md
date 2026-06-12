# Economy & Markets

Load-bearing decisions extracted from `CLAUDE.md`, in build order.

### Load-bearing decisions from `living-economy`

- **The shared world heals over time** via two slow, time-based mechanics plus a
  demand-side trade. The discipline is **apply-on-read, persist-on-write**: the
  pure recovery math runs every read off a stored timestamp, but state is only
  rewritten (and the recovery clock reset) on an actual mutation. The pure rule
  functions take **`elapsedMs` as a parameter** and never touch `Date` — the
  impure `world.ts` adapters compute `elapsedMs = Date.now() − timestamp` and
  pass it in (the only place `Date.now()` lives).
- **Tuning constants** (all in `src/lib/game/rules.ts`, documented inline):
  - `REGEN_PER_MS = 1 / 86_400_000` — a fully-drained ~1.0 ore vein regenerates
    over ~24h.
  - `PRICE_REVERT_PER_MS = 5e-6` — a ~100-credit price displacement drifts back
    to `base_value` over ~several hours.
  - `BUY_MARKUP = 1.5` — `buy` pays 150% of the current sell price.
- **Pure fns** (mirror the existing `priceAfterSale`/`effectiveAbundance` style):
  `regeneratedDepletion(totalDepleted, elapsedMs, regenPerMs?)` (clamped to
  `[0, totalDepleted]`, monotonically non-increasing in elapsed),
  `priceTowardBase(price, base, elapsedMs, revertPerMs?)` (moves toward `base`
  without overshooting, floored at `PRICE_FLOOR`), `buyUnitCost(price)` =
  `ceil(price * BUY_MARKUP)`, and `priceAfterPurchase(price, qtyBought)` (the
  buy-side mirror of `priceAfterSale`; see `price-stickiness` below for the
  current volume-based impact model that superseded the old per-unit `MARKET_IMPACT`).
- **Regen on read**: `world.getEffectiveDepletionMap(planetKey)` is the
  regen-aware sibling of `getDepletionMap` — it sums depletion deltas and heals
  each resource by the time since its *most recent* delta, returning the same
  `Record<resourceId, depletion>` shape so `scan`/`mine` feed it straight into
  `effectiveAbundance`. Mining still appends a delta, whose fresh `created_at`
  resets that resource's recovery clock.
- **Drift on read**: `getMarketPrices`/`getMarketPrice` apply
  `priceTowardBase(stored, baseValue, now − updated_at)` and round to an integer
  (the `markets.price` column is `integer ≥ 0`). `setMarketPrice` stamps
  `updated_at = now` on every trade, so drift accrues forward from the last
  trade. `sell`, `buy`, and `inventory` all read the drifted price.
- **`buy <resource> [qty]`** (`handleBuyResource` in `commands.ts`): `buy fuel`
  is unchanged; any other arg-0 is a mineral purchase. Validates credits and
  cargo space **before** mutating, then `addInventory` + `addPlayerCredits(−total)`
  + `setMarketPrice(priceAfterPurchase(...))`. The `buy` abbrev domain is
  `["fuel", ...RESOURCES ids]`; the `qty` arg stays opaque (numeric).

### Load-bearing decisions from `price-stickiness`

- **Global prices are deliberately HARD to move.** The old per-unit, `≥1`-floored
  `MARKET_IMPACT = 0.02` (which swung prices on tiny trades and moved cheap goods
  ~20%/unit) is GONE. The current model is a single tunable constant
  `PRICE_IMPACT = 0.0015` (`rules.ts`, 0.15%/unit, **compounding**, NO per-unit
  `≥1` floor): `priceAfterSale(p, q) = max(PRICE_FLOOR, round(p · (1−PRICE_IMPACT)^q))`
  and `priceAfterPurchase(p, q) = round(p · (1+PRICE_IMPACT)^q)`. Same signatures
  as before — handlers (`sell`/`buy`) are unchanged; only the output is gentler.
- **Feel targets** (the reason for the tuning, reason-check before retuning):
  a ~10-unit trade moves a 1000cr price < ~2% (≈ ±15cr); ~500 units ≈ a ~50%
  swing; a single unit of a cheap good rounds to NO change. Monotonic
  (sale non-increasing, purchase non-decreasing in qty); `qty ≤ 0` is a no-op;
  sale floored at `PRICE_FLOOR`. `priceTowardBase` mean-reversion is untouched.
- **One-time reset**: migration `20260608075033_reset-prices.sql` snaps every
  `location_key = 'global'` market `price` back to its `resources.base_value`
  (and stamps `updated_at = now()`). Forward-only + tracked in
  `schema_migrations`, so it runs EXACTLY ONCE — it will not clobber
  organically-moved prices on later deploys.

### Load-bearing decisions from `upgrade-economy`

- **P9a turns ship upgrades into MANUFACTURED goods with a finite, player-driven
  market supply.** Two coupled changes, both reusing existing machinery (no
  fork):
  1. **Upgrade recipes are now SHIP PARTS, not raw minerals.** `Upgrade.recipe`
     keys are PART ids (`upgrades.ts`): Ablative Shields =
     `{ hull_plating: 2, alloy_beam: 1 }`, Antifreeze Tanks =
     `{ circuit_board: 2, sensor_array: 1 }`. `recipeCost` now sums **`partValue`**
     (× qty) and `upgradeValue = round(recipeCost × CRAFT_VALUE_MARKUP)` is
     unchanged in formula but much higher in absolute value (parts are valuable).
     `upgrades.ts` imports `getPart` from `parts.ts` (one-way; no cycle).
  2. **Upgrades moved OFF manual `craft` onto `produce`.** `craft` now ONLY cooks
     food (P6). `craft <upgrade>` errors with a redirect to `produce` + a
     production line. To make that redirect reachable (the resolver would
     otherwise reject an unknown arg), **`craft`'s arg domain is now OPAQUE
     (`null`)** and `handleCraft` resolves the food prefix itself via
     `resolveToken(target, FOOD_IDS)` (foods still abbreviate handler-side; `help
     craft` shows a `<food>` placeholder + hint). `produce`'s arg domain is now
     `[...PART_IDS, ...UPGRADE_IDS]`.
- **`produce <upgrade>`** (`handleProduceUpgrade`, branched out of `handleProduce`
  after the shared base + production-line checks): consumes the upgrade's siloed
  **PART** inputs (`add_base_storage(-)`) and **grants the upgrade to the player**
  (`add_player_upgrade(+1)`) — NOT banked into storage, so there's NO capacity
  check (upgrades don't sit in the silo). Validates `canProduce(siloed, recipe,
  qty)` BEFORE mutating; atomic; ungated by embark state (it's your base, like
  parts). Supports `qty`.
- **Finite buyable SUPPLY** lives in `public.upgrade_market` (migration
  `20260608120000_upgrade-economy.sql`, forward-only/idempotent): `upgrade_id
  text pk`, `supply integer ≥ 0`, `updated_at`. **PUBLIC read** (shared market,
  like `markets`/`bases`); service-role writes only. Atomic
  `add_upgrade_supply(upgrade, delta)` RPC (clamped ≥ 0, stamps `updated_at`),
  mirroring `add_player_upgrade`/`add_base_storage`. **Seeded 3 per upgrade** via
  `on conflict do nothing` (runs once; never clobbers organically-moved supply).
  The seeded ids MUST stay in lock-step with `UPGRADES`. `world.ts` adapters:
  `getUpgradeSupply(id)`, `getUpgradeSupplies()` (for the view),
  `addUpgradeSupply(id, delta)`.
- **buy/sell upgrade supply mechanics** (still embarked-only economy; PRICE stays
  code-derived `buyUnitCost(upgradeValue)` — only SUPPLY is the new mechanic):
  `buy <upgrade>` requires `canBuyFromSupply(supply)` (pure, `supply > 0`, in
  `upgrades.ts`) — out of stock errors "someone must manufacture and sell one";
  validates `supply ≥ qty` BEFORE charging, then `add_upgrade_supply(-qty)`.
  `sell <upgrade>` is unchanged in payout but now also `add_upgrade_supply(+qty)`
  — so the ONLY way buyable stock grows is players manufacturing + selling.
- **Supply is surfaced in the `upgrades` market view** (`renderUpgrades` /
  `UpgradesView.market`): a "Market (finite supply)" section listing each upgrade
  as `N in stock (price)` (clickable `buy` when in stock) or "out of stock". The
  owned-none hint points to `produce` (no longer a clickable `craft`).
- **Landing gate unchanged** (`canLand`/`landingRequirement`, owning ≥ 1
  Ablative/Antifreeze) — you just obtain upgrades via `produce`/`buy` now.
  `ship-upgrades.test.ts` was migrated: the recipe-component assertion now expects
  the parts-based recipes (the value-band `(cost, 2×cost)` assertion still holds at
  `CRAFT_VALUE_MARKUP = 1.2`).
- **For P9b**: render unbuyable (out-of-stock / unaffordable) and otherwise-
  unperformable action tokens RED. The supply read (`getUpgradeSupplies`) +
  `canBuyFromSupply` are the hooks for the out-of-stock case.

### Load-bearing decisions from `per-system-market`

- **Resource prices are PER-SYSTEM (P12a), not one global market.** The `markets`
  table is now keyed by `location_key = systemKey(systemOf(player))` (the 4-seg
  `"galaxy:arm:cluster:system"`), replacing the hardcoded `'global'`. **NO
  migration** — the table's `(location_key, resource_id)` PK already supported any
  key; the pre-P12 `'global'` rows are now INERT (never read/written) and may be
  cleaned up later. `world.ts` market adapters all take a leading `locationKey`:
  `getMarketPrices(locationKey)`, `getMarketPrice(locationKey, resourceId)`,
  `setMarketPrice(locationKey, resourceId, price)`.
  - **Untraded system → `base_value`.** A system with no stored row for a resource
    defaults to that resource's catalog `base_value`. `getMarketPrices` SEEDS the
    full `RESOURCES` map at `base_value` then overrides with drifted stored rows;
    `getMarketPrice` falls back to `base_value` on a missing row (null only for an
    unknown id). So `sell`/`buy` always have a price at a fresh system.
  - **Reversion target = `getResource(id).baseValue`**, applied on read via the
    unchanged `priceTowardBase(stored, base, now − updated_at)` — now per system
    row, so EACH system reverts on its own clock with no player present.
  - **`setMarketPrice` is now an UPSERT** on `(location_key, resource_id)` (was a
    bare UPDATE): the FIRST trade in a system CREATES its row (most systems start
    rowless), later trades update it + stamp `updated_at = now`. Trades read+write
    ONLY the current system's rows, so prices move locally; travelling never moves
    a price (you just see the destination's reverted/base prices).
  - Materials/upgrades stay CODE-priced (not in `markets`, no per-system pricing);
    only resource PRICES went per-system. Upgrade SUPPLY stays global this phase
    (per-system supply + parts-as-tradeable = P12b).
- **Economy is gated by LOCATION, not embark (supersedes embarked-only).** The
  single applicability source (`applicability.ts`) gained `atTradeLocation` on
  `PlayerStateView` and a new `ECONOMY = {buy, sell}` bucket: economy commands are
  applicable iff `atTradeLocation && !inCombat`, REGARDLESS of embark state (trade
  aboard or on foot once you've arrived somewhere inhabited). `buy`/`sell` left the
  old `EMBARKED_ACTIONS` set (now just travel: `warp`/`land`/`hyperwarp`/
  `disembark`). `atTradeLocation(player, seed)` (in `commands.ts`) = `atOutpost`
  (region === −1) OR `hasSettlement(seed, currentRegionCoord)`; `playerState` now
  takes `seed` to compute it. `dispatchResolved` rejects an off-market economy verb
  with the trade-location message (`isEconomyVerb` exported from `applicability`);
  `scan` at a settlement / the outpost surfaces clickable `buy`/`sell` hints.
  **Travel stays embarked-only; surface/combat rules unchanged.** Help-parity +
  P10 per-state applicability + P9b red-marking all stay consistent (the existing
  `context-help`/`help-args` suites were updated to the 3-field state, not weakened).
- **Biofuel — the anti-softlock conversion.** `craft biofuel <flora|animal
  material> [qty]` refines plant/animal materials into REGULAR fuel so an empty
  tank in deep space (where `buy fuel` is now trade-gated) can never strand you.
  `craft` is OPAQUE-armed, so `handleCraft` resolves `biofuel` (+ foods +
  condensate) handler-side; `handleCraftBiofuel` resolves the material against the
  player's OWNED flora/animal stacks (abbreviates; non-bio/unowned → clear error),
  consumes them (`add_player_material(-)`) and adds fuel (`setFuel`), validating
  ownership first. **`craft` works anywhere** (ungated by location; out-of-combat
  like all fabrication). The pure rule is `biofuelYield(materialValue, qty)` in
  `rules.ts` (`floor(materialValue·qty·BIOFUEL_EFFICIENCY / REGULAR_FUEL_PRICE_PER_UNIT)`,
  `BIOFUEL_EFFICIENCY = 0.5`) with the **loss invariant**: fuel credit-value
  `< materials' credit-value` for all positive inputs (since `EFF < 1`). Seeded
  contract: `src/lib/game/per-system-market.test.ts`.

### Load-bearing decisions from `supply-market`

- **The finite buyable SUPPLY is now PER-SYSTEM and self-reverting (P12b)** — for
  ship UPGRADES (was global in P9a) AND ship PARTS (newly tradeable). New
  `public.system_supply` table (migration `20260608150000_supply-market.sql`,
  forward-only/idempotent): `(location_key, item_id, supply int ≥0, updated_at,
  PK(location_key,item_id))`, where `location_key = systemKey(systemOf(player))`
  (the 4-seg `"galaxy:arm:cluster:system"`) and `item_id` is a code catalog id
  (an upgrade id OR a part id — they don't collide; no FK, like
  `upgrade_market`/`base_storage`). **PUBLIC read** (shared market signal, like
  `markets`); service-role writes only. **Rows are LAZY**: a system+item with no
  row reads as that item's code BASELINE. This SUPERSEDES the global P9a
  `upgrade_market` table — those rows are now **inert** (never read/written), left
  in place (forward-only; a later migration may drop them). The
  `getUpgradeSupply`/`getUpgradeSupplies`/`addUpgradeSupply` world adapters were
  REPLACED by `getSystemSupply(locationKey, itemId)`,
  `getSystemSupplies(locationKey)`, `setSystemSupply(locationKey, itemId, supply)`.
- **Reversion-on-read, persist-on-write** (the SUPPLY-side mirror of P12a's
  per-system PRICE mean-reversion — same discipline, don't fork). Pure rule in
  `rules.ts`: `supplyTowardBaseline(supply, baseline, elapsedMs, ratePerMs?)`
  moves `supply` toward `baseline` by `ratePerMs·elapsedMs` without overshooting,
  clamped ≥0 + integer (mirror of `priceTowardBase`; `elapsedMs` passed in, never
  touches `Date`). Constants: `UPGRADE_SUPPLY_BASELINE = 3` (the old global seed),
  `PART_SUPPLY_BASELINE = 5`, `SUPPLY_REVERT_PER_MS = 1/3_600_000` (~1 unit/hr).
  `world.ts` `driftedSupply`/`supplyBaseline` apply it on read (lazy row →
  baseline; parts→PART baseline, else UPGRADE baseline). The atomic clamped RPC is
  `set_system_supply(p_location, p_item, p_supply)` — an ABSOLUTE upsert (not a
  delta — lazy baseline rows make a delta-from-0 RPC wrong), clamped via
  `greatest(0, …)`, stamps `updated_at = now`. Trades do read-effective →
  `setSystemSupply(effective ± qty)`. So every system's stock drifts to baseline
  on its OWN clock with NO player present. Seeded contract:
  `src/lib/game/supply-market.test.ts`.
- **Ship parts are a fully tradeable commodity.** New `public.player_parts`
  (`player_id → players on delete cascade, part_id text, qty int ≥0,
  PK(player_id,part_id)`, RLS read-own, service-role writes, atomic
  `add_player_part(player, part, delta)` RPC) — the ship's **parts store**, a
  SEPARATE cargo lane from the resource hold (`inventory`); like
  `player_materials`/`player_upgrades`, parts do NOT count against `cargoCap`.
  World adapters `getPlayerParts`/`addPlayerPart` mirror the materials ones.
  - **`buy <part> [qty]`** (`handleBuyPart`): economy-gated (`atTradeLocation`,
    via the `buy` dispatch gate); gated by the current system's part supply
    (`canBuyFromSupply` + `supply ≥ qty`); cost `buyUnitCost(partValue)` per unit;
    decrements the system supply (`setSystemSupply(supply − qty)`); lands in
    `player_parts`. No cargo-space check (separate store).
  - **`sell <part> [qty]`** (`handleSellPart`): pays `partValue`/u from
    `player_parts`; INCREMENTS the current system's part supply
    (`setSystemSupply(current + qty)`). Default qty = whole stack.
  - **`deposit <part>` / `withdraw <part>`** now bridge parts between
    `player_parts` (cargo) and `base_storage` (silo) — **P8b's "parts can't be
    withdrawn" block was LIFTED**. `handleDeposit`/`handleWithdraw` branch on
    `isPartId`: parts source/destination is `player_parts` (uncapped), resources
    use `inventory` (cargo-space bounded); both land in / leave the silo via
    `add_base_storage`. `produce` still consumes parts FROM the silo (unchanged).
- **buy/sell upgrades went per-system** too (`handleBuyUpgrade`/`handleSellUpgrade`
  + the `upgrades` market view + `help buy`): all read this system's supply via
  `getSystemSupply`/`getSystemSupplies` (rowless = `UPGRADE_SUPPLY_BASELINE`),
  persist via `setSystemSupply`. PRICES stay code-derived (`buyUnitCost`/value) —
  only SUPPLY is per-system. Trade-help gained a **`"parts"` `TradeCategory`**
  (`tradeCategoryOf`: `isPartId` → parts, ordered fuel→minerals→parts→upgrades→
  everything); `buy`/`sell`/`deposit`/`withdraw` abbrev domains include part ids;
  P9b red-marking (`buyDisabled`/`tradeAnnotation` parts branch — out-of-stock /
  unaffordable) + help-parity + per-state applicability all intact. `inventory`
  lists held parts (`InventoryView.parts`) with `sell`/`deposit` actions.
- **For later phases**: more supply-market item kinds drop into `system_supply`
  by id (no schema change — `item_id` is free-text); per-system part PRICES (vs
  code-derived) would extend the `markets` keying, not `system_supply`.
