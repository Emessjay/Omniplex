# Factions & Social

Load-bearing decisions extracted from `CLAUDE.md`, in build order.

### Load-bearing decisions from `factions-core` (Keystone 1a)

- **The DEMAND side of the economy (per `docs/design/path-depth-roadmap.md`):
  NPC factions post rotating contracts for goods; fulfilling pays credits +
  faction reputation.** First piece that makes production/exploration/capitalism
  *pull* instead of dumping onto a flat market. (Ranks/gating = 1b; politics =
  1c — not yet built.)
- **`FACTIONS` catalog** (`src/lib/game/factions.ts`, pure): 4 factions with
  distinct demand themes — militarist (metals + parts), agrarian (crops + food +
  animal products), scientific (rare minerals + relics), mercantile (broad).
  `Faction = { id, name, blurb, demand: string[] }`; `demand` ids are all real
  CARRIABLE goods (resource/material/part — no silo-only ingots, no upgrades).
  Helpers `FACTIONS`/`FACTION_IDS`/`isFactionId`/`getFaction`.
- **Deterministic hub alignment + contract generation** (pure, no `Date`/
  `Math.random`): `factionAt(seed, locationKey)` aligns every trade hub
  (settlement region / outpost) to one faction. `contractsAt(seed, locationKey,
  factionId, timeBucket)` generates a bounded set of delivery contracts;
  `timeBucket = floor(now / CONTRACT_ROTATION_MS)` (passed in by the handler).
  `Contract = { key:"<hub>|<bucket>|<slot>", factionId, want:{itemId,qty},
  rewardCredits, rewardRep }`. Contracts ROTATE per bucket (keys bucket-distinct).
  **Reward is a PREMIUM over market**: `rewardCredits = round(itemUnitValue ×
  qty × CONTRACT_REWARD_MARKUP[=1.5])` (> dumping on the market); `rewardRep ≥ 1`.
- **Persistence** (migration `20260609030000_factions-core.sql`, forward-only/
  idempotent): `player_reputation (player_id→players cascade, faction_id text,
  rep int ≥0 check, pk(player,faction))` — **read-OWN RLS** (the inventory-policy
  pattern: `player_id in (select id from players where user_id = auth.uid())`),
  service-role writes, atomic clamped `add_reputation(p_player, p_faction,
  p_delta)` (`greatest(0, …)` upsert). `completed_contracts (player_id→players
  cascade, contract_key text, completed_at, pk(player,key))` — read-own RLS,
  guards double-fulfill. `world.ts`: `getReputation`/`addReputation`,
  `getCompletedContractKeys`/`markContractComplete`.
- **Commands**: `standing` (INFORMATIONAL — per-faction rep), `contracts`
  (INFORMATIONAL — current hub's contracts with fulfillable/completed/short
  states + P9b red + `fulfill <n>` actions; off-hub note), `fulfill <n>`
  (ECONOMY bucket: `atTradeLocation && !inCombat`; validate current+unfulfilled+
  held-goods → consume from the right store [inventory/materials/parts] →
  `addPlayerCredits`+`addReputation`+`markContractComplete`, atomic,
  validate-before-mutate, double-fulfill-guarded). Registered in `VERBS`/`USAGE`/
  `applicability`; `scan` at a hub surfaces a `contracts` hint. Seeded:
  `factions-core.test.ts` (+ `factions-extra.test.ts`).

### Load-bearing decisions from `faction-ranks` (Keystone 1b)

