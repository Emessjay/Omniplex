# Survival & Combat

Load-bearing decisions extracted from `CLAUDE.md`, in build order.

### Load-bearing decisions from `survival-core`

- **Embark state machine.** A player is either `embarked` (aboard ship) or
  on foot in the current region. `players.embarked boolean not null default
  true` + `players.health integer not null default 100 check (health >= 0)`
  (migration `20260608090759_survival-core.sql`, forward-only/idempotent) carried
  on `Player`/`PlayerRow` + `rowToPlayer`. New players spawn embarked at full HP.
  `disembark` (embarked→on foot) and `embark` (on foot→aboard) toggle it via
  `world.setEmbarked`; both are idempotent-friendly. `warp`/`land` do NOT change
  embark state (you stay aboard to fly).
- **Command gating by embark state** (`dispatchResolved` in `commands.ts`, two
  `Set`s checked before the switch): `EMBARKED_ONLY = {buy, sell, warp, land}`
  (the economy + ship travel; `buy fuel` is covered by `buy`) errors "You must
  `embark` your ship first." when on foot; `DISEMBARKED_ONLY = {mine}` errors
  "You must `disembark` onto the surface to mine." when aboard. Everything else
  (`scan`/`map`/`inventory`/`upgrades`/`who`/`help`/`jump`/`regions`/`craft`) is
  state-agnostic. **P5 `explore` joins `DISEMBARKED_ONLY`** (today it's a
  coming-soon stub, `handleExplore`).
- **Hazard damage model is PURE in `rules.ts`** (rolls passed in; handler supplies
  `Math.random()`): `MAX_HEALTH=100`, `DEATH_GOLD_PENALTY=0.1`,
  `HAZARD_DAMAGE_MAX=40`. `damageChance(hazard)=clamp01(hazard)` (chance an action
  harms you; 0 at hazard 0, monotonic). `damageAmount(hazard, roll)=max(1,
  round(HAZARD_DAMAGE_MAX·hazard·(0.5+0.5·roll)))` (magnitude; positive int for
  hazard>0, monotonic in both args). `rollHazardDamage(hazard, chanceRoll,
  magnitudeRoll)` = 0 if `chanceRoll >= damageChance` else `damageAmount`.
  `creditsAfterDeath(c)=floor(c·0.9)` floored at 0. Seeded contract:
  `survival-core.test.ts`.
- **Damage applies AFTER a successful disembarked action** (this phase: `mine` —
  the ore is granted first, then `rollHazardDamage(planet.hazard, …)` subtracts
  from health). Hazard is PLANET-level (unchanged). On HP>0 after damage:
  `world.setHealth`, report damage + remaining HP in `danger` style. On HP≤0:
  **death sequence** — `addPlayerCredits(-(credits − creditsAfterDeath(credits)))`
  (atomic credit RPC; never negative), then `world.setHealthAndEmbarked(id,
  MAX_HEALTH, true)` (full HP, wake aboard, **location unchanged**), with a death
  frame. P5 (flora/fauna/combat/scavenging) and P6 (food) build directly on
  disembarked actions + this health model.
- **`scan` and `inventory` show survival status** — an `HP n/100` readout (red
  when ≤30%) + `aboard ship`/`on foot`, threaded through `ScanView`/
  `InventoryView` (`render.ts`). Disembarked surfacing only; the rules stay pure.

### Load-bearing decisions from `wildlife`

- **Materials subsystem** (the spoils of the on-foot loop) mirrors `upgrades`
  exactly: code catalog `src/lib/game/materials.ts` (`MATERIALS` =
  `{ id, name, category: "flora"|"animal"|"relic"|"mineral", value }`, helpers
  `isMaterialId`/`getMaterial`/`materialValue`), code-priced (NOT in `markets`,
  no drift, like upgrades). Ownership in `public.player_materials`
  (`player_id, material_id, qty`, pk, qty≥0 check, RLS read-own, service-role
  writes) + atomic `add_player_material(player, material, delta)` RPC, both added
  in migration `20260608093000_wildlife.sql` (forward-only/idempotent). World
  adapters `getPlayerMaterials`/`addPlayerMaterial` in `world.ts`. Relics
  (`precursor_relic`, `void_idol`) are the rare high-value tier.
