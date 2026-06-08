/**
 * Pure RenderFrame builders for command output. Given already-fetched data,
 * these compose the terminal frames — no DB, no game logic beyond formatting.
 * Kept separate from `commands.ts` so the (thin) handlers stay focused on
 * orchestration and these stay trivially testable.
 *
 * Every noun a player might act on is an `action` span whose `command` is the
 * exact string the click submits (AC: "use clickable actions generously").
 */
import type { Biome, Planet, Region, StarSystem } from "@/lib/universe";
import { getResource } from "@/lib/universe";
import type { RenderFrame, RenderLine, RenderSpan } from "@/lib/terminal/types";
import { action, frame, line, text } from "@/lib/terminal/helpers";
import { effectiveAbundance, fuelCost, FREEZING_C, BOILING_C } from "./rules";
import { UPGRADES, getUpgrade } from "./upgrades";
import { VERBS, USAGE, usageLine } from "./usage";

/** Human description of what owning an upgrade lets you do (UI text only). */
function capabilityOf(upgradeId: string): string {
  switch (upgradeId) {
    case "ablative_shields":
      return `land & mine boiling worlds (> ${BOILING_C}°C)`;
    case "antifreeze_tanks":
      return `land & mine freezing worlds (< ${FREEZING_C}°C)`;
    default:
      return "no known capability";
  }
}

/** A single error/notice line — never throw to the client. */
export function errorFrame(message: string): RenderFrame {
  return frame([line(text(message, "danger"))]);
}

export function noticeFrame(message: string): RenderFrame {
  return frame([line(text(message, "muted"))]);
}

/**
 * The full command list, GENERATED from the single command registry
 * (`VERBS` + `USAGE`) so it can never drift from what the dispatcher actually
 * accepts: every dispatchable verb appears here automatically, and removing one
 * removes its help line. There is intentionally no hardcoded command array.
 *
 * Order follows `VERBS` (the abbreviation vocabulary), which is also the only
 * place a command's display position is recorded — there's no second order list
 * to forget a command in. Aliases (e.g. `look` → `scan`) are skipped so the same
 * capability isn't listed twice; they still resolve and have their own
 * `help <alias>`. Each line shows the canonical `usageLine(verb)` as a clickable
 * token plus the verb's one-line `desc`.
 */
export function renderHelp(): RenderFrame {
  const verbs = VERBS.filter((verb) => !USAGE[verb]?.alias);
  return frame([
    line(text("Omniplex — commands", "heading")),
    ...verbs.map((verb) => {
      const u = USAGE[verb]!;
      return line([
        text("  ", "muted"),
        action(usageLine(verb), verb, { title: `run "${verb}"` }),
        text("  — " + u.desc, "muted"),
      ]);
    }),
    line(text("Click any blue token, or type a command and press Enter.", "muted")),
  ]);
}

/** One enumerated candidate for a resolvable slot. */
export interface CommandHelpCandidate {
  label: string;
  /** The command a click submits, or `null` to render as plain text. */
  command: string | null;
  /** Optional annotation shown muted after the token, e.g. a price (`8cr`). */
  annotation?: string;
}

/**
 * A labeled group of candidates within one slot. A `null` label renders the
 * group inline against the slot's `<placeholder>:` prefix (the single-category
 * case — visually identical to a plain candidate line). A non-null label (e.g.
 * `minerals`, `fuel`, `upgrades`) renders the group on its own `label:` line, so
 * trade commands can separate categories.
 */
export interface CommandHelpGroup {
  label: string | null;
  candidates: CommandHelpCandidate[];
}

/** One argument slot's resolved help info (built by the `help` handler). */
export interface CommandHelpSlotView {
  /** Placeholder label, e.g. `resource`, `cluster`, `qty`. */
  name: string;
  optional: boolean;
  /** Opaque position: show `<name>` + this hint (no enumeration). */
  hint?: string;
  /**
   * Resolvable position: the live candidates from `argDomain`, partitioned into
   * one or more labeled groups. A single `{ label: null }` group is the common
   * case (mine/craft); trade commands split into category groups with prices.
   */
  groups?: CommandHelpGroup[];
  /** Resolvable but currently empty: a contextual note (e.g. "nothing minable here"). */
  emptyNote?: string;
}

