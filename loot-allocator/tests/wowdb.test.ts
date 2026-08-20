import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WowDbCatalog } from "../src/wowdb.js";
import type { CharacterEquipmentCache, EquippedItem } from "../src/types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("wow-db catalog adapter", () => {
  it("counts only the current season class set across the five tier slots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wow-db-tier-set-"));
    cleanupPaths.push(directory);
    const path = join(directory, "wow.sqlite");
    const sqlite = new DatabaseSync(path);
    sqlite.exec(`
      CREATE TABLE ItemSet (ID INTEGER, Name_lang TEXT, ItemID TEXT);
      CREATE TABLE ItemSetSpell (ID INTEGER, ItemSetID INTEGER, SpellID INTEGER, Threshold INTEGER);
      CREATE TABLE SpellName (ID INTEGER, Name_lang TEXT);
      INSERT INTO ItemSet VALUES
        (1981, '旧赛季套装', '[249997,249995,250000,249998,249996]'),
        (2058, '灾厄回响', '[271504,271502,271501,271500,271499]');
      INSERT INTO ItemSetSpell VALUES (1, 1981, 1001, 2), (2, 2058, 1002, 2), (3, 2058, 1003, 4);
      INSERT INTO SpellName VALUES
        (1001, 'Evoker 12.0 Class Set 2pc'),
        (1002, 'Evoker 12.1 Class Set 2pc'),
        (1003, 'Evoker 12.1 Class Set 4pc');
    `);
    sqlite.close();

    const wowDb = new WowDbCatalog(path, "12.1", "12.1");
    const oldSet = characterEquipment([
      tierItem(249997, "HEAD", "旧赛季套装"),
      tierItem(249995, "SHOULDER", "旧赛季套装"),
    ]);
    expect(wowDb.getCurrentTierSetSummary(oldSet)).toMatchObject({ equipped: 0, name: null });

    const currentSet = characterEquipment([
      tierItem(271501, "HEAD", ""),
      tierItem(271504, "HEAD", "灾厄回响"),
      tierItem(999998, "SHOULDER", "灾厄回响"),
      tierItem(999999, "LEGS", ""),
    ]);
    expect(wowDb.getCurrentTierSetSummary(currentSet)).toMatchObject({
      equipped: 2,
      name: "灾厄回响",
      slots: { head: true, shoulder: true, chest: false, hands: false, legs: false },
    });
    wowDb.close();
  });

  it("loads localized spell names and action icons in one batch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wow-db-spells-"));
    cleanupPaths.push(directory);
    const path = join(directory, "wow.sqlite");
    const sqlite = new DatabaseSync(path);
    sqlite.exec(`
      CREATE TABLE SpellName (ID INTEGER, Name_lang TEXT);
      CREATE TABLE SpellMisc (ID INTEGER, DifficultyID INTEGER, SpellID INTEGER, SpellIconFileDataID INTEGER);
      INSERT INTO SpellName VALUES (188196, '闪电箭'), (51505, '熔岩爆裂');
      INSERT INTO SpellMisc VALUES
        (1, 0, 188196, 136048),
        (2, 1, 188196, 999999),
        (3, 0, 51505, 237582);
    `);
    sqlite.close();

    const wowDb = new WowDbCatalog(path, "12.1", "12.1");
    const spells = wowDb.getSpellReferences([188196, 51505, 188196, 0, -1]);
    expect(spells.size).toBe(2);
    expect(spells.get(51505)).toEqual({
      id: 51505,
      name: "熔岩爆裂",
      iconFileDataId: 237582,
      iconUrl: "/api/loot/icon/file/237582",
    });
    expect(spells.get(188196)).toEqual({
      id: 188196,
      name: "闪电箭",
      iconFileDataId: 136048,
      iconUrl: "/api/loot/icon/file/136048",
    });
    expect(wowDb.getItemIconFileDataId(188196)).toBeNull();
    wowDb.close();
  });

  it("joins the current-season journal to filtered equipment drops", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wow-db-adapter-"));
    cleanupPaths.push(directory);
    const path = join(directory, "wow.sqlite");
    const sqlite = new DatabaseSync(path);
    sqlite.exec(`
      CREATE TABLE __wowdb_tables (table_name TEXT, build TEXT, locale TEXT, completed_at TEXT);
      CREATE TABLE JournalTier (ID INTEGER, Name_lang TEXT);
      CREATE TABLE JournalTierXInstance (JournalTierID INTEGER, JournalInstanceID INTEGER, OrderIndex INTEGER, AvailabilityCondition INTEGER);
      CREATE TABLE JournalInstance (ID INTEGER, Name_lang TEXT, MapID INTEGER);
      CREATE TABLE "Map" (ID INTEGER, InstanceType INTEGER, ExpansionID INTEGER);
      CREATE TABLE JournalEncounter (ID INTEGER, Name_lang TEXT, JournalInstanceID INTEGER, OrderIndex INTEGER);
      CREATE TABLE JournalEncounterItem (ID INTEGER, JournalEncounterID INTEGER, ItemID INTEGER);
      CREATE TABLE ItemSparse (ID INTEGER, Display_lang TEXT, ItemLevel INTEGER, InventoryType INTEGER, OverallQualityID INTEGER, StatModifier_bonusStat TEXT, StatPercentEditor TEXT, StatPercentageOfSocket TEXT, AllowableClass INTEGER);
      CREATE TABLE Item (ID INTEGER, ClassID INTEGER, SubclassID INTEGER, IconFileDataID INTEGER);
      CREATE TABLE ItemModifiedAppearance (ID INTEGER, ItemID INTEGER, ItemAppearanceModifierID INTEGER, ItemAppearanceID INTEGER, OrderIndex INTEGER);
      CREATE TABLE ItemAppearance (ID INTEGER, DefaultIconFileDataID INTEGER);
      CREATE TABLE ItemSubClass (ClassID INTEGER, SubClassID INTEGER, DisplayName_lang TEXT, VerboseName_lang TEXT);
      CREATE TABLE ChrClasses (ID INTEGER, ArmorTypeMask INTEGER);
      CREATE TABLE SkillRaceClassInfo (ID INTEGER, SkillID INTEGER, ClassMask INTEGER, Availability INTEGER);
      CREATE TABLE SkillLineAbility (SkillLine INTEGER, ClassMask INTEGER);
      INSERT INTO __wowdb_tables VALUES ('ItemSparse', '12.1.0.69283', 'zhCN', '2026-08-18');
      INSERT INTO JournalTier VALUES (505, '本赛季');
      INSERT INTO JournalTierXInstance VALUES (505, 1320, 1, 156363), (505, 2000, 2, 156363);
      INSERT INTO JournalInstance VALUES (1320, '烈毒之渊', 3004), (2000, '测试秘境', 4000);
      INSERT INTO "Map" VALUES (3004, 2, 11), (4000, 1, 11);
      INSERT INTO JournalEncounter VALUES (2888, '盘魂者内克扎莉', 1320, 1);
      INSERT INTO JournalEncounter VALUES (3000, '秘境首领', 2000, 1);
      INSERT INTO JournalEncounterItem VALUES (47063, 2888, 270162);
      INSERT INTO JournalEncounterItem VALUES (47064, 2888, 268203);
      INSERT INTO JournalEncounterItem VALUES (48000, 3000, 270162);
      INSERT INTO ItemSparse VALUES (270162, '盘魂者仪式容器', 219, 12, 4, '[5,-1,-1,-1]', '[10000,0,0,0]', '[0,0,0,0]', -1);
      INSERT INTO ItemSparse VALUES (268203, '咒魇裂魂匕首', 219, 13, 4, '[5,7,49,32]', '[5259,7889,3609,3391]', '[0,0,0,0]', -1);
      INSERT INTO Item VALUES (270162, 4, 0, 12345);
      INSERT INTO Item VALUES (268203, 2, 15, 0);
      INSERT INTO ItemModifiedAppearance VALUES (1, 268203, 0, 10, 0);
      INSERT INTO ItemAppearance VALUES (10, 54321);
      INSERT INTO ItemSubClass VALUES (2, 15, '匕首', '匕首');
      INSERT INTO ChrClasses VALUES (4, 37), (5, 35);
      INSERT INTO SkillRaceClassInfo VALUES (1, 173, 24029, 1);
      INSERT INTO SkillLineAbility VALUES (173, 24541);
    `);
    sqlite.close();

    const wowDb = new WowDbCatalog(path, "12.1", "12.1");
    const catalog = wowDb.getCatalog();
    expect(catalog).toMatchObject({
      connected: true,
      build: "12.1.0.69283",
      locale: "zhCN",
      raids: [{
        name: "烈毒之渊",
        bosses: [{
          name: "盘魂者内克扎莉",
          items: [
            { itemId: 270162, equipmentType: "trinket", isSpecialEffect: true, allowableClassMask: null },
            {
              itemId: 268203,
              equipmentType: "one_hand_weapon",
              isSpecialEffect: false,
              weaponType: "匕首",
              allowableClassMask: 24541,
            },
          ],
        }],
      }],
    });
    expect(wowDb.getItemIconFileDataId(270162)).toBe(12345);
    expect(wowDb.getItemIconFileDataId(268203)).toBe(54321);
    expect(wowDb.getItemIconFileDataId(999999)).toBeNull();
    expect(wowDb.getMythicPlusCatalog()).toMatchObject({
      connected: true,
      dungeons: [{
        name: "测试秘境",
        bosses: [{ name: "秘境首领", items: [{ itemId: 270162 }] }],
      }],
    });
    wowDb.close();
  });

  it("restricts armor to each class primary armor type", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wow-db-armor-"));
    cleanupPaths.push(directory);
    const path = join(directory, "wow.sqlite");
    const sqlite = new DatabaseSync(path);
    sqlite.exec(`
      CREATE TABLE __wowdb_tables (table_name TEXT, build TEXT, locale TEXT, completed_at TEXT);
      CREATE TABLE JournalTier (ID INTEGER, Name_lang TEXT);
      CREATE TABLE JournalTierXInstance (JournalTierID INTEGER, JournalInstanceID INTEGER, OrderIndex INTEGER);
      CREATE TABLE JournalInstance (ID INTEGER, Name_lang TEXT, MapID INTEGER);
      CREATE TABLE "Map" (ID INTEGER, InstanceType INTEGER, ExpansionID INTEGER);
      CREATE TABLE JournalEncounter (ID INTEGER, Name_lang TEXT, JournalInstanceID INTEGER, OrderIndex INTEGER);
      CREATE TABLE JournalEncounterItem (ID INTEGER, JournalEncounterID INTEGER, ItemID INTEGER);
      CREATE TABLE ItemSparse (ID INTEGER, Display_lang TEXT, ItemLevel INTEGER, InventoryType INTEGER, OverallQualityID INTEGER, StatModifier_bonusStat TEXT, StatPercentEditor TEXT, StatPercentageOfSocket TEXT, AllowableClass INTEGER);
      CREATE TABLE Item (ID INTEGER, ClassID INTEGER, SubclassID INTEGER, IconFileDataID INTEGER);
      CREATE TABLE ItemSubClass (ClassID INTEGER, SubClassID INTEGER, DisplayName_lang TEXT, VerboseName_lang TEXT);
      CREATE TABLE ChrClasses (ID INTEGER, ArmorTypeMask INTEGER);
      INSERT INTO __wowdb_tables VALUES ('ItemSparse', '12.1.0.69283', 'zhCN', '2026-08-18');
      INSERT INTO JournalTier VALUES (505, '本赛季');
      INSERT INTO JournalTierXInstance VALUES (505, 1320, 1);
      INSERT INTO JournalInstance VALUES (1320, '烈毒之渊', 3004);
      INSERT INTO "Map" VALUES (3004, 2, 11);
      INSERT INTO JournalEncounter VALUES (2888, '盘魂者内克扎莉', 1320, 1);
      INSERT INTO JournalEncounterItem VALUES (47063, 2888, 250456);
      INSERT INTO ItemSparse VALUES (250456, '枯法学者的鎏金长袍', 197, 20, 4, '[5]', '[10000]', '[0]', -1);
      INSERT INTO Item VALUES (250456, 4, 1, 12345);
      INSERT INTO ItemSubClass VALUES (4, 1, '布甲', '布甲');
      INSERT INTO ChrClasses VALUES (1, 113), (4, 37), (5, 35), (8, 35), (9, 35);
    `);
    sqlite.close();

    const item = new WowDbCatalog(path, "12.1", "12.1").getCatalog().raids[0]?.bosses[0]?.items[0];
    expect(item).toMatchObject({
      armorType: "布甲",
      weaponType: null,
      allowableClassMask: (1 << 4) | (1 << 7) | (1 << 8),
    });
  });

  it("calculates fully upgraded raid item levels and stats from local game data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wow-db-calculation-"));
    cleanupPaths.push(directory);
    const path = join(directory, "wow.sqlite");
    const sqlite = new DatabaseSync(path);
    sqlite.exec(`
      CREATE TABLE __wowdb_tables (table_name TEXT, build TEXT, locale TEXT, completed_at TEXT);
      CREATE TABLE JournalTier (ID INTEGER, Name_lang TEXT);
      CREATE TABLE JournalTierXInstance (JournalTierID INTEGER, JournalInstanceID INTEGER, OrderIndex INTEGER, AvailabilityCondition INTEGER);
      CREATE TABLE JournalInstance (ID INTEGER, Name_lang TEXT, MapID INTEGER);
      CREATE TABLE "Map" (ID INTEGER, InstanceType INTEGER, ExpansionID INTEGER);
      CREATE TABLE JournalEncounter (ID INTEGER, Name_lang TEXT, JournalInstanceID INTEGER, OrderIndex INTEGER);
      CREATE TABLE JournalEncounterItem (ID INTEGER, JournalEncounterID INTEGER, ItemID INTEGER);
      CREATE TABLE ItemSparse (ID INTEGER, Display_lang TEXT, ItemLevel INTEGER, InventoryType INTEGER, OverallQualityID INTEGER, StatModifier_bonusStat TEXT, StatPercentEditor TEXT, StatPercentageOfSocket TEXT);
      CREATE TABLE Item (ID INTEGER, SubclassID INTEGER, IconFileDataID INTEGER);
      CREATE TABLE ItemBonus (ParentItemBonusListID INTEGER, Type INTEGER, Value TEXT, OrderIndex INTEGER);
      CREATE TABLE ItemScalingConfig (ID INTEGER, ItemLevel INTEGER);
      CREATE TABLE RandPropPoints (ID INTEGER, EpicF TEXT, SuperiorF TEXT, GoodF TEXT);
      CREATE TABLE CombatRatingsMultByILvl (ID INTEGER, ArmorMultiplier REAL, WeaponMultiplier REAL, TrinketMultiplier REAL, JewelryMultiplier REAL);
      CREATE TABLE StaminaMultByILvl (ID INTEGER, ArmorMultiplier REAL, WeaponMultiplier REAL, TrinketMultiplier REAL, JewelryMultiplier REAL);
      CREATE TABLE ItemSocketCostPerLevel (ID INTEGER, SocketCost REAL);
      CREATE TABLE ItemXBonusTree (ItemBonusTreeID INTEGER, ItemID INTEGER);
      CREATE TABLE ItemBonusTreeNode (ID INTEGER, ItemContext INTEGER, ChildItemBonusTreeID INTEGER, ChildItemBonusListGroupID INTEGER, IblGroupPointsModSetID INTEGER, ParentItemBonusTreeID INTEGER);
      CREATE TABLE ItemBonusListGroupEntry (ID INTEGER, ItemBonusListGroupID INTEGER, ItemBonusListID INTEGER, SequenceValue INTEGER);

      INSERT INTO __wowdb_tables VALUES ('ItemSparse', '12.1.0.69283', 'zhCN', '2026-08-18');
      INSERT INTO JournalTier VALUES (505, '本赛季');
      INSERT INTO JournalTierXInstance VALUES (505, 1320, 1, 156363);
      INSERT INTO JournalInstance VALUES (1320, '烈毒之渊', 3004);
      INSERT INTO "Map" VALUES (3004, 2, 11);
      INSERT INTO JournalEncounter VALUES (2888, '盘魂者内克扎莉', 1320, 1);
      INSERT INTO JournalEncounterItem VALUES (47063, 2888, 250456);
      INSERT INTO JournalEncounterItem VALUES (47064, 2888, 250447);
      INSERT INTO JournalEncounterItem VALUES (47065, 2888, 250458);
      INSERT INTO ItemSparse VALUES (250456, '枯法学者的鎏金长袍', 197, 20, 4, '[5,7,36,32,-1]', '[5259,7889,3609,3391,0]', '[0,0,0,0,0]');
      INSERT INTO ItemSparse VALUES (250447, '光耀永歌权杖', 197, 23, 4, '[-1,7,36,40,-1,5]', '[0,7889,4046,2954,0,16132]', '[0,0,0,0,0,0]');
      INSERT INTO ItemSparse VALUES (250458, '后二史诗长袍', 197, 20, 4, '[5,7,36,32,-1]', '[5259,7889,3609,3391,0]', '[0,0,0,0,0]');
      INSERT INTO Item VALUES (250456, 1, 12345);
      INSERT INTO Item VALUES (250447, 0, 12346);
      INSERT INTO Item VALUES (250458, 1, 12347);

      INSERT INTO ItemBonus VALUES (12830, 49, '[311,0,0,0]', 0);
      INSERT INTO ItemBonus VALUES (12838, 49, '[315,0,0,0]', 0);
      INSERT INTO ItemBonus VALUES (12846, 49, '[319,0,0,0]', 0);
      INSERT INTO ItemBonus VALUES (12854, 49, '[323,0,0,0]', 0);
      INSERT INTO ItemBonus VALUES (13848, 49, '[453,0,0,0]', 0);
      INSERT INTO ItemScalingConfig VALUES (311, 295), (315, 308), (319, 321), (323, 334), (453, 344);
      INSERT INTO ItemXBonusTree VALUES (6108, 250458);
      INSERT INTO ItemBonusTreeNode VALUES (29724, 0, 6109, 0, 0, 6108);
      INSERT INTO ItemBonusTreeNode VALUES (29728, 6, 0, 618, 2970, 6109);
      INSERT INTO ItemBonusListGroupEntry VALUES (4451, 618, 12854, 6);
      INSERT INTO ItemBonusListGroupEntry VALUES (5499, 618, 13848, 9);
      INSERT INTO RandPropPoints VALUES
        (295, '[249.31483,186.98611,140.2396,124.65742,124.65742]', '[]', '[]'),
        (308, '[281.41867,211.064,158.298,140.70934,140.70934]', '[]', '[]'),
        (321, '[317.65646,238.24236,178.68176,158.82823,158.82823]', '[]', '[]'),
        (334, '[358.56055,268.9204,201.6903,179.28027,179.28027]', '[]', '[]'),
        (344, '[393.9304,295.4478,221.58585,196.9652,196.9652]', '[]', '[]');
      INSERT INTO CombatRatingsMultByILvl VALUES
        (295, .97043908, .97043908, .97043908, 1.290158162),
        (308, .913097959, .913097959, .913097959, 1.24970913),
        (321, .856210407, .856210407, .856210407, 1.201698816),
        (334, .800419171, .800419171, .800419171, 1.148378783),
        (344, .758561541, .758561541, .758561541, 1.109);
      INSERT INTO StaminaMultByILvl VALUES
        (295, 12.67030326, 12.67030326, 12.67030326, 12.67030326),
        (308, 13.04264226, 13.04264226, 13.04264226, 13.04264226),
        (321, 13.44269711, 13.44269711, 13.44269711, 13.44269711),
        (334, 13.82240869, 13.82240869, 13.82240869, 13.82240869),
        (344, 14.12120732, 14.12120732, 14.12120732, 14.12120732);
      INSERT INTO ItemSocketCostPerLevel VALUES (295, 8), (308, 8), (321, 8), (334, 8), (344, 8);
    `);
    sqlite.close();

    const items = new WowDbCatalog(path, "12.1", "12.1").getCatalog().raids[0]?.bosses[0]?.items || [];
    expect(items.find((item) => item.itemId === 250456)).toMatchObject({
      itemLevels: { lfr: 295, normal: 308, heroic: 321, mythic: 334 },
      itemLevelSource: "difficulty-data",
      statValuesByDifficulty: {
        heroic: { "智力": 167, "耐力": 3369, "急速": 98, "暴击": 92 },
      },
    });
    expect(items.find((item) => item.itemId === 250447)?.statValuesByDifficulty.heroic).toEqual({
      "耐力": 1684,
      "急速": 55,
      "全能": 40,
      "智力": 256,
    });
    expect(items.find((item) => item.itemId === 250458)).toMatchObject({
      itemLevels: { lfr: 295, normal: 308, heroic: 321, mythic: 344 },
      fullyUpgradedBonusLists: { lfr: 12830, normal: 12838, heroic: 12846, mythic: 13848 },
      statValuesByDifficulty: { mythic: { "智力": expect.any(Number), "耐力": expect.any(Number) } },
    });
  });
});

function characterEquipment(items: EquippedItem[]): CharacterEquipmentCache {
  return {
    schemaVersion: 1,
    season: "12.1",
    gameVersion: "12.1",
    player: {
      id: "player-1", name: "测试角色", realm: "测试服", realmSlug: "test",
      className: "唤魔师", specialization: "湮灭",
    },
    source: { provider: "blizzard-cn-armory", fetchedAt: "2026-08-18T12:00:00.000Z" },
    level: 90,
    averageItemLevel: 300,
    equippedItemLevel: 300,
    items,
  };
}

function tierItem(itemId: number, slotType: string, setName: string): EquippedItem {
  return {
    itemId,
    name: `物品 ${itemId}`,
    itemLevel: 300,
    slotType,
    slotName: slotType,
    inventoryType: slotType,
    quality: "EPIC",
    bonusList: [],
    enchantments: [],
    sockets: [],
    set: setName ? { name: setName, displayString: `${setName}（2/5）`, effects: [] } : null,
    iconUrl: null,
  };
}
