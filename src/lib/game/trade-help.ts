/**
 * Pure presentation helpers for the trade commands' `help` output.
 *
 * `help buy` / `help sell` source their candidate *set* from the same
 * `argDomain` the parser uses (the no-drift guarantee), then layer grouping +
 * pricing on top for clarity. This module owns the grouping/labeling math only
 * — it is pure (no IO, no `server-only`, no pricing lookups), so it stays
 * trivially unit-testable. The handler in `commands.ts` supplies the live prices
 * and turns these groups into the `CommandHelpGroup` view the renderer draws.
 */
import { isUpgradeId } from "./upgrades";

/**
 * Which help group a `buy`/`sell` candidate belongs to. Categorize by id, the
 * same rule the spec mandates: `fuel` → fuel; `all` → its own "everything"
 * token; a known upgrade id → upgrades; anything else → a mineral.
 */
export type TradeCategory = "fuel" | "minerals" | "upgrades" | "everything";

export function tradeCategoryOf(id: string): TradeCategory {
  if (id === "fuel" || id === "warpfuel") return "fuel";
  if (id === "all") return "everything";
  if (isUpgradeId(id)) return "upgrades";
  return "minerals";
}

/** Fixed display order of the trade help groups. */
const CATEGORY_ORDER: readonly TradeCategory[] = [
  "fuel",
  "minerals",
  "upgrades",
  "everything",
];

export interface TradeGroup {
  category: TradeCategory;
  ids: string[];
}

/**
 * Partition trade candidate ids into ordered groups (fuel, minerals, upgrades,
 * everything), preserving input order within each group and dropping empty
 * groups. Pure — categorization only; pricing is layered on by the caller.
 */
export function groupTradeCandidates(ids: string[]): TradeGroup[] {
  const buckets = new Map<TradeCategory, string[]>();
  for (const id of ids) {
    const cat = tradeCategoryOf(id);
    const arr = buckets.get(cat);
    if (arr) arr.push(id);
    else buckets.set(cat, [id]);
  }
  return CATEGORY_ORDER.filter((c) => buckets.has(c)).map((category) => ({
    category,
    ids: buckets.get(category)!,
  }));
}

/** Credit annotation consistent with the rest of the UI: `<n>cr`. */
export function creditLabel(n: number): string {
  return `${n}cr`;
}
