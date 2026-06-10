/**
 * Static command vocabulary + per-command usage descriptors.
 *
 * Pure — no IO, no `server-only` — so the parser, the `help` handler, and unit
 * tests can all share it. `VERBS` is the abbreviation vocabulary (the verbs the
 * dispatcher understands); `USAGE` gives each verb its ordered argument slots
 * (name, optional?, and a hint for OPAQUE/free-form positions).
 *
 * The CONTEXTUAL candidate enumerations are deliberately NOT here — those come
 * from the `argDomain` builder in `commands.ts` so `help` and the resolver never
 * disagree about what arguments are valid. Every verb in `VERBS` MUST have a
 * `USAGE` entry (enforced by a unit test); register a new command in both this
 * file (vocabulary + usage) and `commands.ts` (its `argDomain` + handler).
 */

/**
 * Command vocabulary for prefix abbreviation — the canonical verbs the
 * dispatcher switch understands (plus the `look` alias, which is a distinct
 * word; `inv` is omitted because it already resolves as a prefix of
 * `inventory`). Typing a unique prefix of any of these expands to the full
 * verb before dispatch.
 */
export const VERBS: string[] = [
  "scan",
  "look",
  "map",
  "warp",
  "hyperwarp",
  "land",
  "jump",
  "regions",
  "disembark",
  "embark",
  "mine",
  "explore",
  "harvest",
  "plant",
  "ranch",
  "feed",
  "slaughter",
  "attack",
  "flee",
  "inventory",
  "upgrades",
  "craft",
  "eat",
  "build",
  "bases",
  "base",
  "storage",
  "deposit",
  "withdraw",
  "produce",
  "sell",
  "buy",
  "standing",
  "contracts",
  "fulfill",
  "who",
  "rename",
  "help",
];

/** One ordered argument position of a command. */
export interface UsageSlot {
  /** Placeholder label, e.g. `resource`, `cluster`, `qty`. */
  name: string;
  /** True when the argument may be omitted (rendered as `[name]`). */
  optional?: boolean;
  /**
   * Shown for OPAQUE positions (those whose `argDomain` returns `null` —
   * free-form / numeric, never prefix-matched). Tells the player what to type.
   */
  hint?: string;
}

/** Usage descriptor for one command: a one-line description + arg slots. */
export interface UsageDescriptor {
  /** One-line description of what the command does. */
  desc: string;
  /** Ordered argument slots; empty for no-argument commands. */
  slots: UsageSlot[];
  /**
   * True for a command that is merely another spelling of an existing
   * capability (e.g. `look` → `scan`). Aliases stay in `VERBS` (so they
   * resolve/abbreviate) and keep a `USAGE` entry (so `help <alias>` works), but
   * the no-arg `help` command list SKIPS them so the same capability isn't
   * listed twice as if distinct. See `renderHelp`.
   */
  alias?: boolean;
}

/**
 * Usage descriptor per verb. Resolvable slots (mine/sell/craft/buy arg 0) carry
 * no hint — their candidates come from the live `argDomain`; opaque slots carry
 * a hint so help can show a placeholder + guidance instead of a bogus list.
 */
