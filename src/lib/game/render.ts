/**
 * Pure RenderFrame builders for command output. Given already-fetched data,
 * these compose the terminal frames — no DB, no game logic beyond formatting.
 * Kept separate from `commands.ts` so the (thin) handlers stay focused on
 * orchestration and these stay trivially testable.
 *
 * Every noun a player might act on is an `action` span whose `command` is the
 * exact string the click submits (AC: "use clickable actions generously").
 */
import type { Planet, StarSystem } from "@/lib/universe";
import { getResource } from "@/lib/universe";
import type { RenderFrame, RenderLine, RenderSpan } from "@/lib/terminal/types";
import { action, frame, line, text } from "@/lib/terminal/helpers";
import { effectiveAbundance, fuelCost } from "./rules";

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
    ["sell <resource> | sell all", "sell cargo at the global market"],
    ["buy fuel [n]", "refuel for credits"],
    ["buy <resource> [qty]", "buy minerals at 1.5× price (pushes price up)"],
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

function abundanceLabel(value: number): string {
  if (value <= 0) return "depleted";
  return `${Math.round(value * 100)}%`;
}

export interface ScanView {
  planet: Planet;
  system: StarSystem;
  /** Accumulated depletion per resource id on this planet. */
  depletionMap: Record<string, number>;
  /** True only on the scan that first recorded the discovery. */
  justDiscovered: boolean;
  /** Handle of the original discoverer, if known and not this player. */
  discovererNote?: string;
}

/** Scan/look/arrival frame: describe the current planet + its system. */
export function renderScan(view: ScanView): RenderFrame {
  const { planet, system, depletionMap, justDiscovered } = view;
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

  lines.push(
    line([
      text("biome ", "muted"),
      text(planet.biome, "accent"),
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

  // Deposits with effective (post-depletion) abundance.
  if (planet.deposits.length === 0) {
    lines.push(line(text("No mineable deposits here.", "muted")));
  } else {
    lines.push(line(text("Deposits:", "heading")));
    for (const dep of planet.deposits) {
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
