export const raidRoles = ["tank", "melee", "ranged", "healer"] as const;
export type RaidRole = (typeof raidRoles)[number];

export const lootDifficulties = ["lfr", "normal", "heroic", "mythic"] as const;
export type LootDifficulty = (typeof lootDifficulties)[number];

export const mainStats = ["strength", "agility", "intellect"] as const;
export type MainStat = (typeof mainStats)[number];

export function isDamageRole(role: RaidRole): boolean {
  return role === "melee" || role === "ranged";
}

export interface Season {
  id: string;
  seasonKey: string;
  gameVersion: string;
  isActive: boolean;
  createdAt: string;
  archivedAt: string | null;
}

export interface Player {
  id: string;
  name: string;
  realmName: string;
  realmSlug: string;
  className: string | null;
  specialization: string | null;
  raidRole: RaidRole;
  mainStat: MainStat | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  latestWeightFetchedAt?: string | null;
  latestWeightGameVersion?: string | null;
  latestWeightSourceCreatedAt?: string | null;
  latestSimulationDps?: number | null;
  hasLocalSimulation?: boolean;
  latestCharacterFetchedAt?: string | null;
  seasonPickupCount?: number;
  seasonItemCount?: number;
}

export interface LootRule {
  id: string;
  seasonId: string;
  ruleKey: string;
  displayName: string;
  pickupCount: number;
  countsTowardTotal: boolean;
  sortOrder: number;
  gameVersion: string;
  updatedAt: string;
}

export interface AllocationRecord {
  id: string;
  seasonId: string;
  playerId: string;
  playerName: string;
  playerClassName: string | null;
  playerRole: RaidRole;
  raidId: string | null;
  raidName: string;
  bossId: string | null;
  bossName: string;
  itemId: number | null;
  itemName: string;
  equipmentType: string;
  itemLevel: number | null;
  difficulty: LootDifficulty;
  pickupCount: number;
  countsTowardTotal: boolean;
  isSpecialEffect: boolean;
  note: string | null;
  allocatedAt: string;
  gameVersion: string;
}

export interface LootItemReference {
  itemId: number;
  name: string;
  itemLevel: number;
  baseItemLevel: number;
  itemLevels: Record<LootDifficulty, number>;
  fullyUpgradedBonusLists: Record<LootDifficulty, number>;
  itemLevelSource: "db2-base" | "difficulty-data";
  inventoryType: number;
  slotName: string;
  equipmentType: string;
  armorType: string | null;
  weaponType: string | null;
  allowableClassMask: number | null;
  quality: number;
  isSpecialEffect: boolean;
  iconFileDataId: number | null;
  iconUrl: string | null;
  statTypes: number[];
  statValues: Record<string, number>;
  statValuesByDifficulty: Record<LootDifficulty, Record<string, number>>;
  description: string;
  tooltipLines: string[];
}

export interface LootBossReference {
  id: number;
  name: string;
  order: number;
  items: LootItemReference[];
}

export interface LootRaidReference {
  id: number;
  name: string;
  mapId: number;
  order: number;
  contentVersion: string;
  isCurrent: boolean;
  availabilityCondition: number;
  bosses: LootBossReference[];
}

export interface LootCatalog {
  source: "wow-db";
  connected: boolean;
  databasePath: string;
  season: string;
  gameVersion: string;
  build: string | null;
  locale: string | null;
  raids: LootRaidReference[];
}

export interface MythicPlusDungeonReference {
  id: number;
  name: string;
  mapId: number;
  order: number;
  bosses: LootBossReference[];
}

export interface MythicPlusCatalog {
  source: "wow-db";
  connected: boolean;
  databasePath: string;
  season: string;
  gameVersion: string;
  build: string | null;
  locale: string | null;
  dungeons: MythicPlusDungeonReference[];
}

export interface EquipmentEnchantment {
  id: number | null;
  displayString: string;
}

export interface EquipmentSocket {
  type: string;
  itemId: number | null;
  itemName: string | null;
  displayString: string;
}

export interface EquipmentSetEffect {
  displayString: string;
  requiredCount: number;
  isActive: boolean;
}

export interface EquipmentSetInfo {
  name: string;
  displayString: string;
  effects: EquipmentSetEffect[];
}

export interface EquippedItem {
  itemId: number;
  name: string;
  itemLevel: number;
  slotType: string;
  slotName: string;
  inventoryType: string;
  quality: string;
  bonusList: number[];
  enchantments: EquipmentEnchantment[];
  sockets: EquipmentSocket[];
  set: EquipmentSetInfo | null;
  iconUrl: null;
}

