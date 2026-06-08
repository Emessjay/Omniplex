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

/** The MVP command list, each a clickable action. */
export function renderHelp(): RenderFrame {
  const cmds: [string, string][] = [
    ["scan", "describe the planet you're on"],
    ["map", "list nearby systems to warp to"],
    ["warp <sector> <system>", "travel to another system (burns fuel)"],
    ["land <i>", "move to another planet in this system"],
    ["mine <resource>", "harvest a resource from this planet"],
    ["inventory", "show cargo, credits and fuel"],
    ["upgrades", "show installed ship upgrades + capabilities"],
    ["craft <upgrade>", "synthesize an upgrade from mined components"],
    ["sell <resource> | sell all", "sell cargo at the global market"],
    ["buy fuel [n]", "refuel for credits"],
    ["buy <resource> [qty]", "buy minerals at 1.5× price (pushes price up)"],
    ["buy <upgrade> | sell <upgrade>", "trade ship upgrades (1.5× / sell value)"],
    ["who", "see the shared-world leaderboards"],
  ];
  return frame([
    line(text("Omniplex — commands", "heading")),
    ...cmds.map(([cmd, desc]) => {
      const verb = cmd.split(" ")[0]!;
      return line([
        text("  ", "muted"),
        action(cmd, verb, { title: `run "${verb}"` }),
        text("  — " + desc, "muted"),
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
  /** Placeholder label, e.g. `resource`, `sector`, `qty`. */
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
  sector: number;
  system: number;
  name: string;
  distance: number;
  discovered: boolean;
}

/** Nearby-systems map: each row a warp action + fuel cost. */
export function renderMap(neighbors: MapNeighbor[], currentFuel: number): RenderFrame {
  const lines: RenderLine[] = [
    line([
      text("Nearby systems", "heading"),
      text(`   (fuel: ${currentFuel})`, "muted"),
    ]),
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
        action(n.name, `warp ${n.sector} ${n.system}`, {
          style: "link",
          title: `warp to ${n.name}`,
        }),
        text(`  ${n.sector}:${n.system}`, "muted"),
        text(`  fuel ${cost}`, affordable ? "default" : "danger"),
        text(n.discovered ? "  ✓ discovered" : "  • uncharted", "muted"),
      ]),
    );
  }
  return frame(lines);
}

export interface InventoryView {
  stacks: { resourceId: string; qty: number; price: number | null }[];
  cargoUsed: number;
  cargoCap: number;
  credits: number;
  fuel: number;
}

export function renderInventory(view: InventoryView): RenderFrame {
  const { stacks, cargoUsed, cargoCap, credits, fuel } = view;
  const lines: RenderLine[] = [
    line([
      text("Cargo ", "heading"),
      text(`${cargoUsed}/${cargoCap}`, cargoUsed >= cargoCap ? "warning" : "default"),
      text(`   credits ${credits}`, "accent"),
      text(`   fuel ${fuel}`, "default"),
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
