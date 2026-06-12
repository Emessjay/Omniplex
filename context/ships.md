# Ships & Upgrades

Load-bearing decisions extracted from `CLAUDE.md`, in build order.

### Load-bearing decisions from `ship-upgrades`

- **Upgrade catalog lives in code** (`src/lib/game/upgrades.ts`), like
  `RESOURCES`: `UPGRADES`/`UPGRADE_IDS`/`isUpgradeId`/`getUpgrade`/`recipeOf`/
  `recipeCost`/`upgradeValue`. Recipes: Ablative Shields = titanium+silica,
  Antifreeze Tanks = titanium+iron. `upgradeValue = round(recipeCost ×
  CRAFT_VALUE_MARKUP)` (~1.2 — "a bit above components"). Upgrades are NOT in
  the `markets` table (no FK, no price drift); prices are code-derived.
- **Ownership** in `public.player_upgrades` (migration
  `20260608073000_ship-upgrades.sql`): `(player_id, upgrade_id, qty)`, RLS
  read-own, service-role writes, atomic `add_player_upgrade(player, upgrade,
  delta)` RPC clamped at 0. Owning ≥1 = capability active; selling the last
  one removes it.
- **Landing gate** (`canLand`/`landingRequirement` in `rules.ts`,
  `FREEZING_C` 0 / `BOILING_C` 100, boundaries survivable): `land` and `mine`
  are blocked on a world below freezing (needs Antifreeze Tanks) or above
  boiling (needs Ablative Shields) unless owned; **`warp` is never gated**
  (arrive in-orbit at planet 0 → can't softlock). `scan` shows the requirement.
- **`craft <upgrade>`** consumes recipe components from inventory atomically
  (validate `canCraft` first). `buy`/`sell` extended to upgrade ids (buy at
  `buyUnitCost(upgradeValue)`, sell at `upgradeValue`). Abbrev domains: `craft`
  → upgrade ids; `buy`/`sell` → resources + upgrade ids.

### Load-bearing decisions from `ships` (Keystone 2a)

- **Buyable ships: the credit SINK + cargo/hauling ladder.** Wealth finally
  buys something aspirational; bigger cargo unlocks real hauling/arbitrage/
  bigger contract deliveries. (Ship fuel/speed/modules + production-built ships/
  stations are 2b+.)
- **`SHIPS` catalog** (`src/lib/game/ships.ts`, pure): `Ship = {id, name,
  cargoCap, price, blurb?}`; 4 ships STRICTLY ascending in both cargo & price —
  `shuttle`(50, free, the STARTER) → `courier`(150, 6k) → `freighter`(500, 50k)
  → `hauler`(1500, ~250k). Helpers `SHIPS`/`SHIP_IDS`/`STARTER_SHIP_ID`/
  `isShipId`/`getShip`/`shipCargoCap`/`shipTradeIn`. `shipTradeIn = floor(price ×
  TRADE_IN_FRACTION[=0.7])` (< price — reselling toward an upgrade is always a
  net loss, a sink).
- **The ship is the SINGLE source of cargo capacity.** `players.ship_id text
  default 'shuttle'` (migration `20260610000000_ships.sql`, forward-only/
  idempotent; the shuttle's cargoCap 50 matches the pre-existing `cargo_cap`
  default, so existing players need no cargo migration), carried on `Player`/
  `PlayerRow`/`rowToPlayer`. `world.setShip` writes `ship_id` + `cargo_cap` (=
  the ship's cargoCap) in ONE update, so all existing `player.cargoCap` cargo
  checks keep working unchanged.
- **Commands**: `shipyard` (INFORMATIONAL, anywhere — lists catalog, marks
  current/affordable/trade-in, P9b red off-hub/unaffordable/overflow-downgrade)
  + `buyship <id>` (ECONOMY — `atTradeLocation && !inCombat`): net cost =
  `price − shipTradeIn(currentShip)`; validate affordable + not-current + your
  current cargo fits the new ship (reject overflow downgrade) BEFORE charging;
  atomic `addPlayerCredits(-net)` + `setShip`. `inventory` shows the ship.
  Seeded: `ships.test.ts`. **Keystone 2b** (constructions: production-built
  ships/stations/base tiers) builds on this.

### Load-bearing decisions from `construct-ships` (Keystone 2b)

- **Production now BUILDS ships** — `produce <ship>` is the alternative to
  buying (2a), closing the chain mine→ingot→part→**ship**. Building costs
  materials worth LESS than the cash price (the producer's payoff), never free.
  NO migration (recipes are code; `produce` extended).
- **Ship recipes** (`ships.ts`): every ship except the starter `shuttle` has a
  `recipe` (Record of PART/INGOT id → qty). Helpers `shipRecipeOf(id)` (null for
  the starter), `isBuildableShip(id)`, `shipRecipeValue(id)` (Σ part/ingot value
  × qty). **Invariant: `0 < shipRecipeValue < getShip(id).price`** and recipe
  value ascends with cargo (courier 3580<6000 / freighter 26450<50000 / hauler
  121920<250000).
- **`produce` 4th branch** (`commands.ts`): `isShipId` + buildable → build a
  ship. Requires a base in-region with a **production_line**, **powered** (reuse
  the produce power gate), recipe inputs siloed (`canProduce`), not-already-your-
  ship, current cargo fits (no overflow-downgrade), qty must be 1. Consumes the
  recipe from `base_storage` then `setShip(id)` (ship_id + cargo_cap, the same
  swap `buyship` uses) — NO credit cost. Validate-before-mutate, atomic. The
  `produce` arg domain + the `storage` buildable list include buildable ships
  (P9b red when not producible). Seeded: `construct-ships.test.ts`. (2c —
  stations / base-tier upgrades — builds on this.)
