# Omniplex — The Seven Pillars

> The master design vision. Omniplex is a shared, procedurally-generated
> sci-fi universe (a terminal MMO) organized around **seven pillars** of play.
> Six are public, intertwined careers; the seventh is hidden and story-like.
> This doc fleshes each out — vision, its organization, mechanics, progression,
> what exists today vs. what's to build, and open questions for feedback.
> Supersedes the framing in [`path-depth-roadmap.md`](./path-depth-roadmap.md)
> (which still holds for the demand-economy keystones already built); world
> generation that feeds all of this lives in
> [`generation-cascade.md`](./generation-cascade.md).
> Status legend: ✅ built · ◖ partial · ○ to build.

## The shape of it — three social layers

Omniplex's society stacks in **three layers**, and the pillars sit on top of all
three:

1. **Species** *(foundational — a prerequisite for the pillars at full scale)*.
   Procedurally-generated sapient aliens: **a handful of dominant species** (not
   a fixed four) plus many minor ones, each with cultural DNA derived from its
   origin world. See [§Foundation](#foundation-sapient-species-the-prerequisite).
2. **Empires** *(the political structure)*. Empires fall largely along **species
   lines** — each dominant species anchors an empire — with **cross-cultural
   mingling** at the edges. This is the **Politics** pillar's playing field. The
   current 4 NPC factions are the seed (to be reframed/expanded as species-
   empires).
3. **Guilds** *(cross-cutting professions — a layer on TOP of species/empires)*.
   **Seven** organizations, one per pillar, that you rise through regardless of
   your species or empire (a Kh+ trader and a human Founder belong to the same
   Free Traders' League). Six are public; the seventh — Neutralization's **Veil**
   — is hidden. **Politics has its own guild too**: not the empires themselves,
   but an interspecies association of the influential.

The seven **guilds**:

| Pillar | Guild | What it offers |
|---|---|---|
| Discovery | **Cartographers' Union** | survey contracts, charts, first-claim rights, codex prestige |
| Trade | **Free Traders' League** ◖(faction exists) | market access, trade contracts, broker licenses, (grey) black-market ties |
| Building | **Founders' Guild** | claim rights, blueprints, megastructure charters, shared-build permits |
| Combat | **Mercenary Charter** | bounty boards, letters of marque (piracy), military commissions |
| Science | **Arcanum Collegium** ◖(faction exists) | research grants, lab access, patents, gene-banks |
| Politics | **the Conclave** | an interspecies association of power-brokers "rubbing elbows" — introductions, influence, diplomatic standing, alliance charters (distinct from the empires it operates within) |
| Neutralization | *(hidden — the Veil)* | recruited, never advertised; anomaly dossiers, containment tools |

The existing four factions span both lower layers and will be sorted as we build
the species foundation: `arcanum_collegium` / `free_traders_league` read
naturally as the **Science / Trade guilds**, while `iron_vanguard` /
`verdant_compact` read as **species-empires**.

---

## Foundation: sapient species (the prerequisite)

Before the pillars work at full scale, the universe needs **sapient aliens** —
because empires, the Conclave, inter-species trade/diplomacy, and most flavor
all rest on *who* inhabits the galaxy.

- **Procedural, but curated-feeling** (the Sonnet "speculative" sketch +
  [`generation-cascade.md`](./generation-cascade.md) extended above the
  non-sapient biology tier). A species' "cultural DNA" derives from three
  parameters tied to its **origin ecology**: the planet type it evolved on
  (high-gravity → compact/hierarchical; extreme world → hive/symbiotic), a
  **technological-aptitude vector** (biotech / materials / computation — which
  cascades into trade goods + research strengths), and a **social-structure
  archetype** (hive / hierarchical / consensus / nomadic / isolationist). Players
  infer the rest; generated text snippets (the Nimbus blurb writer) fill gaps.
- **A handful of DOMINANT species** (hand-curated or curated-procedural — the
  narrative anchors with real political weight; ~3–6, "not necessarily four")
  plus **a vast number of minor species** generated from the parameters above.
- **Empires along species lines** — each dominant species anchors an empire,
  with cross-cultural mingling (minorities, trade enclaves, mixed border
  systems). This is what the **Politics** pillar climbs.
- **Build order implication:** the sapient-species + species-empire layer is a
  near-term foundation (alongside finishing the creature-genome cascade tier) —
  the public pillars only reach full scale once the galaxy is *populated*.

## Foundation: shared presence (co-location) — concurrent with species

The second multiplayer foundation, to be built **concurrently with sapient
species**: players in the **same place** — orbiting the same planet, on the same
surface region, docked at the same station — can **see each other** and interact
**live** (chat, trade, and combat). Co-location is the join point: the shared
world stops being parallel-singleplayer and becomes social. This underpins the
**Combat** (live duels/piracy when co-located), **Politics** (meeting), and
collaborative **Building** pillars. (Today the world is shared in *state* —
bases/depletion/markets are visible — but players don't see or meet each other in
real time.) **It also revises the Combat design (below):** co-located players can
engage in *real-time*, with the asynchronous/snapshot model reserved for
*non-co-located* cases (raiding an offline player's base, intercepting their
haulers). Open: presence scope (region vs system vs station), how "live" the
interaction is (live tick vs near-real-time), and online/offline handling.

---

## i. Discovery

**Vision.** Find new and exotic worlds, relics, alien flora and livestock — and
turn those finds into the money that funds the next expedition. Discovery is the
self-financing engine of exploration: you go out, you bring back the unseen, you
sell or study it, you go further (and deeper coreward, where it's richer and
deadlier).

**Organization — Cartographers' Union.** Survey contracts ("chart N worlds in
this arm", "find a habitable world with biome X"), first-claim rights to what you
find, and a public **codex** of catalogued species/sites that confers prestige.

**Mechanics & progression.**
- ✅ procedural universe (galaxy→region) with the cascade making worlds
  genuinely varied; `scan`/`map`/`regions`; warp/hyperwarp.
- ✅ `exploration-sites` (derelicts/ruins/anomalies) + `salvage` loot; orbital
  derelicts; first-discovery **bounties**; **cartography rank** + leaderboard.
- ◖ wildlife (flora/fauna) — fixed catalogs today; the **creature genome**
  (cascade) makes "new alien flora and livestock" a real, near-endless find.
- ○ **a codex/catalog**: first-to-document a species/site/world → permanent
  credit + prestige (ties to the Nimbus blurb writer for flavor). Specimen
  capture (live flora/livestock you can sell to ranchers/scientists).
- ○ deeper findables: rare phenomena, named landmarks, lost-tech caches.

**Cross-ties.** Sells into **Trade** (relics/specimens), feeds **Science**
(research inputs, breeding stock) and **Building** (rare materials), and is how
**Neutralization** stumbles onto anomalies.

**Open Qs.** What's the codex unit (species? world? site?) and its reward curve?
Specimen capture — a live-cargo mechanic, or abstract? How rare should "named"
finds be?

---

## ii. Trade

**Vision.** Build a business — from a single hauler to a commercial empire —
using *real* market strategy: honest production-and-sale, arbitrage across the
per-system economy, cornering scarce supply, and (greyer) bribery, smuggling,
and black-market dealing. Wealth should compound through cleverness, not just
grind.

**Organization — Free Traders' League** (✅ exists as a faction). Broker
licenses, trade contracts, market intel; and, off the books, the ties that get
you into **black markets**.

**Mechanics & progression.**
- ✅ per-system markets (drift + mean-reversion), finite per-system **supply**
  (parts/upgrades), buy/sell across resources/materials/parts/upgrades/ships,
  faction **contracts** (demand), the full production chain, rank **discounts**.
- ✅ arbitrage is already possible (per-system price differences + cargo); ships
  scale hauling.
- ○ **owned businesses / passive income**: a depot or shop at a hub that buys/
  sells on standing orders and earns while you're away — the "build a business"
  core. Trade-route automation (hire NPC haulers).
- ○ **market intelligence**: see remote prices / discover routes (today you must
  fly there) — the information game that makes arbitrage skillful.
- ○ **black market & bribery**: contraband goods (illicit tech, anomaly
  byproducts, protected species), smuggling (cargo scans at hubs, risk of
  seizure), **bribery** (pay officials/factions to look away, lower tariffs, or
  unlock restricted goods). A heat/notoriety axis.
- ○ **price-making at scale**: corner a system's finite supply; manipulate.

**Cross-ties.** Consumes **Building** (factories/depots) and **Production**;
feeds **Politics** (economic influence); smuggling invites **Combat** (piracy/
interdiction) and brushes **Neutralization** (anomaly byproducts are contraband).

**Open Qs.** How illicit do we go (bribery/black-market tone)? Passive-income
businesses — how hands-off? A notoriety/heat system shared with Combat?

---

## iii. Building

**Vision.** Raise large bases — even megastructures and orbital stations — from
unique materials in unique locations, and do it **collaboratively** with other
players. Building is the way you stake permanent, visible presence in the shared
world.

**Organization — Founders' Guild.** Claim rights, blueprints, megastructure
charters, and **shared-build permits** (the legal framework for collaborative
construction).

**Mechanics & progression.**
- ✅ bases (claim a region, public to all players), buildings (silos/excavators/
  production lines/blast furnaces/power plants/crop farms/livestock pens), **base
  tiers** (capacity + power), power siting (thermal/solar by environment).
- ○ **orbital stations** (build in orbit, not just on a surface) + **unique
  locations** (coreward/hazardous high-value sites, anomaly-adjacent).
- ○ **unique materials**: rare ores, relics, and science outputs as
  construction inputs → distinctive, expensive megastructures (not just "more
  silos").
- ○ **collaborative building** (multiplayer): shared bases/stations multiple
  players co-own and co-build — permits, contribution tracking, shared storage.
  The first genuinely *cooperative* multiplayer mechanic.
- ○ defenses (turrets/shields) — the bridge to **Combat** (raids on bases).

**Cross-ties.** Houses **Production**/**Science** (labs, factories); produces for
**Trade**; collaborative bases are **Politics** (alliance territory); defenses
tie to **Combat**.

**Open Qs.** Co-ownership model (shared vs contribution-shares)? How big do
megastructures get? Are stations a new building tier or a new place-type?

---

## iv. Combat

**Vision.** Piracy, bounty-hunting, and military service — a real share of the
action. Two explicit design constraints from the start: combat must be **more
engaging than trading blows**, and **real-time PvP is a problem** in an async,
text, shared-world game (players aren't online together; text input isn't
twitch-friendly).

**Organization — Mercenary Charter.** Bounty boards (hunt wanted NPCs/players),
**letters of marque** (sanctioned piracy targets), and military commissions
(fight in faction wars).

**Proposed engagement model (the key design).** Make combat **loadout- and
tactics-driven**, not an HP slugfest — with a **two-mode** structure keyed off
the new shared-presence layer (§Foundation):
- **Loadout & tactics over reflexes.** Ships have module slots (weapons,
  shields, evasion, ECM, targeting). An engagement resolves in **phases**
  (approach/positioning → exchange with **subsystem targeting** → outcome), where
  module **counters** (e.g. ECM vs targeting, evasion vs accuracy, shields vs
  burst) make it a rock-paper-scissors of preparation + read, not attrition.
  (Even "real-time" combat is then about *commitments and counters*, not twitch —
  fitting the text interface.)
- **Live, when co-located** (the revision per the presence layer): two players
  in the same place (same orbit/region/station, both online) can engage
  **directly** — a structured, phase-paced exchange both participate in.
- **Asynchronous, when NOT co-located** — resolve against a **committed
  loadout/defense snapshot** so nobody needs the other online:
  - *Piracy* = intercept a hauler's route → vs the target's ship/escort snapshot
    (richer + riskier coreward).
  - *Base raids* = attack a base's **defenses** (turret/shield buildings) while
    the owner's offline; they see the aftermath and rebuild/retaliate.
  - *Bounty-hunting* = track a wanted target, resolve on interception.
  - *Military* = faction-war ops (take/hold contested systems) as structured battles.
- **Consent & stakes.** A notoriety/wanted axis (shared with Trade's heat);
  opt-in danger zones (lawless/coreward) vs protected hubs; insurance/escape so
  loss stings without being rage-quit-inducing.

**Status.** ○ almost entirely to build (today: only on-foot wildlife combat
`attack`/`flee`). This pillar needs the most new systems: ship modules/loadouts,
the encounter resolver, piracy/bounty/military frameworks, the notoriety axis.

**Cross-ties.** Preys on **Trade** (piracy) and **Building** (raids); serves
**Politics** (war); bounty-hunting polices the lawless; **Neutralization**
borrows the combat resolver to fight hostile anomalies.

**Open Qs.** How deep do ship modules go? Is the phase-resolver turn-based-visible
(you pick maneuvers and watch) or instant-with-a-log? How much PvP is opt-in vs
ambient-risk? Insurance/death-stakes for ships?

**Resolved (2026-06, build plan).** Ship combat is a **distinct system from
on-foot wildlife `attack`** (which stays the on-foot melee layer); they may share
death/notoriety plumbing but not the resolver. Decisions:
- **Resolver style = interactive turn-by-turn.** A fight is a *stateful,
  multi-command* exchange: each phase you choose a maneuver (approach: close /
  hold range / evade → exchange: target a subsystem / alpha strike → …), an NPC
  AI picks its maneuver, the phase resolves, and you choose again until an
  outcome. Persisted as a ship-combat **session** on the player (a richer sibling
  of the wildlife `encounter`). Driven by ONE phase-contextual verb whose valid
  choices come from the session's current phase (reuses the arg-domain/abbrev/
  applicability machinery — no verb explosion), with the choices rendered as
  clickable actions. The pure resolver core takes
  `(phase, loadouts+state, playerChoice, npcChoice, rolls) → (nextState, log)`
  (rolls + NPC choice injected at the handler boundary — testable/seeded).
- **Modules = shallow archetypal.** ~5 slot types — weapon / shield / evasion /
  ECM / targeting — 2–3 modules each with legible rock-paper-scissors counters
  (targeting↔evasion, ECM↔targeting, shields↔burst, missiles↔evasion), slot
  COUNT scaling by ship class (shuttle 2 → hauler 5). A code catalog like
  `parts`/`upgrades`; obtained via the existing buy/`produce` economy. Deep
  fitting (power budgets, stacking penalties) is a later deepening, not now.
- **First proving ground = a PvE bounty board** (the Mercenary Charter org):
  hunt deterministically-generated NPC *wanted* ships posted at hubs
  (contracts-style) — accept → intercept → fight → reward + rep. Exercises
  modules + resolver with **no PvP/consent/notoriety** surface yet.
- **Async-before-live; coreward = the consent gradient.** The async/snapshot
  modes (piracy/base-raid/bounty vs a committed loadout/defense snapshot) come
  before live co-located duels (which build on the §Foundation 3b Realtime
  presence channel). The existing radiation/coreward axis (richer + deadlier) IS
  the lawless-danger-zone-vs-protected-rim-hub gradient — no new geography.

**Build order.** **Combat-1** — ship combat core (modules/loadouts + the
interactive phase resolver + the PvE bounty board). **Combat-2** — async PvP +
the Mercenary Charter (piracy, base raids vs defense buildings, notoriety/wanted,
insurance/escape). **Combat-3** — live co-located duels (on 3b presence).
**Combat-4** — military / faction war (take-and-hold contested systems; ties to
Politics). Combat-1 is independent of 3b but shares hot files (`commands.ts`/
`applicability.ts`/`usage.ts`/`render.ts`/`Player`), so it lands *after*
live-presence merges.

---

## v. Science

**Vision.** Invent, don't just craft. Materials science (discover new ways to
combine the known, and identify the genuinely new on new worlds), **breeding &
genetic engineering** of profitable plant/animal cultivars, and unique **ship
technologies** — research as a path that creates value nobody else has yet.

**Organization — Arcanum Collegium** (✅ exists as a faction). Research grants,
lab access, **patents** (own a recipe others must license), and gene-banks.

**Mechanics & progression.**
- ✅ fixed crafting (ingots/parts/upgrades/food/biofuel/condensate), farming &
  ranching with fixed cultivars.
- ○ **research / recipe discovery**: spend research (a lab building + inputs +
  time) to *unlock* new recipes — combine materials experimentally; analyze
  found materials/relics to discover new ones. A tech tree that's partly
  procedural (new worlds → new base materials → new recipes).
- ○ **breeding & engineering** (ties hard to the **creature genome** cascade):
  selectively breed farmed crops/livestock for better yield/traits; genetically
  engineer new cultivars (combine genome traits) — profitable, ownable strains.
  This is what makes the genome a *player-shaped* system, not just flavor.
- ○ **unique ship tech**: research → new ship modules/upgrades (feeds Combat &
  Discovery gear). **Patents**: a researched recipe can be licensed/sold (Trade).
- ○ **anomaly science** (the bridge to Neutralization): studying contained
  anomalies yields exotic, dangerous tech.

**Cross-ties.** Consumes **Discovery** (new materials/specimens) and
**Building** (labs); its outputs power **Trade** (patents), **Combat** (tech),
**Building** (advanced materials); anomaly research links **Neutralization**.

**Open Qs.** Research as time+inputs, or puzzle/experiment? How procedural is the
recipe space (finite-but-huge, like the genome)? Patents — enforceable in a
shared world, or just first-mover advantage?

---

## vi. Politics

**Vision.** Operate on the **species-empire** layer: earn standing with an
empire and climb it, broker between empires through the Conclave, or **found
your own alliance** — accumulating real influence over territory, trade law,
war, and other players.

**Two distinct things here (don't conflate them):**
- **The empires** (§Foundation) — the political *structure*, along species
  lines. ✅ the 4 NPC factions are the seed (reputation, ranks, rivalries, rank
  perks) and become species-empires as the species layer lands.
- **The Conclave** — Politics's own *guild*: an interspecies association of the
  influential (power-brokers rubbing elbows), distinct from the empires. Your
  guild rank here is your *personal* political clout — introductions, diplomatic
  standing, the right to charter an alliance — independent of any one empire's
  reputation ladder.

**Mechanics & progression.**
- ✅ empire reputation, the rank ladder (Unknown→Champion), rivalries + standing
  trade-offs, rank-based trade perks, contracts as the demand engine.
- ○ **the Conclave** (Politics guild): a personal influence track earned by
  brokering deals/fulfilling cross-empire contracts; gates diplomacy actions +
  alliance charters.
- ○ **player alliances** (multiplayer): charter one (via the Conclave), recruit,
  pool resources, hold territory, coordinate — the social backbone the other
  pillars plug into (alliance bases, alliance trade, alliance war).
- ○ **influence mechanics**: rise toward empire leadership; steer empire
  behavior; **territory control** (who owns a cluster/system — coreward systems
  are the prize); diplomacy & war between empires and alliances.

**Cross-ties.** The connective tissue: trade access, war (Combat), territory
(Building), survey rights (Discovery), grants (Science) all flow through
empire reputation + Conclave standing.

**Open Qs.** Conclave-influence vs empire-reputation — separate currencies or
intertwined? Alliance governance model? Territory granularity (system? cluster?)?
How much can a player steer an NPC empire? War declaration & resolution rules?

---

## vii. Neutralization — the hidden pillar

**Vision.** The one path that doesn't intertwine with the others, and the most
**story-like**. Where every public pillar has a public organization, this one's
organization is **hidden** — *the Veil* (working name): a secret
interspecies body that maintains **spacetime stability** by **neutralizing
anomalies** — SCP-like creatures, locations, and phenomena that threaten the
fabric of the universe.

**The secrecy.** You can't apply to join. You're **recruited** — by stumbling
onto an anomaly and surviving/handling it, or by another neutralizer's notice.
The Veil never appears in public faction lists, contracts, or the org table; its
existence is itself a discovery. This gives Neutralization a genuine **story
arc** rather than a grind ladder.

**Anomalies (SCP-like taxonomy).** Rare, deterministic, dangerous — seeded into
the universe like sites but far rarer and stranger. Classes (sketch):
- **Entity anomalies** — creatures that break the normal rules (don't die
  conventionally, alter their surroundings, replicate, haunt a region).
- **Locus anomalies** — places where physics misbehaves (time dilation, looping
  geography, a region that rewrites its own biome, a planet that "shouldn't
  exist").
- **Phenomenon anomalies** — spacetime instabilities (rifts, drift in the warp
  metric, radiation that isn't from the core) that, if left, **spread** and
  degrade **regional stability**.
- (Today's `exploration-sites` `anomaly` type is the seed of this — Neutralization
  deepens "anomaly" from "a loot site" into a contained, classified entity.)

**Mechanics & progression.**
- **Detection**: anomalies are hidden until you have the means to sense them
  (a Veil-issued instrument, or a science/anomaly tech) — discovery within
  discovery.
- **Containment vs neutralization**: study (Science), **contain** (a structured,
  risky encounter — borrows the Combat resolver but anomalies have unique rules/
  counters), or destroy. Each carries spacetime-stability consequences.
- **Spacetime stability**: a meta-resource (global, or per-cluster) that
  anomalies erode; neutralizers restore it. Left unchecked, instability has
  *world* effects (warp costs spike, regions corrupt, hostile spawns) — so the
  Veil's work quietly protects everyone, mostly unseen.
- **Rank within the Veil**: dossier access, better containment tools, knowledge
  of the deeper story (what's *causing* the anomalies — the late-game mystery).

**Cross-ties.** Deliberately thin (it's the distinct path), but it *uses*
Discovery (find them), Science (study them), Combat (neutralize them) as tools
— it just doesn't feed the public economy. Anomaly byproducts are the contraband
that brushes Trade's black market and the exotic inputs Science covets — a quiet
leak between the hidden world and the public one.

**Open Qs.** How is the Veil first revealed (the recruitment trigger)? Is
stability global or regional? How "SCP" in tone — wiki-style dossiers (great fit
for the text interface + Nimbus blurb writer)? Is the late-game "what causes
anomalies" a fixed authored mystery or procedural?

---

## Cross-pillar weave (summary)

```
Discovery → finds worlds/relics/species → Trade sells, Science studies, Building uses
Science  → patents/tech/cultivars       → Trade, Combat, Building, Discovery gear
Building → bases/stations/megastructures → houses Production/Science, projects Politics
Trade    → wealth + goods + black market → funds all; smuggling invites Combat
Combat   → piracy/bounty/war             → polices & disrupts Trade/Building; serves Politics
Politics → influence/territory/alliances → gates access across every pillar
Neutralization → hidden; borrows Discovery/Science/Combat; protects the whole board
```

## Where it stands & how it gets built

- **Foundations already in place** (the demand economy + world richness): the
  factions/contracts/reputation/ranks system (Politics + Trade demand), the
  production chain & bases (Building + Trade supply), exploration sites/
  cartography/salvage (Discovery), ships (gear/sink), and the **generation
  cascade** (galaxy→biology) that makes Discovery/Science worth doing.
- **Biggest gaps, by pillar**: Combat (almost all of it — the engagement model
  is the key design), Science (research/breeding/tech tree), Trade (owned
  businesses + black market), Building (collaborative + stations + unique
  materials), Politics (player alliances + territory), Neutralization (the entire
  hidden layer — the most creative net-new).
- **Sequencing intuition** (for later planning, not committed): finish the
  **cascade** (surface ✅/geology/creature genome) since it underpins Discovery &
  Science; **populate the galaxy with sapient species + species-empires**
  (§Foundation) — the prerequisite for the pillars at full scale; then
  **Science** (research + breeding — activates the genome, feeds everyone); then
  **Combat** (the engagement model, which Neutralization reuses); **player
  alliances + the Conclave** (Politics) and **collaborative building** are the
  big multiplayer-social additions; **Neutralization** can seed early (anomalies
  already exist) and deepen as a story layer throughout.

## Collected open questions (for feedback)

1. **Combat**: depth of ship modules; turn-visible vs instant-with-log
   resolution; opt-in PvP vs ambient risk; ship-loss stakes/insurance.
2. **Trade**: how far into bribery/black-market; passive-income business design;
   a shared notoriety/heat axis with Combat.
3. **Building**: co-ownership model for collaborative bases; stations as tier vs
   place-type; megastructure scale.
4. **Science**: research as time-inputs vs experiment-puzzle; how procedural the
   recipe space is; patent enforceability.
5. **Politics**: alliance governance; territory granularity; steering NPC
   empires; war rules.
6. **Neutralization**: the recruitment reveal; global vs regional stability;
   tone (SCP dossier style?); authored vs procedural late-game mystery.
7. **Orgs**: ✅ RESOLVED — three layers (species → species-empires → 7 cross-
   cutting guilds, incl. Politics's Conclave + the hidden Veil). Remaining:
   Conclave-influence vs empire-reputation as separate vs intertwined currencies.
8. **Species** (the new foundation): how many dominant species (~3–6)? Hand-
   author the dominant ones vs curated-procedural? How much do origin-ecology
   parameters drive empire behavior/demand vs flavor only?