export interface CommandHelpView {
  verb: string;
  /** Canonical usage string, e.g. `mine <resource>`. */
  usage: string;
  /** One-line description of what the command does. */
  desc: string;
  /** Ordered argument slots; empty for no-argument commands. */
  slots: CommandHelpSlotView[];
}

/**
 * `help <command>`: a usage line + per-argument detail. Resolvable positions
 * list their LIVE candidates (clickable when the click forms a complete
 * command); opaque positions show a `<placeholder>` + hint. The candidate sets
 * come from the same `argDomain` the parser uses, so help always matches what
 * the command actually accepts.
 */
export function renderCommandHelp(view: CommandHelpView): RenderFrame {
  const lines: RenderLine[] = [
    line(text(view.usage, "heading")),
    line(text(`  ${view.desc}`, "muted")),
  ];

  if (view.slots.length === 0) {
    lines.push(line(text("  (no arguments)", "muted")));
    return frame(lines);
  }

  for (const slot of view.slots) {
    const placeholder = slot.optional ? `[${slot.name}]` : `<${slot.name}>`;
    if (slot.groups) {
      const nonEmpty = slot.groups.filter((g) => g.candidates.length > 0);
      if (nonEmpty.length === 0) {
        lines.push(
          line([
            text(`  ${placeholder}: `, "muted"),
            text(slot.emptyNote ?? "nothing available right now", "muted"),
          ]),
        );
      } else {
        // One line per group. A null label uses the slot placeholder as the
        // prefix (single-category case, unchanged); a named label heads its own
        // line so trade categories read distinctly.
        for (const group of nonEmpty) {
          const prefix = group.label === null ? `  ${placeholder}: ` : `  ${group.label}: `;
          const spans: RenderSpan[] = [text(prefix, "muted")];
          group.candidates.forEach((c, idx) => {
            if (idx > 0) spans.push(text(" ", "muted"));
            if (c.command) {
              spans.push(action(c.label, c.command, { style: "link", title: c.command }));
            } else {
              spans.push(text(c.label, "accent"));
            }
            if (c.annotation) spans.push(text(` (${c.annotation})`, "muted"));
          });
          lines.push(line(spans));
        }
      }
    } else {
      // Opaque (free-form / numeric): placeholder + hint, never an enumeration.
      const spans: RenderSpan[] = [text(`  ${placeholder}`, "default")];
      if (slot.hint) spans.push(text(` — ${slot.hint}`, "muted"));
      lines.push(line(spans));
    }
  }

  return frame(lines);
}

function abundanceLabel(value: number): string {
  if (value <= 0) return "depleted";
  return `${Math.round(value * 100)}%`;
}

export interface ScanView {
  planet: Planet;
  system: StarSystem;
  /** The region the player is currently standing in (its biome + deposits). */
  region: Region;
  /** Accumulated depletion per resource id in the CURRENT region. */
  depletionMap: Record<string, number>;
  /** True only on the scan that first recorded the discovery. */
  justDiscovered: boolean;
  /** Handle of the original discoverer, if known and not this player. */
  discovererNote?: string;
  /** Upgrade id required to land/mine here, or null if survivable bare. */
  requiredUpgrade?: string | null;
  /** Whether the player currently satisfies `requiredUpgrade`. */
  hasRequiredUpgrade?: boolean;
  /** Current hit points. */
  health: number;
  /** Maximum hit points (for the `HP n/max` readout). */
  maxHealth: number;
  /** True = aboard ship; false = on foot in this region. */
  embarked: boolean;
  /** Active combat encounter to surface (with `attack`/`flee` options), or null. */
  encounter?: EncounterView | null;
  /** Bases present in this region (shared-world presence); yours are marked. */
  bases?: ScanBase[];
}

