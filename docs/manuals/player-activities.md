# Omniplex — Player Activities Manual

> A catch-up reference for everything a player can *do*. Companion to
> [`world-generation.md`](./world-generation.md) (which describes the universe
> they do it in). For implementation invariants, see `CLAUDE.md`
> §"Conventions".

---

## 1. The interface

Omniplex is a **text terminal**. Players submit a command string (or click a
rendered noun/action, which submits a command for them). The game is
**server-authoritative**: the client is a thin renderer; the server validates
every command against game rules + current DB state, mutates Postgres, and
returns a new render frame. Never trust the client for resource/credit math.

- **Abbreviation**: any unique prefix of a verb or of an enumerable argument
  works — `mi t` → `mine titanium`, `sc` → `scan`, `sel a` → `sell all`.
  Ambiguous prefixes surface the choices as an error.
- **`help`** lists only the commands usable *right now* (see §2);
  `help <command>` shows live usage + candidate arguments, with a note if the
  command isn't currently applicable. Unperformable action links render
  **red** (you can still click them — you get the explanatory error).

New players spawn at a **safe rocky starting world**, aboard their ship, with:
**1000 credits, 100 fuel, 100 warp fuel, 50 cargo capacity, 100 health.**

---

## 2. Player state & the applicability model

A single source of truth (`src/lib/game/applicability.ts`) decides, for every
verb, whether it's usable in the current state — and this drives **both** the
`help` listing and the dispatch gate (they can never drift). State is
`{ embarked, inCombat, atTradeLocation }`.

| Bucket | Usable when | Verbs |
|---|---|---|
| **Always** | every state, incl. combat | `eat` + all informational |
| **Informational** | every state | `help` `scan`(`look`) `map` `inventory`(`inv`) `upgrades` `who` `bases` `regions` `storage`(`base`) |
| **Combat only** | in an encounter | `attack` `flee` |
| **Economy** | at a trade location, not in combat (either embark state) | `buy` `sell` |
| **Embarked** | aboard ship, not in combat | `warp` `land` `hyperwarp` `disembark` |
| **Disembarked** | on foot, not in combat | `mine` `explore` `harvest` `build` `produce` `deposit` `withdraw` `embark` |
| **Anytime (out of combat)** | either embark state, not combat | `craft` `jump` `rename` |

**Combat overrides everything**: in an encounter only `attack`/`flee`/`eat`
(+ informational) work. You're either **embarked** (aboard ship) or **on
foot** in a region — `disembark`/`embark` toggle it.

---

## 3. Exploration & travel

| Command | Does |
|---|---|
| `scan` (`look`) | Describe your current region/planet/orbit: biome, deposits, temperature, hazard, survival status, settlements, bases here, clickable next actions. At a gas giant or outpost, describes that instead. |
| `map` | Show your location (incl. `(x,y,z)`), the **nearest stars** by real distance with their coords + warp-fuel cost (red if unaffordable), arm/cluster neighbors, and the galaxy-jump section. |
| `regions [page]` | Paged, clickable list of the planet's surface regions (`jump <n>`); marks settlements `⌂` and offers `jump O` to the orbital outpost when one exists. |
| `warp <arm> <cluster> <system>` | Travel to another star **within the galaxy**. The system can be an **index** (`warp 0 0 742`) **or coordinates** (`warp 0 0 3.27,-1.04,0.88`). Costs **warp fuel** = `warpFuelCost(warpDistance)`. You arrive in **orbit** at planet 0 (never gated → no softlock). |
| `land <planet>` | Fly to another planet **within the current system**. Costs **regular fuel** = takeoff + interplanetary distance. Gated by the landing requirement (freezing→Antifreeze Tanks, boiling→Ablative Shields) and blocked at gas giants. |
| `jump <n>` / `jump O` | Move between **regions** of the current planet (free), or `jump O` to dock at the **orbital outpost** (`region = -1`). No fuel. |
| `hyperwarp <galaxy>` | Travel to **another galaxy** — the only command that changes `players.galaxy`. Consumes **1 Hyperwarp Condensate** (crafted from 10 voidstone). No fuel charge. Arrives at the destination galaxy's entry point (arm/cluster/system/planet/region 0). |

**Two fuels**: *warp fuel* powers `warp` (system-and-larger jumps, distance-
scaled); *regular fuel* powers `land` (planet-to-planet within a system —
takeoff cost scales with atmosphere + gravity, plus interplanetary distance).
Region `jump` is free.

---

## 4. Survival (on foot)

