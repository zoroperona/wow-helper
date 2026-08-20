import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LootDatabase } from "../src/db.js";
import { DpsWowClient, WeightImportService } from "../src/dpswow.js";
import { gzipSync } from "node:zlib";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local weight cache", () => {
  it("updates players and only deletes players without allocation history", async () => {
    const fixture = await createDatabase();
    const editable = fixture.database.createPlayer({
      name: "错误名字",
      realmName: "测试服",
      realmSlug: "test-realm",
      raidRole: "melee",
    });
    expect(fixture.database.updatePlayer(editable.id, {
      name: "正确名字",
      realmName: "测试服",
      realmSlug: "test-realm",
      raidRole: "ranged",
    })).toMatchObject({ name: "正确名字", raidRole: "ranged" });
    expect(fixture.database.deletePlayer(editable.id)).toBe("deleted");

    const recorded = fixture.database.createPlayer({
      name: "已有记录",
      realmName: "测试服",
      realmSlug: "test-realm",
      raidRole: "ranged",
    });
    fixture.database.createAllocation({
      playerId: recorded.id,
      raidName: "测试副本",
      bossName: "测试 Boss",
      itemName: "测试装备",
      equipmentType: "head",
      pickupCount: 1,
      countsTowardTotal: true,
      isSpecialEffect: false,
    });
    expect(fixture.database.deletePlayer(recorded.id)).toBe("has-allocations");
    fixture.database.close();
  });

  it("creates versioned default loot rules with trinkets excluded from pickup totals", async () => {
    const fixture = await createDatabase();
    const rules = fixture.database.listLootRules();
    expect(rules.find((rule) => rule.ruleKey === "two_hand_weapon")).toMatchObject({
      pickupCount: 4,
      countsTowardTotal: true,
      gameVersion: "12.1",
    });
    expect(rules.find((rule) => rule.ruleKey === "trinket")).toMatchObject({
      pickupCount: 0,
      countsTowardTotal: false,
    });
    expect(
      fixture.database.updateLootRule("two_hand_weapon", {
        pickupCount: 5,
        countsTowardTotal: true,
      }),
    ).toMatchObject({ pickupCount: 5, gameVersion: "12.1" });
    fixture.database.close();
  });

  it("keeps trinkets in history without adding them to a player's pickup total", async () => {
    const fixture = await createDatabase();
    const player = fixture.database.createPlayer({
      name: "输出一号",
      realmName: "测试服",
      realmSlug: "test-realm",
      raidRole: "ranged",
    });
    const weapon = fixture.database.createAllocation({
      playerId: player.id,
      raidName: "测试副本",
      bossName: "测试 Boss",
      itemName: "测试双手武器",
      equipmentType: "two_hand_weapon",
      difficulty: "lfr",
      pickupCount: 4,
      countsTowardTotal: true,
      isSpecialEffect: false,
    });
    fixture.database.createAllocation({
      playerId: player.id,
      raidName: "测试副本",
      bossName: "测试 Boss",
      itemName: "测试饰品",
      equipmentType: "trinket",
      pickupCount: 0,
      countsTowardTotal: false,
      isSpecialEffect: true,
    });

    expect(fixture.database.listAllocations()).toHaveLength(2);
    expect(fixture.database.listAllocations().find((entry) => entry.itemName === "测试双手武器"))
      .toMatchObject({ difficulty: "lfr" });
    expect(fixture.database.listPlayers()[0]).toMatchObject({
      seasonPickupCount: 4,
      seasonItemCount: 2,
    });
    expect(fixture.database.updateAllocationPickupCount(weapon.id, 0.5)).toMatchObject({
      id: weapon.id,
      pickupCount: 0.5,
      playerClassName: null,
    });
    expect(fixture.database.listPlayers()[0]?.seasonPickupCount).toBe(0.5);
    expect(fixture.database.updateAllocationPickupCount("missing", 1)).toBeNull();
    expect(fixture.database.deleteAllocation(weapon.id)).toBe(true);
    expect(fixture.database.deleteAllocation(weapon.id)).toBe(false);
    expect(fixture.database.listAllocations()).toHaveLength(1);
    expect(fixture.database.listPlayers()[0]).toMatchObject({
      seasonPickupCount: 0,
      seasonItemCount: 1,
    });
    fixture.database.close();
  });

  it("lazily normalizes equipment from an existing compressed character snapshot", async () => {
    const fixture = await createDatabase();
    const player = fixture.database.createPlayer({
      name: "倾白",
      realmName: "死亡之翼",
      realmSlug: "deathwing",
      raidRole: "ranged",
    });
    const season = fixture.database.getActiveSeason();
    fixture.database.saveCharacterSnapshot({
      playerId: player.id,
      seasonId: season.id,
      fetchedAt: "2026-08-17T14:46:11.292Z",
      gameVersion: "12.1",
      level: 90,
      averageItemLevel: 291,
      equippedItemLevel: 289,
      equipment: [{
        itemId: 249997,
        name: "黑爪龙人的角盔",
        itemLevel: 289,
        slotType: "HEAD",
        slotName: "头部",
        inventoryType: "HEAD",
        quality: "EPIC",
        bonusList: [],
        enchantments: [],
        sockets: [],
        set: null,
        iconUrl: null,
      }],
      payloadGzip: gzipSync("{}"),
      source: "blizzard-cn-armory",
    });

    expect(fixture.database.getLatestCharacterEquipment(player.id)).toMatchObject({
      season: "12.1",
      player: { name: "倾白" },
      equippedItemLevel: 289,
      source: { provider: "blizzard-cn-armory" },
      items: [{ itemId: 249997, iconUrl: null }],
    });
    fixture.database.close();
  });

  it("stores a season and exports the latest normalized snapshot", async () => {
    const fixture = await createDatabase();
    const player = fixture.database.createPlayer({
      name: "近战一号",
      realmName: "测试服",
      realmSlug: "test-realm",
      raidRole: "melee",
    });
    const season = fixture.database.getActiveSeason();
    fixture.database.saveWeightSnapshot(
      {
        playerId: player.id,
        seasonId: season.id,
        sourceResultId: "11111111-1111-1111-1111-111111111111",
        sourceUrl: "https://www.dpswow.com/gear/result/weight?id=fixture",
        sourcePlayerName: player.name,
        sourceRealmName: player.realmName,
        sourceCreatedAt: "2026-08-17 12:00:00",
        fetchedAt: "2026-08-17T12:00:01.000Z",
        gameVersion: "12.1.0.69299",
        gameBuild: 69299,
        baselineDps: 100000,
        weights: {
          strength: 20,
          agility: 0,
          intellect: 0,
          versatility: 7,
          haste: 8,
          mastery: 9,
          criticalStrike: 10,
        },
        sourcePayloadGzip: Buffer.from("fixture"),
      },
      "strength",
    );

    const cache = fixture.database.getLatestWeightCache(player.id);
    expect(cache).toMatchObject({
      schemaVersion: 1,
      season: "12.1",
      gameVersion: "12.1.0.69299",
      gameBuild: 69299,
      player: { role: "melee", mainStat: "strength" },
      weights: { strength: 20, criticalStrike: 10 },
    });
    expect(fixture.database.listPlayers()[0]?.latestSimulationDps).toBeUndefined();
    expect(fixture.database.listPlayers()[0]?.hasLocalSimulation).toBe(false);

    fixture.database.saveWeightSnapshot(
      {
        playerId: player.id,
        seasonId: season.id,
        source: "local-simc",
        sourceResultId: "local-test-result",
        sourceUrl: "/tmp/test-report.json",
        sourcePlayerName: player.name,
        sourceRealmName: player.realmName,
        sourceCreatedAt: "2026-08-18T12:00:00.000Z",
        fetchedAt: "2026-08-18T12:00:00.000Z",
        gameVersion: "12.1.0.69300",
        gameBuild: 69300,
        baselineDps: 123456.7,
        weights: {
          strength: 21,
          agility: 0,
          intellect: 0,
          versatility: 8,
          haste: 9,
          mastery: 10,
          criticalStrike: 11,
        },
        sourcePayloadGzip: Buffer.from("local fixture"),
      },
      "strength",
    );
    expect(fixture.database.listPlayers()[0]?.latestSimulationDps).toBe(123456.7);
    expect(fixture.database.listPlayers()[0]?.hasLocalSimulation).toBe(true);
    fixture.database.close();
  });

  it("rejects weight imports for tanks before making a network request", async () => {
    const fixture = await createDatabase();
    const player = fixture.database.createPlayer({
      name: "坦克一号",
      realmName: "测试服",
      realmSlug: "test-realm",
      raidRole: "tank",
    });
    const service = new WeightImportService(fixture.database, new DpsWowClient());

    await expect(
      service.importForPlayer(
        player.id,
        "https://www.dpswow.com/gear/result/weight?id=11111111-1111-1111-1111-111111111111",
      ),
    ).rejects.toThrow("only available to melee and ranged");
    fixture.database.close();
  });
});

async function createDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "wow-loot-test-"));
  cleanupPaths.push(directory);
  const database = await LootDatabase.open(join(directory, "test.sqlite"));
  return { directory, database };
}