/** A base present in the scanned region, for the shared-world presence readout. */
export interface ScanBase {
  /** Owner's display handle (shown for other players' bases). */
  handle: string;
  /** The base's name, or null if unnamed. */
  name: string | null;
  /** True when this base belongs to the scanning player. */
  mine: boolean;
}

/** The creature the player is currently facing, for the scan readout. */
export interface EncounterView {
  name: string;
  /** The creature's current hit points. */
  hp: number;
  /** The creature's maximum hit points. */
  maxHp: number;
  hostile: boolean;
}

/**
 * Scan/look/arrival frame: describe the CURRENT REGION (biome + deposits) plus
 * the planet context (palette, region count, the index of the region you're in)
 * and its system. Deposits and biome are per-region now; the landing
 * requirement remains planet-level (reads the planet's temperature).
 */
export function renderScan(view: ScanView): RenderFrame {
  const { planet, system, region, depletionMap, justDiscovered } = view;
  const lines: RenderLine[] = [];

  lines.push(
    line([
      text(planet.name, "heading"),
      text(`  (${system.name}, class-${system.starClass})`, "muted"),
    ]),
  );
  if (justDiscovered) {
    lines.push(line(text("★ First discovery! You charted this world.", "success")));
  } else if (view.discovererNote) {
    lines.push(line(text(view.discovererNote, "muted")));
  }

  // Survival status: health + whether you're aboard the ship or on foot.
  const lowHealth = view.health <= view.maxHealth * 0.3;
  lines.push(
    line([
      text("HP ", "muted"),
      text(`${view.health}/${view.maxHealth}`, lowHealth ? "danger" : "default"),
      text("   ", "muted"),
      view.embarked
        ? text("aboard ship", "accent")
        : text("on foot", "warning"),
    ]),
  );

  // Active combat encounter: name the creature, its HP, and the attack/flee
  // options. Surfaced on scan so a player who steps away mid-fight can see it.
  if (view.encounter) {
    const enc = view.encounter;
    lines.push(
      line([
        text(enc.hostile ? "⚔ Fighting " : "Facing ", enc.hostile ? "danger" : "warning"),
        text(`${enc.name}`, "accent"),
        text(`  HP ${enc.hp}/${enc.maxHp}`, "default"),
      ]),
    );
    lines.push(
      line([
        text("  ", "muted"),
        action("attack", "attack", { style: "link", title: `attack the ${enc.name}` }),
        text("  ", "muted"),
        action("flee", "flee", { style: "link", title: "break off combat" }),
      ]),
    );
  }

  // Current region: which region of how many, and its biome.
  lines.push(
    line([
      text("region ", "muted"),
      text(`${region.coord.region}`, "accent"),
      text(` / ${planet.regionCount}`, "muted"),
      text("   biome ", "muted"),
      text(region.biome, "accent"),
    ]),
  );
  // Planet context: the biome palette its regions draw from + atmosphere.
  lines.push(
    line([
      text("palette ", "muted"),
      text(planet.biomePalette.join(", "), "default"),
      text("   atmosphere ", "muted"),
      text(planet.atmosphere, "accent"),
    ]),
  );
  lines.push(
    line([
      text("gravity ", "muted"),
      text(`${planet.gravity}g`, "default"),
      text("   hazard ", "muted"),
      text(
        `${Math.round(planet.hazard * 100)}%`,
        planet.hazard >= 0.6 ? "danger" : "default",
      ),
      text("   temp ", "muted"),
      text(`${planet.temperature}°C`, "default"),
    ]),
  );

  // Landing/mining requirement for this surface, when one applies.
  if (view.requiredUpgrade) {
    const up = getUpgrade(view.requiredUpgrade);
    if (view.hasRequiredUpgrade) {
      lines.push(
        line(text(`Hostile surface — ${up.name} equipped ✓`, "success")),
      );
    } else {
      lines.push(
        line(text(`Hostile surface — requires ${up.name} to land/mine.`, "danger")),
      );
    }
  }

  // Deposits (this region) with effective (post-depletion) abundance.
  if (region.deposits.length === 0) {
    lines.push(line(text("No mineable deposits in this region.", "muted")));
  } else {
    lines.push(line(text("Deposits (this region):", "heading")));
    for (const dep of region.deposits) {
      const res = getResource(dep.resourceId);
      const eff = effectiveAbundance(dep.abundance, depletionMap[dep.resourceId] ?? 0);
      const spans: RenderSpan[] = [
        text("  • ", "muted"),
        text(`${res.name} `, "default"),
        text(`[${abundanceLabel(eff)}]`, eff <= 0 ? "muted" : "accent"),
      ];
      if (eff > 0) {
        spans.push(text("  ", "muted"));
        spans.push(
          action(`mine ${dep.resourceId}`, `mine ${dep.resourceId}`, {
            style: "link",
            title: `mine ${res.name}`,
          }),
        );
      }
      lines.push(line(spans));
    }
  }

  // Bases present in this region (shared-world presence): yours are marked,
  // others are shown by their owner's handle, proving cross-player visibility.
  const bases = view.bases ?? [];
  if (bases.length > 0) {
    lines.push(line(text("Bases here:", "heading")));
    for (const b of bases) {
      const label = b.name && b.name.length > 0 ? b.name : "(unnamed base)";
      lines.push(
        line([
          text("  • ", "muted"),
          text(`${label} `, b.mine ? "accent" : "default"),
          text(b.mine ? "(yours)" : `— ${b.handle}`, "muted"),
        ]),
      );
    }
  }

  // Explore other regions of this planet.
  lines.push(
    line([
      action("regions", "regions", { style: "link", title: "list this planet's regions" }),
      text(` to browse all ${planet.regionCount} regions; `, "muted"),
      text("jump <n>", "default"),
      text(" to move to another.", "muted"),
    ]),
  );

  // Sibling planets to land on.
  if (system.planetCount > 1) {
    lines.push(line(text("Other planets in this system:", "heading")));
    for (let i = 0; i < system.planetCount; i++) {
      const sib = system.planets[i]!;
      if (i === planet.coord.planet) {
        lines.push(
          line([text(`  ${i}: `, "muted"), text(`${sib.name} (here)`, "accent")]),
        );
      } else {
        lines.push(
          line([
            text(`  ${i}: `, "muted"),
            action(sib.name, `land ${i}`, { style: "link", title: `land on ${sib.name}` }),
          ]),
        );
      }
    }
  }

  return frame(lines);
}