- **`disembark`** steps onto the surface (rocky regions only — blocked at gas
  giants and outposts); **`embark`** climbs back aboard. You must be on foot
  to `mine`/`explore`/`harvest`/`build`; aboard to `buy`/`sell`/`warp`/`land`.
- **Health** (max 100). Disembarked actions on a hazardous region can damage
  you: `rollHazardDamage(region.hazard, …)` after a successful `mine`/
  `explore`/`disembark`. At HP ≤ 0 you **die**: lose 10% of credits, then
  respawn aboard at full HP, location unchanged.
- **`eat <food>`** restores HP (never overheals; usable in any state, even
  combat). Food is cooked via `craft` (see §7).

---

## 5. Mining & on-foot encounters

- **`mine <resource>`** works the current region's deposits, adds ore to
  cargo, depletes the region (others see less; it regenerates over time).
  On foot only; blocked at gas giants. Then takes a hazard roll.
- **`explore`** rolls an outcome: **scavenge** (a material award), **flora**
  (offers `harvest`), or **fauna** (starts a combat **encounter**). Then a
  hazard roll. Gated like `mine`.
- **`harvest`** gathers a plant material from the current region.
- **Combat** (one creature at a time): **`attack`** = one combat round (both
  sides hit; `PLAYER_BASE_ATTACK = 12`); kill → drop award + encounter
  cleared; you die → death sequence. **`flee`** clears the encounter (no
  parting hit). While in combat, only `attack`/`flee`/`eat` (+ info) work.

**Materials** (`src/lib/game/materials.ts`, separate from mined resources):
- flora (luminous_spores, ironbark_resin), animal (scaled_hide, venom_gland),
  mineral (geode_cluster, meteoric_dust), relic (precursor_relic, void_idol —
  rare/valuable), food (spore_broth, seared_haunch, field_stew — heal), and
  consumable (hyperwarp_condensate). Stored in `player_materials` (uncapped,
  not against cargo). Sellable at trade locations.

---

## 6. Economy (buy / sell)

**Gated by location, not embark**: `buy`/`sell` only work at a **trade
location** — a settlement region or an orbital outpost — regardless of embark
state. Off-market, the commands are rejected with a "find a settlement/
outpost" message; `scan` at a trade hub surfaces clickable `buy`/`sell` hints.

- **Resource prices are per-system** (keyed by `systemKey`). Each system has
  its own market that drifts back toward each resource's `base_value` over
  time (reversion-on-read). Trading moves the local price; travelling to
  another system just shows that system's (reverted/base) prices. `buy` pays
  a `BUY_MARKUP = 1.5` over the sell price; trades nudge price by a gentle
  compounding `PRICE_IMPACT`.
- **`buy fuel [n]`** / **`buy warpfuel [n]`** refuel (regular @3/u, warp @9/u).
- **Ship parts & upgrades** have a **finite, per-system supply**
  (`system_supply`, self-reverting toward a baseline). You can only `buy` one
  if a system has stock; selling one adds to that system's supply — so buyable
  stock only grows when players manufacture and sell. Prices are code-derived
  (`buyUnitCost(value)`).
- **`sell <item> [qty]`** sells resources, materials, parts, or upgrades.
  `sell all` dumps the whole resource hold.

---

## 7. Crafting & fabrication (`craft`)

`craft` is hand-fabrication, usable anywhere out of combat (either embark
state). It branches on the target:
- **Cook food** — `craft spore_broth|seared_haunch|field_stew`: consumes
  *material* ingredients from `player_materials` → one food item.
- **Biofuel** — `craft biofuel <flora|animal material> [qty]`: refines
  plant/animal materials into **regular fuel** (`BIOFUEL_EFFICIENCY = 0.5`,
  a deliberate value loss). The anti-softlock: an empty tank in deep space,
  far from any market, can always be refilled from the wildlife you harvest.
- **Hyperwarp Condensate** — `craft hyperwarp_condensate`: consumes **10
  voidstone** (a mined resource in cargo) → 1 condensate. The galaxy-travel
  consumable.

(Ship parts and ship upgrades are NOT hand-crafted — they're manufactured at
a base via `produce`; see §8.)

---

## 8. Bases & production (the production track)

A **base** is a player's claim on a region — and **other players can see it**
(`scan` shows bases in a region; bases are public).

- **`build <structure> [name]`** (on foot, own/claim a base in-region, atomic
  cost). Structures: **`base`** (the claim), **`silo`** (storage, +1000
  capacity each), **`excavator`** (passive ore drain), **`production_line`**
  (raw→parts), **`thermal_plant`** / **`solar_array`** (power). Costs are
  credits + minerals.
