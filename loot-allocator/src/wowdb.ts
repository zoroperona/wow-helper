import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  LootBossReference,
  LootCatalog,
  LootItemReference,
  MythicPlusCatalog,
  MythicPlusDungeonReference,
  LootRaidReference,
  LootDifficulty,
  SpellReference,
  CharacterEquipmentCache,
  TierSetSummary,
} from "./types.js";

interface WowDbRow {
  [key: string]: string | number | null;
}

export const fullyUpgradedBonusByDifficulty: Record<LootDifficulty, number> = {
  lfr: 12830,
  normal: 12838,
  heroic: 12846,
  mythic: 12854,
};

interface ItemCalculationContext {
  itemLevels: Record<LootDifficulty, number>;
  fullyUpgradedBonusLists: Record<LootDifficulty, number>;
  statValuesByDifficulty: Record<LootDifficulty, Record<string, number>>;
  complete: boolean;
}

// wow-db currently exports the modifier-set ID but not its definition table.
// Set 2970 is the 12.1 late-raid Mythic track whose highest unlocked rank is 9/9.
const maximumRankByIblGroupPointsModSetId = new Map([[2970, 9]]);

export class WowDbCatalog {
  private sqlite: DatabaseSync | null = null;
  private catalog: LootCatalog | null = null;
  private currentTierSets: CurrentTierSetIndex | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly season: string,
    private readonly gameVersion: string,
  ) {}

  getCatalog(forceReload = false): LootCatalog {
    if (this.catalog && !forceReload) {
      return this.catalog;
    }
    if (!existsSync(this.databasePath)) {
      this.close();
      return (this.catalog = emptyCatalog(this.databasePath, this.season, this.gameVersion));
    }

    this.open();
    const sqlite = this.sqlite!;
    const metadata = sqlite
      .prepare(
        `SELECT build, locale
           FROM __wowdb_tables
          ORDER BY completed_at DESC
          LIMIT 1`,
      )
      .get() as unknown as WowDbRow | undefined;
    const build = textValue(metadata?.build);
    const locale = textValue(metadata?.locale);
    const raids = this.loadRaids(sqlite);
    return (this.catalog = {
      source: "wow-db",
      connected: true,
      databasePath: this.databasePath,
      season: this.season,
      gameVersion: this.gameVersion,
      build,
      locale,
      raids,
    });
  }

  getMythicPlusCatalog(): MythicPlusCatalog {
    if (!existsSync(this.databasePath)) {
      return emptyMythicPlusCatalog(this.databasePath, this.season, this.gameVersion);
    }
    this.open();
    const sqlite = this.sqlite!;
    const metadata = sqlite
      .prepare(
        `SELECT build, locale
           FROM __wowdb_tables
          ORDER BY completed_at DESC
          LIMIT 1`,
      )
      .get() as unknown as WowDbRow | undefined;
    return {
      source: "wow-db",
      connected: true,
      databasePath: this.databasePath,
      season: this.season,
      gameVersion: this.gameVersion,
      build: textValue(metadata?.build),
      locale: textValue(metadata?.locale),
      dungeons: this.loadMythicPlusDungeons(sqlite),
    };
  }

  getSpellReferences(spellIds: number[]): Map<number, SpellReference> {
    const references = new Map<number, SpellReference>();
    const ids = [...new Set(spellIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length || !existsSync(this.databasePath)) return references;

    this.open();
    const sqlite = this.sqlite!;
    if (!hasTable(sqlite, "SpellName") || !hasTable(sqlite, "SpellMisc")) return references;
    for (let offset = 0; offset < ids.length; offset += 400) {
      const chunk = ids.slice(offset, offset + 400);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = sqlite.prepare(
        `SELECT sn.ID AS spell_id,
                sn.Name_lang AS spell_name,
                COALESCE((
                  SELECT sm.SpellIconFileDataID
                    FROM SpellMisc sm
                   WHERE sm.SpellID = sn.ID
                     AND sm.SpellIconFileDataID > 0
                ORDER BY CASE WHEN sm.DifficultyID = 0 THEN 0 ELSE 1 END, sm.ID
                   LIMIT 1
                ), 0) AS icon_file_data_id
           FROM SpellName sn
          WHERE sn.ID IN (${placeholders})`,
      ).all(...chunk) as unknown as WowDbRow[];
      for (const row of rows) {
        const id = numberValue(row.spell_id);
        const name = textValue(row.spell_name);
        const iconFileDataId = numberValue(row.icon_file_data_id) || null;
        if (!id || !name) continue;
        references.set(id, {
          id,
          name,
          iconFileDataId,
          iconUrl: iconFileDataId ? iconUrlFromFileDataId(iconFileDataId) : null,
        });
      }
    }
    return references;
  }

  getItemIconFileDataId(itemId: number): number | null {
    if (!Number.isInteger(itemId) || itemId <= 0 || !existsSync(this.databasePath)) return null;
    this.open();
    const sqlite = this.sqlite!;
    if (hasTable(sqlite, "Item") && hasColumn(sqlite, "Item", "IconFileDataID")) {
      const row = sqlite
        .prepare(
          `SELECT IconFileDataID AS icon_file_data_id
             FROM Item
            WHERE ID = ? AND IconFileDataID > 0
         ORDER BY IconFileDataID DESC
            LIMIT 1`,
        )
        .get(itemId) as unknown as WowDbRow | undefined;
      const directIcon = numberValue(row?.icon_file_data_id);
      if (directIcon) return directIcon;
    }
    if (!hasTable(sqlite, "ItemModifiedAppearance") || !hasTable(sqlite, "ItemAppearance")) {
      return null;
    }
    const appearance = sqlite
      .prepare(
        `SELECT appearance.DefaultIconFileDataID AS icon_file_data_id
           FROM ItemModifiedAppearance modified
           JOIN ItemAppearance appearance ON appearance.ID = modified.ItemAppearanceID
          WHERE modified.ItemID = ?
            AND appearance.DefaultIconFileDataID > 0
       ORDER BY CASE WHEN modified.ItemAppearanceModifierID = 0 THEN 0 ELSE 1 END,
                modified.OrderIndex,
                modified.ID
          LIMIT 1`,
      )
      .get(itemId) as unknown as WowDbRow | undefined;
    return numberValue(appearance?.icon_file_data_id) || null;
  }

  getCurrentTierSetSummary(equipment: CharacterEquipmentCache | null): TierSetSummary | null {
    if (!equipment?.items.length) return null;
    const index = this.getCurrentTierSetIndex();
    if (!index.names.size || !index.itemSets.size) return null;

    const slots = { head: false, shoulder: false, chest: false, hands: false, legs: false };
    const slotKeys = new Map<string, keyof TierSetSummary["slots"]>([
      ["HEAD", "head"], ["SHOULDER", "shoulder"], ["CHEST", "chest"],
      ["HANDS", "hands"], ["LEGS", "legs"],
    ]);
    let name: string | null = null;
    let effects: TierSetSummary["effects"] = [];
    for (const item of equipment.items) {
      const slot = slotKeys.get(item.slotType);
      if (!slot) continue;
      const setName = item.set?.name || null;
      const itemSetName = index.itemSets.get(item.itemId) || null;
      const current = Boolean((setName && index.names.has(setName)) || itemSetName);
      if (!current) continue;
      slots[slot] = true;
      name ||= setName || itemSetName;
      if (!effects.length && item.set?.effects.length) effects = item.set.effects;
    }
    return {
      name,
      equipped: Object.values(slots).filter(Boolean).length,
      total: 5,
      slots,
      effects,
      fetchedAt: equipment.source.fetchedAt,
    };
  }

  close(): void {
    this.sqlite?.close();
    this.sqlite = null;
    this.catalog = null;
    this.currentTierSets = null;
  }

  private getCurrentTierSetIndex(): CurrentTierSetIndex {
    if (this.currentTierSets) return this.currentTierSets;
    const empty = { names: new Set<string>(), itemSets: new Map<number, string>() };
    if (!existsSync(this.databasePath)) return (this.currentTierSets = empty);
    this.open();
    const sqlite = this.sqlite!;
    if (!["ItemSet", "ItemSetSpell", "SpellName"].every((table) => hasTable(sqlite, table))) {
      return (this.currentTierSets = empty);
    }
    const rows = sqlite.prepare(
      `SELECT DISTINCT sets.ID AS set_id, sets.Name_lang AS set_name, sets.ItemID AS item_ids
         FROM ItemSet sets
         JOIN ItemSetSpell spells ON spells.ItemSetID = sets.ID
         JOIN SpellName names ON names.ID = spells.SpellID
        WHERE spells.Threshold IN (2, 4)
          AND names.Name_lang LIKE ?`,
    ).all(`%${this.gameVersion}%Class Set%`) as unknown as WowDbRow[];
    for (const row of rows) {
      const name = textValue(row.set_name);
      if (!name) continue;
      empty.names.add(name);
      for (const itemId of parseNumberArray(row.item_ids)) {
        if (itemId > 0) empty.itemSets.set(itemId, name);
      }
    }
    return (this.currentTierSets = empty);
  }

  private open(): void {
    if (!this.sqlite) {
      this.sqlite = new DatabaseSync(this.databasePath, { readOnly: true });
    }
  }

  private loadRaids(sqlite: DatabaseSync): LootRaidReference[] {
    const tier = sqlite
      .prepare(
        `SELECT ID
           FROM JournalTier
          WHERE Name_lang = '本赛季'
          ORDER BY ID DESC
          LIMIT 1`,
      )
      .get() as unknown as WowDbRow | undefined;
    const tierId = numberValue(tier?.ID);
    if (!tierId) {
      return [];
    }

    const raidRows = sqlite
      .prepare(
        `SELECT ji.ID AS raid_id,
                ji.Name_lang AS raid_name,
                ji.MapID AS map_id,
                jti.OrderIndex AS raid_order,
                ${hasColumn(sqlite, "JournalTierXInstance", "AvailabilityCondition") ? "jti.AvailabilityCondition" : "0"} AS availability_condition
           FROM JournalTierXInstance jti
           JOIN JournalInstance ji ON ji.ID = jti.JournalInstanceID
           JOIN "Map" map ON map.ID = ji.MapID
          WHERE jti.JournalTierID = ?
            AND map.InstanceType = 2
            AND map.ExpansionID = (
              SELECT MAX(ExpansionID) FROM "Map" WHERE InstanceType = 2
            )
       ORDER BY jti.OrderIndex, ji.ID`,
      )
      .all(tierId) as unknown as WowDbRow[];

    const currentAvailabilityCondition = Math.max(
      ...raidRows.map((raid) => numberValue(raid.availability_condition)),
    );
    return raidRows.map((raid) => {
      const raidId = numberValue(raid.raid_id);
      const availabilityCondition = numberValue(raid.availability_condition);
      const bosses = sqlite
        .prepare(
          `SELECT ID, Name_lang, OrderIndex
             FROM JournalEncounter
            WHERE JournalInstanceID = ?
         ORDER BY OrderIndex, ID`,
        )
        .all(raidId) as unknown as WowDbRow[];
      return {
        id: raidId,
        name: textValue(raid.raid_name) || `副本 ${raidId}`,
        mapId: numberValue(raid.map_id),
        order: numberValue(raid.raid_order),
        contentVersion: availabilityCondition === currentAvailabilityCondition ? "12.1" : "12.0",
        isCurrent: availabilityCondition === currentAvailabilityCondition,
        availabilityCondition,
        bosses: bosses.map((boss) => this.loadBoss(sqlite, boss)),
      };
    });
  }

  private loadMythicPlusDungeons(sqlite: DatabaseSync): MythicPlusDungeonReference[] {
    const tier = sqlite
      .prepare(
        `SELECT ID
           FROM JournalTier
          WHERE Name_lang = '本赛季'
          ORDER BY ID DESC
          LIMIT 1`,
      )
      .get() as unknown as WowDbRow | undefined;
    const tierId = numberValue(tier?.ID);
    if (!tierId) return [];

    const rows = sqlite
      .prepare(
        `SELECT ji.ID AS dungeon_id,
                ji.Name_lang AS dungeon_name,
                ji.MapID AS map_id,
                jti.OrderIndex AS dungeon_order,
                jti.AvailabilityCondition AS availability_condition
           FROM JournalTierXInstance jti
           JOIN JournalInstance ji ON ji.ID = jti.JournalInstanceID
           JOIN "Map" map ON map.ID = ji.MapID
          WHERE jti.JournalTierID = ?
            AND map.InstanceType = 1
            AND EXISTS (
              SELECT 1
                FROM JournalEncounter encounter
                JOIN JournalEncounterItem item
                  ON item.JournalEncounterID = encounter.ID
               WHERE encounter.JournalInstanceID = ji.ID
            )
            AND jti.AvailabilityCondition = (
              SELECT MAX(candidate.AvailabilityCondition)
                FROM JournalTierXInstance candidate
                JOIN JournalInstance candidate_instance
                  ON candidate_instance.ID = candidate.JournalInstanceID
                JOIN "Map" candidate_map ON candidate_map.ID = candidate_instance.MapID
               WHERE candidate.JournalTierID = jti.JournalTierID
                 AND candidate_map.InstanceType = 1
            )
       ORDER BY jti.OrderIndex, ji.ID`,
      )
      .all(tierId) as unknown as WowDbRow[];
    return rows.map((row) => {
      const dungeonId = numberValue(row.dungeon_id);
      const bosses = sqlite
        .prepare(
          `SELECT ID, Name_lang, OrderIndex
             FROM JournalEncounter
            WHERE JournalInstanceID = ?
         ORDER BY OrderIndex, ID`,
        )
        .all(dungeonId) as unknown as WowDbRow[];
      return {
        id: dungeonId,
        name: textValue(row.dungeon_name) || `地下城 ${dungeonId}`,
        mapId: numberValue(row.map_id),
        order: numberValue(row.dungeon_order),
        bosses: bosses.map((boss) => this.loadBoss(sqlite, boss, 3)),
      };
    });
  }

  private loadBoss(
    sqlite: DatabaseSync,
    boss: WowDbRow,
    minimumQuality = 4,
  ): LootBossReference {
    const bossId = numberValue(boss.ID);
    const itemRows = sqlite
      .prepare(
        `SELECT jei.ItemID AS item_id,
                COALESCE(NULLIF(isp.Display_lang, ''), '物品 ' || jei.ItemID) AS item_name,
                isp.ItemLevel AS item_level,
                isp.InventoryType AS inventory_type,
                isp.OverallQualityID AS quality,
                isp.StatModifier_bonusStat AS stat_types,
                isp.StatPercentEditor AS stat_percentages,
                isp.StatPercentageOfSocket AS socket_percentages,
                ${optionalColumn(sqlite, "ItemSparse", "AllowableClass", "allowable_class")},
                ${optionalColumn(sqlite, "Item", "ClassID", "item_class")},
                item.SubclassID AS item_subclass,
                item.IconFileDataID AS icon_file_data_id,
                ${optionalColumn(sqlite, "ItemSparse", "Description_lang", "description")},
                ${optionalColumn(sqlite, "ItemSparse", "Display1_lang", "display_1")},
                ${optionalColumn(sqlite, "ItemSparse", "Display2_lang", "display_2")},
                ${optionalColumn(sqlite, "ItemSparse", "Display3_lang", "display_3")}
           FROM JournalEncounterItem jei
           LEFT JOIN ItemSparse isp ON isp.ID = jei.ItemID
           LEFT JOIN Item item ON item.ID = jei.ItemID
          WHERE jei.JournalEncounterID = ?
            AND COALESCE(isp.ItemLevel, 0) > 1
            AND COALESCE(isp.OverallQualityID, 0) >= ?
       ORDER BY jei.ID`,
      )
      .all(bossId, minimumQuality) as unknown as WowDbRow[];
    const seen = new Set<number>();
    const items = itemRows
      .map((item) => normalizeLootItem(sqlite, item))
      .filter((item): item is LootItemReference => {
        if (!item || seen.has(item.itemId)) return false;
        seen.add(item.itemId);
        return true;
      });
    return {
      id: bossId,
      name: textValue(boss.Name_lang) || `Boss ${bossId}`,
      order: numberValue(boss.OrderIndex),
      items,
    };
  }
}