/** One region row in the `regions` listing. */
export interface RegionListEntry {
  index: number;
  biome: Biome;
  /** True for the region the player is currently standing in. */
  current: boolean;
}

export interface RegionsView {
  planetName: string;
  /** Total regions on this planet. */
  regionCount: number;
  /** 1-based page being shown. */
  page: number;
  /** Total number of pages at the current page size. */
  pageCount: number;
  /** The window of regions on this page. */
  entries: RegionListEntry[];
}

/**
 * A paged, clickable listing of a planet's regions. A planet can have up to
 * 100,000 regions, so we show one window (page) at a time; each entry is a
 * `jump <n>` action labeled by the region's biome, and prev/next page links
 * advance the window.
 */
export function renderRegions(view: RegionsView): RenderFrame {
  const lines: RenderLine[] = [
    line([
      text(`${view.planetName} — regions`, "heading"),
      text(`  (${view.regionCount} total)`, "muted"),
    ]),
    line(text(`page ${view.page}/${view.pageCount}`, "muted")),
  ];

  for (const e of view.entries) {
    if (e.current) {
      lines.push(
        line([text(`  ${e.index}: `, "muted"), text(`${e.biome} (here)`, "accent")]),
      );
    } else {
      lines.push(
        line([
          text(`  ${e.index}: `, "muted"),
          action(e.biome, `jump ${e.index}`, {
            style: "link",
            title: `jump to region ${e.index}`,
          }),
        ]),
      );
    }
  }

  // Prev / next page navigation, shown only when there's somewhere to go.
  const nav: RenderSpan[] = [];
  if (view.page > 1) {
    nav.push(
      action("‹ prev", `regions ${view.page - 1}`, { style: "link", title: "previous page" }),
    );
  }
  if (view.page < view.pageCount) {
    if (nav.length > 0) nav.push(text("   ", "muted"));
    nav.push(
      action("next ›", `regions ${view.page + 1}`, { style: "link", title: "next page" }),
    );
  }
  if (nav.length > 0) lines.push(line(nav));

  return frame(lines);
}

