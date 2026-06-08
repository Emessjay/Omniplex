/**
 * Public surface of the players module.
 *
 * Note: `getOrCreatePlayer` is intentionally NOT re-exported here — it is
 * `server-only` and importing this barrel from a client component would then
 * pull the service-role code path into a client bundle and fail the build.
 * Import it directly from `@/lib/players/getOrCreatePlayer` in server code.
 */
export type { Player, PlayerRow } from "./types";
export { rowToPlayer } from "./mapping";
export { generateCallsign, uniqueHandle, CALLSIGN_WORDS } from "./handle";
