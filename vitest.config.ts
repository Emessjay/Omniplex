import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the tsconfig "@/*" path alias so tests can import app modules.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` is a Next.js build-time marker with no Node runtime; stub
      // it so pure-logic tests can import server modules (e.g. game/commands).
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    // Pure-logic unit tests (procedural gen + game rules + helpers). No DOM
    // by default; downstream workers can opt into jsdom per-file if needed.
    environment: "node",
    // App/game logic lives under src/ as .ts(x); infra scripts (e.g. the
    // migration runner) keep their pure-logic tests beside them as .mjs.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.{test,spec}.mjs"],
  },
});
