import type { Config } from "tailwindcss";

/**
 * Omniplex terminal skin.
 *
 * Dark-first. `darkMode: "class"` is enabled so future light-theme work
 * can scope overrides under `.dark` / its absence — but per the project
 * theme-parity rule, theme-scoped rules may only change COLOR, never
 * geometry (sizing, spacing, layout). All semantic terminal colors live
 * under the `term.*` palette so components reference intent, not hex.
 */
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        term: {
          bg: "#06080a",
          fg: "#9ad1b0",
          muted: "#5a6b60",
          accent: "#56b6c2",
          link: "#61afef",
          success: "#7fe08a",
          warning: "#e5c07b",
          danger: "#e06c75",
          heading: "#d6f5e0",
        },
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
