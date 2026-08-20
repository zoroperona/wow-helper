import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { normalizeCharacterEquipment } from "./equipment.js";
import type {
  CharacterEquipmentCache,
  CharacterStatSnapshot,
  EquippedItem,
  MainStat,
  Player,
  RaidRole,
  Season,
  StatWeights,
  WeightCacheJson,
  WeightSnapshot,
  LocalSimulationReport,
  AllocationRecord,
  LootRule,
  LootDifficulty,
} from "./types.js";
import { parseLocalSimulationReport } from "./simulation-report.js";

interface PlayerRow {
  id: string;
  name: string;
  realm_name: string;
  realm_slug: string;
  class_name: string | null;
  specialization: string | null;
  raid_role: RaidRole;
  main_stat: MainStat | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  latest_weight_fetched_at?: string | null;
  latest_weight_game_version?: string | null;
  latest_weight_source_created_at?: string | null;
  latest_simulation_dps?: number | null;
  has_local_simulation?: number;
  latest_character_fetched_at?: string | null;
  season_pickup_count?: number;
  season_item_count?: number;
}

interface SeasonRow {
  id: string;
  season_key: string;
  game_version: string;
  is_active: number;
  created_at: string;
  archived_at: string | null;
}

interface WeightRow {
  id: string;
  player_id: string;
  season_id: string;
  source: "dpswow-result-link" | "local-simc";
  source_result_id: string;
  source_url: string;
  source_player_name: string;
  source_realm_name: string;
  source_created_at: string | null;
  fetched_at: string;
  game_version: string;
  game_build: number | null;
  baseline_dps: number | null;
  intellect: number;
  agility: number;
  strength: number;
  versatility: number;
  haste: number;
  mastery: number;
  critical_strike: number;
}

interface WeightPayloadRow extends WeightRow {
  source_payload_gzip: Uint8Array;
}

interface CharacterSnapshotRow {
  id: string;
  player_id: string;
  season_id: string;
  source: "blizzard-cn-armory" | "dpswow-cn-armory";
  fetched_at: string;
  game_version: string;
  character_level: number | null;
  average_item_level: number | null;
  equipped_item_level: number | null;
  equipment_json: string | null;
  character_stats_json: string | null;
  source_payload_gzip: Uint8Array;
}

interface LootRuleRow {
  id: string;
  season_id: string;
  rule_key: string;
  display_name: string;
  pickup_count: number;
  counts_toward_total: number;
  sort_order: number;
  game_version: string;
  updated_at: string;
}

interface AllocationRow {
  id: string;
  season_id: string;
  player_id: string;
  player_name: string;
  player_class_name: string | null;
  raid_role: RaidRole;
  raid_id: string | null;
  raid_name: string;
  boss_id: string | null;
  boss_name: string;
  item_id: number | null;
  item_name: string;
  equipment_type: string;
  item_level: number | null;
  difficulty: LootDifficulty;
  pickup_count: number;
  counts_toward_total: number;
  is_special_effect: number;
  note: string | null;
  allocated_at: string;
  game_version: string;
}

export interface CreateAllocationInput {
  playerId: string;
  raidId?: string | null;
  raidName: string;
  bossId?: string | null;
  bossName: string;
  itemId?: number | null;
  itemName: string;
  equipmentType: string;
  itemLevel?: number | null;
  difficulty?: LootDifficulty;
  pickupCount: number;
  countsTowardTotal: boolean;
  isSpecialEffect: boolean;
  note?: string | null;
}

const defaultLootRules = [
  ["two_hand_weapon", "双手武器", 4, 1],
  ["one_hand_weapon", "单手武器", 2, 2],
  ["off_hand", "副手 / 盾牌", 2, 3],
  ["head", "头部", 1, 10],
  ["neck", "颈部", 1, 11],
  ["shoulder", "肩部", 1, 12],
  ["back", "背部", 1, 13],
  ["chest", "胸部", 1, 14],
  ["wrist", "腕部", 1, 15],
  ["hands", "手部", 1, 16],
  ["waist", "腰部", 1, 17],
  ["legs", "腿部", 1, 18],
  ["feet", "脚部", 1, 19],
  ["finger", "戒指", 1, 20],
  ["trinket", "饰品", 0, 21],
  ["other", "其他装备", 1, 99],
] as const;

export interface CreatePlayerInput {
  name: string;
  realmName: string;
  realmSlug: string;
  raidRole: RaidRole;
  className?: string | null;
  specialization?: string | null;
  mainStat?: MainStat | null;
}

export type UpdatePlayerInput = Pick<
  CreatePlayerInput,
  "name" | "realmName" | "realmSlug" | "raidRole"
>;