interface CurrentTierSetIndex {
  names: Set<string>;
  itemSets: Map<number, string>;
}

function normalizeLootItem(sqlite: DatabaseSync, row: WowDbRow): LootItemReference | null {
  const itemId = numberValue(row.item_id);
  const inventoryType = numberValue(row.inventory_type);
  if (!itemId || !inventoryType) {
    return null;
  }
  const equipment = inventoryTypeToEquipment(inventoryType);
  const itemClass = numberValue(row.item_class);
  const itemSubclass = numberValue(row.item_subclass);
  const compatibility = resolveItemCompatibility(
    sqlite,
    itemClass,
    itemSubclass,
    inventoryType,
    numberValue(row.allowable_class),
  );
  const baseItemLevel = numberValue(row.item_level);
  const calculation = calculateItem(sqlite, row, baseItemLevel, inventoryType);
  return {
    itemId,
    name: textValue(row.item_name) || `物品 ${itemId}`,
    itemLevel: baseItemLevel,
    baseItemLevel,
    itemLevels: calculation.itemLevels,
    fullyUpgradedBonusLists: calculation.fullyUpgradedBonusLists,
    itemLevelSource: calculation.complete ? "difficulty-data" : "db2-base",
    inventoryType,
    slotName: equipment.slotName,
    equipmentType: equipment.ruleKey,
    armorType: compatibility.armorType,
    weaponType: compatibility.weaponType,
    allowableClassMask: compatibility.allowableClassMask,
    quality: numberValue(row.quality),
    isSpecialEffect: inventoryType === 12,
    iconFileDataId: numberValue(row.icon_file_data_id) || null,
    iconUrl: iconUrlFromFileDataId(numberValue(row.icon_file_data_id)),
    statTypes: parseStatTypes(row.stat_types),
    statValues: calculation.statValuesByDifficulty.heroic,
    statValuesByDifficulty: calculation.statValuesByDifficulty,
    description: textValue(row.description),
    tooltipLines: [row.display_1, row.display_2, row.display_3]
      .map(textValue)
      .filter(Boolean),
  };
}

