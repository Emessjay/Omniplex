# Commands & Terminal UI

Load-bearing decisions extracted from `CLAUDE.md`, in build order.

### Load-bearing decisions from `command-abbrev`

- **Prefix abbreviation** lets players type a unique *prefix* of a command verb
  or of an enumerable argument: `mi t` → `mine titanium`, `sc` → `scan`,
  `sel a` → `sell all`. Resolution is **server-authoritative** (the pipeline
  already knows the valid sets) and happens before dispatch.
- **Pure core** is `src/lib/game/resolve.ts` (no IO; the dispatcher supplies
  candidate sets from state). Two functions:
  - `resolveToken(fragment, candidates) → TokenResolution` — exact match wins
    outright (even when it also prefixes another candidate); else a single
    prefix match resolves; >1 ⇒ `{ok:false, reason:"ambiguous", matches}` (sorted);
    0 ⇒ `{ok:false, reason:"none"}`. Case-insensitive; returns canonical spelling.
  - `resolveCommandLine(input, spec) → LineResolution` — parses via
    `parseCommand`, resolves the verb against `spec.verbs`, then each arg via
    `spec.argDomain(verb, argIndex, priorArgs)`. Returns `{ok:true, verb, args,
    canonical}` or `{ok:false, error}` (human-readable, names candidates on
    ambiguity). Blank input ⇒ the empty verb (dispatcher no-op).
- **`argDomain` contract**: return the candidate `string[]` for a *resolvable*
  argument position, or **`null`** for an **opaque** position (free-form /
  numeric — passed through verbatim, never prefix-matched). Ambiguity / no-match
  **never silently picks one** — it always surfaces the choice as an error.