export interface SaveWeightInput {
  playerId: string;
  seasonId: string;
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
  sourcePayloadGzip: Buffer;
  source?: "dpswow-result-link" | "local-simc";
}

export class LootDatabase {
  private constructor(
    readonly path: string,
    private readonly sqlite: DatabaseSync,
  ) {}

  static async open(path: string): Promise<LootDatabase> {
    await mkdir(dirname(path), { recursive: true });
    const sqlite = new DatabaseSync(path);
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA synchronous = NORMAL");
    const database = new LootDatabase(path, sqlite);
    if (process.env.AUTO_MIGRATE === "0") database.assertExternalMigrationTrusted();
    else database.migrate();
    database.ensureDefaultSeason();
    database.ensureDefaultLootRules();
    return database;
  }

  close(): void {
    this.sqlite.close();
  }

  async backup(destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    await sqliteBackup(this.sqlite, destination);
  }

  getActiveSeason(): Season {
    const row = this.sqlite
      .prepare("SELECT * FROM seasons WHERE is_active = 1 LIMIT 1")
      .get() as SeasonRow | undefined;
    if (!row) {
      throw new Error("No active season configured");
    }
    return mapSeason(row);
  }

  listPlayers(): Player[] {
    const rows = this.sqlite
      .prepare(
        `SELECT p.*,
                w.fetched_at AS latest_weight_fetched_at,
                w.game_version AS latest_weight_game_version,
                w.source_created_at AS latest_weight_source_created_at,
                (
                  SELECT sw.baseline_dps
                    FROM stat_weight_snapshots sw
                   WHERE sw.player_id = p.id
                     AND sw.season_id = (SELECT id FROM seasons WHERE is_active = 1 LIMIT 1)
                     AND sw.source = 'local-simc'
                ORDER BY sw.fetched_at DESC, sw.id DESC
                   LIMIT 1
                ) AS latest_simulation_dps,
                EXISTS (
                  SELECT 1
                    FROM stat_weight_snapshots sw
                   WHERE sw.player_id = p.id
                     AND sw.season_id = (SELECT id FROM seasons WHERE is_active = 1 LIMIT 1)
                     AND sw.source = 'local-simc'
                ) AS has_local_simulation,
                c.fetched_at AS latest_character_fetched_at,
                COALESCE((
                  SELECT SUM(a.pickup_count)
                    FROM loot_allocations a
                   WHERE a.player_id = p.id
                     AND a.season_id = (SELECT id FROM seasons WHERE is_active = 1 LIMIT 1)
                     AND a.counts_toward_total = 1
                ), 0) AS season_pickup_count,
                COALESCE((
                  SELECT COUNT(*)
                    FROM loot_allocations a
                   WHERE a.player_id = p.id
                     AND a.season_id = (SELECT id FROM seasons WHERE is_active = 1 LIMIT 1)
                ), 0) AS season_item_count
           FROM players p
      LEFT JOIN stat_weight_snapshots w
             ON w.id = (
                SELECT sw.id
                  FROM stat_weight_snapshots sw
                 WHERE sw.player_id = p.id
                   AND sw.season_id = (SELECT id FROM seasons WHERE is_active = 1 LIMIT 1)
              ORDER BY sw.fetched_at DESC, sw.id DESC
                 LIMIT 1
             )
      LEFT JOIN character_snapshots c
             ON c.id = (
                SELECT cs.id
                  FROM character_snapshots cs
                 WHERE cs.player_id = p.id
                   AND cs.season_id = (SELECT id FROM seasons WHERE is_active = 1 LIMIT 1)
              ORDER BY cs.fetched_at DESC, cs.id DESC
                 LIMIT 1
             )
       ORDER BY CASE p.raid_role
                  WHEN 'tank' THEN 1
                  WHEN 'melee' THEN 2
                  WHEN 'ranged' THEN 3
                  WHEN 'healer' THEN 4
                END,
                p.name COLLATE NOCASE`,
      )
      .all() as unknown as PlayerRow[];
    return rows.map(mapPlayer);
  }

  getPlayer(id: string): Player | null {
    const row = this.sqlite.prepare("SELECT * FROM players WHERE id = ?").get(id) as
      | PlayerRow
      | undefined;
    return row ? mapPlayer(row) : null;
  }

  createPlayer(input: CreatePlayerInput): Player {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO players (
           id, name, realm_name, realm_slug, class_name, specialization,
           raid_role, main_stat, is_active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.realmName.trim(),
        input.realmSlug.trim(),
        input.className?.trim() || null,
        input.specialization?.trim() || null,
        input.raidRole,
        input.mainStat || null,
        now,
        now,
      );
    return this.getPlayer(id)!;
  }

