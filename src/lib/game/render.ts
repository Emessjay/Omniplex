/**
 * Pure RenderFrame builders for command output. Given already-fetched data,
 * these compose the terminal frames — no DB, no game logic beyond formatting.
 * Kept separate from `commands.ts` so the (thin) handlers stay focused on
 * orchestration and these stay trivially testable.
 *
 * Every noun a player might act on is an `action` span whose `command` is the
 * exact string the click submits (AC: "use clickable actions generously").
 */
import type { Biome, Planet, Region, StarSystem, StarPosition } from "@/lib/universe";
import { getResource, SIZE_CLASS_LABELS } from "@/lib/universe";
import type { RenderFrame, RenderLine, RenderSpan } from "@/lib/terminal/types";
import { action, frame, line, text } from "@/lib/terminal/helpers";
import { effectiveAbundance, warpFuelCost, FREEZING_C, BOILING_C } from "./rules";
import { UPGRADES, getUpgrade } from "./upgrades";
import { USAGE, usageLine } from "./usage";
import { applicableVerbs, type PlayerStateView } from "./applicability";
import type { GuideAdvice } from "./advisor";

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
 * The CONTEXT-AWARE command list: lists exactly the verbs applicable in the
 * player's current `state` (`applicableVerbs`), so "shown in `help`" ⇔ "usable
 * right now" — help and the dispatch gate read the SAME applicability predicate
 * and can never drift. The set narrows by state (economy/travel aboard,
 * surface/base on foot, only attack/flee/eat in combat, informational always).
 *
 * Still GENERATED from the single command registry — `applicableVerbs` filters
 * `VERBS`, preserving its order (the only place a command's display position is
 * recorded; no second order list to forget a command in). Aliases (e.g. `look` →
 * `scan`) are skipped so the same capability isn't listed twice; they still
 * resolve and have their own `help <alias>`. Each line shows the canonical
 * `usageLine(verb)` as a clickable token plus the verb's one-line `desc`.
 */
