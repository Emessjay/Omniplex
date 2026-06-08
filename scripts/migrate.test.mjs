import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listMigrations } from "./migrate.mjs";

// The migrate runner shares its apply order with scripts/db-migrate.sh:
// filename (lexical) order, .sql files only. That ordering is the contract —
// the only pure piece worth unit-testing (the runner itself is integration).
describe("listMigrations", () => {
  it("returns .sql files in lexical (filename) order, ignoring non-.sql", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omx-migrate-"));
    // Write deliberately out of creation order and with noise files.
    await writeFile(join(dir, "20260608073000_ship-upgrades.sql"), "");
    await writeFile(join(dir, "20260607000000_init.sql"), "");
    await writeFile(join(dir, "20260608030357_command-core.sql"), "");
    await writeFile(join(dir, "README.md"), ""); // not a migration
    await writeFile(join(dir, ".keep"), ""); // not a migration

    expect(await listMigrations(dir)).toEqual([
      "20260607000000_init.sql",
      "20260608030357_command-core.sql",
      "20260608073000_ship-upgrades.sql",
    ]);
  });

  it("returns an empty list when there are no .sql files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omx-migrate-empty-"));
    await writeFile(join(dir, "notes.txt"), "");
    expect(await listMigrations(dir)).toEqual([]);
  });
});