  updatePlayer(id: string, input: UpdatePlayerInput): Player | null {
    const current = this.getPlayer(id);
    if (!current) return null;
    const identityChanged = current.name !== input.name.trim() || current.realmSlug !== input.realmSlug.trim();
    this.sqlite
      .prepare(
        `UPDATE players
            SET name = ?, realm_name = ?, realm_slug = ?, raid_role = ?,
                class_name = CASE WHEN ? THEN NULL ELSE class_name END,
                specialization = CASE WHEN ? THEN NULL ELSE specialization END,
                main_stat = CASE WHEN ? THEN NULL ELSE main_stat END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.name.trim(),
        input.realmName.trim(),
        input.realmSlug.trim(),
        input.raidRole,
        identityChanged ? 1 : 0,
        identityChanged ? 1 : 0,
        identityChanged ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    return this.getPlayer(id);
  }

  deletePlayer(id: string): "deleted" | "not-found" | "has-allocations" {
    if (!this.getPlayer(id)) return "not-found";
    const allocation = this.sqlite
      .prepare("SELECT 1 FROM loot_allocations WHERE player_id = ? LIMIT 1")
      .get(id);
    if (allocation) return "has-allocations";
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("DELETE FROM stat_weight_snapshots WHERE player_id = ?").run(id);
      this.sqlite.prepare("DELETE FROM character_snapshots WHERE player_id = ?").run(id);
      this.sqlite.prepare("DELETE FROM players WHERE id = ?").run(id);
      this.sqlite.exec("COMMIT");
      return "deleted";
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  updatePlayerFromCharacter(
    id: string,
    character: {
      name: string;
      realmName: string;
      realmSlug: string;
      className: string;
      specialization: string;
    },
  ): Player {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `UPDATE players
            SET name = ?, realm_name = ?, realm_slug = ?, class_name = ?,
                specialization = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        character.name,
        character.realmName,
        character.realmSlug,
        character.className,
        character.specialization,
        now,
        id,
      );
    const player = this.getPlayer(id);
    if (!player) {
      throw new Error("Player not found");
    }
    return player;
  }

  saveCharacterSnapshot(input: {
    playerId: string;
    seasonId: string;
    fetchedAt: string;
    gameVersion: string;
    payloadGzip: Buffer;
    level: number;
    averageItemLevel: number;
    equippedItemLevel: number;
    equipment: EquippedItem[];
    source?: "blizzard-cn-armory" | "dpswow-cn-armory";
  }): string {
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO character_snapshots (
           id, player_id, season_id, source, fetched_at, game_version,
           character_level, average_item_level, equipped_item_level, equipment_json,
           source_payload_gzip
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.playerId,
        input.seasonId,
        input.source || "dpswow-cn-armory",
        input.fetchedAt,
        input.gameVersion,
        input.level,
        input.averageItemLevel,
        input.equippedItemLevel,
        JSON.stringify(input.equipment),
        input.payloadGzip,
      );
    return id;
  }

  getLatestCharacterSnapshotPayload(playerId: string): { id: string; payload: unknown } | null {
    const season = this.getActiveSeason();
    const row = this.sqlite
      .prepare(
        `SELECT id, source_payload_gzip
           FROM character_snapshots
          WHERE player_id = ? AND season_id = ?
       ORDER BY fetched_at DESC, id DESC
          LIMIT 1`,
      )
      .get(playerId, season.id) as Pick<CharacterSnapshotRow, "id" | "source_payload_gzip"> | undefined;
    if (!row) return null;
    return {
      id: row.id,
      payload: JSON.parse(gunzipSync(row.source_payload_gzip).toString("utf8")) as unknown,
    };
  }

  saveCharacterStats(snapshotId: string, stats: CharacterStatSnapshot): boolean {
    const result = this.sqlite
      .prepare("UPDATE character_snapshots SET character_stats_json = ? WHERE id = ?")
      .run(JSON.stringify(stats), snapshotId);
    return Number(result.changes) > 0;
  }

