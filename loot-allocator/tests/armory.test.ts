import { describe, expect, it } from "vitest";
import { characterPageUrl, normalizeArmoryCharacter } from "../src/armory.js";

describe("official CN armory parsing", () => {
  it("combines index identity with the equipment resource", () => {
    const result = normalizeArmoryCharacter(
      {
        character_summary: {
          name: "倾白",
          level: 90,
          average_item_level: 291,
          equipped_item_level: 289,
          realm: { name: "死亡之翼", slug: "deathwing" },
          character_class: { name: "唤魔师" },
          active_spec: { name: "湮灭" },
        },
      },
      {
        equipped_items: [{
          media: { id: 249997 },
          name: "黑爪龙人的角盔",
          level: { value: 289 },
          slot: { name: "头部", type: "HEAD" },
          inventory_type: { type: "HEAD" },
          quality: { type: "EPIC" },
        }],
      },
    );

    expect(result).toMatchObject({
      name: "倾白",
      realmName: "死亡之翼",
      realmSlug: "deathwing",
      className: "唤魔师",
      specialization: "湮灭",
      equippedItemLevel: 289,
      equipment: [{ itemId: 249997, slotType: "HEAD" }],
    });
  });

  it("encodes the official character URL", () => {
    expect(characterPageUrl("deathwing", "倾白")).toBe(
      "https://wow.blizzard.cn/character/#/deathwing/%E5%80%BE%E7%99%BD",
    );
  });
});