- **Flora/fauna catalogs** in `src/lib/game/wildlife.ts` (code, no DB): `FLORA`
  (`{ id, name, biomes: Biome[], harvest: { materialId, qty } }`) and `FAUNA`
  (`{ id, name, biomes, maxHp, attack, hostile, drop: { materialId, qty } }`).
  Every one of the 10 `BIOMES` has ≥1 flora AND ≥1 fauna so `explore` always
  finds something (guarded in `wildlife-catalog.test.ts`). Helpers
  `floraForBiome`/`faunaForBiome`/`getFauna`/`getFlora` and the PURE selector
  `pickForBiome(list, biome, roll)` — filters to biome-valid entries then indexes
  by roll, so a pick is ALWAYS biome-appropriate (AC#2); `null` if none.
- **Combat is PURE in `rules.ts`**: `PLAYER_BASE_ATTACK = 12` (flat — no weapon
  upgrades yet), `combatRound({playerHp, playerAtk, creatureHp, creatureAtk})`
  deals damage to BOTH sides at once (clamped ≥0, `playerDead`/`creatureDead`
  flags; both can die in one round). `exploreOutcome(roll)` partitions `[0,1)` →
  `scavenge` `[0,0.30)` / `flora` `[0.30,0.65)` / `fauna` `[0.65,1)` (thresholds
  `EXPLORE_SCAVENGE_MAX`/`EXPLORE_FLORA_MAX`). Handlers supply the real
  `Math.random()` rolls (same pattern as the P4 hazard model).
- **Combat state** is `players.encounter jsonb` (nullable; `null` = not fighting,
  else `{ faunaId, hp }`), on `Player`/`PlayerRow`/`PlayerEncounter` +
  `rowToPlayer`. `world.setEncounter(id, enc|null)` is the mutator. Set on a fauna
  encounter (hostile AND placid — so `attack` always has a target), cleared on
  kill / `flee` / death.
- **Commands** (`commands.ts`): `explore`/`harvest`/`attack`/`flee` joined
  `VERBS`+`USAGE` (P4 explore stub replaced; help parity green).
  `explore`/`harvest`/`attack`/`flee` are all in `DISEMBARKED_ONLY`;
  `attack`/`flee` additionally need an `encounter` (handler-checked, helpful
  error else). `explore` rolls `exploreOutcome` → scavenge (`pickScavenge` award)
  / flora (offer `harvest`) / fauna (set `encounter`), then takes the P4
  hazard roll (can kill → death). Gated by `canLand` like `mine` (hostile
  surface needs the upgrade). `harvest` re-rolls a biome flora (no hazard).
  `attack` = one `combatRound`: creature dies → award `drop` + clear encounter;
  player dies → death sequence; else update both HPs. `flee` clears the
  encounter (no parting hit). The P4 death sequence was extracted to the shared
  `runDeath(player, causeText)` helper (also clears any encounter); `mine` now
  uses it too.
- **Selling**: `sell <material> [qty]` (embarked-only, like all economy) pays
  `materialValue`/u via `handleSellMaterial` (code-priced, no cargo, no `all`
  inclusion — default qty = whole stack). `sell`'s abbrev domain now appends
  OWNED material ids. `scan` shows an active encounter (creature + HP +
  `attack`/`flee`) via `ScanView.encounter`/`EncounterView`; `inventory` lists
  owned materials with their fixed value (`InventoryView.materials`).
- **For P6 (food)**: animal/flora materials become healing items there. P9's
  market-supply ideas may extend material selling. Combat is one-creature-at-a-
  time; no flee-into-new-encounter chains.

### Load-bearing decisions from `food`

- **Food are materials** with `category: "food"` (`src/lib/game/materials.ts`) —
  no new table; they reuse `player_materials` storage, the `sell <material>`
  path, and `getPlayerMaterials`/`addPlayerMaterial` exactly like every other
  material. What sets food apart: an optional **`heal`** field on `Material`
  (HP restored by `eat`; present + `> 0` only on food) and a **cooking recipe**.
  Helpers: `FOOD`/`FOOD_IDS`/`isFoodId`/`healOf(id)` (0 for inedible) +
  `FOOD_RECIPES`/`foodRecipeOf(id)` (food id → `{ materialId: qty }` of OTHER
  materials; throws on unknown). Food carry a real `value` so they're sellable
  too, but the point is `heal`. **`SCAVENGEABLE` now excludes `food`** (alongside
  `animal`) — cooked food is crafted, never found/dropped.
- **Cooking via `craft`** (no new verb): `handleCraft` branches up front —
  `isFoodId` → `handleCookFood` (consume MATERIAL ingredients from
  `player_materials`, then grant one food), else the existing upgrade path
  (consume MINED resources from cargo). Validation reuses the pure `canCraft(have,
  recipe)`; consumption is atomic via `add_player_material(-qty)`. `craft`'s
  abbrev domain is `[...UPGRADE_IDS, ...FOOD_IDS]`. Cooking is **un-gated** by
  embark state (matches `craft`).
- **`eat <food>`** (`handleEat`, new `VERBS`+`USAGE` entry): validates ownership
  + edibility (inedible material / unowned → clear error, no state change), reads
  the freshest HP, then `setHealth(healValue(hp, healOf(food), MAX_HEALTH))` and
  `add_player_material(-1)`. Refuses at full HP. **Un-gated** by embark state
  (you take damage on foot, but a snack aboard is fine). Reports HP before→after.
  Its abbrev domain = OWNED food ids (loaded in `loadArgDomainContext` like
  `sell`/`mine`; `ArgDomainContext.eatCandidates`).
- **Pure heal math** is `healValue(currentHp, healAmount, maxHp = MAX_HEALTH)` =
  `min(maxHp, currentHp + max(0, healAmount))` in `rules.ts` — never overheals,
  a non-positive heal can't reduce HP. Seeded contract: `food.test.ts`.
- **Inventory display**: `InventoryView.materials[]` items gained an optional
  `heal`; `renderInventory` shows `+N HP` and an `eat <id>` action for food
  (alongside the existing `sell` action). **No migration** — food is pure catalog
  + craft-extension + `eat`; `player_materials` already stores it.
- **For later phases**: cooking stations / buildings are production-era (P7–P9);
  this phase is catalog + `craft` branch + `eat` only.

### Load-bearing decisions from `combat-fitting` (Combat-1a — ship modules + loadouts)

- **The FITTING foundation for the Combat pillar (per `docs/design/pillars.md`
  §iv): ships have module slots; modules are a manufactured good you `equip` into
  a persisted loadout.** Ships GEAR + fitting UX only — **NO fighting** (the
  interactive phase resolver + PvE bounty board = Combat-1b, which consumes the
  loadout and is where module `stats` finally bite).
- **`src/lib/game/modules.ts` (pure, mirrors `parts.ts`)**: `ShipModule = {id,
  name, slot, recipe (PART ids), value, stats}`; `ModuleSlot =
  weapon|shield|evasion|ecm|targeting`; `ModuleStats` is a discriminated union
  keyed by slot (weapon `{damage, profile: burst|sustained|missile}`, shield
  `{absorb}`, evasion `{evade}`, ecm `{jam}`, targeting `{lock}` — all positive).
  Helpers `MODULES`/`MODULE_IDS`/`isModuleId`/`getModule`/`moduleRecipeOf`/
  `moduleValue`/`moduleInputValue`. 7 modules covering all 5 slots; **invariant
  (unit-tested): `moduleValue > moduleInputValue`** (`value =
  round(inputValue × MODULE_VALUE_MARKUP=1.4)` — manufacturing adds value, like
  parts/ingots). Recipes reference only real `PARTS`.
- **`Ship.slots`** added to every `SHIPS` entry, **strictly ascending** (shuttle 2
  → courier 3 → freighter 4 → hauler 5); helper `shipSlots(id)`. Any module fits
  any slot (shallow model — no per-slot-type counts).
- **Pure fitting rules** (`modules.ts`): `canEquip(loadout, ownedQty, moduleId,
  shipSlots)` = free slot (`loadout.length < shipSlots`) AND an unfitted owned
  copy (`count(moduleId in loadout) < ownedQty`); `loadoutAfterEquip` (append),
  `loadoutAfterUnequip` (remove FIRST occurrence, no-op if absent), `trimLoadout(
  loadout, newSlots)` = `slice(0, max(0,newSlots))`. Seeded: `combat-fitting.test.ts`.
- **Persistence** (migration `20260611000000_combat-fitting.sql`, forward-only/
  idempotent): `public.player_modules` (`player_id→players cascade, module_id text
  [code catalog, no FK], qty int ≥0, pk(player_id,module_id)`, **RLS read-own** +
  service-role writes, atomic clamped `add_player_module(p_player, p_module,
  p_delta)` RPC — mirrors `player_parts`); **`players.loadout jsonb default '[]'`**
  = the fitted module-id list (slot order; may repeat). Carried on `Player.loadout:
  string[]`/`PlayerRow`/`rowToPlayer` (defensive `Array.isArray ?? []`). World
  adapters `getPlayerModules`/`addPlayerModule`/`setLoadout`.
- **Commands**: `produce <module>` is a NEW `handleProduce` branch (after the
  shared base + production-line + **power** gate, like parts/upgrades/ships):
  consume the part recipe from the silo (`add_base_storage(-)`), GRANT the module
  to `player_modules` (`add_player_module(+)`, NOT siloed → no capacity check);
  `produce` arg-0 domain gains `...MODULE_IDS`. **`equip <module>`/`unequip
  <module>`** (`ANYTIME_OUT_OF_COMBAT` — refit anywhere but not mid-fight): arg
  domains are owned-and-`canEquip`-now / currently-fitted respectively (loaded in
  `loadArgDomainContext`). **`loadout` (alias `fit`)** (INFORMATIONAL): the fitting
  screen (slots used/total, fitted + owned-unfitted modules, P9b red when no free
  slot) via `renderLoadout`. **Ship-change loadout trim**: BOTH `handleBuyShip`
  AND `handleProduceShip` call `setLoadout(trimLoadout(loadout, newShip.slots))`
  after the swap (a downgrade leaves the extras owned-but-unfitted). `inventory`
  lists owned modules with an `equip` action. Registered `VERBS`/`USAGE`/
  `applicability`; help-parity held.
- **Deferred (Combat-1b+)**: the resolver/combat-session/bounty board; module
  `stats` are stored but UNUSED here. **Buying/selling modules at hubs** is a
  noted later add (plumb module ids into `system_supply` like parts — `item_id` is
  free-text, no schema change). **Owner answers (`pillars.md` §iv, 2026-06-11):
  PvP is mandatory but ONLINE-only (live mode); a destroyed-last-ship player with
  no assets gets a free replacement (emergency services) — pins Combat-2's
  insurance + the async/live split keying off online presence.**

### Load-bearing decisions from `combat-resolver` (Combat-1b — interactive ship combat + PvE bounty board)

- **The CENTREPIECE of the Combat pillar (completes Combat-1): a stateful,
  turn-by-turn ship-to-ship fight proven against a PvE bounty board.** Consumes
  Combat-1a loadouts (the fitted modules' `stats` finally bite). PvE ship combat
  ONLY — PvP/live-mode/combat-logging-penalty/ship-destruction+insurance/notoriety
  are Combat-2/3 (the session is SHAPED to carry them). On-foot wildlife
  `attack`/`flee` is untouched (a SEPARATE system).
- **Pure engine `src/lib/game/combat.ts`** (no `Date`/`Math.random` — rolls + NPC
  choice injected at the handler boundary, the `combatRound`/`contractsAt`
  pattern): `ShipCombatStats {hullMax, shield, evade, jam, lock, weapons:{burst,
  sustained,missile}}`; `loadoutStats(loadout, shipId)` aggregates fitted modules
  (+ `Ship.hull`/`shipHull`, ascending; empty loadout = hull only). A fight is one
  **approach** phase (sets `Range` close|mid|long) then repeated **exchange**
  rounds. `RANGE_WEAPON_MULT` (burst✦close / sustained✦mid / missile✦long).
  `resolveApproach(playerChoice, enemyChoice, rolls)` / `resolveExchange(state,
  playerChoice, enemyChoice, rolls) → {state, log, outcome?}` with the FOUR
  counters: targeting↔evasion (lock vs evade in hit-quality), ecm↔targeting (jam
  cuts effective lock), shield↔burst (extra burst absorb), evasion↔missiles (evade
  dodges missile damage). Subsystem choices `weapons` (cut enemy weapons next
  round) / `engines` (cut enemy evade next round) / `hull` (straight) / `alpha`
  (bonus damage, drop your own evade). Seeded NPC AI `npcApproach`/`npcExchange`.
  Seeded contracts: `combat.test.ts` + `combat-resolver.test.ts`.
- **`bountiesAt(seed, hubKey, timeBucket, rankTier?)`** (pure, mirrors
  `contractsAt`): deterministic premium tier-scaled rotating PvE wanted-ships
  posted at a hub (aligned to `factionAt`), `key = "<hub>|<bucket>|<slot>"`.
- **Session + verbs** (migration `20260611120000_combat-resolver.sql`, forward-
  only/idempotent): **`players.combat jsonb`** (nullable; the active `ShipCombat`
  session — bounty + both ships' SNAPSHOT stats + live hull/shield + phase;
  distinct from `encounter`; persists across reconnect — combat-logging penalty is
  Combat-3) on `Player`/`PlayerRow`/`rowToPlayer`; `world.setShipCombat`.
  **`completed_bounties`** (`player_id→players cascade, bounty_key text, pk`,
  read-own RLS, service-role writes — mirrors `completed_contracts`);
  `getCompletedBountyKeys`/`markBountyComplete`. **`engage <choice>`** = the ONE
  phase-contextual combat verb (arg-0 domain = the current phase's choices,
  loaded in `loadArgDomainContext`; clickable). **`flee`** EXTENDED to ship combat
  (spans on-foot AND ship). **`bounties`** (INFORMATIONAL, off-hub note) +
  **`hunt <n>`** (HUB_COMBAT — `atTradeLocation && !inCombat && !inShipCombat` →
  snapshot `loadoutStats` and start the fight). `render.ts` `renderBounties` +
  combat-phase frames.
- **Outcomes** (`commands.ts`): **victory** → `addPlayerCredits(reward)` +
  `addReputation(factionId, rewardRep)` + `markBountyComplete` + clear session.
  **PvE defeat = NON-PERMANENT** "disabled & recovered" → clear session,
  `addPlayerCredits(-penalty)`, `setDistressLocation(nearest outpost, MAX_HEALTH)`
  — **NO ship loss** (destruction + emergency-ship insurance is Combat-2). `flee` →
  clear on success / enemy parting exchange on fail. No persistent hull damage
  between fights (each starts at full).
- **Applicability**: `PlayerStateView.inShipCombat` (`combat != null`) OVERRIDES
  everything (like `inCombat`) → only `engage`/`flee` + `ALWAYS`; `bounties`
  informational; `hunt` hub-gated. `flee` applies in EITHER `inCombat` OR
  `inShipCombat`. Help-parity + per-state suites updated.
- **Next**: Combat-2 (async PvP + Mercenary Charter: piracy, base raids,
  notoriety, ship-destruction + the free-replacement insurance) and Combat-3
  (live co-located duels on the 3b Realtime layer + the combat-logging penalty)
  build on this resolver + session.

### Load-bearing decisions from `notoriety` (the shared Combat ⇄ Trade heat axis)

- **A single player "heat" stat that Combat (piracy/attacking the unwanted/raids —
  Combat-2) and Trade (illicit businesses — later) both feed, driving the law's
  response.** Built ONCE here as a shared primitive. **This phase = the MECHANIC +
  display only**: the stat, time-decay, tiers, `wanted` display. NO gain sources /
  NO enforcement yet (Combat-2/Trade call `addNotoriety` + read the tier). Inert on
  prod until then (everyone reads "clean") — additive + safe to ship ahead.
- **Pure rules** (`rules.ts`, seeded `notoriety.test.ts`; `elapsedMs` injected, no
  `Date`): `notorietyDecayed(stored, elapsedMs, perMs?)` cools toward 0 (floored,
  monotonic non-increasing, integer — the `priceTowardBase`-toward-0 mirror);
  `NOTORIETY_TIERS` ascending `{tier,title,minNotoriety}` ladder (Clean at 0,
  clamps) + `notorietyTier(n)` (mirror `rankFor`); `lawResponseFor(tier)` (copy:
  the law's response per tier — actual enforcement is Combat-2); constants
  `NOTORIETY_DECAY_PER_MS`/`MAX_NOTORIETY_TIER`.
- **Persistence** (migration `20260612010000_notoriety.sql`, forward-only/
  idempotent, **purely ADDITIVE** — prod-safe): `players.notoriety integer default
  0 check(>=0)` + `players.notoriety_updated_at timestamptz default now()` on
  `Player`/`PlayerRow`/`rowToPlayer`; atomic `add_notoriety(p_player, p_delta)` RPC
  (clamped ≥0, **stamps notoriety_updated_at = now()**). No RLS change (rides the
  players row; NOT on the public leaderboard — heat isn't public).
- **Adapters** (`world.ts`, the only `Date.now()` site): `getNotoriety(playerId)`
  decays on read (`notorietyDecayed(stored, now − updated_at)`, int);
  `addNotoriety(playerId, delta)` realizes decay THEN applies the delta + stamps —
  the hook Combat-2/Trade call on an illicit act.
- **Display**: `wanted` (NEW verb, INFORMATIONAL/anywhere — `VERBS`/`USAGE`/
  `applicability`, help-parity held): heat + tier title + `lawResponseFor` meaning
  + next-tier threshold (clean message at 0). Status bar surfaces a heat readout in
  the `danger` style when `tier > 0` (additive `StatusBar` field; color-only, P9b).
  `renderWanted` in `render.ts`.
- **Next**: Combat-2 calls `addNotoriety` on illicit acts (attacking the unwanted,
  piracy, raids) + READS `notorietyTier` for enforcement (patrols, a bounty on the
  player) + the ship-loss insurance; the Trade business layer reuses the SAME stat
  for corporate notoriety.
