import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LootDatabase } from "../src/db.js";
import { SimulationService, isWeightOlderThan } from "../src/simulation.js";
import type { LocalSimResult } from "../src/simc.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("simulation service", () => {
  it("locks concurrent starts and updates equipment before the weight cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wow-simulation-test-"));
    cleanupPaths.push(directory);
    const database = await LootDatabase.open(join(directory, "test.sqlite"));
    const player = database.createPlayer({
      name: "测试输出",
      realmName: "测试服",
      realmSlug: "test-realm",
      raidRole: "ranged",
    });
    const profilePath = join(directory, "profile.simc");
    await writeFile(profilePath, "mage=测试输出\n", "utf8");

    let finishSimulation!: (result: LocalSimResult) => void;
    const runnerResult = new Promise<LocalSimResult>((resolve) => {
      finishSimulation = resolve;
    });
    const runner = async () => runnerResult;
    const service = new SimulationService(
      database,
      { lookupCharacter: async () => characterFixture() },
      "/test/simc",
      directory,
      runner,
      () => new Date("2026-08-18T08:00:00.000Z"),
    );

    expect(service.startSingle(player.id)).toMatchObject({
      running: true,
      mode: "single",
      total: 1,
    });
    expect(() => service.startSingle(player.id)).toThrow("already running");

    finishSimulation(simResultFixture(profilePath));
    await service.waitForIdle();

    expect(service.getStatus()).toMatchObject({
      running: false,
      completed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(database.getLatestCharacterEquipment(player.id)).toMatchObject({
      source: { provider: "dpswow-cn-armory" },
      equippedItemLevel: 290,
    });
    expect(database.getLatestWeight(player.id)).toMatchObject({
      source: "local-simc",
      baselineDps: 123456,
      weights: { intellect: 10, haste: 7 },
    });
    database.close();
  });

  it.each(["tank", "healer"] as const)("allows active %s players to start a simulation", async (raidRole) => {
    const directory = await mkdtemp(join(tmpdir(), `wow-${raidRole}-simulation-test-`));
    cleanupPaths.push(directory);
    const database = await LootDatabase.open(join(directory, "test.sqlite"));
    const player = database.createPlayer({
      name: raidRole === "tank" ? "测试坦克" : "测试治疗",
      realmName: "测试服",
      realmSlug: "test-realm",
      raidRole,
    });
    const profilePath = join(directory, "profile.simc");
    await writeFile(profilePath, `${raidRole}=测试角色\n`, "utf8");
    const service = new SimulationService(
      database,
      { lookupCharacter: async () => characterFixture() },
      "/test/simc",
      directory,
      async () => {
        if (raidRole === "healer") throw new Error("specialization is unsupported");
        return simResultFixture(profilePath);
      },
      () => new Date("2026-08-18T08:00:00.000Z"),
    );

    expect(service.startSingle(player.id)).toMatchObject({ running: true, total: 1 });
    await service.waitForIdle();
    expect(service.getStatus()).toMatchObject(raidRole === "tank"
      ? { succeeded: 1, failed: 0 }
      : {
          succeeded: 0,
          failed: 1,
          failures: [{ playerId: player.id, message: "specialization is unsupported" }],
        });
    database.close();
  });

  it("treats missing, invalid, and older-than-one-day weights as stale", () => {
    const cutoff = new Date("2026-08-17T08:00:00.000Z").getTime();
    expect(isWeightOlderThan(null, cutoff)).toBe(true);
    expect(isWeightOlderThan("invalid", cutoff)).toBe(true);
    expect(isWeightOlderThan("2026-08-17T07:59:59.999Z", cutoff)).toBe(true);
    expect(isWeightOlderThan("2026-08-17T08:00:00.000Z", cutoff)).toBe(false);
    expect(isWeightOlderThan("2026-08-18T08:00:00.000Z", cutoff)).toBe(false);
  });
});

function characterFixture() {
  return {
    name: "测试输出",
    realmName: "测试服",
    realmSlug: "test-realm",
    className: "法师",
    specialization: "奥术",
    level: 90,
    averageItemLevel: 291,
    equippedItemLevel: 290,
    equipment: [],
    rawPayload: { character_summary: { name: "测试输出" } },
  };
}

function simResultFixture(profilePath: string): LocalSimResult {
  return {
    report: { version: "12.1-test" },
    weights: {
      intellect: 10,
      agility: 0,
      strength: 0,
      versatility: 6,
      haste: 7,
      mastery: 8,
      criticalStrike: 9,
    },
    inferredMainStat: "intellect",
    baselineDps: 123456,
    gameVersion: "12.1.0.70000",
    gameBuild: 70000,
    simcVersion: "12.1-test",
    profilePath,
    reportPath: profilePath.replace(".simc", ".json"),
    htmlPath: profilePath.replace(".simc", ".html"),
    logPath: profilePath.replace(".simc", ".log"),
  };
}