const armorInventoryTypes = new Set([1, 3, 5, 6, 7, 8, 9, 10, 20]);
const weaponSkillBySubclass: Record<number, number> = {
  0: 44,
  1: 172,
  2: 45,
  3: 46,
  4: 54,
  5: 160,
  6: 229,
  7: 43,
  8: 55,
  9: 2152,
  10: 136,
  13: 473,
  15: 173,
  18: 226,
  19: 228,
};

function resolveItemCompatibility(
  sqlite: DatabaseSync,
  itemClass: number,
  itemSubclass: number,
  inventoryType: number,
  explicitClassMask: number,
): { armorType: string | null; weaponType: string | null; allowableClassMask: number | null } {
  let armorType: string | null = null;
  let weaponType: string | null = null;
  let databaseClassMask: number | null = null;

  if (itemClass === 4 && armorInventoryTypes.has(inventoryType) && itemSubclass >= 1 && itemSubclass <= 4) {
    armorType = itemSubclassName(sqlite, itemClass, itemSubclass);
    if (hasTable(sqlite, "ChrClasses") && hasColumn(sqlite, "ChrClasses", "ArmorTypeMask")) {
      const rows = sqlite
        .prepare("SELECT ID, ArmorTypeMask FROM ChrClasses WHERE ID BETWEEN 1 AND 31")
        .all() as unknown as WowDbRow[];
      databaseClassMask = rows.reduce((mask, row) => {
        const armorMask = numberValue(row.ArmorTypeMask);
        const primaryArmorSubclass = [4, 3, 2, 1].find((subclass) => (
          (armorMask & (1 << subclass)) !== 0
        ));
        return primaryArmorSubclass === itemSubclass
          ? mask | classBit(numberValue(row.ID))
          : mask;
      }, 0);
    }
  } else if (itemClass === 4 && itemSubclass === 6 && inventoryType === 14) {
    if (hasTable(sqlite, "ChrClasses") && hasColumn(sqlite, "ChrClasses", "ArmorTypeMask")) {
      const rows = sqlite
        .prepare("SELECT ID FROM ChrClasses WHERE ID BETWEEN 1 AND 31 AND (ArmorTypeMask & ?) <> 0")
        .all(1 << itemSubclass) as unknown as WowDbRow[];
      databaseClassMask = rows.reduce((mask, row) => mask | classBit(numberValue(row.ID)), 0);
    }
  } else if (itemClass === 2) {
    weaponType = itemSubclassName(sqlite, itemClass, itemSubclass);
    const skillId = weaponSkillBySubclass[itemSubclass];
    databaseClassMask = skillId ? weaponClassMask(sqlite, skillId) : null;
  }

  const itemClassMask = explicitClassMask > 0 ? explicitClassMask : null;
  const allowableClassMask = databaseClassMask && itemClassMask
    ? databaseClassMask & itemClassMask
    : databaseClassMask || itemClassMask;
  return { armorType, weaponType, allowableClassMask };
}