  getLatestCharacterEquipment(playerId: string): CharacterEquipmentCache | null {
    const player = this.getPlayer(playerId);
    if (!player) {
      return null;
    }
    const season = this.getActiveSeason();
    const row = this.sqlite
      .prepare(
        `SELECT *
           FROM character_snapshots
          WHERE player_id = ? AND season_id = ?
       ORDER BY fetched_at DESC, id DESC
          LIMIT 1`,
      )
      .get(playerId, season.id) as CharacterSnapshotRow | undefined;
    if (!row) {
      return null;
    }

    let normalized;
    if (row.equipment_json) {
      const items = JSON.parse(row.equipment_json) as EquippedItem[];
      normalized = {
        level: row.character_level ?? 0,
        averageItemLevel: row.average_item_level ?? 0,
        equippedItemLevel: row.equipped_item_level ?? 0,
        items,
      };
      if (items.some((item) => !("set" in item))) {
        const payload = JSON.parse(gunzipSync(row.source_payload_gzip).toString("utf8")) as unknown;
        const sourceItems = normalizeCharacterEquipment(payload).items;
        const setsByItem = new Map(sourceItems.map((item) => [`${item.itemId}:${item.slotType}`, item.set]));
        normalized.items = items.map((item) => ({
          ...item,
          set: setsByItem.get(`${item.itemId}:${item.slotType}`) ?? null,
        }));
        this.sqlite
          .prepare("UPDATE character_snapshots SET equipment_json = ? WHERE id = ?")
          .run(JSON.stringify(normalized.items), row.id);
      }
    } else {
      const payload = JSON.parse(gunzipSync(row.source_payload_gzip).toString("utf8")) as unknown;
      normalized = normalizeCharacterEquipment(payload);
      this.sqlite
        .prepare(
          `UPDATE character_snapshots
              SET character_level = ?, average_item_level = ?, equipped_item_level = ?,
                  equipment_json = ?
            WHERE id = ?`,
        )
        .run(
          normalized.level,
          normalized.averageItemLevel,
          normalized.equippedItemLevel,
          JSON.stringify(normalized.items),
          row.id,
        );
    }

    return {
      schemaVersion: 1,
      season: season.seasonKey,
      gameVersion: row.game_version,
      player: {
        id: player.id,
        name: player.name,
        realm: player.realmName,
        realmSlug: player.realmSlug,
        className: player.className,
        specialization: player.specialization,
      },
      source: { provider: row.source, fetchedAt: row.fetched_at },
      level: normalized.level,
      averageItemLevel: normalized.averageItemLevel,
      equippedItemLevel: normalized.equippedItemLevel,
      characterStats: row.character_stats_json
        ? JSON.parse(row.character_stats_json) as CharacterStatSnapshot
        : null,
      items: normalized.items,
    };
  }