export const USAGE: Record<string, UsageDescriptor> = {
  scan: { desc: "describe the planet you're on", slots: [] },
  look: { desc: "alias for scan", slots: [], alias: true },
  map: { desc: "list nearby systems to warp to", slots: [] },
  warp: {
    desc: "travel to another system in this galaxy (burns warp fuel)",
    slots: [
      { name: "arm", hint: "an arm # (wraps around the galaxy); see `map`" },
      { name: "cluster", hint: "see `map` for destinations" },
      { name: "system", hint: "a star index 0–1023 OR an x,y,z position; see `map`" },
    ],
  },
  hyperwarp: {
    desc: "jump to another galaxy (consumes a Hyperwarp Condensate)",
    slots: [{ name: "galaxy", hint: "a galaxy index ≥ 0 (galaxies are infinite outward)" }],
  },
  land: {
    desc: "fly to another planet in this system (burns regular fuel)",
    slots: [{ name: "planet", hint: "a planet # in this system; see `scan`" }],
  },
  jump: {
    desc: "jump to another region of this planet (or `O` for its orbital outpost)",
    slots: [{ name: "region", hint: "a region # on this planet, or `O` for the orbital outpost; see `regions`" }],
  },
  regions: {
    desc: "list regions of this planet to jump to",
    slots: [{ name: "page", optional: true, hint: "a page number (default 1)" }],
  },
  disembark: {
    desc: "step out of your ship onto the surface (needed to mine)",
    slots: [],
  },
  embark: {
    desc: "climb back aboard your ship (needed to trade & fly)",
    slots: [],
  },
  mine: {
    desc: "harvest a resource from this region (must be on foot)",
    slots: [{ name: "resource" }],
  },
  explore: {
    desc: "search the surface for salvage, plants and creatures (on foot)",
    slots: [],
  },
  harvest: {
    desc: "harvest wild plants here, or `harvest <crop>` your ripe farm plots (on foot)",
    slots: [{ name: "crop", optional: true }],
  },
  plant: {
    desc: "sow a biome-appropriate crop into a free plot at your crop farm (on foot)",
    slots: [{ name: "crop" }],
  },
  ranch: {
    desc: "acquire a biome-appropriate animal into your livestock pen (on foot)",
    slots: [{ name: "animal" }],
  },
  feed: {
    desc: "feed your herd its crop to breed it over time (on foot)",
    slots: [{ name: "animal" }],
  },
  slaughter: {
    desc: "slaughter animals from your herd for product materials (on foot)",
    slots: [
      { name: "animal" },
      { name: "n", optional: true, hint: "how many to slaughter (default: the whole herd)" },
    ],
  },
  attack: {
    desc: "strike the creature you're facing (one combat round)",
    slots: [],
  },
  flee: {
    desc: "break off combat and slip away",
    slots: [],
  },
  inventory: { desc: "show cargo, credits, fuel and status", slots: [] },
  upgrades: {
    desc: "show installed ship upgrades + capabilities",
    slots: [],
  },
  craft: {
    desc: "cook food, refine biofuel, or craft Hyperwarp Condensate (upgrades are now `produce`d)",
    slots: [{ name: "item", hint: "a food id, `biofuel <material>`, or `hyperwarp_condensate`" }],
  },
  eat: {
    desc: "eat a cooked food to restore health",
    slots: [{ name: "food" }],
  },
  build: {
    desc: "build a base or an in-base structure (silo/excavator/production_line/blast_furnace/crop_farm/power plant) here (on foot)",
    slots: [
      { name: "structure" },
      { name: "name", optional: true, hint: "an optional base name (build base only)" },
    ],
  },
  bases: {
    desc: "list the bases you've established",
    slots: [],
  },
  storage: {
    desc: "show this region's base: buildings + stored contents",
    slots: [],
  },
  base: {
    desc: "alias for storage",
    slots: [],
    alias: true,
  },
  deposit: {
    desc: "move cargo from your ship into this base's storage",
    slots: [
      { name: "item" },
      { name: "qty", optional: true, hint: "a number (default: as much as fits)" },
    ],
  },
  withdraw: {
    desc: "move stored items from this base back to your ship",
    slots: [
      { name: "item" },
      { name: "qty", optional: true, hint: "a number (default: as much as fits)" },
    ],
  },
  produce: {
    desc: "smelt an ingot (blast furnace), or manufacture a ship part/upgrade (production line) from siloed inputs",
    slots: [
      { name: "item" },
      { name: "qty", optional: true, hint: "a number (default 1)" },
    ],
  },
  sell: {
    desc: "sell cargo (or an upgrade) at a settlement/outpost market",
    slots: [{ name: "resource" }],
  },
  buy: {
    desc: "buy fuel, warp fuel, minerals or upgrades",
    slots: [
      { name: "item" },
      { name: "qty", optional: true, hint: "a number (default 1)" },
    ],
  },
  standing: {
    desc: "show your reputation with each NPC faction",
    slots: [],
  },
  contracts: {
    desc: "list the goods contracts on offer at this trade hub's faction",
    slots: [],
  },
  fulfill: {
    desc: "deliver the goods for a hub contract for credits + faction reputation",
    slots: [{ name: "n", hint: "a contract # from `contracts`" }],
  },
  who: { desc: "see the shared-world leaderboards", slots: [] },
  rename: {
    desc: "set your public handle (shown on leaderboards, `who` and bases)",
    slots: [
      { name: "username", hint: "3–20 letters, digits, dashes or underscores" },
    ],
  },
  help: {
    desc: "list commands, or show usage for one",
    slots: [{ name: "command", optional: true, hint: "a command name; see `help`" }],
  },
};

/** Build the canonical usage string, e.g. `buy <item> [qty]` or `scan`. */
export function usageLine(verb: string): string {
  const u = USAGE[verb];
  if (!u) return verb;
  const parts = u.slots.map((s) => (s.optional ? `[${s.name}]` : `<${s.name}>`));
  return [verb, ...parts].join(" ");
}
