/**
 * World seed accessor. The procedural universe is a pure function of
 * `(WORLD_SEED, coords)`, so every command handler must read the planet/system
 * from the SAME seed. Read lazily (not at import time) so the build works with
 * no env set; falls back to the dev seed used in `.env.example`.
 */

/** The active world seed. Changing it re-rolls the entire galaxy. */
export function getWorldSeed(): string {
  return process.env.WORLD_SEED ?? "omniplex-dev";
}