  saveWeightSnapshot(input: SaveWeightInput, inferredMainStat: MainStat | null): WeightSnapshot {
    const id = randomUUID();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite
        .prepare(
          `INSERT INTO stat_weight_snapshots (
             id, player_id, season_id, source, source_result_id, source_url,
             source_player_name, source_realm_name, source_created_at, fetched_at,
             game_version, game_build, baseline_dps, intellect, agility, strength,
             versatility, haste, mastery, critical_strike, source_payload_gzip
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )
           ON CONFLICT(player_id, source_result_id) DO UPDATE SET
             source_url = excluded.source_url,
             source_player_name = excluded.source_player_name,
             source_realm_name = excluded.source_realm_name,
             source_created_at = excluded.source_created_at,
             fetched_at = excluded.fetched_at,
             game_version = excluded.game_version,
             game_build = excluded.game_build,
             baseline_dps = excluded.baseline_dps,
             intellect = excluded.intellect,
             agility = excluded.agility,
             strength = excluded.strength,
             versatility = excluded.versatility,
             haste = excluded.haste,
             mastery = excluded.mastery,
             critical_strike = excluded.critical_strike,
             source_payload_gzip = excluded.source_payload_gzip`,
        )
        .run(
          id,
          input.playerId,
          input.seasonId,
          input.source || "dpswow-result-link",
          input.sourceResultId,
          input.sourceUrl,
          input.sourcePlayerName,
          input.sourceRealmName,
          input.sourceCreatedAt,
          input.fetchedAt,
          input.gameVersion,
          input.gameBuild,
          input.baselineDps,
          input.weights.intellect,
          input.weights.agility,
          input.weights.strength,
          input.weights.versatility,
          input.weights.haste,
          input.weights.mastery,
          input.weights.criticalStrike,
          input.sourcePayloadGzip,
        );
      if (inferredMainStat) {
        this.sqlite
          .prepare(
            `UPDATE players
                SET main_stat = COALESCE(main_stat, ?), updated_at = ?
              WHERE id = ?`,
          )
          .run(inferredMainStat, input.fetchedAt, input.playerId);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getLatestWeight(input.playerId)!;
  }

  getLatestWeight(playerId: string): WeightSnapshot | null {
    const activeSeason = this.getActiveSeason();
    const row = this.sqlite
      .prepare(
        `SELECT *
           FROM stat_weight_snapshots
          WHERE player_id = ? AND season_id = ?
       ORDER BY fetched_at DESC, id DESC
          LIMIT 1`,
      )
      .get(playerId, activeSeason.id) as WeightRow | undefined;
    return row ? mapWeight(row) : null;
  }

  getLatestLocalSimulationReport(playerId: string): LocalSimulationReport | null {
    const player = this.getPlayer(playerId);
    if (!player) return null;
    const activeSeason = this.getActiveSeason();
    const row = this.sqlite
      .prepare(
        `SELECT *
           FROM stat_weight_snapshots
          WHERE player_id = ? AND season_id = ? AND source = 'local-simc'
       ORDER BY fetched_at DESC, id DESC
          LIMIT 1`,
      )
      .get(playerId, activeSeason.id) as WeightPayloadRow | undefined;
    if (!row) return null;
    const payload = JSON.parse(gunzipSync(row.source_payload_gzip).toString("utf8")) as unknown;
    const equipment = this.getLatestCharacterEquipment(playerId);
    const equipmentNames = new Map(equipment?.items.map((item) => [item.itemId, item.name]) || []);
    return parseLocalSimulationReport({ player, snapshot: mapWeight(row), payload, equipmentNames });
  }

  listLootRules(): LootRule[] {
    const season = this.getActiveSeason();
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM loot_rules
          WHERE season_id = ?
       ORDER BY sort_order, display_name`,
      )
      .all(season.id) as unknown as LootRuleRow[];
    return rows.map(mapLootRule);
  }

  updateLootRule(
    ruleKey: string,
    input: { pickupCount: number; countsTowardTotal: boolean },
  ): LootRule | null {
    const season = this.getActiveSeason();
    this.sqlite
      .prepare(
        `UPDATE loot_rules
            SET pickup_count = ?, counts_toward_total = ?, updated_at = ?
          WHERE season_id = ? AND rule_key = ?`,
      )
      .run(
        input.pickupCount,
        input.countsTowardTotal ? 1 : 0,
        new Date().toISOString(),
        season.id,
        ruleKey,
      );
    const row = this.sqlite
      .prepare("SELECT * FROM loot_rules WHERE season_id = ? AND rule_key = ?")
      .get(season.id, ruleKey) as LootRuleRow | undefined;
    return row ? mapLootRule(row) : null;
  }

  listAllocations(limit = 200): AllocationRecord[] {
    const season = this.getActiveSeason();
    const rows = this.sqlite
      .prepare(
        `SELECT a.*, p.name AS player_name, p.class_name AS player_class_name, p.raid_role
           FROM loot_allocations a
           JOIN players p ON p.id = a.player_id
          WHERE a.season_id = ?
       ORDER BY a.allocated_at DESC, a.id DESC
          LIMIT ?`,
      )
      .all(season.id, limit) as unknown as AllocationRow[];
    return rows.map(mapAllocation);
  }

  createAllocation(input: CreateAllocationInput): AllocationRecord {
    const season = this.getActiveSeason();
    const player = this.getPlayer(input.playerId);
    if (!player) {
      throw new Error("Player not found");
    }
    const id = randomUUID();
    const allocatedAt = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO loot_allocations (
           id, season_id, player_id, raid_id, raid_name, boss_id, boss_name,
           item_id, item_name, equipment_type, item_level, pickup_count,
           difficulty, counts_toward_total, is_special_effect, note, allocated_at, game_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        season.id,
        input.playerId,
        input.raidId || null,
        input.raidName,
        input.bossId || null,
        input.bossName,
        input.itemId ?? null,
        input.itemName,
        input.equipmentType,
        input.itemLevel ?? null,
        input.pickupCount,
        input.difficulty || "heroic",
        input.countsTowardTotal ? 1 : 0,
        input.isSpecialEffect ? 1 : 0,
        input.note || null,
        allocatedAt,
        season.gameVersion,
      );
    const row = this.sqlite
      .prepare(
        `SELECT a.*, p.name AS player_name, p.class_name AS player_class_name, p.raid_role
           FROM loot_allocations a
           JOIN players p ON p.id = a.player_id
          WHERE a.id = ?`,
      )
      .get(id) as unknown as AllocationRow;
    return mapAllocation(row);
  }

  updateAllocationPickupCount(id: string, pickupCount: number): AllocationRecord | null {
    const season = this.getActiveSeason();
    this.sqlite
      .prepare(
        `UPDATE loot_allocations
            SET pickup_count = ?
          WHERE id = ? AND season_id = ?`,
      )
      .run(pickupCount, id, season.id);
    const row = this.sqlite
      .prepare(
        `SELECT a.*, p.name AS player_name, p.class_name AS player_class_name, p.raid_role
           FROM loot_allocations a
           JOIN players p ON p.id = a.player_id
          WHERE a.id = ? AND a.season_id = ?`,
      )
      .get(id, season.id) as unknown as AllocationRow | undefined;
    return row ? mapAllocation(row) : null;
  }

  deleteAllocation(id: string): boolean {
    const season = this.getActiveSeason();
    const result = this.sqlite
      .prepare("DELETE FROM loot_allocations WHERE id = ? AND season_id = ?")
      .run(id, season.id);
    return Number(result.changes) > 0;
  }

  getLatestWeightCache(playerId: string): WeightCacheJson | null {
    const player = this.getPlayer(playerId);
    const snapshot = this.getLatestWeight(playerId);
    if (!player || !snapshot) {
      return null;
    }
    return {
      schemaVersion: 1,
      season: this.getActiveSeason().seasonKey,
      gameVersion: snapshot.gameVersion,
      gameBuild: snapshot.gameBuild,
      player: {
        id: player.id,
        name: player.name,
        realm: player.realmName,
        realmSlug: player.realmSlug,
        role: player.raidRole,
        mainStat: player.mainStat,
      },
      source: {
        provider: snapshot.source === "local-simc" ? "local-simc" : "dpswow",
        resultId: snapshot.sourceResultId,
        resultUrl: snapshot.sourceUrl,
        simulatedAt: snapshot.sourceCreatedAt,
        fetchedAt: snapshot.fetchedAt,
      },
      baselineDps: snapshot.baselineDps,
      weights: snapshot.weights,
    };
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS seasons (
        id TEXT PRIMARY KEY,
        season_key TEXT NOT NULL UNIQUE,
        game_version TEXT NOT NULL,
        is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_seasons_active
        ON seasons(is_active) WHERE is_active = 1;

      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        realm_name TEXT NOT NULL,
        realm_slug TEXT NOT NULL,
        class_name TEXT,
        specialization TEXT,
        raid_role TEXT NOT NULL CHECK (raid_role IN ('tank', 'melee', 'ranged', 'healer')),
        main_stat TEXT CHECK (main_stat IS NULL OR main_stat IN ('strength', 'agility', 'intellect')),
        is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(name, realm_slug)
      );

      CREATE TABLE IF NOT EXISTS character_snapshots (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players(id),
        season_id TEXT NOT NULL REFERENCES seasons(id),
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        game_version TEXT NOT NULL,
        character_level INTEGER,
        average_item_level REAL,
        equipped_item_level REAL,
        equipment_json TEXT,
        character_stats_json TEXT,
        source_payload_gzip BLOB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ix_character_snapshots_latest
        ON character_snapshots(player_id, season_id, fetched_at DESC);

      CREATE TABLE IF NOT EXISTS stat_weight_snapshots (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES players(id),
        season_id TEXT NOT NULL REFERENCES seasons(id),
        source TEXT NOT NULL,
        source_result_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_player_name TEXT NOT NULL,
        source_realm_name TEXT NOT NULL,
        source_created_at TEXT,
        fetched_at TEXT NOT NULL,
        game_version TEXT NOT NULL,
        game_build INTEGER,
        baseline_dps REAL,
        intellect REAL NOT NULL,
        agility REAL NOT NULL,
        strength REAL NOT NULL,
        versatility REAL NOT NULL,
        haste REAL NOT NULL,
        mastery REAL NOT NULL,
        critical_strike REAL NOT NULL,
        source_payload_gzip BLOB NOT NULL,
        UNIQUE(player_id, source_result_id)
      );

      CREATE INDEX IF NOT EXISTS ix_stat_weight_snapshots_latest
        ON stat_weight_snapshots(player_id, season_id, fetched_at DESC);

      CREATE TABLE IF NOT EXISTS loot_rules (
        id TEXT PRIMARY KEY,
        season_id TEXT NOT NULL REFERENCES seasons(id),
        rule_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        pickup_count REAL NOT NULL CHECK (pickup_count >= 0),
        counts_toward_total INTEGER NOT NULL CHECK (counts_toward_total IN (0, 1)),
        sort_order INTEGER NOT NULL,
        game_version TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(season_id, rule_key)
      );

      CREATE TABLE IF NOT EXISTS loot_allocations (
        id TEXT PRIMARY KEY,
        season_id TEXT NOT NULL REFERENCES seasons(id),
        player_id TEXT NOT NULL REFERENCES players(id),
        raid_id TEXT,
        raid_name TEXT NOT NULL,
        boss_id TEXT,
        boss_name TEXT NOT NULL,
        item_id INTEGER,
        item_name TEXT NOT NULL,
        equipment_type TEXT NOT NULL,
        item_level INTEGER,
        pickup_count REAL NOT NULL CHECK (pickup_count >= 0),
        difficulty TEXT NOT NULL DEFAULT 'heroic' CHECK (difficulty IN ('lfr', 'normal', 'heroic', 'mythic')),
        counts_toward_total INTEGER NOT NULL CHECK (counts_toward_total IN (0, 1)),
        is_special_effect INTEGER NOT NULL CHECK (is_special_effect IN (0, 1)),
        note TEXT,
        allocated_at TEXT NOT NULL,
        game_version TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ix_loot_allocations_season_time
        ON loot_allocations(season_id, allocated_at DESC);
      CREATE INDEX IF NOT EXISTS ix_loot_allocations_player
        ON loot_allocations(player_id, season_id, allocated_at DESC);
    `);
    this.ensureColumn("character_snapshots", "character_level", "INTEGER");
    this.ensureColumn("character_snapshots", "average_item_level", "REAL");
    this.ensureColumn("character_snapshots", "equipped_item_level", "REAL");
    this.ensureColumn("character_snapshots", "equipment_json", "TEXT");
    this.ensureColumn("character_snapshots", "character_stats_json", "TEXT");
    this.ensureColumn("loot_allocations", "difficulty", "TEXT NOT NULL DEFAULT 'heroic'");
    this.ensureLootAllocationDifficulties();
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS ix_loot_allocations_season_time
        ON loot_allocations(season_id, allocated_at DESC);
      CREATE INDEX IF NOT EXISTS ix_loot_allocations_player
        ON loot_allocations(player_id, season_id, allocated_at DESC);
    `);
    this.sqlite
      .prepare(
        `INSERT INTO app_meta(key, value) VALUES ('schema_version', '5')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private ensureLootAllocationDifficulties(): void {
    const table = this.sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'loot_allocations'")
      .get() as { sql?: string } | undefined;
    if (table?.sql?.includes("'lfr'")) return;

    this.sqlite.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE loot_allocations_v5 (
        id TEXT PRIMARY KEY,
        season_id TEXT NOT NULL REFERENCES seasons(id),
        player_id TEXT NOT NULL REFERENCES players(id),
        raid_id TEXT,
        raid_name TEXT NOT NULL,
        boss_id TEXT,
        boss_name TEXT NOT NULL,
        item_id INTEGER,
        item_name TEXT NOT NULL,
        equipment_type TEXT NOT NULL,
        item_level INTEGER,
        pickup_count REAL NOT NULL CHECK (pickup_count >= 0),
        difficulty TEXT NOT NULL DEFAULT 'heroic' CHECK (difficulty IN ('lfr', 'normal', 'heroic', 'mythic')),
        counts_toward_total INTEGER NOT NULL CHECK (counts_toward_total IN (0, 1)),
        is_special_effect INTEGER NOT NULL CHECK (is_special_effect IN (0, 1)),
        note TEXT,
        allocated_at TEXT NOT NULL,
        game_version TEXT NOT NULL
      );
      INSERT INTO loot_allocations_v5 (
        id, season_id, player_id, raid_id, raid_name, boss_id, boss_name, item_id,
        item_name, equipment_type, item_level, pickup_count, difficulty,
        counts_toward_total, is_special_effect, note, allocated_at, game_version
      )
      SELECT
        id, season_id, player_id, raid_id, raid_name, boss_id, boss_name, item_id,
        item_name, equipment_type, item_level, pickup_count, difficulty,
        counts_toward_total, is_special_effect, note, allocated_at, game_version
      FROM loot_allocations;
      DROP TABLE loot_allocations;
      ALTER TABLE loot_allocations_v5 RENAME TO loot_allocations;
      COMMIT;
    `);
  }

  private ensureDefaultSeason(): void {
    const existing = this.sqlite.prepare("SELECT id FROM seasons WHERE is_active = 1").get();
    if (existing) {
      return;
    }
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO seasons(id, season_key, game_version, is_active, created_at)
         VALUES (?, '12.1', '12.1', 1, ?)`,
      )
      .run(randomUUID(), now);
  }

