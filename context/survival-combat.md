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

### Load-bearing decisions from `ship-repair` (Combat-2 stakes primitive)

- **Combat losses never DESTROY a ship** — the SHARED stakes layer the PvE bounty
  fights (Combat-1b) and the upcoming raids (2a) / ship piracy (2b) all route their
  loss outcome through. A defeated ship is **towed to the nearest station at a low
  "disabled" condition** where the player **`repair`s** it; a disabled ship is
  still **flyable** (anti-softlock — the ship is never taken away, you're never
  stranded: a broke pilot can limp out, mine metal, and repair). This SUPERSEDES
  1b's "disabled & recovered, full heal, **credit fine**" loss path (the credit
  fine is GONE — the repair cost is the stake now) and the earlier
  "destruction + free-shuttle insurance" idea.
- **`players.ship_condition integer not null default 100 check (between 0 and
  100)`** (migration `20260612020000_ship-repair.sql`, forward-only/idempotent,
  **purely ADDITIVE** — one defaulted column, prod-safe like notoriety/manifold;
  no RLS change, NOT on the public `leaderboard` — condition isn't public). 0 =
  wreck, 100 = pristine. Carried on `Player.shipCondition`/`PlayerRow`/`rowToPlayer`
  (defensive `?? 100` for old rows/fixtures). World adapter `setShipCondition`
  (read-compute-write, no atomic RPC — sequential per-player like fuel/health).
- **Pure rules** (`rules.ts`, seeded `ship-repair.test.ts`; no `Date`/`Math.random`/
  IO): constants `MAX_SHIP_CONDITION=100`, `DISABLED_CONDITION=15` (the tow floor —
  low but >0 = flyable), `MIN_HULL_FRACTION=0.25` (combat-hull floor),
  `REPAIR_CREDITS_PER_POINT=5`, `REPAIR_METAL_PER_POINT=0.5`. Functions:
  `effectiveHull(baseHull, condition) = round(baseHull × max(MIN_HULL_FRACTION,
  condition/MAX))` (combat hull scales with condition, monotonic, =baseHull at
  full, floored >0 at 0); `conditionAfterDefeat(prev) = min(prev,
  DISABLED_CONDITION)` (drops to the floor, never raises);
  `repairCreditsFor(missing)`/`repairMetalFor(missing)` = `ceil(missing × per-point)`
  (0 at 0); `pointsAffordable(have, perPoint) = floor(have/perPoint)` (0 if either
  ≤0); `conditionAfterRepair(condition, points) = min(MAX, condition + max(0,
  points))` (partial, capped, never overshoots/reduces).
- **Combat hook**: `loadoutStats(loadout, shipId, condition=MAX_SHIP_CONDITION)`
  gained an OPTIONAL `condition` arg that scales `hullMax` via `effectiveHull` —
  stays PURE (condition passed in at the engage-start boundary). `handleHunt`
  snapshots `loadoutStats(loadout, shipId, player.shipCondition)` so a damaged ship
  enters the fight with less hull. **NPC/bounty enemy profiles are UNAFFECTED**
  (generated directly; the default arg keeps them unchanged).
- **Defeat path rewired** (`shipCombatDefeat`): clear the session →
  `setShipCondition(conditionAfterDefeat(current))` → tow to nearest outpost +
  full HP via the existing `setDistressLocation` (reused, not forked). **NO credit
  fine** (the `distressCost` charge removed from THIS path; `distressCost` is still
  used by the on-foot `distress` command). The defeat frame surfaces the disabled
  condition + a `repair` hint.
- **`setShip` (buyship / `produce <ship>`) resets `ship_condition = 100`** in the
  SAME write that swaps `ship_id`+`cargo_cap` — a newly-acquired ship is pristine,
  never inherits the old hull's battle damage.
- **`repair [amount|metal] [n]`** (NEW verb, ECONOMY applicability bucket —
  `atTradeLocation && !inCombat`, like buy/sell/buyship; arg slot OPAQUE/free-form
  so `metal` + numbers pass through, handler-parsed): `repair` = as much as CREDITS
  afford toward full; `repair <n>` = n points in credits; `repair metal [n]` = pay
  in mined **`iron`** (`REPAIR_METAL_ID`, a cheap broadly-mineable ore — anti-
  softlock) from cargo. Validate funds → charge (`addPlayerCredits(-)` /
  `removeInventory(iron,-)`) → `setShipCondition(+)`. Partial allowed; no-op-with-
  message at full or zero funds (ship stays flyable). Registered `VERBS`/`USAGE`/
  `applicability`; help-parity held.
- **Display**: ship condition as `hull N%` (RED when `<50`, P9b color-only) in the
  **status bar** (additive REQUIRED `StatusBar.condition` field — survives `clear`),
  in `scan` (surface frame via `ScanView.shipCondition`/`repairAvailable`; orbital/
  outpost frames via the shared `conditionLine(player, repairable)` helper), with a
  clickable `repair` hint at trade locations (else a muted "repair at a settlement/
  outpost" nudge — the ship still flies). Seeded contract: `ship-repair.test.ts`.
- **For Combat-2a/2b**: base raids + ship piracy route their loss outcomes through
  this primitive (`conditionAfterDefeat` + tow + `repair`); 2b adds notoriety +
  marque on top. Out of scope here: repair at OWNED bases (trade locations only),
  per-module damage, condition decay over time/use (only combat reduces it), towing
  fee, actual ship destruction.

### Load-bearing decisions from `base-raids` (Combat-2a — base defenses + async raiding)

- **The first PvP loop: build DEFENSES on your base, `raid` another player's base
  in the same region — resolved ASYNCHRONOUSLY against the base's installed
  buildings (the owner need not be online; the buildings ARE the snapshot).** A
  WIN loots a capped silo share + knocks defenses offline for a cooldown + raises
  the raider's notoriety + logs the raid; a LOSS tows the raider via `ship-repair`.
  **NO permanent destruction** (owner-signed-off) — only silo goods move and the
  defenses recharge. A base on cooldown is PROTECTED (can't be re-raided), so an
  offline owner can't be camped. Reuses bases/build/power + the `engage`/combat
  resolver + `notoriety` + `ship-repair` wholesale — no fork.
- **Defense buildings** (`bases.ts`): `turret` + `shield_generator` join
  `STRUCTURE_KINDS` (the `base-buildings-cost.test.ts` exact-match assertion was
  updated, per the production-line/base-power/blast-furnace precedent), with
  tunable `BUILDING_BUILD_COST` entries (metals + credits). Both are **power-gated
  consumers**: `TURRET_POWER_DEMAND = 3` / `SHIELD_POWER_DEMAND = 3` (`rules.ts`)
  add to `basePower`'s demand (the args gained optional `turrets`/`shieldGenerators`,
  default 0 so pre-raid call sites read unchanged; EVERY `basePower` call site —
  build echo, storage, excavator accrual, produce gate, the per-base scan profile —
  passes the counts). Built via the existing `build` path (DISEMBARKED + own base
  in-region + atomic cost); `build`'s arg-0 domain + usage gained both.
- **Defense profile** is PURE in `combat.ts`: `baseDefenseStats({turrets,
  shieldGenerators, tier, powered}) → ShipCombatStats`. Turrets → a weapon mix
  (`TURRET_WEAPONS` per turret) + targeting `lock`; shield generators → `shield`
  (`SHIELD_PER_GENERATOR`); base `tier` → `hullMax` (`BASE_DEFENSE_HULL_PER_TIER`,
  always > 0, monotonic in tier). **CRUCIAL: `!powered` ⇒ near-zero (weapons + shield
  read 0, only the inert tier-hull remains)** — ties power to defense, so an
  unpowered base is easy pickings. A base never evades/jams. This is the "enemy"
  the raider's `loadoutStats` fights through the SAME `resolveApproach`/
  `resolveExchange` engine + `players.combat` `engage` session. Seeded contract:
  `base-raids.test.ts`.
- **Pure raid rules** (`rules.ts`, same seeded contract): `raidLoot(siloStacks,
  fraction) → stacks[]` (per-stack `floor(qty × RAID_LOOT_FRACTION=0.25)`, drops
  0-floored stacks, never the whole stack — empty silo ⇒ `[]`); `raidOnCooldown(
  raidedAt, now, cooldownMs) → boolean` (`now − raidedAt < cooldownMs`; null/NaN
  raidedAt ⇒ never on cooldown). Constants `RAID_LOOT_FRACTION`,
  `RAID_COOLDOWN_MS` (6h), `RAID_NOTORIETY_GAIN` (150). `now`/`raidedAt`(ms)
  injected — no `Date` in rules.
- **Persistence** (migration `20260612070642_base-raids.sql`, forward-only/
  idempotent, **purely ADDITIVE** — prod-safe like notoriety/ship-repair):
  `bases.raided_at timestamptz` (nullable; set on a WIN, drives the cooldown AND
  the "defenses recharging" window) + `public.base_raids` (`id, base_id → bases on
  delete cascade, raider_handle text, loot jsonb, raided_at timestamptz default
  now()`, index on `base_id`) — the aftermath log. **PUBLIC READ** (a shared-world
  event, like `bases`); service-role writes only. `world.ts`: `RegionBase`/
  `OwnedBaseRow` gained `baseId`/`tier`/`raidedAt`; `setBaseRaidedAt`/`recordRaid`/
  `recentRaidsOn`. Region-keyed ⇒ manifold-partitioned automatically.
- **`raid [handle]`** (NEW verb, `commands.ts`): applicable when on a SURFACE
  region (`state.landed`, aboard or on foot — its own applicability bucket
  `SURFACE_COMBAT`, not orbit/outpost) and out of any combat; the handler validates
  an enemy base is here (`basesInRegion`, excluding your own), not on cooldown
  (`raidOnCooldown` → "defenses still recharging"), and selects by handle when
  several. Starts a `players.combat` session marked `raid: {baseId, regionKey,
  ownerHandle}` (`bountyKey:""`, rewards 0) whose enemy is the target's
  `baseDefenseStats`; the existing `engage` plays it out. `ShipCombat` gained the
  optional `raid` marker (jsonb — no migration); `handleEngage`'s outcome branch
  reads it: **WIN → `raidVictory`** (transfer `raidLoot` of resource ids into cargo
  bounded by free space, `add_base_storage(-)`+`addInventory(+)`; `setBaseRaidedAt(now)`;
  `recordRaid(baseId, yourHandle, taken)`; `addNotoriety(RAID_NOTORIETY_GAIN)` +
  report the new tier); **LOSS → the SHARED `shipCombatDefeat`** (ship-repair tow;
  base unharmed — no loot, no cooldown). `raid`'s arg-0 domain = enemy base handles
  here. Registered `VERBS`/`USAGE`/`applicability`; help-parity held.
- **Display**: `storage`/`base` view shows turret/shield counts + defenses
  up/recharging/offline + the owner's recent-raid aftermath (`recentRaidsOn`, "⚠
  raided by <handle> <ago> — lost <items>"), plus red-marked `build turret`/`build
  shield_generator` hints (P9b affordability). Base `scan` shows each base's defense
  posture + a clickable **`raid <handle>`** action on OTHERS' bases (red/advisory
  when on cooldown, still clickable — P9b).
- **Combat-2b** (ship piracy) adds ship-snapshot PvP + letters of marque (lawful
  targets) + NPC bounty-hunters reading the notoriety tier. Out of scope here:
  permanent base/structure destruction, razing/claiming a base, raiding non-base
  targets, defenses beyond turret/shield, auto-retaliation/alarms beyond the log,
  live co-located raids (Combat-3).

### Load-bearing decisions from `ship-piracy` (Combat-2b — co-located player piracy + the Mercenary Charter)

- **Completes Combat-2: a pirate attacks a CO-LOCATED player's ship, resolved
  ASYNCHRONOUSLY against that player's STORED snapshot through the same combat
  resolver/`engage` session a bounty hunt (1b) or base raid (2a) uses** — so it
  works whether the victim is online or not (live duels are Combat-3). A WIN loots
  a capped share of the victim's CARGO (credits SAFE), disables their ship IN
  PLACE, logs the robbery, and either CLAIMS their bounty (Wanted ⇒ lawful, no
  heat) or earns ZONE-SCALED piracy notoriety (clean). A LOSS tows the attacker via
  the SHARED `shipCombatDefeat` (ship-repair). NO credit theft, no permanent ship
  loss. Reuses presence + `engage` + ship-repair + notoriety + base-raids'
  loot/aftermath/cooldown + the radiation/settlement axis WHOLESALE — no fork.
- **NEW verb `pirate [handle]`** (`commands.ts` `handlePirate`), NOT an overload of
  wildlife `attack` (which stays combat-only + untouched, so its tests/applicability
  hold). Its own applicability bucket `CO_LOCATED_COMBAT` in `applicability.ts`:
  applicable in ANY out-of-combat state (co-location can be surface/orbit/outpost,
  so there's no useful coarse LOCATION gate — like `move`/`salvage`, the handler
  does the fine checks: a co-located target is here, isn't you, isn't on
  piracy-cooldown). Bare `pirate` targets the sole co-located player / errors with
  the list when several; `pirate <handle>` selects (exact or unique prefix). Arg-0
  domain = co-located OTHER players' handles (`ctx.pirateCandidates` via
  `world.playersHere(presenceQueryOf(player))` — manifold-scoped already).
  Registered in `VERBS`/`USAGE`/`applicability`; help-parity held. The scan/`here`
  presence rows (`presenceRow` in `render.ts`) carry a clickable `pirate <handle>`
  action + a **WANTED** flag (+ bounty) on Wanted players.
- **The snapshot is the victim's STORED row** — `world.coLocatedPlayerByHandle(loc,
  handle)` reads the full authoritative row (service-role; re-applies the SAME
  `sameLocation`/manifold filters + `neq self` as `playersHere`, so it can ONLY
  resolve a player who genuinely shares your location right now). The enemy =
  `loadoutStats(victim.loadout, victim.shipId, victim.shipCondition)`. Starts a
  `players.combat` session with a `piracy: {victimId, victimHandle}` marker (jsonb,
  no migration — joins the `raid` marker on `ShipCombat`); the existing `engage`
  plays it out, and its outcome branch reads the marker.
- **Pure rules** (`rules.ts`, seeded `ship-piracy.test.ts`; no `Date`/`Math.random`/
  IO — radiation/`isHub`/`now` injected): `lawfulnessScore(radiation, isHub) →
  [0,1]` (hub ⇒ 1; else `1 − radiation/RADIATION_MAX` — low-rad RIM lawful,
  high-rad CORE lawless); `piracyNotorietyGain(base, lawfulness) → int`
  (`round(base × lawfulness)`, monotonic UP in lawfulness, 0 at lawless);
  `isWantedPlayer(n) = notorietyTier(n) >= WANTED_TIER` (the **Wanted** tier, index
  2); `playerBounty(n)` (0 below WANTED_TIER, else `PIRACY_BOUNTY_BASE + round(n ×
  PIRACY_BOUNTY_PER_HEAT)` — positive + rising with heat); `piracyOnCooldown(
  lastPiratedAt, now, cooldownMs)` (reuses `raidOnCooldown`'s shape). Constants
  `PIRACY_NOTORIETY_BASE`(200), `PIRACY_COOLDOWN_MS`(6h), `WANTED_TIER`(2),
  `PIRACY_LOOT_FRACTION`(0.25, reuses `raidLoot`), `PIRACY_BOUNTY_BASE`/
  `PIRACY_BOUNTY_PER_HEAT`/`PIRACY_WANTED_HEAT_CUT`/`PIRACY_BOUNTY_REP`.
- **Win path `piracyVictory`** (`commands.ts`): re-reads the victim fresh, loots
  `raidLoot(victimCargo, PIRACY_LOOT_FRACTION)` RESOURCES-only (filtered by
  `RAIDABLE_RESOURCE_IDS`, credits never touched) bounded by attacker free cargo
  (`removeInventory(victim)`/`addInventory(attacker)`); `setShipCondition(victim,
  conditionAfterDefeat(...))` — **disabled IN PLACE, the offline victim is NOT
  relocated** (they `repair` on return); `setPiratedAt(victim, now)` (cooldown) +
  `recordPiracy(victim, attackerHandle, taken)` (aftermath). Then the **Mercenary
  Charter** off the victim's LIVE decayed heat (`getNotoriety`): Wanted ⇒
  `addPlayerCredits(playerBounty)` + `addReputation(localFaction, PIRACY_BOUNTY_REP)`
  + `addNotoriety(victim, −PIRACY_WANTED_HEAT_CUT)` (justice; clamps ≥0) + NO heat
  for the attacker; clean ⇒ `addNotoriety(attacker, piracyNotorietyGain(
  PIRACY_NOTORIETY_BASE, lawfulnessScore(galacticRadiation(player.cluster),
  atTradeLocation(player))))`. **Loss** = the shared `shipCombatDefeat` tow (victim
  untouched — no loot, no cooldown).
- **Persistence** (migration `20260612080000_ship-piracy.sql`, forward-only/
  idempotent, **purely ADDITIVE** — one nullable column + one new table, prod-safe
  like notoriety/ship-repair/base-raids): `players.pirated_at timestamptz` (nullable;
  set on a WIN, drives the per-victim cooldown) on `Player.piratedAt`/`PlayerRow`/
  `rowToPlayer` (defensive `?? null`); `public.piracy_log` (`id, victim_id → players
  cascade, attacker_handle text, loot jsonb, attacked_at timestamptz default now()`,
  index on `victim_id`). **RLS READ-OWN** (the VICTIM reads attacks on themselves —
  `victim_id in (select id from players where user_id = auth.uid())`; UNLIKE the
  public `base_raids` — a robbery in transit is private to the victim); service-role
  writes. `world.ts`: `setPiratedAt`/`recordPiracy`/`recentPiracyOn`/
  `coLocatedPlayerByHandle`; `playersHere` extended to carry the PUBLIC-safe
  `wanted`/`bounty` flags (raw heat stays internal).
- **Display**: victim aftermath surfaces on the `wanted` screen
  (`renderWanted`/`WantedView.piracyAftermath` via `recentPiracyOn` — "⚠ <handle>
  pirated your ship <ago> — lost <items>, ship disabled, `repair` it"); the attacker
  sees the haul + (bounty+rep | new heat tier + the policed/lawless zone). Wanted
  players flagged + a `pirate <handle>` action on every co-located presence row.
- **Combat-3** (live co-located duels on the 3b Realtime layer + the combat-logging
  penalty) and active **NPC law patrols** that initiate fights (heat surfaces as a
  claimable bounty for now) build on this. Out of scope here: stealing credits/
  modules/ship, permanent ship loss, formal letters-of-marque issuance (Wanted-status
  IS the lawful-target signal), faction-war/military ops (Combat-4).

### Load-bearing decisions from `live-duels` (Combat-3 — live co-located PvP duels + combat-logging)

- **COMPLETES the two-mode combat vision: `pirate <handle>` now branches on whether
  the co-located target is ONLINE.** ONLINE ⇒ a **LIVE duel** (this phase): a shared,
  server-authoritative, TURN-SYNCHRONIZED fight both players steer over the 3b
  Realtime channel. OFFLINE ⇒ the existing 2b async-snapshot piracy (unchanged). It's
  an EXTENSION of `handlePirate` (the real 2b co-located-player-attack verb — the
  spec's "attack `<handle>`" is this; wildlife `attack` stays creature-only +
  untouched), so no new verb ⇒ help-parity/applicability are untouched. "Online" =
  seen within `PLAYER_ONLINE_WINDOW_MS` via a new `players.last_seen_at` heartbeat
  (`world.touchLastSeen`, stamped once per command in `dispatch`); CONSERVATIVE — a
  stale target falls back to the safe async path (`playerOnline(lastSeen, now)` is
  false for null). Mandatory engagement — starting a duel sets BOTH players' combat
  immediately; **`flee` is the only out.**
- **Shared session = `public.live_duels`** (migration `20260612090000_live-duels.sql`,
  forward-only/idempotent/ADDITIVE): the turn-synced state — `phase`, `turn` (the LOCK),
  `range`, both `*_stats` (immutable `ShipCombatStats` jsonb snapshots), `*_hull`/
  `*_shield`, `*_debuffs` (pending next-round modifiers jsonb), `*_choice`,
  `turn_deadline`, `status`, `winner_id`, denormalized `*_handle`, `channel`. **RLS
  read-PARTICIPANT** (attacker/defender resolve to the viewer); service-role writes.
  BOTH players' `players.combat` carries a `DuelRef` `{kind:"duel", duelId, role,
  opponentHandle, channel}` (jsonb — NO schema change; `isDuelRef` narrows the
  `ShipCombat | DuelRef | null` union; defensive on stale ⇒ clears a dangling ref).
  Also adds `players.last_seen_at` (nullable, additive). `Player` gained `lastSeenAt`;
  `combat` widened to the union.
- **Concurrency = the `turn`-CAS (exactly-once).** `submit_duel_choice(p_duel, p_role,
  p_choice, p_turn)` RPC records a role's choice ONLY for the current `turn`
  (compare-on-turn guard — a stale-turn write no-ops) and returns whether BOTH choices
  are present. Resolution runs in NODE (reuses the already-tested
  `resolveApproach`/`resolveExchange` with BOTH HUMAN choices, ALWAYS mapped
  attacker→`player`/defender→`enemy` so it's deterministic whoever triggers), then
  PERSISTS via `world.casUpdateDuel(duelId, expectedTurn, patch)` — an
  `update … where turn = expectedTurn and status='active'` that bumps `turn` + clears
  both choices, returning whether THIS call won. So of two concurrent `engage`
  requests, exactly ONE resolves a turn; the loser re-reads + re-renders.
- **Turn flow (`engage <choice>` when `combat.kind==="duel"` → `handleDuelTurn`):**
  record my choice (RPC) → re-read → if BOTH present, `resolveDuelRound`; broadcast the
  round (`world.broadcastDuel` = `broadcastChat`'s sibling, event `"duel"`, payload =
  pre-rendered `RenderLine[]`) so the opponent's client renders it (the actor gets the
  return frame; `self:false` avoids a double). A **bare `engage`** (no choice) is a
  timer/refresh PING. **Turn timer** (`DUEL_TURN_MS`, `turn_deadline`): if I've
  committed and the opponent's deadline passed with no choice → `duelTurnExpired` →
  AUTO-PASS them with `DUEL_DEFAULT_CHOICE` (`hold`, valid in both phases) and resolve
  (the fight continues — a slow player is NOT penalized).
- **Combat-logging = verified disconnect ⇒ penalty.** Distinguished from a slow turn:
  a forfeit fires only when the opponent is silent past `turn_deadline +
  DUEL_DISCONNECT_GRACE_MS` AND their `last_seen_at` is stale (`!playerOnline(…,
  grace)`) — server-verified, never a bare client claim. The present player
  re-issues `engage` (their own committed choice + a re-`engage` is the "ping";
  a bare `engage` is a pure refresh-ping); the server's time + heartbeat check is
  the sole guard, so it can't be gamed against a present opponent. (A client-side
  auto-timer that pings on its own is a noted future nicety — the server already
  supports it.) On forfeit: the disconnector takes `combatLogPenalty(credits)` (a significant,
  bounded fraction — pure `rules.ts`) + the standard tow, and the present player WINS.
  So: **slow ⇒ auto-pass; gone ⇒ penalty.**
- **Outcomes REUSE 2b piracy wholesale (`finishDuel`):** WIN loots the loser's cargo
  (`raidLoot` RESOURCES-only, credits safe, bounded by free hold) + the Mercenary
  Charter (`isWantedPlayer`/`playerBounty`/`piracyNotorietyGain`/`recordPiracy`/
  `setPiratedAt` — Wanted loser ⇒ winner claims bounty + cuts their heat; clean ⇒
  winner takes zone heat). LOSE = `conditionAfterDefeat` + TOW (`setDistressLocation`
  — a co-located, online loser IS relocated, unlike 2b's in-place disable of an
  offline victim). Both `players.combat` cleared + `live_duels.status='done'` (+
  `winner_id`). `flee` (`handleDuelFlee`) reliably ends the duel for both (CAS-claimed),
  no loot/penalty — the legitimate out.
- **Client (`Terminal.tsx`):** the existing 3b presence subscription gained a
  `ch.on("broadcast", {event:"duel"})` handler that appends the server's `RenderLine[]`
  verbatim (action spans wire to `run` → the `engage <choice>` buttons submit like any
  command). Thin renderer — never resolves combat. Realtime is FAIL-SOFT +
  config-guarded throughout (`broadcastDuel`/`touchLastSeen` no-op without secrets), so
  build/vitest are green WITHOUT Supabase env; the two-sided sync is **manual two-
  session QA** (the automated surface is only the pure `combatLogPenalty`/
  `duelTurnExpired`/`playerOnline` bits + the reused resolver).
- **This COMPLETES the two-mode Combat vision.** Remaining: **Combat-4** (faction
  war / military ops) and active NPC law patrols. Out of scope here: spectators,
  multi-player melees (1v1 only), ranked/matchmaking, reconnection beyond resuming an
  active duel.