function weaponClassMask(sqlite: DatabaseSync, skillId: number): number | null {
  if (hasTable(sqlite, "SkillLineAbility")) {
    const rows = sqlite
      .prepare("SELECT ClassMask FROM SkillLineAbility WHERE SkillLine = ? AND ClassMask > 0")
      .all(skillId) as unknown as WowDbRow[];
    const mask = rows.reduce((combined, row) => combined | numberValue(row.ClassMask), 0);
    if (mask) return mask;
  }
  if (hasTable(sqlite, "SkillRaceClassInfo")) {
    const rows = sqlite
      .prepare("SELECT ClassMask FROM SkillRaceClassInfo WHERE SkillID = ? AND Availability = 1")
      .all(skillId) as unknown as WowDbRow[];
    const mask = rows.reduce((combined, row) => combined | numberValue(row.ClassMask), 0);
    if (mask) return mask;
  }
  return null;
}

function itemSubclassName(sqlite: DatabaseSync, itemClass: number, itemSubclass: number): string | null {
  if (!hasTable(sqlite, "ItemSubClass")) return null;
  const row = sqlite
    .prepare(
      `SELECT COALESCE(NULLIF(VerboseName_lang, ''), DisplayName_lang) AS name
         FROM ItemSubClass
        WHERE ClassID = ? AND SubClassID = ?
        LIMIT 1`,
    )
    .get(itemClass, itemSubclass) as unknown as WowDbRow | undefined;
  return textValue(row?.name) || null;
}