- **Reputation now pays off via RANKS that gate contract tiers** (the "rising
  through the ranks" payoff). NO migration — rank is a pure function of the
  existing `player_reputation.rep`. Builds on `factions-core`.
- **`RANKS` ladder** (`factions.ts`, 6 tiers): `Unknown`(0) / `Associate`(100) /
  `Contractor`(300) / `Partner`(700) / `Trusted`(1500) / `Champion`(3000) —
  `{tier, title, minRep}`, ascending (tier = array index). `rankFor(rep)` =
  highest rank with `minRep ≤ rep` (tier 0 at/below rep 0; clamps at top);
  monotonic in rep. `MAX_RANK_TIER` exported.
- **`contractsAt` gained a `rankTier` param** (`contractsAt(seed, locationKey,
  factionId, timeBucket, rankTier)`): the contract RNG (which items/slots, the
  `key`s) is **rank-INDEPENDENT** — only `want.qty`/rewards **scale UP with
  rank** — so higher standing ⇒ at-least-as-lucrative contracts
  (monotonic-in-rank) while the `factions-core` invariants (reward PREMIUM,
  bucket ROTATION, key stability) still hold at EVERY rank. `factions-core.test`/
  `factions-extra.test` were threaded with the new param (not weakened).
- **Display**: `handleContracts` reads the player's rep with the hub faction →
  `rankFor` → passes the tier to `contractsAt`, and the `contracts`/`standing`
  views show the rank **title** + next-tier threshold (`render.ts`). No new
  verbs (help-parity/applicability unchanged). Seeded: `faction-ranks.test.ts`.
- **Deferred (1b-cont / 1c)**: rank-based price discounts, rank-locked goods,
  faction politics/rivalry.

### Load-bearing decisions from `faction-politics` (Keystone 1c)

- **Faction standing is now strategic** — rivalries + standing trade-offs + a
  rank trade perk. NO migration (uses `player_reputation`), NO new verbs.
- **Rivalries** (`factions.ts`): each `Faction.rival` points at exactly one
  other faction, SYMMETRIC (`X.rival===Y ⟺ Y.rival===X`), 2 opposed pairs among
  the 4 — `iron_vanguard ↔ arcanum_collegium`, `verdant_compact ↔
  free_traders_league`. `rivalOf(id)` helper.
- **Standing trade-off**: `rivalRepPenalty(gain) = floor(gain ×
  RIVAL_REP_PENALTY_FRACTION[=0.5])` (pure). `handleFulfill` awards `rewardRep`
  to the hub faction THEN `addReputation(rivalOf(F), -rivalRepPenalty(rewardRep))`
  (RPC clamps ≥0); both the gain and the rival loss are reported. So you can't
  max everyone — allying antagonizes the rival.
- **Rank trade perk**: `repPriceDiscount(tier) = min(0.15, tier × 0.03)` (pure,
  0 at tier 0, monotonic, capped). At a faction's hub, `buy`/`sell` apply it per
  the player's rank with THAT hub's faction (resolved via `factionAt(hubKey)`):
  buy unit cost `floor(× (1−d))` (≥1), sell payout `round(× (1+d))`. Applies to
  resource/material/part/upgrade hub trades; NOT the distress fee. `standing`
  shows each faction's rival + both sides; `contracts`/`buy`/`sell` surface the
  active discount. Seeded: `faction-politics.test.ts`. (Keystone 1 — factions —
  is now complete: 1a contracts/rep, 1b ranks, 1c politics.)

### Load-bearing decisions from `sapient-species` (species foundation)

- **The galaxy is populated with sapient species** (per `pillars.md`
  §Foundation). Additive, NO migration, NO faction restructure, NO player-species.
  `src/lib/game/species.ts` (pure): `Species` cultural-DNA model (`originWorld`,
  `techAptitude` biotech/materials/computation/industry/broad, `socialStructure`
  hive/hierarchical/consensus/nomadic/isolationist + name/blurb — origin ecology
  drives the DNA, Sonnet model). **5 `DOMINANT_SPECIES`** (Kthar/Sylvani/Cindrel/
  Voorn/Tessarin) + helpers; deterministic **`minorSpeciesAt(seed, key)`**
  (`makeRng`-based) for the vast minor species.
- **Each faction is anchored to a dominant species** (`factions.species`,
  additive — mechanics untouched), techAptitude↔demand aligned: iron_vanguard→
  Kthar (industry/metals), verdant_compact→Sylvani (biotech/crops),
  arcanum_collegium→Cindrel (computation/relics), free_traders_league→Voorn
  (broad/trade); Tessarin unaffiliated (empire TBD). So demand themes now have an
  in-world reason.
- **Hubs show their inhabiting species**: `scan` at a settlement / outpost
  surfaces `inhabitingSpecies` — the hub faction's species (`factionAt`) or a
  `minorSpeciesAt` fallback. Display-only (no verb/applicability changes).
  Seeded: `sapient-species.test.ts`. The Politics-pillar buildout (empire/guild
  sort, alliances, the Conclave), player-species/character creation, species
  goods/diplomacy, and the Nimbus blurb writer build on this. Shared presence
  (co-location) is the next foundation.

### Load-bearing decisions from `shared-presence` (foundation 3a — co-located visibility)

- **The shared world is now socially visible**: players in the SAME place see
  each other. Polled (per-command), NO realtime/chat/combat yet (3b), NO migration.
- **`sameLocation(a, b)`** (pure, `src/lib/game/presence.ts`): true iff the full
  six-tier location tuple matches `(galaxy, arm, cluster, system, planet, region)`
  — groups same-region surface players, same-planet orbiters (region 0), and
  same-outpost dockers (region −1). **`presentPlayerView(p)`** is the PUBLIC
  boundary: handle + ship + embark/landed state ONLY — **never** id/user_id/email
  (same rule as the public `leaderboard` view; identity columns never reach the
  view). `world.playersHere(player)` (service-role) returns co-located OTHERS
  mapped through it (self-excluded).
- **Display**: a "Players here:" line in the surface/orbital/outpost `scan`
  frames (omitted when alone) + a NEW informational **`here`** verb
  (`VERBS`/`USAGE`/`applicability`, help-parity held) with an alone-message.
  `renderPresence` in `render.ts`. Seeded: `shared-presence.test.ts` (+ the
  worker's presence-display tests).
- **3b** adds Supabase Realtime (live arrive/leave + `say` local chat); co-located
  COMBAT (the pillars two-mode model) + trade build on this presence layer.

### Load-bearing decisions from `live-presence` (foundation 3b — live presence + local chat)

- **Co-location is now LIVE via Supabase Realtime** (3a was polled). NO migration,
  NO chat persistence (ephemeral by decision), NO co-located combat (a later
  Combat phase). The first Realtime code in the repo (the browser anon client was
  already Realtime-ready).
- **The server names the channel; the client just joins it.** Additive
  **`RenderFrame.presence?: PresenceHint`** (`terminal/types.ts`, type-only import
  of `PresenceHint` from `game/presence` — erased at runtime, no cycle), attached
  at the SAME central dispatch spot as `buildStatusBar`, built from the FRESH
  post-command player so the channel reflects movement. `presenceHintOf(player)`
  returns `undefined` when `!isSupabaseConfigured()` (build/CI green without
  secrets). `submitCommand` signature unchanged.
- **Pure helpers extend `src/lib/game/presence.ts`** (3a's module — not forked):
  `presenceChannelFor(loc)` = `"loc:g:a:c:s:p:r"` with the **load-bearing
  invariant `presenceChannelFor(a) === presenceChannelFor(b)` iff
  `sameLocation(a,b)`** (co-location ⇔ same channel); `presenceHintFor(player)`
  composes the channel + `presentPlayerView` (privacy in ONE place — never
  user_id/email); `sanitizeChatBody(raw)` strips control chars (U+0000–U+001F,
  U+007F → space), collapses whitespace, trims, caps at `CHAT_MAX_LEN`(240),
  empty→`null`; `presenceRoster(presenceState, selfKey)` flattens the Realtime
  presence-state, excludes self by handle, dedupes, stable-sorts (DEFENSIVE —
  tolerates garbage/missing fields). Seeded: `live-presence.test.ts`.
- **`say <message>` is server-authoritative + UNSPOOFABLE** (`handleSay`, `ALWAYS`
  applicability — talk in any state incl. combat; opaque free-text tail): sanitize
  → null⇒error; broadcast via `world.broadcastChat(presenceChannelFor(player),
  player.handle, body)` where the handle is taken from the SERVER record (never
  the client); echo `You say: …` to the sender. **`world.broadcastChat`**
  (`server-only`, service-role) is FAIL-SOFT: a NO-OP when unconfigured, and any
  Realtime error is swallowed (a failed publish never fails the command). Ephemeral
  broadcast (`event:"chat"`, payload `{handle, body}`) — no table, no history.
- **Client (`Terminal.tsx`)** keeps the latest `frame.presence` in state and a
  `useEffect` (re)subscribes when `channel`/`self.handle` changes (movement),
  tearing down the old channel (`untrack`+`removeChannel`): presence `sync`→a
  "Here now: …" line via `presenceRoster`, `join`/`leave`→live arrive/left lines,
  `broadcast:chat`→a `handle: body` line — all appended as ordinary log lines
  (never touch the status bar). Channel opened with `presence.key = self.handle`
  + **`broadcast.self = false`** (sender doesn't see a dup — they get the
  `You say:` echo). Guarded by `isSupabaseConfigured()` + a try/caught
  `getBrowserClient()` (SSR-safe, never crashes the renderer). The polled 3a
  `scan`/`here` snapshot is unchanged — live deltas layer on top.
- **Known minor**: self's tracked ship/state can go briefly stale to others if it
  changes WITHOUT a channel change (rare: buyship-in-place; embark/disembark keeps
  the same `presenceState` label) — cosmetic, acceptable for ephemeral presence.
- **Next**: co-located COMBAT (the two-mode model) builds on this presence channel
  (Combat-3, after the Combat-1/2 ship-combat core).