export interface TierSetSummary {
  name: string | null;
  equipped: number;
  total: 5;
  slots: Record<"head" | "shoulder" | "chest" | "hands" | "legs", boolean>;
  effects: EquipmentSetEffect[];
  fetchedAt: string;
}

export interface CharacterEquipmentCache {
  schemaVersion: 1;
  season: string;
  gameVersion: string;
  player: {
    id: string;
    name: string;
    realm: string;
    realmSlug: string;
    className: string | null;
    specialization: string | null;
  };
  source: {
    provider: "blizzard-cn-armory" | "dpswow-cn-armory";
    fetchedAt: string;
  };
  level: number;
  averageItemLevel: number;
  equippedItemLevel: number;
  characterStats: CharacterStatSnapshot | null;
  items: EquippedItem[];
}

export interface CharacterStatValue {
  rating: number;
  percent: number;
}

export interface CharacterStatSnapshot {
  schemaVersion: 1;
  calculatedAt: string;
  gameVersion: string;
  gameBuild: number | null;
  simcVersion: string;
  environment: "character";
  mainStat: MainStat | null;
  attributes: {
    strength: number;
    agility: number;
    intellect: number;
    stamina: number;
  };
  secondary: {
    criticalStrike: CharacterStatValue;
    haste: CharacterStatValue;
    mastery: CharacterStatValue;
    versatility: CharacterStatValue;
  };
}

export interface StatWeights {
  intellect: number;
  agility: number;
  strength: number;
  versatility: number;
  haste: number;
  mastery: number;
  criticalStrike: number;
}

export interface WeightSnapshot {
  id: string;
  playerId: string;
  seasonId: string;
  source: "dpswow-result-link" | "local-simc";
  sourceResultId: string;
  sourceUrl: string;
  sourcePlayerName: string;
  sourceRealmName: string;
  sourceCreatedAt: string | null;
  fetchedAt: string;
  gameVersion: string;
  gameBuild: number | null;
  baselineDps: number | null;
  weights: StatWeights;
}

export interface WeightCacheJson {
  schemaVersion: 1;
  season: string;
  gameVersion: string;
  gameBuild: number | null;
  player: {
    id: string;
    name: string;
    realm: string;
    realmSlug: string;
    role: RaidRole;
    mainStat: MainStat | null;
  };
  source: {
    provider: "dpswow" | "local-simc";
    resultId: string;
    resultUrl: string;
    simulatedAt: string | null;
    fetchedAt: string;
  };
  baselineDps: number | null;
  weights: StatWeights;
}

export interface LocalSimulationReport {
  schemaVersion: 1;
  player: {
    id: string;
    name: string;
    realm: string;
    className: string | null;
    specialization: string | null;
    mainStat: MainStat | null;
    talents: string | null;
  };
  source: {
    simulatedAt: string | null;
    fetchedAt: string;
    gameVersion: string;
    gameBuild: number | null;
    simcVersion: string;
  };
  summary: {
    dps: number | null;
    dpsMin: number | null;
    dpsMax: number | null;
    dpsError: number | null;
    fightLength: number | null;
    iterations: number | null;
    fightStyle: string;
    targets: number | null;
  };
  weights: StatWeights;
  statTotals: StatWeights;
  statPercentages: Omit<StatWeights, "strength" | "agility" | "intellect">;
  damage: Array<{
    id: number | null;
    name: string;
    iconUrl: string | null;
    dps: number;
    percent: number;
    executes: number | null;
  }>;
  castFrequency: Array<{
    id: number | null;
    name: string;
    iconUrl: string | null;
    executes: number;
    castsPerMinute: number | null;
    interval: number | null;
  }>;
  actionSequence: {
    precombat: SimulationAction[];
    combat: SimulationAction[];
  };
  equipment: Array<{
    slot: string;
    id: number | null;
    name: string;
    itemLevel: number | null;
    stats: Array<{ name: string; value: number }>;
  }>;
  profile: string;
}

export interface SimulationAction {
  time: number;
  id: number | null;
  name: string;
  iconUrl: string | null;
  target: string | null;
  resources: Array<{ name: string; value: number; max: number | null }>;
}

export interface SpellReference {
  id: number;
  name: string;
  iconFileDataId: number | null;
  iconUrl: string | null;
}