function classBit(classId: number): number {
  return classId > 0 && classId <= 31 ? 1 << (classId - 1) : 0;
}

function iconUrlFromFileDataId(fileDataId: number): string | null {
  return fileDataId > 0
    ? `/api/loot/icon/file/${fileDataId}`
    : null;
}

function difficultyItemLevels(baseItemLevel: number): Record<LootDifficulty, number> {
  return {
    lfr: baseItemLevel,
    normal: baseItemLevel,
    heroic: baseItemLevel,
    mythic: baseItemLevel,
  };
}

function calculateItem(
  sqlite: DatabaseSync,
  row: WowDbRow,
  baseItemLevel: number,
  inventoryType: number,
): ItemCalculationContext {
  const emptyStats = emptyDifficultyStats();
  const requiredTables = [
    "ItemBonus",
    "ItemScalingConfig",
    "RandPropPoints",
    "CombatRatingsMultByILvl",
    "StaminaMultByILvl",
    "ItemSocketCostPerLevel",
  ];
  if (requiredTables.some((table) => !hasTable(sqlite, table))) {
    return {
      itemLevels: difficultyItemLevels(baseItemLevel),
      fullyUpgradedBonusLists: { ...fullyUpgradedBonusByDifficulty },
      statValuesByDifficulty: emptyStats,
      complete: false,
    };
  }

  const itemLevels = difficultyItemLevels(baseItemLevel);
  const fullyUpgradedBonusLists = resolveFullyUpgradedBonusLists(sqlite, numberValue(row.item_id));
  const statValuesByDifficulty = emptyDifficultyStats();
  const statTypes = parseNumberArray(row.stat_types);
  const statPercentages = parseNumberArray(row.stat_percentages);
  const socketPercentages = parseNumberArray(row.socket_percentages);
  let complete = true;

  for (const difficulty of Object.keys(fullyUpgradedBonusLists) as LootDifficulty[]) {
    const itemLevel = resolveItemLevel(sqlite, fullyUpgradedBonusLists[difficulty], baseItemLevel);
    if (!itemLevel) {
      complete = false;
      continue;
    }
    itemLevels[difficulty] = itemLevel;
    const points = randomPropertyPoints(
      sqlite,
      itemLevel,
      numberValue(row.quality),
      inventoryType,
      numberValue(row.item_subclass),
    );
    const ratingMultiplier = itemLevelMultiplier(sqlite, "CombatRatingsMultByILvl", itemLevel, inventoryType);
    const staminaMultiplier = itemLevelMultiplier(sqlite, "StaminaMultByILvl", itemLevel, inventoryType);
    const socketCost = numberValue(sqlite.prepare("SELECT SocketCost FROM ItemSocketCostPerLevel WHERE ID = ?").get(itemLevel)?.SocketCost);
    if (!points || !ratingMultiplier || !staminaMultiplier) {
      complete = false;
      continue;
    }

    const values: Record<string, number> = {};
    for (let index = 0; index < statTypes.length; index++) {
      const statType = statTypes[index] || 0;
      const labels = statLabels(statType);
      if (!labels.length) continue;
      let value = (statPercentages[index] || 0) * points * 0.0001;
      value -= (socketPercentages[index] || 0) * socketCost;
      if (statType === 7) value *= staminaMultiplier;
      else if (isCombatRating(statType)) value *= ratingMultiplier;
      const rounded = Math.round(value);
      for (const label of labels) values[label] = (values[label] || 0) + rounded;
    }
    statValuesByDifficulty[difficulty] = values;
  }

  return { itemLevels, fullyUpgradedBonusLists, statValuesByDifficulty, complete };
}

