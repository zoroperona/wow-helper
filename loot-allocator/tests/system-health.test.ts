import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemHealthService } from "../src/system-health.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("system health", () => {
  it("reports build drift, missing simulations, and hotfix limitations without requiring a local scheduler", async () => {
    const fixture = await createFixture({ simcBuild: 69299, wowDbBuild: 69283 });
    const report = await fixture.service.getReport(true);

    expect(report.status).toBe("warning");
    expect(report.components.find((entry) => entry.id === "simc")).toMatchObject({
      status: "healthy",
      summary: "1210-01 / WoW 12.1.0.69299",
    });
    expect(report.components.find((entry) => entry.id === "wowdb")).toMatchObject({
      status: "warning",
    });
    expect(report.issues.map((entry) => entry.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("相差 16"),
      expect.stringContaining("DBCache.bin"),
      expect.stringContaining("尚无本地模拟结果"),
    ]));
    expect(report.components.find((entry) => entry.id === "runtime")).toMatchObject({
      status: "healthy",
      summary: "构建产物正常，本机不执行定时任务",
    });
  });

  it("marks an unavailable wow-db as critical", async () => {
    const fixture = await createFixture({ simcBuild: 69299, wowDbBuild: null });
    const report = await fixture.service.getReport(true);

    expect(report.status).toBe("critical");
    expect(report.components.find((entry) => entry.id === "wowdb")).toMatchObject({
      status: "critical",
      summary: "wow-db 不可用或校验失败",
    });
  });
});

async function createFixture(input: { simcBuild: number; wowDbBuild: number | null }) {
  const root = await mkdtemp(join(tmpdir(), "wow-health-test-"));
  cleanupPaths.push(root);
  const simcPath = join(root, "simc");
  const simcRunsPath = join(root, "simc-runs", "2026-08-18");
  const wowDbPath = join(root, "wow.sqlite");
  const databasePath = join(root, "app.sqlite");
  const backupsPath = join(root, "backups");
  const appRoot = join(root, "app");
  await Promise.all([
    mkdir(simcRunsPath, { recursive: true }),
    mkdir(backupsPath, { recursive: true }),
    mkdir(join(appRoot, "src"), { recursive: true }),
    mkdir(join(appRoot, "dist"), { recursive: true }),
  ]);

  await writeFile(simcPath, `#!/bin/sh\necho 'SimulationCraft 1210-01 for World of Warcraft 12.1.0.${input.simcBuild} Live' >&2\nexit 1\n`, "utf8");
  await chmod(simcPath, 0o755);
  await writeFile(join(simcRunsPath, "fixture.html"), `
    <style>${"x".repeat(80 * 1024)}</style>
    <h1>SimulationCraft 1210-01</h1>
    <h2>for World of Warcraft 12.1.0.${input.simcBuild} Live
      (hotfix 2026-08-15/${input.simcBuild}, git build
      <a href="https://github.com/simulationcraft/simc/commit/abcdef1">abcdef1</a>)
    </h2>
  `, "utf8");
  await writeFile(join(appRoot, "src", "server.ts"), "export {};\n", "utf8");
  await writeFile(join(appRoot, "dist", "server.js"), "export {};\n", "utf8");
  await writeFile(join(backupsPath, "backup.sqlite"), "fixture", "utf8");
  createAppDatabase(databasePath);
  if (input.wowDbBuild) createWowDatabase(wowDbPath, input.wowDbBuild);

  return {
    service: new SystemHealthService({
      simcPath,
      simcRunsPath,
      wowDbPath,
      databasePath,
      backupsPath,
      appRoot,
      cacheMs: 0,
      now: () => new Date("2026-08-18T12:00:00.000Z"),
    }),
  };
}

function createAppDatabase(path: string): void {
  const sqlite = new DatabaseSync(path);
  sqlite.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_meta VALUES ('schema_version', '5');
    CREATE TABLE players (id TEXT PRIMARY KEY, is_active INTEGER NOT NULL);
    INSERT INTO players VALUES ('player-1', 1);
    CREATE TABLE character_snapshots (id TEXT PRIMARY KEY, player_id TEXT, fetched_at TEXT);
    INSERT INTO character_snapshots VALUES ('character-1', 'player-1', '2026-08-18T10:00:00.000Z');
    CREATE TABLE stat_weight_snapshots (
      id TEXT PRIMARY KEY, player_id TEXT, source TEXT, fetched_at TEXT, game_build INTEGER
    );
  `);
  sqlite.close();
}

function createWowDatabase(path: string, build: number): void {
  const sqlite = new DatabaseSync(path);
  sqlite.exec(`
    CREATE TABLE __wowdb_tables (table_name TEXT, build TEXT, locale TEXT, completed_at TEXT);
    INSERT INTO __wowdb_tables VALUES ('Item', '12.1.0.${build}', 'zhCN', '2026-08-18T10:00:00.000Z');
    ${[
      "JournalInstance", "JournalEncounter", "JournalEncounterItem", "Item", "ItemSparse",
      "ItemBonus", "ItemBonusListGroupEntry", "RandPropPoints", "CombatRatingsMultByILvl",
      "StaminaMultByILvl", "ItemSocketCostPerLevel",
    ].map((table) => `CREATE TABLE "${table}" (ID INTEGER);`).join("\n")}
  `);
  sqlite.close();
}