export interface MapNeighbor {
  arm: number;
  cluster: number;
  system: number;
  name: string;
  distance: number;
  discovered: boolean;
}

/** The player's current six-tier location + galaxy context, shown atop `map`. */
export interface MapLocation {
  galaxyName: string;
  armCount: number;
  galaxy: number;
  arm: number;
  cluster: number;
  system: number;
  planet: number;
  region: number;
}

/**
 * Nearby-systems map: the player's full location (galaxy/arm/cluster/system/
 * planet/region) and the galaxy's arm count, then each neighbor as a `warp <arm>
 * <cluster> <system>` action + its fuel cost.
 */
export function renderMap(
  neighbors: MapNeighbor[],
  currentFuel: number,
  loc: MapLocation,
): RenderFrame {
  const lines: RenderLine[] = [
    line([
      text(`Galaxy ${loc.galaxy} `, "heading"),
      text(`${loc.galaxyName} `, "accent"),
      text(`(${loc.armCount} arms)   fuel ${currentFuel}`, "muted"),
    ]),
    line([
      text("you are at  ", "muted"),
      text(
        `arm ${loc.arm} · cluster ${loc.cluster} · system ${loc.system} · planet ${loc.planet} · region ${loc.region}`,
        "default",
      ),
    ]),
    line(text("Nearby systems", "heading")),
  ];
  if (neighbors.length === 0) {
    lines.push(line(text("No charted neighbors in range.", "muted")));
    return frame(lines);
  }
  for (const n of neighbors) {
    const cost = fuelCost(n.distance);
    const affordable = cost <= currentFuel;
    lines.push(
      line([
        action(n.name, `warp ${n.arm} ${n.cluster} ${n.system}`, {
          style: "link",
          title: `warp to ${n.name}`,
        }),
        text(`  ${n.arm}:${n.cluster}:${n.system}`, "muted"),
        text(`  fuel ${cost}`, affordable ? "default" : "danger"),
        text(n.discovered ? "  ✓ discovered" : "  • uncharted", "muted"),
      ]),
    );
  }
  return frame(lines);
}

export interface InventoryView {
  stacks: { resourceId: string; qty: number; price: number | null }[];
  /**
   * Owned materials (sellable, no cargo cost), with name + fixed sell value.
   * Food materials also carry a `heal` (HP restored by `eat`).
   */
  materials?: { materialId: string; qty: number; name: string; value: number; heal?: number }[];
  cargoUsed: number;
  cargoCap: number;
  credits: number;
  fuel: number;
  health: number;
  maxHealth: number;
  embarked: boolean;
}