function resolveFullyUpgradedBonusLists(
  sqlite: DatabaseSync,
  itemId: number,
): Record<LootDifficulty, number> {
  const result = { ...fullyUpgradedBonusByDifficulty };
  const requiredTables = [
    "ItemXBonusTree",
    "ItemBonusTreeNode",
    "ItemBonusListGroupEntry",
  ];
  if (!itemId || requiredTables.some((table) => !hasTable(sqlite, table))) return result;

  const modifierRows = sqlite.prepare(
    `WITH RECURSIVE reachable(tree_id) AS (
       SELECT ItemBonusTreeID FROM ItemXBonusTree WHERE ItemID = ?
       UNION
       SELECT node.ChildItemBonusTreeID
         FROM ItemBonusTreeNode node
         JOIN reachable ON reachable.tree_id = node.ParentItemBonusTreeID
        WHERE node.ChildItemBonusTreeID > 0
     )
     SELECT node.IblGroupPointsModSetID AS modifier_set_id,
            node.ChildItemBonusListGroupID AS bonus_group_id
       FROM reachable
       JOIN ItemBonusTreeNode node ON node.ParentItemBonusTreeID = reachable.tree_id
      WHERE node.ItemContext = 6
        AND node.IblGroupPointsModSetID > 0
        AND node.ChildItemBonusListGroupID > 0`,
  ).all(itemId) as unknown as WowDbRow[];

  for (const row of modifierRows) {
    const maximumRank = maximumRankByIblGroupPointsModSetId.get(numberValue(row.modifier_set_id));
    if (!maximumRank) continue;
    const entry = sqlite.prepare(
      `SELECT ItemBonusListID
         FROM ItemBonusListGroupEntry
        WHERE ItemBonusListGroupID = ? AND SequenceValue = ?
     ORDER BY ID DESC
        LIMIT 1`,
    ).get(numberValue(row.bonus_group_id), maximumRank) as WowDbRow | undefined;
    const bonusListId = numberValue(entry?.ItemBonusListID);
    if (bonusListId) result.mythic = bonusListId;
  }
  return result;
}

