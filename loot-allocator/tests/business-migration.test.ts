import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LootDatabase } from "../src/db.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationScript = join(projectRoot, "scripts", "migrate-business-database.mjs");
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("business migration baseline", () => {
  it("creates an immutable schema 5 baseline and verifies an idempotent rerun", async () => {
    const databasePath = await createSchemaFiveDatabase();

    expect(runMigration(databasePath, "--baseline")).toMatchObject({ status: 0 });
    expect(runMigration(databasePath, "--check")).toMatchObject({ status: 0 });
    expect(runMigration(databasePath, "--baseline")).toMatchObject({ status: 0 });

    const sqlite = new DatabaseSync(databasePath);
    try {
      expect(() => sqlite.prepare("UPDATE schema_migrations SET checksum = ?").run("0".repeat(64)))
        .toThrow("append-only");
      expect(sqlite.prepare("SELECT status FROM migration_attempts").get())
        .toMatchObject({ status: "success" });
    } finally {
      sqlite.close();
    }
  });

  it("fails closed while a running attempt exists", async () => {
    const databasePath = await createSchemaFiveDatabase();
    expect(runMigration(databasePath, "--baseline")).toMatchObject({ status: 0 });

    const sqlite = new DatabaseSync(databasePath);
    try {
      sqlite.prepare(`
        INSERT INTO migration_attempts (
          attempt_id, migration_id, checksum, from_schema, to_schema,
          status, started_at, before_fingerprint
        ) VALUES ('running-test', '0006_test', ?, 5, 6, 'running', ?, ?)
      `).run("1".repeat(64), new Date().toISOString(), "2".repeat(64));
    } finally {
      sqlite.close();
    }

    const result = runMigration(databasePath, "--check");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("存在未可信 migration attempt");
  });
});

async function createSchemaFiveDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wow-business-migration-test-"));
  cleanupPaths.push(directory);
  const databasePath = join(directory, "business.sqlite");
  const database = await LootDatabase.open(databasePath);
  database.close();
  return databasePath;
}

function runMigration(databasePath: string, mode: "--baseline" | "--check") {
  return spawnSync(process.execPath, [migrationScript, "--database", databasePath, mode], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}