export function renderInventory(view: InventoryView): RenderFrame {
  const { stacks, cargoUsed, cargoCap, credits, fuel, health, maxHealth, embarked } = view;
  const lowHealth = health <= maxHealth * 0.3;
  const lines: RenderLine[] = [
    line([
      text("Cargo ", "heading"),
      text(`${cargoUsed}/${cargoCap}`, cargoUsed >= cargoCap ? "warning" : "default"),
      text(`   credits ${credits}`, "accent"),
      text(`   fuel ${fuel}`, "default"),
    ]),
    line([
      text("HP ", "muted"),
      text(`${health}/${maxHealth}`, lowHealth ? "danger" : "default"),
      text("   ", "muted"),
      embarked ? text("aboard ship", "accent") : text("on foot", "warning"),
    ]),
  ];
  if (stacks.length === 0) {
    lines.push(line(text("Hold is empty. Find a planet and `mine`.", "muted")));
  } else {
    for (const s of stacks) {
      const res = getResource(s.resourceId);
      const priceText =
        s.price != null ? `@ ${s.price}/u` : "(no market)";
      lines.push(
        line([
          text("  • ", "muted"),
          text(`${res.name} ×${s.qty}  `, "default"),
          text(priceText + "  ", "muted"),
          action(`sell ${s.resourceId}`, `sell ${s.resourceId}`, {
            style: "link",
            title: `sell ${res.name}`,
          }),
        ]),
      );
    }
    lines.push(
      line([
        text("  ", "muted"),
        action("sell all", "sell all", { style: "link", title: "sell everything" }),
      ]),
    );
  }

  // Materials (sellable salvage; not in the hold). Listed only when held.
  const materials = view.materials ?? [];
  if (materials.length > 0) {
    lines.push(line(text("Materials (sell while embarked):", "heading")));
    for (const m of materials) {
      const spans: RenderSpan[] = [
        text("  • ", "muted"),
        text(`${m.name} ×${m.qty}  `, "default"),
        text(`@ ${m.value}/u  `, "muted"),
      ];
      // Food: show its heal and offer `eat` (works in either embark state).
      if (m.heal && m.heal > 0) {
        spans.push(text(`+${m.heal} HP  `, "accent"));
        spans.push(
          action(`eat ${m.materialId}`, `eat ${m.materialId}`, {
            style: "link",
            title: `eat ${m.name}`,
          }),
          text("  ", "muted"),
        );
      }
      spans.push(
        action(`sell ${m.materialId}`, `sell ${m.materialId}`, {
          style: "link",
          title: `sell ${m.name}`,
        }),
      );
      lines.push(line(spans));
    }
  }
  return frame(lines);
}

export interface UpgradesView {
  owned: { upgradeId: string; qty: number }[];
}

/**
 * Owned ship upgrades + the capability each one activates. When the player owns
 * none, list the craftable catalog as a hint (each a clickable `craft` action).
 */
export function renderUpgrades(view: UpgradesView): RenderFrame {
  const lines: RenderLine[] = [line(text("Ship upgrades", "heading"))];
  if (view.owned.length === 0) {
    lines.push(line(text("None installed. Craftable:", "muted")));
    for (const u of UPGRADES) {
      lines.push(
        line([
          text("  • ", "muted"),
          action(u.name, `craft ${u.id}`, { style: "link", title: `craft ${u.name}` }),
          text(`  — ${capabilityOf(u.id)}`, "muted"),
        ]),
      );
    }
    return frame(lines);
  }
  for (const o of view.owned) {
    const up = getUpgrade(o.upgradeId);
    lines.push(
      line([
        text("  • ", "muted"),
        text(`${up.name} ×${o.qty}  `, "default"),
        text(`✓ ${capabilityOf(o.upgradeId)}`, "success"),
      ]),
    );
  }
  return frame(lines);
}

export interface BasesView {
  /** The player's own bases: a friendly location label + optional name. */
  bases: { name: string | null; location: string; regionKey: string }[];
}

/**
 * The `bases` listing — every base the player owns, with its location and name.
 * When they own none, a hint to `build base` while on foot.
 */
export function renderBases(view: BasesView): RenderFrame {
  const lines: RenderLine[] = [line(text("Your bases", "heading"))];
  if (view.bases.length === 0) {
    lines.push(
      line([
        text("None yet. ", "muted"),
        text("`disembark` then `build base [name]` to establish one.", "muted"),
      ]),
    );
    return frame(lines);
  }
  for (const b of view.bases) {
    const label = b.name && b.name.length > 0 ? b.name : "(unnamed base)";
    lines.push(
      line([
        text("  • ", "muted"),
        text(`${label}  `, "accent"),
        text(b.location, "muted"),
      ]),
    );
  }
  return frame(lines);
}

export interface StorageView {
  /** The base's name, or null if unnamed. */
  name: string | null;
  /** Friendly location label for the base's region. */
  location: string;
  /** Number of silos (storage) and excavators (passive ore drain) in the base. */
  silos: number;
  excavators: number;
  /** Number of production lines (turn siloed minerals into ship parts via `produce`). */
  productionLines: number;
  /** Stored units used + total capacity (= SILO_CAPACITY × silos). */
  used: number;
  capacity: number;
  /** Stored items: item id (resource OR part), quantity, and display name. */
  items: { itemId: string; qty: number; name: string }[];
  /**
   * Parts a production line here can manufacture (each with a recipe summary).
   * Empty when there's no production line — only surfaced once one exists.
   */
  producible: { id: string; name: string; recipe: string }[];
}