- **Resolvable positions today** (wired in `commands.ts` `dispatch`): `mine`
  arg 0 = resource ids with non-depleted deposits on the current planet; `sell`
  arg 0 = inventory resource ids + the literal `all`; `buy` arg 0 = `["fuel"]`.
  `warp`/`land` args (and `buy`'s quantity) are **opaque**. New verticals plug
  their arg domains into the same `argDomain` switch.
- **Verb vocabulary** is the `VERBS` array (now in `src/lib/game/usage.ts`;
  canonical verbs + the `look` alias; `inv` is omitted since it resolves as a
  prefix of `inventory`). `dispatch` resolves the line, renders `error` as an error frame
  on failure, otherwise dispatches the canonical verb/args via
  `dispatchResolved` and prepends a muted `» <canonical>` echo line whenever
  abbreviation expanded the typed input (so players learn the full form).

### Load-bearing decisions from `help-args`

- **`help <command>` shows live usage** drawn from the SAME `argDomain` the
  parser uses, so help can never list an argument the parser rejects (or omit
  one it accepts). `help` (no arg) is unchanged (`renderHelp` command list).
- **Two registration points for a command** — keep them in lock-step:
  1. `src/lib/game/usage.ts` (PURE, no `server-only`): `VERBS` (the
     abbreviation vocabulary, moved here from `commands.ts`) + `USAGE`
     (`verb → { desc, slots: { name, optional?, hint? }[] }`). A slot's `hint`
     is shown for OPAQUE positions only. `usageLine(verb)` renders the canonical
     usage string (`<required>` / `[optional]`). Every verb in `VERBS` MUST have
     a `USAGE` entry (unit-tested in `help-args.test.ts`).
  2. `commands.ts`: the contextual `argDomain` via the reusable
     `buildResolveSpec(ctx)` + `loadArgDomainContext(player, seed, verb)` pair
     (extracted from `dispatch`; only `mine`/`sell` hit the DB). Both `dispatch`
     and `handleHelp` call these, so resolution and help share one domain.
- **`handleHelp`** resolves its command arg by the same unique-prefix
  `resolveToken` (so `help mi` → `mine`); unknown/ambiguous → an error frame,
  never a throw. For each slot it calls `argDomain(verb, i, [])`: non-null →
  enumerate candidates (clickable as `verb <candidate>` when arg 0 + all later
  slots optional; empty → a contextual note like "nothing minable here");
  null → a `<placeholder>` + the slot's `hint`. Rendering is
  `renderCommandHelp(CommandHelpView)` in `render.ts` (pure; handler computes
  candidates/clickability, renderer stays dumb).

### Load-bearing decisions from `help-trade-clarity`

- **Grouped + price-annotated help** for trade commands. A resolvable help
  slot's candidates are now `CommandHelpGroup[]` (in `render.ts`): each group
  has a `label` (`null` = the single-category case, rendered inline against the
  `<placeholder>:` prefix exactly as before; a string = its own `label:` line)
  and `CommandHelpCandidate[]` (each `{ label, command, annotation? }`, the
  annotation shown muted as `(<n>cr)` after the clickable token). mine/craft
  stay one `{label:null}` group (visually unchanged).
- **`help buy`/`help sell`** keep sourcing the candidate SET from the SAME
  `argDomain` the parser uses (no-drift guarantee), then layer grouping +
  pricing on top in `handleHelp`. Grouping is the pure `groupTradeCandidates`
  in `src/lib/game/trade-help.ts` (`tradeCategoryOf`: `fuel`→fuel, `all`→
  everything, `isUpgradeId`→upgrades, else minerals; fixed group order;
  unit-tested in `trade-help.test.ts`). Prices come from ONE `getMarketPrices`
  call: buy = `buyUnitCost(price)` / `buyUnitCost(upgradeValue)` /
  `FUEL_PRICE_PER_UNIT`; sell = market price / `upgradeValue`; `all` carries no
  price. Credit format is `creditLabel(n)` = `<n>cr`.
- **Reuse for future trade-like commands**: build groups via
  `groupTradeCandidates` + `creditLabel`; single-category commands just pass one
  `{label:null}` group and render identically to the old single line.

### Load-bearing decisions from `help-parity`

- **The no-arg `help` command list is GENERATED from the single registry**
  (`VERBS` + `USAGE` in `usage.ts`), not a hardcoded array — `renderHelp()`
  (`render.ts`) iterates `VERBS` (skipping aliases) and renders
  `usageLine(verb)` + `USAGE[verb].desc` per command. So a new command appears
  in `help` automatically once it's in `USAGE`/`VERBS`; there is NO second
  command list to forget it in. Display order = `VERBS` order.
- **Aliases carry `alias: true`** in their `USAGE` descriptor (today: `look` →
  `scan`). Aliases stay in `VERBS` (so they abbreviate/resolve) and keep a
  `USAGE` entry (so `help <alias>` works), but `renderHelp` SKIPS them so the
  same capability isn't listed twice. Mark any future synonym this way rather
  than special-casing it in the renderer.
- **Parity is locked** in `help-args.test.ts`: the verbs `help` links to ===
  `VERBS` minus aliases (both directions), and `USAGE` keys === `VERBS` (both
  directions). Registering a command in only one place fails the suite.

### Load-bearing decisions from `red-actions`

- **`ActionSpan.disabled` is the "unperformable → red" convention.** An
  `ActionSpan` (`src/lib/terminal/types.ts`) carries an optional
  `disabled?: boolean`; when set, the renderer colors the token with the
  `danger` (red) intent instead of the usual `link` (blue), **overriding any
  declared `style`**. It is **color-only** (theme-parity rule — no geometry
  change) and the token **stays clickable**: clicking a red action still submits
  its command and returns the normal "you can't do that" error frame (which is
  informative). Default undefined/false = performable = blue.
- **Renderer color choice is the pure `actionStyle(span)`** in
  `src/lib/terminal/helpers.ts` (`disabled → "danger"`, else `style ?? "link"`),
  used by `<Terminal>`'s `Span` (`STYLE_CLASS[actionStyle(span)]`) so the mapping
  is unit-testable without React (`src/lib/terminal/red-actions.test.ts`). The
  `action(label, command, { disabled })` helper gained the optional flag and
  stays back-compatible (falsey `disabled` is not serialized).
- **Server decides performability using the SAME gates that reject the command**
  — never parallel logic — so red ⇔ the command would error. Coverage today
  (`render.ts` + `commands.ts`): `mine` actions in `scan` (red when embarked, or
  hostile surface without the landing gear — `view.embarked` /
  `requiredUpgrade`+`hasRequiredUpgrade`); `land` siblings (red when on foot);
  `warp` in `map` (red when `fuelCost > fuel`); upgrade `buy` in `upgrades`
  (`!canBuyFromSupply(supply)` out-of-stock, or `credits < price`); `build
  silo|excavator|production_line` hints in `storage` (`canAffordBase(have,
  buildingCost(kind))`); `produce <part>` in `storage` (`!canProduce(siloed,
  recipe, 1)`); and `help buy` candidates (`buyDisabled` reusing
  `FUEL_PRICE_PER_UNIT`/`buyUnitCost`/`canBuyFromSupply`). `CommandHelpCandidate`
  and `StorageView`/`UpgradesView` gained the flags/affordability inputs that
  carry this from handler to renderer.
- **Future actionable output adopts this:** mark an action `disabled` whenever
  the emitting handler already knows it would be rejected. The exploration track
  should mark P2 can't-afford warp/fuel and P3 galaxy-jump-without-condensate
  actions `disabled` too.

### Load-bearing decisions from `context-help`

- **ONE applicability model is the single source of truth for both context-aware
  `help` AND the dispatch gate** — "shown in `help`" ⇔ "usable right now" can
  never drift (the same single-source pattern as arg domains + the verb
  registry). It lives in `src/lib/game/applicability.ts` (PURE — no IO, no
  `server-only`): `isApplicable(verb, state)` + `applicableVerbs(state, verbs?)`
  over `PlayerStateView = { embarked: boolean; inCombat: boolean }` (`inCombat =
  player.encounter != null`). This REPLACED the scattered `EMBARKED_ONLY` /
  `DISEMBARKED_ONLY` sets and the ad-hoc combat checks in `commands.ts` — there
  is NO parallel gating logic anymore.
- **State buckets** (each verb lives in exactly ONE; that placement decides both
  help-visibility and dispatch-acceptance):
  - **INFORMATIONAL** (always, every state incl. combat): `help`, `scan`,
    `map`, `inventory`, `upgrades`, `who`, `bases`, `regions`, `storage` (+ the
    `look`/`base` aliases, which follow their canonical informational verb).
  - **COMBAT_ONLY** (iff `inCombat`): `attack`, `flee`.
  - **EMBARKED_ACTIONS** (iff `embarked && !inCombat`): `buy`, `sell`, `warp`,
    `land`, `hyperwarp`, `disembark`.
  - **DISEMBARKED_ACTIONS** (iff `!embarked && !inCombat`): `mine`, `explore`,
    `harvest`, `build`, `produce`, `collect`, `deposit`, `withdraw`, `embark`.
    NOTE: `produce`/`collect`/`deposit`/`withdraw` are now DISEMBARKED-only
    (they were ungated "it's your base" before P10) — viewing the base
    (`storage`) stays informational, but ACTING on it requires being on foot.
  - **ANYTIME_OUT_OF_COMBAT** (either embark state, but NOT combat): `craft`
    (fabrication — cook food / make condensate), `jump` (free region nav; combat
    must not let you slip away).
  - **`eat`** is in the ALWAYS set (usable in every state incl. combat — you can
    always snack to heal).
- **Combat overrides everything**: while `inCombat`, only `attack`/`flee`/`eat`
  (+ informational) are applicable; all surface/economy/travel/base verbs are
  hidden in `help` and rejected by dispatch.
- **`renderHelp(state)`** (now takes state) lists `applicableVerbs(state)` minus
  aliases, preserving `VERBS` display order — still GENERATED from the registry,
  just state-filtered. **`handleHelp` threads `playerState(player)`**; the
  no-arg list is context-aware, and `help <command>` still fully describes any
  command but appends a muted `(<reason>)` note when it isn't usable now.
- **Dispatch gate** (`dispatchResolved`): `if (!isApplicable(verb, state))
  return errorFrame(inapplicableReason(verb, state))`. `inapplicableReason`
  derives the message from the SAME buckets (in-combat → "`attack`, `flee`, or
  `eat`"; combat verbs out of combat → "nothing to fight"; `embark`/`disembark`
  no-ops → "already aboard/on the surface"; else must-embark / must-disembark).
  Finer handler-level errors (e.g. `attack` with a stale encounter) still live
  in the handlers and stay CONSISTENT with the gate. You can still TYPE/abbrev
  any verb — inapplicable ones get the contextual rejection.
- **Parity is locked per-state** in `help-args.test.ts` (updated): for
  embarked/disembarked/combat, the `help`-listed set === applicable non-alias
  verbs, bidirectionally, and every listed verb is `isApplicable`. The seeded
  `context-help.test.ts` locks the `isApplicable`/`applicableVerbs` matrix.
- **Future commands declare applicability HERE**: add the verb to exactly one
  bucket in `applicability.ts` (alongside its `VERBS`+`USAGE` registration and
  `argDomain`/handler) — help-visibility and dispatch-gating both follow
  automatically.

### Load-bearing decisions from `player-guidance`

- **Two player-assistance commands, no migration.** `guide` (soft-tutorial
  advisor) + `distress` (emergency rescue / anti-softlock).
- **`guide`** — pure advice engine `nextStep(snapshot) → {message,
  suggestedCommand?, stage}` in `src/lib/game/advisor.ts` (no IO; the handler
  builds a `GuideSnapshot` from live state). Returns the FIRST unmet rung of an
  ordered ladder: combat→attack/flee → orbiting-gas→`orbit <n>` →
  orbiting-rocky→`land` → landed→`disembark` → on-foot-no-ore→`scan`/`mine` →
  goods-off-hub→`map`/`regions`/`jump O` → at-hub→`contracts`/`fulfill`/`sell` →
  credits-no-base→`build base` → has-base→grow it → established→open-ended. Each
  nudges the player to re-run `guide` when done. **INFORMATIONAL — usable in
  EVERY state incl. combat.** New players are pointed to it via a boot-banner
  hint (`Terminal.tsx`). `renderGuide` in `render.ts`.
- **`distress`** — always-available rescue. `distressCost(credits) =
  min(credits, DISTRESS_FEE=5000)` (pure, `rules.ts`) — never fails for lack of
  funds (true safety net) yet stings the wealthy; broke players are rescued for
  the credits they have. Teleports to the **nearest outpost in the CURRENT
  system** (`systemOutpostPlanets`, nearest by `interplanetaryDistance`, lowest-
  index tiebreak — every system has ≥1), docking there (`region=-1`,
  `embarked=true`, `landed=false`), heals to `MAX_HEALTH`, clears any encounter,
  deducts the cost (atomic, validate-before-mutate, never negative).
  **ANYTIME_OUT_OF_COMBAT** (works stranded on a surface; `flee` covers combat).
  `world.setDistressLocation` is the single-write mutator. Only rescues to the
  current system, so the broke-free rescue isn't exploitable as free travel.
  Seeded: `player-guidance.test.ts`.

### Load-bearing decisions from `guide-advisor-fix`

- **The `guide` advisor was looping mine↔sell forever** (the "no ore→mine" /
  "has ore→sell" rungs fired before the progression rungs and were always
  satisfiable). Reworked `nextStep` (`advisor.ts`) into a **stable, milestone-
  based ladder** keyed off STABLE state (credits/holdings/base/ship/location),
  not transient cargo: combat → reach-a-surface → first ore → **gather base
  materials → build base** (a new player has the 500cr, so it says MINE the base
  minerals, NOT sell) → grow the base (excavators/production/farms/contracts) →
  bigger ship → explore/factions/coreward → open-ended. Selling is only advised
  toward a NAMED goal, never as a bare rung that ping-pongs with mining. Gives a
  new forward step each milestone. Seeded: `guide-advisor-fix.test.ts`.

### Load-bearing decisions from `status-bar`

- **Persistent HUD header** (playtest ask — clearing the terminal lost context).
  `StatusBar` type + **additive `RenderFrame.status?`** (`terminal/types.ts`);
  pure **`buildStatusBar(player, seed)`** (credits, friendly location, fuel,
  warpFuel, health/maxHealth, ship) attached in ONE central dispatch spot.
  `<Terminal>` keeps the latest status in its OWN state (separate from the log)
  and renders a fixed header — **survives `clear`** (the client meta-command only
  clears log lines) and is seeded from the `player` prop on first paint. Low HP
  red (P9b), color-only styling (theme parity). `submitCommand` signature
  unchanged. Custom "pin what you want" deferred to v2. Seeded: `status-bar.test.ts`.