- **`storage`** (`base`) shows the base here: silo/excavator/production-line
  counts, stored contents vs capacity, and the **power balance**.
- **`deposit <item> [qty]` / `withdraw <item> [qty]`** move resources/parts
  between ship cargo and the base's silos.
- **`produce <part|upgrade> [qty]`** runs a production line:
  - **Parts** (`hull_plating`, `circuit_board`, `alloy_beam`, `sensor_array`)
    are manufactured from **siloed raw minerals** into the silo. They're a
    tradeable commodity (their own cargo lane, `player_parts`).
  - **Upgrades** (`Ablative Shields`, `Antifreeze Tanks`) are manufactured
    from **siloed parts** and granted directly to the player.

### Power (everything's gated by it)

Production lines and excavators need **power**. Plants scale with the
environment: **thermal** rises with the base region's temperature; **solar**
rises as the planet's atmosphere thins. `basePower` is all-or-nothing —
`powered = supply ≥ demand`. Underpowered ⇒ `produce` is blocked and
excavators accrue nothing. Siting is a real choice (thermal on hot worlds,
solar on thin-atmosphere worlds).

### Automatic excavators

There is **no `collect` command**. Excavators funnel ore into the silos **on
their own**, computed from elapsed time and realized lazily whenever you touch
the base (e.g. `scan`/`storage`/`deposit`), **gated by power** (no power → no
accrual, clock paused). Capacity-capped; the banked ore depletes the same
per-region vein that manual `mine` does.

---

## 9. Ship upgrades

`upgrades` shows what you own + the per-system market. Two upgrades exist,
both **landing gear**: **Ablative Shields** (survive boiling worlds, > 100°C)
and **Antifreeze Tanks** (survive freezing worlds, < 0°C). Owning ≥1 enables
the capability; selling your last one removes it. Obtain them via `produce`
(manufacture at a base) or `buy` (if a system has supply).

---

## 10. Identity & social

- **`who`** — leaderboard / presence (public **handles** only; never emails).
- **`rename <handle>`** — set your own public callsign (anytime out of
  combat). New accounts get a neutral generated callsign, not an email-derived
  name.
- **Shared world**: bases, depletion, discoveries, and market movements are
  all visible/felt by other players in the same place. The universe heals over
  time (depletion regenerates, prices/supply revert toward baseline).

---

## 11. The roadmap so far (what's built)

The game was built in phases, all merged:
- **Spatial/exploration**: six-tier addressing, two fuels + orbital mechanics,
  galaxy jumps (hyperwarp/condensate), **star (x,y,z) positions + Euclidean
  intra-cluster distance**.
- **Survival**: health/death, disembark-to-act, wildlife + combat, food/`eat`.
- **Production**: bases, silos, excavators (now automatic + power-gated),
  production lines, parts, upgrades-as-manufactured-goods, power plants.
- **Economy**: per-system markets, finite self-reverting supply, tradeable
  parts, biofuel anti-softlock, trade-location gating (settlements/outposts).
- **World realism**: temperature/biome/hazard coherence, Kopparapu-based
  planet sizes (rocky/gas, ~49/51) & temperatures (~76/8/15 cold/warm/hot),
  planets ordered by orbital distance.

### Notable open / deferred items
- **Arm-jump cost** is currently a placeholder (`ARM_SPAN = CLUSTER_SPAN`) —
  flagged for a future balance pass.
- **Warp-fuel economy**: cluster hops became ~10× more expensive after the
  distance retune; warp-fuel supply/pricing may want tuning.
- Longer-horizon themes from the original vision not yet built: research,
  deeper NPC empires/politics, bounty hunting.

---

## 12. Command quick-reference

```
help [cmd]   scan/look   map   regions [pg]   inventory/inv   who
warp <arm> <cluster> <system|x,y,z>     land <planet>     jump <n>|O
hyperwarp <galaxy>      disembark   embark
mine <res>   explore   harvest   attack   flee   eat <food>
buy <item> [qty]   sell <item> [qty]      (at settlements/outposts)
craft <food|biofuel <mat> [qty]|hyperwarp_condensate>
build <base|silo|excavator|production_line|thermal_plant|solar_array> [name]
produce <part|upgrade> [qty]   deposit <item> [qty]   withdraw <item> [qty]
storage/base   upgrades   bases   rename <handle>
```