/**
 * `storage` (alias `base`) — the current region's base: its silo/excavator
 * counts and what's stored against capacity. A clickable `build silo` /
 * `build excavator` / `collect` hint guides expanding it.
 */
export function renderStorage(view: StorageView): RenderFrame {
  const label = view.name && view.name.length > 0 ? view.name : "(unnamed base)";
  const lines: RenderLine[] = [
    line([
      text("Base ", "heading"),
      text(label, "accent"),
      text(`  ${view.location}`, "muted"),
    ]),
    line([
      text("silos ", "muted"),
      text(`${view.silos}`, "default"),
      text("   excavators ", "muted"),
      text(`${view.excavators}`, "default"),
      text("   lines ", "muted"),
      text(`${view.productionLines}`, "default"),
      text("   storage ", "muted"),
      text(`${view.used}/${view.capacity}`, view.used >= view.capacity ? "warning" : "default"),
    ]),
  ];

  if (view.items.length === 0) {
    lines.push(line(text("Storage is empty. `deposit <item>` or `collect` from excavators.", "muted")));
  } else {
    lines.push(line(text("Stored:", "heading")));
    for (const it of view.items) {
      lines.push(
        line([
          text("  • ", "muted"),
          text(`${it.name} ×${it.qty}  `, "default"),
          action(`withdraw ${it.itemId}`, `withdraw ${it.itemId}`, {
            style: "link",
            title: `withdraw ${it.name}`,
          }),
        ]),
      );
    }
  }

  // Producible parts (only once a production line exists), each clickable.
  if (view.producible.length > 0) {
    lines.push(line(text("Producible:", "heading")));
    for (const p of view.producible) {
      lines.push(
        line([
          text("  • ", "muted"),
          action(`produce ${p.id}`, `produce ${p.id}`, {
            style: "link",
            title: `manufacture ${p.name}`,
          }),
          text(`  (${p.recipe})`, "muted"),
        ]),
      );
    }
  }

  // Expansion hints (clickable).
  const hints: RenderSpan[] = [
    action("build silo", "build silo", { style: "link", title: "add storage capacity" }),
    text("   ", "muted"),
    action("build excavator", "build excavator", { style: "link", title: "add an ore drain" }),
    text("   ", "muted"),
    action("build production_line", "build production_line", {
      style: "link",
      title: "add a parts manufacturer",
    }),
  ];
  if (view.excavators > 0) {
    hints.push(text("   ", "muted"));
    hints.push(action("collect", "collect", { style: "link", title: "funnel accrued ore in" }));
  }
  lines.push(line(hints));
  return frame(lines);
}

export interface WhoView {
  topCredits: { handle: string; credits: number }[];
  topDiscoveries: { handle: string; count: number }[];
}

export function renderWho(view: WhoView): RenderFrame {
  const lines: RenderLine[] = [line(text("Galactic standings", "heading"))];
  lines.push(line(text("Richest pilots:", "accent")));
  if (view.topCredits.length === 0) {
    lines.push(line(text("  (no one out there yet)", "muted")));
  } else {
    view.topCredits.forEach((r, i) => {
      lines.push(
        line([
          text(`  ${i + 1}. `, "muted"),
          text(r.handle, "default"),
          text(`  ${r.credits} cr`, "accent"),
        ]),
      );
    });
  }
  lines.push(line(text("Top explorers:", "accent")));
  if (view.topDiscoveries.length === 0) {
    lines.push(line(text("  (nothing charted yet)", "muted")));
  } else {
    view.topDiscoveries.forEach((r, i) => {
      lines.push(
        line([
          text(`  ${i + 1}. `, "muted"),
          text(r.handle, "default"),
          text(`  ${r.count} discoveries`, "accent"),
        ]),
      );
    });
  }
  return frame(lines);
}
