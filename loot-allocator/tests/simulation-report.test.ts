import { describe, expect, it } from "vitest";
import { localizeSimulationReport, parseLocalSimulationReport } from "../src/simulation-report.js";
import type { Player, WeightSnapshot } from "../src/types.js";

describe("local simulation report", () => {
  it("keeps the real sample action order and normalizes report sections", () => {
    const result = parseLocalSimulationReport({
      player: playerFixture(),
      snapshot: snapshotFixture(),
      equipmentNames: new Map([[249317, "测试头盔"]]),
      payload: {
        simcVersion: "1210-01",
        profile: "shaman=Test\nfight_style=Patchwerk",
        report: {
          version: "1210-01",
          sim: {
            options: { iterations: 1000, fight_style: "Patchwerk", desired_targets: 1 },
            players: [{
              specialization: "Elemental Shaman",
              talents: "talent-code",
              scale_factors: { Int: 10 },
              collected_data: {
                dps: { mean: 123456, min: 110000, max: 135000, mean_std_dev: 123 },
                fight_length: { mean: 300 },
                buffed_stats: {
                  attribute: { strength: 100, agility: 200, intellect: 4321 },
                  stats: { haste_rating: 1200, mastery_rating: 950, crit_rating: 780, versatility_rating: 410 },
                },
                action_sequence_precombat: [
                  { time: 0, id: 192106, name: "lightning_shield", spell_name: "Lightning Shield" },
                ],
                action_sequence: [
                  { time: 0, id: 188196, spell_name: "Lightning Bolt", resources: { maelstrom: 10 }, resources_max: { maelstrom: 150 } },
                  { time: 1.5, id: 51505, spell_name: "Lava Burst", resources: { maelstrom: 20 }, resources_max: { maelstrom: 150 } },
                  { time: 3, id: 0, spell_name: "Auto Attack" },
                ],
              },
              stats: [{
                id: 188196,
                spell_name: "Lightning Bolt",
                num_executes: { mean: 100 },
                portion_aps: { mean: 50000 },
                portion_amount: 0.4,
                total_intervals: { mean: 3 },
                children: [{
                  id: 45284,
                  spell_name: "Lightning Bolt Overload",
                  num_executes: { mean: 40 },
                  portion_aps: { mean: 20000 },
                  portion_amount: 0.16,
                }],
              }],
              gear: {
                head: {
                  name: "fixture_helm",
                  encoded_item: "fixture_helm,id=249317,bonus_id=1/2",
                  ilevel: 289,
                  crit_rating: 113,
                  agiint: 204,
                },
              },
            }],
          },
        },
      },
    });

    expect(result.summary).toMatchObject({ dps: 123456, fightLength: 300, iterations: 1000 });
    expect(result.actionSequence.combat.map((action) => action.name)).toEqual([
      "Lightning Bolt",
      "Lava Burst",
      "Auto Attack",
    ]);
    expect(result.actionSequence.combat[0]?.resources).toEqual([
      { name: "maelstrom", value: 10, max: 150 },
    ]);
    expect(result.damage).toEqual([
      { id: 188196, name: "Lightning Bolt", iconUrl: null, dps: 50000, percent: 40, executes: 100 },
      { id: 45284, name: "Lightning Bolt Overload", iconUrl: null, dps: 20000, percent: 16, executes: 40 },
    ]);
    expect(result.castFrequency[0]).toMatchObject({ name: "Lightning Bolt", castsPerMinute: 20 });
    expect(result.equipment[0]).toMatchObject({ name: "测试头盔", itemLevel: 289 });
    expect(result.equipment[0]?.stats).toContainEqual({ name: "intellect", value: 204 });
    expect(result.statTotals).toEqual({
      strength: 100,
      agility: 200,
      intellect: 4321,
      haste: 1200,
      mastery: 950,
      criticalStrike: 780,
      versatility: 410,
    });
    expect(result.statPercentages).toEqual({
      haste: 0,
      mastery: 0,
      criticalStrike: 0,
      versatility: 0,
    });
    expect(result.profile).toContain("fight_style=Patchwerk");

    const localized = localizeSimulationReport(result, new Map([
      [188196, { id: 188196, name: "闪电箭", iconFileDataId: 136048, iconUrl: "/api/loot/icon/file/136048" }],
      [51505, { id: 51505, name: "熔岩爆裂", iconFileDataId: 237582, iconUrl: "/api/loot/icon/file/237582" }],
    ]));
    expect(localized.damage[0]).toMatchObject({ name: "闪电箭", iconUrl: "/api/loot/icon/file/136048" });
    expect(localized.castFrequency[0]).toMatchObject({ name: "闪电箭", iconUrl: "/api/loot/icon/file/136048" });
    expect(localized.actionSequence.combat).toMatchObject([
      { name: "闪电箭", iconUrl: "/api/loot/icon/file/136048" },
      { name: "熔岩爆裂", iconUrl: "/api/loot/icon/file/237582" },
      { name: "自动攻击", iconUrl: null },
    ]);
    expect(localized.actionSequence.precombat[0]).toMatchObject({
      name: "Lightning Shield",
      iconUrl: null,
    });
  });
});

function playerFixture(): Player {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "测试角色",
    realmName: "测试服",
    realmSlug: "test-realm",
    className: "萨满祭司",
    specialization: "元素",
    raidRole: "ranged",
    mainStat: "intellect",
    isActive: true,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function snapshotFixture(): WeightSnapshot {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    playerId: "11111111-1111-1111-1111-111111111111",
    seasonId: "33333333-3333-3333-3333-333333333333",
    source: "local-simc",
    sourceResultId: "local-fixture",
    sourceUrl: "/private/report.json",
    sourcePlayerName: "测试角色",
    sourceRealmName: "测试服",
    sourceCreatedAt: "2026-08-18T12:00:00.000Z",
    fetchedAt: "2026-08-18T12:00:01.000Z",
    gameVersion: "12.1.0.69299",
    gameBuild: 69299,
    baselineDps: 123456,
    weights: {
      intellect: 35,
      agility: 0,
      strength: 0,
      versatility: 16,
      haste: 18,
      mastery: 25,
      criticalStrike: 17,
    },
  };
}
