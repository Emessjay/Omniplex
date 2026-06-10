/**
 * Test-only stub for Next.js's `server-only` marker package.
 *
 * `server-only` has no real export — it exists purely to make a build FAIL if a
 * server module is pulled into a Client Component bundle (Next swaps in an
 * empty module under the `react-server` export condition). Vitest runs plain
 * Node with no such condition, so `import "server-only"` would fail to resolve.
 * Aliasing it to this empty module (see `vitest.config.ts`) lets pure-logic
 * tests import server modules (e.g. `@/lib/game/commands`) without dragging in a
 * real server runtime. It changes nothing about the production build.
 */
export {};
