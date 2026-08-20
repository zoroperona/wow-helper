import { describe, expect, it, vi } from "vitest";
import { DpsWowClient, normalizeWeights, parseResultId } from "../src/dpswow.js";
import { normalizeCharacterEquipment } from "../src/equipment.js";

describe("DPSWOW result parsing", () => {
  it("normalizes armory equipment without retaining remote icons", () => {
    const result = normalizeCharacterEquipment({
      character_summary: {
        level: 90,
        average_item_level: 291.5,
        equipped_item_level: 289.25,
      },
      equipment: {
        equipped_items: [
          {
            media: { id: 249997, icon: "https://remote.example/icon.jpg" },
            name: "黑爪龙人的角盔",
            level: { value: 289 },
            slot: { name: "头部", type: "HEAD" },
            inventory_type: { type: "HEAD" },
            quality: { type: "EPIC" },
            bonus_list: [13335, 13338],
            set: {
              display_string: "黑爪龙人的制服（4/5）",
              item_set: { name: "黑爪龙人的制服" },
              effects: [{ display_string: "套装：测试效果", required_count: 2, is_active: true }],
            },
            enchantments: [{ enchantment_id: 8017, display_string: "附魔：测试" }],
            sockets: [{
              socket_type: { type: "PRISMATIC" },
              media: { id: 240983 },
              item: { name: "费解之永歌钻石" },
              display_string: "+32 主属性",
            }],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      level: 90,
      averageItemLevel: 291.5,
      equippedItemLevel: 289.25,
      items: [{
        itemId: 249997,
        slotType: "HEAD",
        iconUrl: null,
        set: { name: "黑爪龙人的制服", effects: [{ requiredCount: 2, isActive: true }] },
      }],
    });
    expect(JSON.stringify(result)).not.toContain("remote.example");
  });

  it("extracts an ID from a weight result URL", () => {
    expect(
      parseResultId(
        "https://www.dpswow.com/gear/result/weight?id=d71fdb1d-1f6a-4352-b6be-5014f2191d8a&fromType=run",
      ),
    ).toBe("d71fdb1d-1f6a-4352-b6be-5014f2191d8a");
  });

  it("rejects non-weight result pages", () => {
    expect(() =>
      parseResultId(
        "https://www.dpswow.com/gear/result/drop?id=d71fdb1d-1f6a-4352-b6be-5014f2191d8a",
      ),
    ).toThrow("Only DPSWOW weight result links are supported");
  });

  it("maps all seven supported stats", () => {
    expect(
      normalizeWeights({ Int: 10, Agi: 0, Str: 0, Vers: 4, Haste: 5, Mastery: 6, Crit: 7 }),
    ).toEqual({
      intellect: 10,
      agility: 0,
      strength: 0,
      versatility: 4,
      haste: 5,
      mastery: 6,
      criticalStrike: 7,
    });
  });

  it("imports versioned weights from result metadata and report JSON", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 1000,
          message: "success",
          data: {
            result: {
              id: "d71fdb1d-1f6a-4352-b6be-5014f2191d8a",
              playerInfo: { playerName: "测试角色", server: "测试服" },
              rawResultUrl: "https://public.dpswow.com/Simc/report/test.json",
              createTime: "2026-08-17 12:00:00",
              bestDps: 123456,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          version: "1210-01",
          sim: {
            options: {
              dbc: {
                version_used: "Live",
                Live: { wow_version: "12.1.0.69299", build_level: 69299 },
              },
            },
            players: [
              {
                name: "测试角色",
                scale_factors: { Agi: 31, Crit: 14, Haste: 13, Mastery: 12, Vers: 11 },
                collected_data: { dps: { mean: 123456.4 } },
              },
            ],
          },
        }),
      );

    const result = await new DpsWowClient(fetcher).importWeightResult(
      "d71fdb1d-1f6a-4352-b6be-5014f2191d8a",
    );

    expect(result.gameVersion).toBe("12.1.0.69299");
    expect(result.gameBuild).toBe(69299);
    expect(result.inferredMainStat).toBe("agility");
    expect(result.weights.criticalStrike).toBe(14);
    expect(result.sourcePayloadGzip.length).toBeGreaterThan(0);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