  private ensureDefaultLootRules(): void {
    const season = this.getActiveSeason();
    const now = new Date().toISOString();
    const insert = this.sqlite.prepare(
      `INSERT INTO loot_rules (
         id, season_id, rule_key, display_name, pickup_count, counts_toward_total,
         sort_order, game_version, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(season_id, rule_key) DO NOTHING`,
    );
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const [ruleKey, displayName, pickupCount, sortOrder] of defaultLootRules) {
        insert.run(
          randomUUID(),
          season.id,
          ruleKey,
          displayName,
          pickupCount,
          ruleKey === "trinket" ? 0 : 1,
          sortOrder,
          season.gameVersion,
          now,
        );
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private assertExternalMigrationTrusted(): void {
    const quickCheck = String(this.sqlite.prepare("PRAGMA quick_check").get()?.quick_check || "unknown");
    if (quickCheck !== "ok") throw new Error(`外部 migration 启动门禁失败：SQLite quick_check=${quickCheck}`);

    const tableExists = (name: string) => Boolean(this.sqlite
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(name));
    if (!tableExists("schema_migrations") || !tableExists("migration_attempts")) {
      throw new Error("外部 migration 启动门禁失败：缺少 migration ledger");
    }

    const trusted = this.sqlite.prepare(`
      SELECT m.migration_id, m.checksum, m.to_schema,
             a.attempt_id AS success_attempt_id
        FROM schema_migrations m
        LEFT JOIN migration_attempts a
          ON a.migration_id = m.migration_id
         AND a.checksum = m.checksum
         AND a.status = 'success'
       ORDER BY applied_at DESC, migration_id DESC
       LIMIT 1
    `).get() as { migration_id?: string; checksum?: string; to_schema?: number; success_attempt_id?: string } | undefined;
    const schemaVersion = this.sqlite.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    if (!trusted || !trusted.success_attempt_id || !/^\d{4}_[a-z0-9-]+$/.test(String(trusted.migration_id)) || !/^[0-9a-f]{64}$/.test(String(trusted.checksum)) || String(schemaVersion?.value) !== String(trusted.to_schema)) {
      throw new Error("外部 migration 启动门禁失败：没有可信 success migration");
    }

    const untrustedAttempt = this.sqlite.prepare(`
      SELECT attempt_id, migration_id, status
        FROM migration_attempts
       WHERE status IN ('running', 'unknown')
       ORDER BY started_at DESC
       LIMIT 1
    `).get() as { attempt_id?: string; migration_id?: string; status?: string } | undefined;
    if (untrustedAttempt) {
      throw new Error(`外部 migration 启动门禁失败：存在未可信 attempt ${untrustedAttempt.attempt_id}/${untrustedAttempt.migration_id}/${untrustedAttempt.status}`);
    }
  }
}

function mapSeason(row: SeasonRow): Season {
  return {
    id: row.id,
    seasonKey: row.season_key,
    gameVersion: row.game_version,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

function mapPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    name: row.name,
    realmName: row.realm_name,
    realmSlug: row.realm_slug,
    className: row.class_name,
    specialization: row.specialization,
    raidRole: row.raid_role,
    mainStat: row.main_stat,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestWeightFetchedAt: row.latest_weight_fetched_at,
    latestWeightGameVersion: row.latest_weight_game_version,
    latestWeightSourceCreatedAt: row.latest_weight_source_created_at,
    latestSimulationDps: row.latest_simulation_dps ?? undefined,
    hasLocalSimulation: row.has_local_simulation === 1,
    latestCharacterFetchedAt: row.latest_character_fetched_at,
    seasonPickupCount: row.season_pickup_count ?? 0,
    seasonItemCount: row.season_item_count ?? 0,
  };
}

function mapLootRule(row: LootRuleRow): LootRule {
  return {
    id: row.id,
    seasonId: row.season_id,
    ruleKey: row.rule_key,
    displayName: row.display_name,
    pickupCount: row.pickup_count,
    countsTowardTotal: row.counts_toward_total === 1,
    sortOrder: row.sort_order,
    gameVersion: row.game_version,
    updatedAt: row.updated_at,
  };
}

function mapAllocation(row: AllocationRow): AllocationRecord {
  return {
    id: row.id,
    seasonId: row.season_id,
    playerId: row.player_id,
    playerName: row.player_name,
    playerClassName: row.player_class_name,
    playerRole: row.raid_role,
    raidId: row.raid_id,
    raidName: row.raid_name,
    bossId: row.boss_id,
    bossName: row.boss_name,
    itemId: row.item_id,
    itemName: row.item_name,
    equipmentType: row.equipment_type,
    itemLevel: row.item_level,
    difficulty: row.difficulty || "heroic",
    pickupCount: row.pickup_count,
    countsTowardTotal: row.counts_toward_total === 1,
    isSpecialEffect: row.is_special_effect === 1,
    note: row.note,
    allocatedAt: row.allocated_at,
    gameVersion: row.game_version,
  };
}

function mapWeight(row: WeightRow): WeightSnapshot {
  return {
    id: row.id,
    playerId: row.player_id,
    seasonId: row.season_id,
    source: row.source,
    sourceResultId: row.source_result_id,
    sourceUrl: row.source_url,
    sourcePlayerName: row.source_player_name,
    sourceRealmName: row.source_realm_name,
    sourceCreatedAt: row.source_created_at,
    fetchedAt: row.fetched_at,
    gameVersion: row.game_version,
    gameBuild: row.game_build,
    baselineDps: row.baseline_dps,
    weights: {
      intellect: row.intellect,
      agility: row.agility,
      strength: row.strength,
      versatility: row.versatility,
      haste: row.haste,
      mastery: row.mastery,
      criticalStrike: row.critical_strike,
    },
  };
}