function resolveItemLevel(sqlite: DatabaseSync, bonusListId: number, baseItemLevel: number): number {
  const bonuses = sqlite
    .prepare("SELECT Type, Value FROM ItemBonus WHERE ParentItemBonusListID = ? ORDER BY OrderIndex")
    .all(bonusListId) as unknown as WowDbRow[];
  let itemLevel = baseItemLevel;
  for (const bonus of bonuses) {
    const values = parseNumberArray(bonus.Value);
    switch (numberValue(bonus.Type)) {
      case 1:
        itemLevel += values[0] || 0;
        break;
      case 42:
        itemLevel = values[0] || itemLevel;
        break;
      case 49: {
        const scalingConfigId = values[0] || 0;
        const config = sqlite.prepare("SELECT ItemLevel FROM ItemScalingConfig WHERE ID = ?").get(scalingConfigId) as WowDbRow | undefined;
        itemLevel = numberValue(config?.ItemLevel) || itemLevel;
        break;
      }
      case 50:
        itemLevel = resolveItemLevel(sqlite, values[0] || 0, itemLevel);
        break;
    }
  }
  return itemLevel;
}

function randomPropertyPoints(
  sqlite: DatabaseSync,
  itemLevel: number,
  quality: number,
  inventoryType: number,
  itemSubclass: number,
): number {
  const row = sqlite.prepare("SELECT EpicF, SuperiorF, GoodF FROM RandPropPoints WHERE ID = ?").get(itemLevel) as WowDbRow | undefined;
  if (!row) return 0;
  const propertyIndex = randomPropertyIndex(inventoryType, itemSubclass);
  if (propertyIndex < 0) return 0;
  const column = quality >= 4 && quality <= 6 ? row.EpicF : quality === 3 || quality === 7 ? row.SuperiorF : row.GoodF;
  return parseNumberArray(column)[propertyIndex] || 0;
}

function randomPropertyIndex(inventoryType: number, itemSubclass: number): number {
  if ([1, 4, 5, 7, 15, 17, 20, 25].includes(inventoryType)) return 0;
  if (inventoryType === 26) return itemSubclass === 19 ? 3 : 0;
  // Current retail uses the one-hand weapon budget for shields and held-in-offhand items too.
  if ([13, 14, 21, 22, 23].includes(inventoryType)) return 3;
  if ([3, 6, 8, 10, 12].includes(inventoryType)) return 1;
  if ([2, 9, 11, 16].includes(inventoryType)) return 2;
  if (inventoryType === 28) return 4;
  return -1;
}

