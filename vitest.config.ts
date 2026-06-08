import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the tsconfig "@/*" path alias so tests can import app modules.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Pure-logic unit tests (procedural gen + game rules + helpers). No DOM
    // by default; downstream workers can opt into jsdom per-file if needed.
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
