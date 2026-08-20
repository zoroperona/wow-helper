import { describe, expect, it } from "vitest";
import {
  buildSimcArtifactName,
  buildCharacterStatsProfile,
  buildSimcProfile,
  formatLocalDate,
  inferProfileMainStat,
  parseCharacterStats,
} from "../src/simc.js";

describe("local SimulationCraft profile", () => {
  it("builds identity, talents, equipment and default raid options", () => {
    const profile = buildSimcProfile({
      character_summary: {
        name: "测试德",
        level: 90,
        race: { name: "暗夜精灵" },
        character_class: { id: 11 },
      },
      specializations: {
        active_specialization: { id: 102 },
        specializations: [{
          specialization: { id: 102 },
          loadouts: [{ is_active: true, talent_loadout_code: "TEST_TALENTS" }],
        }],
      },
      equipment: {
        equipped_items: Array.from({ length: 10 }, (_, index) => ({
          slot: { type: ["HEAD", "NECK", "SHOULDER", "BACK", "CHEST", "WRIST", "HANDS", "WAIST", "LEGS", "FEET"][index] },
          media: { id: 250000 + index },
          bonus_list: index === 0 ? [100, 200] : [],
          sockets: index === 0 ? [{ media: { id: 240983 } }] : [],
          enchantments: index === 0 ? [{ enchantment_id: 8017 }] : [],
          modified_crafting_stat: index === 0 ? [{ id: 40 }, { id: 32 }] : [],
        })),
      },
    });

    expect(profile).toContain("druid=测试德");
    expect(profile).toContain("race=night_elf");
    expect(profile).toContain("spec=balance");
    expect(profile).not.toMatch(/^role=/m);
    expect(profile).toContain("talents=TEST_TALENTS");
    expect(profile).toContain("head=,id=250000,bonus_id=100/200,gem_id=240983,enchant_id=8017,crafted_stats=40/32");
    expect(profile).toContain("override.bloodlust=1");
    expect(profile).toContain("calculate_scale_factors=1");
    expect(inferProfileMainStat({
      specializations: { active_specialization: { id: 102 } },
    })).toBe("intellect");

    const characterProfile = buildCharacterStatsProfile({
      character_summary: {
        name: "测试德",
        level: 90,
        race: { name: "暗夜精灵" },
        character_class: { id: 11 },
      },
      specializations: {
        active_specialization: { id: 102 },
        specializations: [{
          specialization: { id: 102 },
          loadouts: [{ is_active: true, talent_loadout_code: "TEST_TALENTS" }],
        }],
      },
      equipment: { equipped_items: Array.from({ length: 10 }, (_, index) => ({
        slot: { type: ["HEAD", "NECK", "SHOULDER", "BACK", "CHEST", "WRIST", "HANDS", "WAIST", "LEGS", "FEET"][index] },
        media: { id: 250000 + index },
      })) },
    });
    expect(characterProfile).toContain("optimal_raid=0");
    expect(characterProfile).toContain("calculate_scale_factors=0");
    expect(characterProfile).toContain("flask=disabled");
    expect(characterProfile).not.toContain("override.mark_of_the_wild=1");
  });

  it("parses lightweight character stats and percentages", () => {
    expect(parseCharacterStats({
      version: "1210-01",
      sim: {
        options: {
          dbc: { version_used: "Live", Live: { build_level: 69299, wow_version: "12.1.0.69299" } },
        },
        players: [{
          collected_data: {
            buffed_stats: {
              attribute: { strength: 100, agility: 200, intellect: 300, stamina: 400 },
              stats: {
                crit_rating: 500, crit_pct: 0.25,
                haste_rating: 600, haste_pct: 0.3,
                mastery_rating: 700, mastery_pct: 0.4,
                versatility_rating: 800, versatility_pct: 0.05,
              },
            },
          },
        }],
      },
    }, "intellect")).toMatchObject({
      mainStat: "intellect",
      gameBuild: 69299,
      attributes: { intellect: 300, stamina: 400 },
      secondary: {
        criticalStrike: { rating: 500, percent: 25 },
        haste: { rating: 600, percent: 30 },
        mastery: { rating: 700, percent: 40 },
        versatility: { rating: 800, percent: 5 },
      },
    });
  });

  it("rejects a payload without a supported race or active talents", () => {
    expect(() => buildSimcProfile({
      character_summary: {
        name: "测试角色", level: 90, race: { name: "未知种族" }, character_class: { id: 11 },
      },
      specializations: { active_specialization: { id: 102 }, specializations: [] },
    })).toThrow("Incomplete SimC identity");
  });

  it.each([
    { classId: 6, specId: 252, expectedClass: "deathknight=测试角色", expectedSpec: "unholy" },
    { classId: 12, specId: 577, expectedClass: "demonhunter=测试角色", expectedSpec: "havoc" },
    { classId: 12, specId: 1480, expectedClass: "demonhunter=测试角色", expectedSpec: "devourer" },
  ])("uses the SimC tokens for class $classId spec $specId", ({ classId, specId, expectedClass, expectedSpec }) => {
    const profile = buildSimcProfile({
      character_summary: {
        name: "测试角色",
        level: 90,
        race: { name: "暗夜精灵" },
        character_class: { id: classId },
      },
      specializations: {
        active_specialization: { id: specId },
        specializations: [{
          specialization: { id: specId },
          loadouts: [{ is_active: true, talent_loadout_code: "TEST_TALENTS" }],
        }],
      },
      equipment: {
        equipped_items: Array.from({ length: 10 }, (_, index) => ({
          slot: { type: ["HEAD", "NECK", "SHOULDER", "BACK", "CHEST", "WRIST", "HANDS", "WAIST", "LEGS", "FEET"][index] },
          media: { id: 250000 + index },
        })),
      },
    });

    expect(profile).toContain(expectedClass);
    expect(profile).toContain(`spec=${expectedSpec}`);
    expect(profile).not.toMatch(/^role=/m);
    if (specId === 1480) {
      expect(inferProfileMainStat({
        specializations: { active_specialization: { id: specId } },
      })).toBe("intellect");
    }
  });

  it("uses a local date directory and readable character report name", () => {
    const simulatedAt = new Date(2026, 7, 18, 4, 5, 6);
    expect(formatLocalDate(simulatedAt)).toBe("2026-08-18");
    expect(buildSimcArtifactName({
      playerName: "小黄油丶",
      realmName: "凤凰之神/测试",
      simulatedAt,
    })).toBe("小黄油丶-凤凰之神-测试-2026-08-18-04-05-06");
  });
});