export function renderHelp(state: PlayerStateView): RenderFrame {
  const verbs = applicableVerbs(state).filter((verb) => !USAGE[verb]?.alias);
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
  /**
   * Marks a clickable candidate the player can't currently perform (e.g. a `buy`
   * item they can't afford or is out of stock) — rendered red. Ignored for
   * non-clickable (`command: null`) candidates.
   */
  disabled?: boolean;
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
              spans.push(
                action(c.label, c.command, {
                  style: "link",
                  title: c.command,
                  disabled: c.disabled,
                }),
              );
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
  /** The current star's `(x,y,z)` position within its cluster (star-coordinates). */
  position?: StarPosition;
  /** The region the player is currently standing in (its biome + deposits). */
  region: Region;
  /** True when this region bears a settlement (P11) — surfaced as a note. */
  settlement?: boolean;
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
  /**
   * On the surface (true) vs in orbit (false) — orbit-land. This is the SURFACE
   * scan frame, so `landed` is true here (Landed aboard, or On-foot); it picks
   * the `launch` (aboard) vs `embark` (on foot) hint at the foot of the frame.
   */
  landed?: boolean;
  /** Regular fuel (burned to `orbit`/`launch` within a system). */
  fuel?: number;
  /** Warp fuel (burned to `warp` between systems). */
  warpFuel?: number;
  /** Active combat encounter to surface (with `attack`/`flee` options), or null. */
  encounter?: EncounterView | null;
  /** Bases present in this region (shared-world presence); yours are marked. */
  bases?: ScanBase[];
  /** Crop plots at the player's OWN base here (crop-farming), per-crop maturity. */
  plots?: PlotSummary[];
  /** Clickable `plant <crop>` hints for this biome (red when no free plot). */
  plantHints?: PlantHint[];
  /** Livestock herds at the player's OWN base here (animal-husbandry). */
  herds?: HerdSummary[];
  /** Clickable `ranch <animal>` hints for this biome (red when pen full). */
  ranchHints?: RanchHint[];
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

/**
 * Per-crop plot summary for a base (crop-farming): how many plots of a crop are
 * ripe vs still growing. Surfaced in `scan` (at your base) and `storage`.
 */
export interface PlotSummary {
  cropId: string;
  name: string;
  /** Mature plots ready to `harvest`. */
  ripe: number;
  /** Plots still growing (not yet mature). */
  growing: number;
}

/** A clickable `plant <crop>` hint (red when not currently performable). */
export interface PlantHint {
  cropId: string;
  name: string;
  /** True when planting can't be done right now (no free plot) — rendered red. */
  disabled: boolean;
}

/**
 * Per-animal herd summary for a base's livestock pen (animal-husbandry):
 * head count, breed-readiness, and feed needed. Surfaced in `scan` (at your
 * base) and `storage`, each with clickable `feed`/`slaughter` actions.
 */
export interface HerdSummary {
  animalId: string;
  name: string;
  /** Head currently penned. */
  count: number;
  /** True when the herd may breed now (`livestockCanBreed` + pen has room). */
  ready: boolean;
  /** Short status note, e.g. "ready to breed" / "breeding — ~12 min" / "pen full". */
  note: string;
  /** Feed-needed summary, e.g. "feed 8 Verdant Fruit". */
  feedSummary: string;
  /** True when `feed` can't be performed now (not ready / pen full) — feed action red. */
  feedDisabled: boolean;
}

/** A clickable `ranch <animal>` hint (red when the pen is full). */
export interface RanchHint {
  animalId: string;
  name: string;
  /** Acquisition cost in credits (shown muted after the token). */
  cost: number;
  /** True when ranching can't be done right now (pen full) — rendered red. */
  disabled: boolean;
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
 * Render a base's crop-farm plots (crop-farming): a per-crop ripe/growing
 * summary (with a clickable `harvest <crop>` on ripe rows) plus clickable
 * `plant <crop>` hints for this biome (red when no free plot — P9b). Returns no
 * lines when there's nothing to show. Shared by `scan` (at your base) and
 * `storage`.
 */
function cropPlotLines(
  plots: PlotSummary[] | undefined,
  hints: PlantHint[] | undefined,
): RenderLine[] {
  const summary = plots ?? [];
  const plantable = hints ?? [];
  if (summary.length === 0 && plantable.length === 0) return [];

  const out: RenderLine[] = [line(text("Crop farm:", "heading"))];
  if (summary.length === 0) {
    out.push(line(text("  no crops planted — `plant <crop>` to sow.", "muted")));
  } else {
    for (const p of summary) {
      const bits: string[] = [];
      if (p.ripe > 0) bits.push(`${p.ripe} ripe`);
      if (p.growing > 0) bits.push(`${p.growing} growing`);
      const spans: RenderSpan[] = [
        text("  • ", "muted"),
        text(`${p.name} `, "default"),
        text(`(${bits.join(", ")})`, p.ripe > 0 ? "success" : "muted"),
      ];
      if (p.ripe > 0) {
        spans.push(text("  ", "muted"));
        spans.push(
          action(`harvest ${p.cropId}`, `harvest ${p.cropId}`, {
            style: "link",
            title: `harvest ripe ${p.name}`,
          }),
        );
      }
      out.push(line(spans));
    }
  }
  if (plantable.length > 0) {
    const row: RenderSpan[] = [text("  plant: ", "muted")];
    plantable.forEach((h, i) => {
      if (i > 0) row.push(text("  ", "muted"));
      row.push(
        action(`plant ${h.cropId}`, `plant ${h.cropId}`, {
          style: "link",
          title: h.disabled ? "no free plot — `harvest` or `build crop_farm`" : `plant ${h.name}`,
          disabled: h.disabled,
        }),
      );
    });
    out.push(line(row));
  }
  return out;
}

/**
 * Render a base's livestock pen (animal-husbandry): a per-herd line (count,
 * breed-readiness, feed needed) with clickable `feed` (red when not ready / pen
 * full — P9b) and `slaughter` actions, plus clickable `ranch <animal>` hints for
 * this biome (each with its cost; red when the pen is full). Returns no lines
 * when there's nothing to show. Shared by `scan` (at your base) and `storage`.
 */
function livestockLines(
  herds: HerdSummary[] | undefined,
  ranchable: RanchHint[] | undefined,
): RenderLine[] {
  const summary = herds ?? [];
  const ranch = ranchable ?? [];
  if (summary.length === 0 && ranch.length === 0) return [];

  const out: RenderLine[] = [line(text("Livestock pen:", "heading"))];
  if (summary.length === 0) {
    out.push(line(text("  no animals — `ranch <animal>` to acquire one.", "muted")));
  } else {
    for (const h of summary) {
      const spans: RenderSpan[] = [
        text("  • ", "muted"),
        text(`${h.count}× ${h.name} `, "default"),
        text(`(${h.note})`, h.ready ? "success" : "muted"),
        text(`  ${h.feedSummary}  `, "muted"),
        action(`feed ${h.animalId}`, `feed ${h.animalId}`, {
          style: "link",
          title: h.feedDisabled ? "not ready to breed (or pen full)" : `feed ${h.name} to breed`,
          disabled: h.feedDisabled,
        }),
        text("  ", "muted"),
        action(`slaughter ${h.animalId}`, `slaughter ${h.animalId}`, {
          style: "link",
          title: `slaughter ${h.name} for products`,
        }),
      ];
      out.push(line(spans));
    }
  }
  if (ranch.length > 0) {
    const row: RenderSpan[] = [text("  ranch: ", "muted")];
    ranch.forEach((h, i) => {
      if (i > 0) row.push(text("  ", "muted"));
      row.push(
        action(`ranch ${h.animalId}`, `ranch ${h.animalId}`, {
          style: "link",
          title: h.disabled ? "pen full — `slaughter` or `build livestock_pen`" : `ranch ${h.name}`,
          disabled: h.disabled,
        }),
      );
      row.push(text(` (${h.cost}cr)`, "muted"));
    });
    out.push(line(row));
  }
  return out;
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
  // The star's position within its cluster (star-coordinates).
  if (view.position) {
    lines.push(
      line([
        text("position ", "muted"),
        text(starPositionLabel(view.position), "accent"),
      ]),
    );
  }
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

  // Fuel readout: both pools (regular feeds `land`, warp feeds `warp`).
  if (view.fuel !== undefined || view.warpFuel !== undefined) {
    lines.push(
      line([
        text("fuel ", "muted"),
        text(`${view.fuel ?? 0}`, "default"),
        text("   warp fuel ", "muted"),
        text(`${view.warpFuel ?? 0}`, "default"),
      ]),
    );
  }

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
  // Settlement presence (P11): an inhabited region. P12a: its market is open —
  // you can `buy`/`sell` here (the economy is gated to settlements/outposts).
  if (view.settlement) {
    lines.push(
      line([
        text("⌂ There is a settlement here", "success"),
        text(" — its market is open; you can ", "muted"),
        action("buy", "buy", { style: "link", title: "buy at this settlement's market" }),
        text(" / ", "muted"),
        action("sell", "sell", { style: "link", title: "sell at this settlement's market" }),
        text(" here.", "muted"),
      ]),
    );
    // Keystone 1a: a settlement is a faction trade hub — surface its contracts.
    lines.push(
      line([
        text("   Its faction posts ", "muted"),
        action("contracts", "contracts", { style: "link", title: "see the faction's goods contracts" }),
        text(" — deliver goods for credits + reputation.", "muted"),
      ]),
    );
  }
  // Per-region climate: this region's own temperature + hazard (the biome nudges
  // them off the planet mean shown below, never crossing the 0/100 band). This is
  // the hazard that bites you on foot, so a volcanic region reads hotter + more
  // dangerous than a barren one alongside it.
  lines.push(
    line([
      text("   region temp ", "muted"),
      text(`${region.temperature}°C`, "default"),
      text("   region hazard ", "muted"),
      text(
        `${Math.round(region.hazard * 100)}%`,
        region.hazard >= 0.6 ? "danger" : "default",
      ),
    ]),
  );
  // Planet physical size: class + radius (R⊕). Rocky worlds (this is a
  // rocky-only scan path) sit below the gas threshold.
  lines.push(
    line([
      text("size ", "muted"),
      text(SIZE_CLASS_LABELS[planet.sizeClass], "accent"),
      text("   radius ", "muted"),
      text(`${planet.radius} R⊕`, "default"),
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

  // Deposits (this region) with effective (post-depletion) abundance. A `mine`
  // action is shown disabled (red) when the player can't mine right now — using
  // the SAME gates the `mine` command enforces: you must be on foot (`mine` is a
  // DISEMBARKED action in the applicability model) and, on a hostile surface,
  // hold the landing gear.
  const mineBlocked =
    view.embarked || (!!view.requiredUpgrade && view.hasRequiredUpgrade === false);
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
            title: mineBlocked
              ? view.embarked
                ? "disembark to mine"
                : "missing landing gear for this surface"
              : `mine ${res.name}`,
            disabled: mineBlocked,
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

  // Crop-farm plots at the player's own base here (crop-farming): per-crop
  // maturity + clickable harvest/plant. Only present when you own a farm here.
  lines.push(...cropPlotLines(view.plots, view.plantHints));

  // Livestock pen at the player's own base here (animal-husbandry): per-herd
  // count + breed-readiness + clickable feed/slaughter, plus ranch hints. Only
  // present when you own a pen here.
  lines.push(...livestockLines(view.herds, view.ranchHints));

  // Explore other regions of this planet.
  lines.push(
    line([
      action("regions", "regions", { style: "link", title: "list this planet's regions" }),
      text(` to browse all ${planet.regionCount} regions; `, "muted"),
      text("jump <n>", "default"),
      text(" to move to another.", "muted"),
    ]),
  );

  // Orbit-land: from a surface you don't fly to siblings directly — `launch`
  // back to orbit first (the sibling `orbit <n>` list lives in the ORBITAL
  // frame). Offer the right action for the surface state you're in.
  if (view.embarked) {
    // Landed aboard: `launch` back to orbit, or `disembark` onto the surface.
    lines.push(
      line([
        action("launch", "launch", { style: "link", title: "lift back into orbit" }),
        text(" to return to orbit, or ", "muted"),
        action("disembark", "disembark", { style: "link", title: "step onto the surface" }),
        text(" to step out and work the surface.", "muted"),
      ]),
    );
  } else {
    // On foot: `embark` to climb aboard (then `launch` to orbit).
    lines.push(
      line([
        action("embark", "embark", { style: "link", title: "climb back aboard your ship" }),
        text(" to climb aboard, then ", "muted"),
        text("launch", "default"),
        text(" to return to orbit.", "muted"),
      ]),
    );
  }

  return frame(lines);
}

/** One region row in the `regions` listing. */
export interface RegionListEntry {
  index: number;
  biome: Biome;
  /** True for the region the player is currently standing in. */
  current: boolean;
  /** True when this region bears a settlement (P11) — marked distinctly. */
  settlement?: boolean;
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
  /** True when the planet has an orbital outpost — shown as a separate `O` entry. */
  hasOutpost?: boolean;
  /** True when the player is currently docked at the outpost (marks the `O` entry). */
  atOutpost?: boolean;
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

  // Orbital outpost: a separate `O` entry (not a numbered surface region),
  // shown once at the top of page 1. `jump O` docks there.
  if (view.hasOutpost && view.page === 1) {
    if (view.atOutpost) {
      lines.push(
        line([text("  O: ", "muted"), text("orbital outpost (docked)", "accent")]),
      );
    } else {
      lines.push(
        line([
          text("  O: ", "muted"),
          action("orbital outpost", "jump O", {
            style: "link",
            title: "dock at the orbital outpost",
          }),
        ]),
      );
    }
  }

  for (const e of view.entries) {
    // Settlement-bearing regions are marked with a ⌂ tag + "settlement" note in a
    // distinct style, so inhabited regions stand out in the list.
    if (e.current) {
      const label = e.settlement ? `⌂ ${e.biome} (here) — settlement` : `${e.biome} (here)`;
      lines.push(line([text(`  ${e.index}: `, "muted"), text(label, "accent")]));
    } else {
      const spans: RenderSpan[] = [text(`  ${e.index}: `, "muted")];
      if (e.settlement) spans.push(text("⌂ ", "success"));
      spans.push(
        action(e.biome, `jump ${e.index}`, {
          style: "link",
          title: `jump to region ${e.index}`,
        }),
      );
      if (e.settlement) spans.push(text(" — settlement", "success"));
      lines.push(line(spans));
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
  /**
   * The star's `(x,y,z)` position within its cluster (star-coordinates). Present
   * for intra-cluster neighbors (shown so the player can `warp <arm> <cluster>
   * <x,y,z>`); absent for cross-cluster neighbors (a different star cloud).
   */
  position?: StarPosition;
}

/** The player's current six-tier location + galaxy context, shown atop `map`. */
export interface MapLocation {
  galaxyName: string;
  armCount: number;
  galaxy: number;
  arm: number;
  cluster: number;
  system: number;
  /** The current star's `(x,y,z)` position within its cluster (star-coordinates). */
  position?: StarPosition;
  planet: number;
  region: number;
  /** Hyperwarp Condensate the player owns — drives the galaxy-jump affordance. */
  condensate?: number;
  /** Current planet's size class label (e.g. "Rocky", "Jovian"). */
  planetSize?: string;
  /** Current planet's radius (R⊕). */
  planetRadius?: number;
  /** Whether the current planet is a gas giant (orbit-only). */
  planetIsGas?: boolean;
}

/**
 * Nearby-systems map: the player's full location (galaxy/arm/cluster/system/
 * planet/region) and the galaxy's arm count, then each neighbor as a `warp <arm>
 * <cluster> <system>` action + its WARP-fuel cost. `currentFuel` is the player's
 * WARP-fuel pool (warp burns warp fuel), used for the affordability red marking.
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
      text(`(${loc.armCount} arms)   warp fuel ${currentFuel}`, "muted"),
    ]),
    line([
      text("you are at  ", "muted"),
      text(
        `arm ${loc.arm} · cluster ${loc.cluster} · system ${loc.system} · planet ${loc.planet} · region ${loc.region}`,
        "default",
      ),
    ]),
  ];
  // Current star's position within its cluster (star-coordinates).
  if (loc.position) {
    lines.push(
      line([
        text("position  ", "muted"),
        text(starPositionLabel(loc.position), "accent"),
      ]),
    );
  }
  // Current planet's physical size (planet-taxonomy), when known.
  if (loc.planetSize !== undefined) {
    lines.push(
      line([
        text("this planet  ", "muted"),
        text(loc.planetSize, "accent"),
        text(loc.planetIsGas ? " (gas giant)" : "", "muted"),
        loc.planetRadius !== undefined
          ? text(`  ${loc.planetRadius} R⊕`, "default")
          : text("", "muted"),
      ]),
    );
  }

  // Galaxy jump (P3): `hyperwarp` consumes a Hyperwarp Condensate to leave this
  // galaxy. The action reads RED (P9b) when you hold none — clicking it still
  // returns the helpful "craft one from voidstone" error. The suggested target is
  // the next galaxy outward; any index ≥ 0 works.
  const condensate = loc.condensate ?? 0;
  const canJump = condensate > 0;
  lines.push(line(text("Galaxy jump", "heading")));
  lines.push(
    line([
      text("Hyperwarp Condensate ", "muted"),
      text(`×${condensate}   `, canJump ? "accent" : "danger"),
      action(`hyperwarp ${loc.galaxy + 1}`, `hyperwarp ${loc.galaxy + 1}`, {
        style: "link",
        title: canJump
          ? `jump to galaxy ${loc.galaxy + 1} (consumes one condensate)`
          : "need Hyperwarp Condensate — craft one from voidstone",
        disabled: !canJump,
      }),
      text("  (any galaxy index ≥ 0; consumes one condensate)", "muted"),
    ]),
  );

  lines.push(line(text("Nearby systems", "heading")));
  if (neighbors.length === 0) {
    lines.push(line(text("No charted neighbors in range.", "muted")));
    return frame(lines);
  }
  for (const n of neighbors) {
    const cost = warpFuelCost(n.distance);
    const affordable = cost <= currentFuel;
    const spans: RenderSpan[] = [
      action(n.name, `warp ${n.arm} ${n.cluster} ${n.system}`, {
        style: "link",
        // Not enough warp fuel to make the jump → the same gate `warp` enforces,
        // so the token reads red up-front.
        title: affordable ? `warp to ${n.name}` : `not enough warp fuel (need ${cost})`,
        disabled: !affordable,
      }),
      text(`  ${n.arm}:${n.cluster}:${n.system}`, "muted"),
    ];
    // Intra-cluster neighbors carry a position; show it so the player can warp
    // by coordinates too.
    if (n.position) {
      spans.push(text(`  ${starPositionLabel(n.position)}`, "muted"));
    }
    spans.push(text(`  warp fuel ${cost}`, affordable ? "default" : "danger"));
    spans.push(text(n.discovered ? "  ✓ discovered" : "  • uncharted", "muted"));
    lines.push(line(spans));
  }
  return frame(lines);
}

/** Format a star position as `(x, y, z)` for display. */
function starPositionLabel(p: StarPosition): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}

export interface InventoryView {
  stacks: { resourceId: string; qty: number; price: number | null }[];
  /**
   * Owned materials (sellable, no cargo cost), with name + fixed sell value.
   * Food materials also carry a `heal` (HP restored by `eat`).
   */
  materials?: { materialId: string; qty: number; name: string; value: number; heal?: number }[];
  /**
   * Ship parts carried in the parts store (P12b) — tradeable + depositable, no
   * cargo cost. Listed with name + fixed sell value, like materials.
   */
  parts?: { partId: string; qty: number; name: string; value: number }[];
  cargoUsed: number;
  cargoCap: number;
  credits: number;
  fuel: number;
  /** Warp fuel (burned on `warp`); shown alongside regular fuel. */
  warpFuel?: number;
  health: number;
  maxHealth: number;
  embarked: boolean;
  /** The planet you're currently at — name + physical size (planet-taxonomy). */
  planet?: { name: string; size: string; radius: number; isGas: boolean };
}

export function renderInventory(view: InventoryView): RenderFrame {
  const { stacks, cargoUsed, cargoCap, credits, fuel, warpFuel, health, maxHealth, embarked } = view;
  const lowHealth = health <= maxHealth * 0.3;
  const lines: RenderLine[] = [
    line([
      text("Cargo ", "heading"),
      text(`${cargoUsed}/${cargoCap}`, cargoUsed >= cargoCap ? "warning" : "default"),
      text(`   credits ${credits}`, "accent"),
      text(`   fuel ${fuel}`, "default"),
      text(`   warp fuel ${warpFuel ?? 0}`, "default"),
    ]),
    line([
      text("HP ", "muted"),
      text(`${health}/${maxHealth}`, lowHealth ? "danger" : "default"),
      text("   ", "muted"),
      embarked ? text("aboard ship", "accent") : text("on foot", "warning"),
    ]),
  ];
  // Current planet + its physical size (planet-taxonomy).
  if (view.planet) {
    lines.push(
      line([
        text("at ", "muted"),
        text(view.planet.name, "accent"),
        text(`  ${view.planet.size}`, "default"),
        text(view.planet.isGas ? " (gas giant)" : "", "muted"),
        text(`  ${view.planet.radius} R⊕`, "muted"),
      ]),
    );
  }
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

  // Ship parts (tradeable commodity; not in the resource hold). Listed only when
  // held — each shows its fixed value with a `sell` action and a `deposit` hint.
  const parts = view.parts ?? [];
  if (parts.length > 0) {
    lines.push(line(text("Ship parts (sell at a market, or `deposit` to a base silo):", "heading")));
    for (const p of parts) {
      lines.push(
        line([
          text("  • ", "muted"),
          text(`${p.name} ×${p.qty}  `, "default"),
          text(`@ ${p.value}/u  `, "muted"),
          action(`sell ${p.partId}`, `sell ${p.partId}`, {
            style: "link",
            title: `sell ${p.name}`,
          }),
          text("  ", "muted"),
          action(`deposit ${p.partId}`, `deposit ${p.partId}`, {
            style: "link",
            title: `deposit ${p.name} into a base silo`,
          }),
        ]),
      );
    }
  }
  return frame(lines);
}

export interface UpgradesView {
  owned: { upgradeId: string; qty: number }[];
  /**
   * The shared finite market (P9a): per-upgrade buyable supply + the per-unit
   * buy price. `buy` works only while `supply > 0`; `sell`/manufacture grow it.
   */
  market?: { upgradeId: string; supply: number; price: number }[];
  /** The player's credits — used to mark unaffordable buy actions red. */
  credits?: number;
}

/**
 * Owned ship upgrades + the capability each one activates, then the shared
 * upgrade MARKET (P9a): how many of each upgrade are currently buyable. Upgrades
 * are now MANUFACTURED at a production line (`produce`), not hand-crafted, so the
 * catalog hint points there; the market section shows live finite supply.
 */
export function renderUpgrades(view: UpgradesView): RenderFrame {
  const lines: RenderLine[] = [line(text("Ship upgrades", "heading"))];
  if (view.owned.length === 0) {
    lines.push(
      line(text("None installed. Manufacture at a base's production line, or buy from the market below:", "muted")),
    );
    for (const u of UPGRADES) {
      lines.push(
        line([
          text("  • ", "muted"),
          text(`${u.name}`, "default"),
          text(`  — ${capabilityOf(u.id)} (\`produce ${u.id}\`)`, "muted"),
        ]),
      );
    }
  } else {
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
  }

  if (view.market && view.market.length > 0) {
    lines.push(line(text("Market (finite supply):", "heading")));
    for (const m of view.market) {
      const up = getUpgrade(m.upgradeId);
      const inStock = m.supply > 0;
      // `buy` is gated by finite supply (out of stock) and by credits — the same
      // checks `handleBuyUpgrade` enforces. The token stays clickable either way
      // (the click returns the informative error) but is shown red when blocked.
      const unaffordable = view.credits !== undefined && view.credits < m.price;
      const buyBlocked = !inStock || unaffordable;
      lines.push(
        line([
          text("  • ", "muted"),
          action(up.name, `buy ${m.upgradeId}`, {
            style: "link",
            title: !inStock
              ? `out of stock — manufacture & sell one`
              : unaffordable
                ? `not enough credits (need ${m.price})`
                : `buy ${up.name}`,
            disabled: buyBlocked,
          }),
          text(
            inStock ? ` — ${m.supply} in stock (${m.price} cr)` : " — out of stock",
            inStock ? "muted" : "warning",
          ),
        ]),
      );
    }
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
  /** Number of production lines (turn siloed ingots into ship parts via `produce`). */
  productionLines: number;
  /** Number of blast furnaces (smelt siloed raw metal into ingots via `produce <ingot>`). */
  blastFurnaces?: number;
  /** Number of power plants by kind (P13) — they power the excavators + lines + furnaces. */
  thermalPlants?: number;
  solarArrays?: number;
  /** Number of crop farms (crop-farming) — each provides CROP_FARM_PLOTS plots. */
  cropFarms?: number;
  /** Plots in use + total plot capacity (= CROP_FARM_PLOTS × crop farms). */
  plotsUsed?: number;
  plotCapacity?: number;
  /** Per-crop plot maturity summary (crop-farming). Empty/absent ⇒ no crop farm. */
  plots?: PlotSummary[];
  /** Clickable `plant <crop>` hints for this biome (red when no free plot). */
  plantHints?: PlantHint[];
  /** Number of livestock pens (animal-husbandry) — each holds LIVESTOCK_PEN_CAPACITY head. */
  livestockPens?: number;
  /** Head penned + total head capacity (= LIVESTOCK_PEN_CAPACITY × livestock pens). */
  headUsed?: number;
  headCapacity?: number;
  /** Per-herd summary (animal-husbandry). Empty/absent ⇒ no livestock pen. */
  herds?: HerdSummary[];
  /** Clickable `ranch <animal>` hints for this biome (red when pen full). */
  ranchHints?: RanchHint[];
  /**
   * Power balance (P13): plant `supply` vs consumer `demand`. Rendered as
   * `Power supply/demand`, green ✓ when `powered`, red when short (per P9b).
   * Absent on bases with no power-relevant buildings (back-compatible).
   */
  power?: { supply: number; demand: number; powered: boolean };
  /** Stored units used + total capacity (= SILO_CAPACITY × silos). */
  used: number;
  capacity: number;
  /** Stored items: item id (resource OR part), quantity, and display name. */
  items: { itemId: string; qty: number; name: string }[];
  /**
   * Parts a production line here can manufacture (each with a recipe summary).
   * Empty when there's no production line — only surfaced once one exists.
   * `disabled` marks a part whose recipe isn't fully siloed (can't produce now).
   */
  producible: { id: string; name: string; recipe: string; disabled?: boolean }[];
  /**
   * Ingots a blast furnace here can smelt (each with a raw-metal recipe summary).
   * Empty when there's no blast furnace — only surfaced once one exists.
   * `disabled` marks an ingot whose raw metal isn't fully siloed, or whose base
   * is underpowered (can't smelt now).
   */
  smeltable?: { id: string; name: string; recipe: string; disabled?: boolean }[];
  /**
   * Affordability of each `build <structure>` hint (credits + cargo minerals).
   * A structure the player can't currently afford renders its hint red. Absent
   * = treat as affordable (back-compatible).
   */
  buildable?: {
    silo: boolean;
    excavator: boolean;
    production_line: boolean;
    thermal_plant?: boolean;
    solar_array?: boolean;
    blast_furnace?: boolean;
    crop_farm?: boolean;
    livestock_pen?: boolean;
  };
}

/**
 * `storage` (alias `base`) — the current region's base: its silo/excavator/plant
 * counts, its power balance, and what's stored against capacity. Clickable
 * `build …` hints guide expanding it (excavators funnel ore automatically — P13).
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
      text("   furnaces ", "muted"),
      text(`${view.blastFurnaces ?? 0}`, "default"),
      text("   farms ", "muted"),
      text(`${view.cropFarms ?? 0}`, "default"),
      text("   pens ", "muted"),
      text(`${view.livestockPens ?? 0}`, "default"),
      text("   plants ", "muted"),
      text(`${(view.thermalPlants ?? 0) + (view.solarArrays ?? 0)}`, "default"),
      text("   storage ", "muted"),
      text(`${view.used}/${view.capacity}`, view.used >= view.capacity ? "warning" : "default"),
    ]),
  ];

  // Power balance (P13). Green ✓ when the plants cover the consumers; red when
  // short (per P9b's unperformable→red convention) so the player sees at a glance
  // that excavators/production lines are stalled for lack of power.
  if (view.power) {
    const { supply, demand, powered } = view.power;
    lines.push(
      line([
        text("power ", "muted"),
        text(`${Math.round(supply)}/${demand}`, powered ? "success" : "danger"),
        powered
          ? text(" ✓", "success")
          : text("  — underpowered; build a thermal_plant or solar_array", "danger"),
      ]),
    );
  }

  if (view.items.length === 0) {
    lines.push(line(text("Storage is empty. `deposit <item>`, or wait for your excavators to fill it.", "muted")));
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

  // Producible parts (only once a production line exists), each clickable. A
  // part whose raw recipe isn't fully siloed is shown red (can't `produce` now).
  if (view.producible.length > 0) {
    lines.push(line(text("Producible:", "heading")));
    for (const p of view.producible) {
      lines.push(
        line([
          text("  • ", "muted"),
          action(`produce ${p.id}`, `produce ${p.id}`, {
            style: "link",
            title: p.disabled ? "missing siloed inputs" : `manufacture ${p.name}`,
            disabled: p.disabled,
          }),
          text(`  (${p.recipe})`, "muted"),
        ]),
      );
    }
  }

  // Smeltable ingots (only once a blast furnace exists), each clickable. An ingot
  // whose raw metal isn't fully siloed (or whose base is underpowered) is red.
  if (view.smeltable && view.smeltable.length > 0) {
    lines.push(line(text("Smeltable:", "heading")));
    for (const s of view.smeltable) {
      lines.push(
        line([
          text("  • ", "muted"),
          action(`produce ${s.id}`, `produce ${s.id}`, {
            style: "link",
            title: s.disabled ? "missing siloed metal or power" : `smelt ${s.name}`,
            disabled: s.disabled,
          }),
          text(`  (${s.recipe})`, "muted"),
        ]),
      );
    }
  }

  // Crop-farm plots (crop-farming) — only once a crop farm exists: a plot-usage
  // line plus per-crop maturity and clickable harvest/plant (red when full).
  if ((view.cropFarms ?? 0) > 0) {
    const used = view.plotsUsed ?? 0;
    const cap = view.plotCapacity ?? 0;
    lines.push(
      line([
        text("plots ", "muted"),
        text(`${used}/${cap}`, used >= cap ? "warning" : "default"),
        text("   (crop farm — agriculture, no power needed)", "muted"),
      ]),
    );
    lines.push(...cropPlotLines(view.plots, view.plantHints));
  }

  // Livestock pen (animal-husbandry) — only once a pen exists: a head-usage line
  // plus per-herd breed-readiness and clickable feed/slaughter/ranch (red when
  // not ready / pen full).
  if ((view.livestockPens ?? 0) > 0) {
    const used = view.headUsed ?? 0;
    const cap = view.headCapacity ?? 0;
    lines.push(
      line([
        text("head ", "muted"),
        text(`${used}/${cap}`, used >= cap ? "warning" : "default"),
        text("   (livestock pen — agriculture, no power needed)", "muted"),
      ]),
    );
    lines.push(...livestockLines(view.herds, view.ranchHints));
  }

  // Expansion hints (clickable). A structure you can't afford is shown red,
  // matching the affordability check `build` enforces.
  const b = view.buildable;
  const hints: RenderSpan[] = [
    action("build silo", "build silo", {
      style: "link",
      title: b && !b.silo ? "can't afford a silo" : "add storage capacity",
      disabled: b ? !b.silo : false,
    }),
    text("   ", "muted"),
    action("build excavator", "build excavator", {
      style: "link",
      title: b && !b.excavator ? "can't afford an excavator" : "add an ore drain",
      disabled: b ? !b.excavator : false,
    }),
    text("   ", "muted"),
    action("build production_line", "build production_line", {
      style: "link",
      title: b && !b.production_line ? "can't afford a production line" : "add a parts manufacturer",
      disabled: b ? !b.production_line : false,
    }),
    text("   ", "muted"),
    action("build thermal_plant", "build thermal_plant", {
      style: "link",
      title: b && b.thermal_plant === false ? "can't afford a thermal plant" : "power from regional heat",
      disabled: b ? b.thermal_plant === false : false,
    }),
    text("   ", "muted"),
    action("build solar_array", "build solar_array", {
      style: "link",
      title: b && b.solar_array === false ? "can't afford a solar array" : "power from sunlight (thin air)",
      disabled: b ? b.solar_array === false : false,
    }),
    text("   ", "muted"),
    action("build blast_furnace", "build blast_furnace", {
      style: "link",
      title: b && b.blast_furnace === false ? "can't afford a blast furnace" : "smelt raw metal into ingots",
      disabled: b ? b.blast_furnace === false : false,
    }),
    text("   ", "muted"),
    action("build crop_farm", "build crop_farm", {
      style: "link",
      title: b && b.crop_farm === false ? "can't afford a crop farm" : "add planting plots for crops",
      disabled: b ? b.crop_farm === false : false,
    }),
    text("   ", "muted"),
    action("build livestock_pen", "build livestock_pen", {
      style: "link",
      title: b && b.livestock_pen === false ? "can't afford a livestock pen" : "add a pen for ranching animals",
      disabled: b ? b.livestock_pen === false : false,
    }),
  ];
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

// ---------------------------------------------------------------------------
// Factions — standing + contracts (Keystone 1a).
// ---------------------------------------------------------------------------

export interface StandingView {
  /**
   * Every faction with the player's reputation, rank title, and the rep needed
   * for the next tier (`nextRep` null = already at the top rank).
   */
  factions: { name: string; blurb: string; rep: number; rankTitle: string; nextRep: number | null }[];
}

/**
 * `standing` — the player's reputation, rank title, and next-tier threshold with
 * each NPC faction (Keystone 1b). Always renders every faction so the player can
 * see who's out there even at rep 0.
 */
export function renderStanding(view: StandingView): RenderFrame {
  const lines: RenderLine[] = [line(text("Faction standing", "heading"))];
  for (const f of view.factions) {
    lines.push(
      line([
        text("  • ", "muted"),
        text(`${f.name} — `, "accent"),
        text(f.rankTitle, f.rep > 0 ? "success" : "muted"),
        text(`  (rep ${f.rep}`, "muted"),
        text(
          f.nextRep === null ? ", max rank)" : `, next at ${f.nextRep})`,
          "muted",
        ),
      ]),
    );
    lines.push(line(text(`      ${f.blurb}`, "muted")));
  }
  lines.push(
    line([
      text("Fulfil ", "muted"),
      action("contracts", "contracts", { style: "link", title: "see contracts at this hub" }),
      text(" at a settlement/outpost to raise your standing.", "muted"),
    ]),
  );
  return frame(lines);
}

/** One contract row on a hub's faction board. */
export interface ContractEntry {
  /** 1-based index, the `fulfill <index>` argument. */
  index: number;
  itemName: string;
  qty: number;
  /** How many of the wanted good the player currently holds. */
  haveQty: number;
  rewardCredits: number;
  rewardRep: number;
  /** fulfillable = hold the goods & not done; completed = already done; short = lack the goods. */
  state: "fulfillable" | "completed" | "short";
}

export interface ContractsView {
  /** Whether the player is at a trade hub (settlement/outpost) with a faction board. */
  atHub: boolean;
  /** The hub faction (when `atHub`). */
  factionName?: string;
  factionBlurb?: string;
  /** The player's reputation with the hub faction (when `atHub`). */
  rep?: number;
  /** The player's rank title with the hub faction — higher rank unlocks bigger contracts. */
  rankTitle?: string;
  /** Rep needed for the next rank (null = at top rank; undefined off-hub). */
  nextRep?: number | null;
  /** The current bucket's contracts (when `atHub`). */
  contracts?: ContractEntry[];
}

/**
 * `contracts` — the hub faction's current goods contracts, each with its wanted
 * item + qty, reward (credits + rep), and state. A `fulfill <n>` action is
 * clickable when fulfillable, RED (P9b `disabled`) when short of the goods, and
 * shown as a muted "done" when already completed. Off-hub: a clear note to find
 * a settlement or outpost.
 */
export function renderContracts(view: ContractsView): RenderFrame {
  if (!view.atHub) {
    return frame([
      line(text("Contracts", "heading")),
      line(text("No faction hub here — find a settlement or orbital outpost to take contracts.", "muted")),
    ]);
  }
  const lines: RenderLine[] = [
    line([
      text("Contracts — ", "heading"),
      text(view.factionName ?? "", "accent"),
    ]),
  ];
  if (view.factionBlurb) lines.push(line(text(`  ${view.factionBlurb}`, "muted")));
  if (view.rankTitle !== undefined) {
    lines.push(
      line([
        text("  Your rank: ", "muted"),
        text(view.rankTitle, (view.rep ?? 0) > 0 ? "success" : "muted"),
        text(`  (rep ${view.rep ?? 0}`, "muted"),
        text(
          view.nextRep == null ? ", max rank)" : `, next at ${view.nextRep})`,
          "muted",
        ),
        text("  — higher rank unlocks bigger contracts.", "muted"),
      ]),
    );
  }
  const contracts = view.contracts ?? [];
  if (contracts.length === 0) {
    lines.push(line(text("  No contracts on offer right now — check back later.", "muted")));
    return frame(lines);
  }
  for (const c of contracts) {
    const reward = `${c.rewardCredits} cr +${c.rewardRep} rep`;
    if (c.state === "completed") {
      lines.push(
        line([
          text(`  ${c.index}. `, "muted"),
          text(`${c.qty} ${c.itemName}  `, "muted"),
          text(`→ ${reward}  `, "muted"),
          text("✓ fulfilled", "muted"),
        ]),
      );
      continue;
    }
    const short = c.state === "short";
    lines.push(
      line([
        text(`  ${c.index}. `, "muted"),
        text(`${c.qty} ${c.itemName}  `, "default"),
        text(`→ ${reward}  `, "accent"),
        action(`fulfill ${c.index}`, `fulfill ${c.index}`, {
          style: "link",
          disabled: short,
          title: short ? "you don't hold enough of the goods" : "deliver the goods",
        }),
        text(short ? `  (have ${c.haveQty}/${c.qty})` : "", "muted"),
      ]),
    );
  }
  return frame(lines);
}

/**
 * `guide` — the soft-tutorial advisor's single next-step advice (player-guidance).
 * Shows the message plus, when there's a concrete command to run, a clickable
 * token for it. The advice text already ends with the nudge to check back with
 * `guide`, so the renderer stays dumb — it just lays out what the engine decided.
 */
export function renderGuide(advice: GuideAdvice): RenderFrame {
  const lines: RenderLine[] = [
    line([
      text("Guide", "heading"),
      text("  — your next step", "muted"),
    ]),
    line(text(advice.message, "default")),
  ];
  if (advice.suggestedCommand) {
    lines.push(
      line([
        text("→ ", "muted"),
        action(advice.suggestedCommand, advice.suggestedCommand, {
          style: "link",
          title: `run \`${advice.suggestedCommand}\``,
        }),
      ]),
    );
  }
  return frame(lines);
}
