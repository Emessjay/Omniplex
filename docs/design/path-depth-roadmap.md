# Omniplex — Path-Depth Roadmap

> A durable design assessment + plan: can a player genuinely choose
> **exploration**, **production**, or **capitalism** as a path and enjoy it for
> hours — not minutes? Written 2026-06 after the industrial/agricultural
> expansion (blast-furnace → crop-farming → animal-husbandry). Companion to the
> [manuals](../manuals/). This is the strategic "why we build what's next."

---

## 1. Verdict (as of the expansion)

**No — today all three paths collapse into one shallow loop.**

| Path | Enjoyable >a few min today? | Where it collapses |
|---|---|---|
| **Exploration** | A little (big, varied universe to look at) | Discovery yields no persistent reward or goal. You explore only to find rarer ore → mine → sell. Every system is structurally identical (star + planets + regions), so novelty dies fast. |
| **Production** | ~30–60 min (now has a real ore→ingot→part→upgrade chain + farming) | No *purpose* for the output. Parts/upgrades exist to sell or to get 2 landing-gear upgrades. No base progression beyond "more buildings," no logistics, **no demand**. |
| **Capitalism** | Barely (minutes) | It's just the *sell half* of mining + marginal arbitrage (cargo 50, prices revert gently). No businesses, no owned income, no contracts, no remote price info, no freight. |

## 2. Root cause (one sentence)

**The game is rich in *supply-side* mechanics — mine, farm, ranch, smelt, craft a
4-tier chain — and almost empty on the *demand side*. Every activity ends in
"sell for credits," and credits buy almost nothing aspirational.**

Consequences:
- All three "paths" are the *same* loop (`acquire goods → sell → number goes
  up`) wearing different hats. They aren't differentiated, interdependent, or
  individually progressing.
- There is **no demand** pulling production/trade, **no sink** giving wealth
  purpose, and **no per-path progression** making "I'm an explorer/producer/
  trader" mechanically real.
- Notably, the three missing ingredients are *exactly the unbuilt pillars of the
  original prompt*: **NPC empires (demand), politics/ranks (progression), and
  "businesses" (capitalism sinks).**

## 3. The plan — three keystones, in priority order

### Keystone 1 — Demand-side economy: NPC factions + contracts + reputation  ⭐ build first
The missing *pull*. NPC factions (anchored at settlements/outposts) post
**contracts**: deliver N titanium / 50 hull_plating / 20 field_stew to a hub;
survey planet X; clear bounty Y. Fulfilling pays **credits + faction
reputation**; reputation gates better contracts, discounts, and access. One
system gives all three paths purpose at once:
- **Production** → a reason to make things (fulfill manufacturing demand — pull, not push).
- **Capitalism** → source/haul/broker goods to fulfill; cornering the finite
  per-system supply (already built) becomes a real play.
- **Exploration** → survey / deliver-to-the-frontier contracts.
- **Progression** → the rank ladder that turns "I mine" into "I'm a Tier-4
  supplier to the Hegemony" (the prompt's "politics").
Smallest lever, largest effect. Sits on what exists (settlements/outposts as
hubs, per-system economy, materials/parts/food as contract goods).

### Keystone 2 — Ships + big constructions: the sinks
Credits buy little today. Introduce **ships you buy and upgrade** (cargo, fuel,
speed, module slots) — a deep credit sink that *also enables the paths*: bigger
cargo → real hauling/capitalism; better drive → deep exploration; specialized
hulls → physically pick a path. And let **production output build things** —
ships, stations, bigger base tiers — so parts aren't just sold. Wealth gets
purpose; each path gets a gear ladder.

### Keystone 3 — Findable, non-uniform exploration content
Scatter deterministic, rare **derelicts / ruins / anomalies** yielding
blueprints, relics, lore, rare materials, plus **first-discovery rewards**
(bounty + a cartography rank). Exploration becomes intrinsically rewarding *and*
feeds the others (blueprints → production unlocks, relics → research/sell, lore
→ faction standing), and the structural sameness breaks.

## 4. What each path becomes (the target)

- **Explorer**: cartography rank + first-discovery bounties + findable
  ruins/anomalies + survey contracts + frontier risk. Rewards that *aren't* ore:
  blueprints, relics, rare creatures, lore, naming rights.
- **Producer**: faction manufacturing contracts (demand) + construction sinks
  (parts → ships/stations/base tiers) + inter-base logistics + research
  consuming output. Progression: throughput, automation tiers, a production rank.
- **Capitalist**: remote market info + trade contracts + **owned businesses**
  (a depot/shop at a hub → passive income) + freight ships + cornering the
  finite per-system supply + player-to-player trade. Progression: trade rank /
  wealth-prestige sinks.

## 5. Sequencing

1. **Keystone 1 — factions/contracts/reputation** (the demand keystone). Sub-phases:
   - **1a** — FACTIONS catalog; hubs aligned to factions; `player_reputation`;
     deterministic rotating **contracts** at hubs; `fulfill` (deliver goods →
     credits + rep); `standing` view. *(The MVP demand loop — build this first.)*
   - **1b** — reputation **ranks/titles** gating contract tiers, discounts, access.
   - **1c** — politics: rival factions, faction-specific perks, standing trade-offs.
2. **Keystone 2 — ships + constructions** (sinks + path gear). Natural follow-up:
   contracts immediately make you want more cargo.
3. **Keystone 3 — exploration content** (derelicts/ruins/anomalies + cartography).

## 6. Design principles to preserve

- **Pull, not push**: prefer demand (contracts/construction/research that
  *consume* goods) over more ways to *produce* goods. The supply side is full.
- **Every new currency/good needs a sink** before (or with) its source.
- **Paths should interdepend**: an explorer's blueprints feed a producer; a
  producer's goods feed a capitalist's contracts; a capitalist funds expeditions.
- **Deterministic universe, persist only mutable state** (contracts generate
  procedurally per hub+time-bucket; only claims/completions/reputation persist).
- **Shared-world stakes**: lean into players mattering to each other (shared
  markets/supply, visible bases, eventually territory/trade/competition).