function itemLevelMultiplier(
  sqlite: DatabaseSync,
  table: "CombatRatingsMultByILvl" | "StaminaMultByILvl",
  itemLevel: number,
  inventoryType: number,
): number {
  const row = sqlite.prepare(`SELECT * FROM "${table}" WHERE ID = ?`).get(itemLevel) as WowDbRow | undefined;
  if (!row) return 0;
  if ([2, 11].includes(inventoryType)) return numberValue(row.JewelryMultiplier);
  if (inventoryType === 12) return numberValue(row.TrinketMultiplier);
  if ([13, 15, 17, 21, 22, 26].includes(inventoryType)) return numberValue(row.WeaponMultiplier);
  return numberValue(row.ArmorMultiplier);
}

function statLabels(statType: number): string[] {
  const labels: Record<number, string[]> = {
    3: ["敏捷"],
    4: ["力量"],
    5: ["智力"],
    7: ["耐力"],
    32: ["暴击"],
    36: ["急速"],
    40: ["全能"],
    49: ["精通"],
    61: ["加速"],
    62: ["吸血"],
    63: ["闪避"],
    71: ["敏捷", "力量", "智力"],
    72: ["敏捷", "力量"],
    73: ["敏捷", "智力"],
    74: ["力量", "智力"],
  };
  return labels[statType] || [];
}

function isCombatRating(statType: number): boolean {
  return (statType >= 12 && statType <= 21) ||
    [31, 32, 33, 34, 35, 36, 37, 40, 49, 61, 62, 63, 64].includes(statType);
}

function emptyDifficultyStats(): Record<LootDifficulty, Record<string, number>> {
  return { lfr: {}, normal: {}, heroic: {}, mythic: {} };
}

function parseStatTypes(value: unknown): number[] {
  return parseNumberArray(value).filter((entry) => entry > 0);
}

function parseNumberArray(value: unknown): number[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(numberValue) : [];
  } catch {
    return [];
  }
}

function inventoryTypeToEquipment(inventoryType: number): { slotName: string; ruleKey: string } {
  const values: Record<number, { slotName: string; ruleKey: string }> = {
    1: { slotName: "头部", ruleKey: "head" },
    2: { slotName: "颈部", ruleKey: "neck" },
    3: { slotName: "肩部", ruleKey: "shoulder" },
    5: { slotName: "胸部", ruleKey: "chest" },
    6: { slotName: "腰部", ruleKey: "waist" },
    7: { slotName: "腿部", ruleKey: "legs" },
    8: { slotName: "脚部", ruleKey: "feet" },
    9: { slotName: "腕部", ruleKey: "wrist" },
    10: { slotName: "手部", ruleKey: "hands" },
    11: { slotName: "戒指", ruleKey: "finger" },
    12: { slotName: "饰品", ruleKey: "trinket" },
    13: { slotName: "单手武器", ruleKey: "one_hand_weapon" },
    14: { slotName: "副手 / 盾牌", ruleKey: "off_hand" },
    15: { slotName: "远程武器", ruleKey: "one_hand_weapon" },
    16: { slotName: "背部", ruleKey: "back" },
    17: { slotName: "双手武器", ruleKey: "two_hand_weapon" },
    20: { slotName: "胸部", ruleKey: "chest" },
    21: { slotName: "主手武器", ruleKey: "one_hand_weapon" },
    22: { slotName: "副手武器", ruleKey: "off_hand" },
    23: { slotName: "副手物品", ruleKey: "off_hand" },
    26: { slotName: "远程武器", ruleKey: "one_hand_weapon" },
  };
  return values[inventoryType] || { slotName: "其他装备", ruleKey: "other" };
}

function emptyCatalog(databasePath: string, season: string, gameVersion: string): LootCatalog {
  return {
    source: "wow-db",
    connected: false,
    databasePath,
    season,
    gameVersion,
    build: null,
    locale: null,
    raids: [],
  };
}

function emptyMythicPlusCatalog(
  databasePath: string,
  season: string,
  gameVersion: string,
): MythicPlusCatalog {
  return {
    source: "wow-db",
    connected: false,
    databasePath,
    season,
    gameVersion,
    build: null,
    locale: null,
    dungeons: [],
  };
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function hasColumn(sqlite: DatabaseSync, table: string, column: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function hasTable(sqlite: DatabaseSync, table: string): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function optionalColumn(sqlite: DatabaseSync, table: string, column: string, alias: string): string {
  const reference = table === "ItemSparse" ? "isp" : table === "Item" ? "item" : table;
  return hasColumn(sqlite, table, column) ? `${reference}."${column}" AS ${alias}` : `'' AS ${alias}`;
}
