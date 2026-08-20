import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config, appRoot } from "./config.js";
import { LootDatabase } from "./db.js";
import { localizeSimulationReport } from "./simulation-report.js";
import type {
  CharacterEquipmentCache,
  EquippedItem,
  LocalSimulationReport,
  LootCatalog,
  LootItemReference,
  MythicPlusCatalog,
  Player,
  TierSetSummary,
  WeightCacheJson,
} from "./types.js";
import { WowDbCatalog } from "./wowdb.js";

const officialIconBase = "https://render.worldofwarcraft.com/us/icons/56";
const wowheadIconBase = "https://wow.zamimg.com/images/wow/icons/large";
const questionIconUrl = `${wowheadIconBase}/inv_misc_questionmark.jpg`;

export interface PublicPlayerSummary {
  id: string;
  name: string;
  realmName: string;
  className: string | null;
  specialization: string | null;
  raidRole: Player["raidRole"];
  mainStat: Player["mainStat"];
  latestSimulationDps: number | null;
  latestSimulationAt: string | null;
  latestCharacterAt: string | null;
  seasonPickupCount: number;
  seasonItemCount: number;
  tierSet: TierSetSummary | null;
  hasSimulation: boolean;
  hasEquipment: boolean;
}

export interface PublicPlayerDetail {
  schemaVersion: 1;
  player: PublicPlayerSummary;
  weights: PublicWeightCache | null;
  equipment: PublicCharacterEquipment | null;
  simulation: PublicSimulationReport | null;
}

type PublicWeightCache = Omit<WeightCacheJson, "source"> & {
  source: Pick<WeightCacheJson["source"], "provider" | "simulatedAt" | "fetchedAt">;
};

type PublicSimulationReport = Omit<LocalSimulationReport, "profile"> & {
  simcIdentity: PublicSimcIdentity | null;
};

interface PublicSimcIdentity {
  actorLine: string;
  race: string;
  level: string;
  spec: string;
  talents: string;
}

type PublicEquippedItem = Omit<EquippedItem, "iconUrl"> & { iconUrl: string | null };
type PublicCharacterEquipment = Omit<CharacterEquipmentCache, "items"> & {
  items: PublicEquippedItem[];
};

export async function buildStaticPublication(input: {
  outputPath?: string;
  publishedAt?: Date;
} = {}): Promise<{ outputPath: string; revision: string; playerCount: number }> {
  const outputPath = resolve(input.outputPath || process.env.PAGES_OUTPUT_PATH || join(appRoot, "pages-dist"));
  const sourcePath = join(appRoot, "pages-src");
  const publishedAt = (input.publishedAt || new Date()).toISOString();
  const database = await LootDatabase.open(config.databasePath);
  const wowDb = new WowDbCatalog(config.wowDbPath, "12.1", "12.1");

  try {
    const season = database.getActiveSeason();
    const allPlayers = database.listPlayers();
    const activePlayers = allPlayers.filter((player) => player.isActive);
    const allocations = database.listAllocations(100_000);
    const rules = database.listLootRules();
    const rawCatalog = wowDb.getCatalog();
    const rawMythicPlus = wowDb.getMythicPlusCatalog();
    const rawDetails = activePlayers.map((player) => ({
      player,
      weights: database.getLatestWeightCache(player.id),
      equipment: database.getLatestCharacterEquipment(player.id),
      simulation: database.getLatestLocalSimulationReport(player.id),
    }));
    const itemIds = [
      ...rawCatalog.raids.flatMap((raid) => raid.bosses.flatMap((boss) => boss.items.map((item) => item.itemId))),
      ...rawMythicPlus.dungeons.flatMap((dungeon) => dungeon.bosses.flatMap((boss) => boss.items.map((item) => item.itemId))),
      ...rawDetails.flatMap((detail) => detail.equipment?.items.map((item) => item.itemId) || []),
    ];
    const itemIconUrls = await resolvePublicItemIcons(itemIds, wowDb);
    const catalog = sanitizeCatalog(rawCatalog, itemIconUrls);
    const mythicPlus = sanitizeMythicPlusCatalog(rawMythicPlus, itemIconUrls);
    const playerSummaries: PublicPlayerSummary[] = [];
    const playerDetails: PublicPlayerDetail[] = [];

    for (const raw of rawDetails) {
      const { player } = raw;
      const weights = sanitizeWeights(raw.weights);
      const equipment = sanitizeEquipment(raw.equipment, itemIconUrls);
      const simulation = sanitizeSimulation(raw.simulation, wowDb);
      const summary: PublicPlayerSummary = {
        id: player.id,
        name: player.name,
        realmName: player.realmName,
        className: player.className,
        specialization: player.specialization,
        raidRole: player.raidRole,
        mainStat: player.mainStat,
        latestSimulationDps: simulation?.summary.dps ?? weights?.baselineDps ?? null,
        latestSimulationAt: simulation?.source.simulatedAt ?? weights?.source.simulatedAt ?? null,
        latestCharacterAt: equipment?.source.fetchedAt ?? null,
        seasonPickupCount: player.seasonPickupCount || 0,
        seasonItemCount: player.seasonItemCount || 0,
        tierSet: wowDb.getCurrentTierSetSummary(raw.equipment),
        hasSimulation: Boolean(simulation || weights),
        hasEquipment: Boolean(equipment?.items.length),
      };
      playerSummaries.push(summary);
      playerDetails.push({ schemaVersion: 1, player: summary, weights, equipment, simulation });
    }

    const publicData = {
      schemaVersion: 1,
      season: { key: season.seasonKey, gameVersion: season.gameVersion },
      players: playerSummaries,
      allocations: allocations.map(({ seasonId: _seasonId, ...allocation }) => allocation),
      rules: rules.map(({ id: _id, seasonId: _seasonId, ...rule }) => rule),
      catalog,
      mythicPlus,
    };
    const revision = createHash("sha256")
      .update(JSON.stringify(publicData))
      .digest("hex")
      .slice(0, 12);
    const snapshot = { ...publicData, publishedAt, revision };

    await rm(outputPath, { recursive: true, force: true });
    await mkdir(join(outputPath, "data", "players"), { recursive: true });
    await cp(sourcePath, outputPath, { recursive: true });
    await writeJson(join(outputPath, "data", "snapshot.json"), snapshot);
    await Promise.all(playerDetails.map((detail) =>
      writeJson(join(outputPath, "data", "players", `${detail.player.id}.json`), detail),
    ));
    await writeFile(join(outputPath, ".nojekyll"), "", "utf8");
    await writeFile(join(outputPath, "publication.json"), `${JSON.stringify({
      schemaVersion: 1,
      publishedAt,
      revision,
      playerCount: playerSummaries.length,
    }, null, 2)}\n`, "utf8");

    return { outputPath, revision, playerCount: playerSummaries.length };
  } finally {
    wowDb.close();
    database.close();
  }
}

function sanitizeWeights(cache: WeightCacheJson | null): PublicWeightCache | null {
  if (!cache) return null;
  return {
    ...cache,
    source: {
      provider: cache.source.provider,
      simulatedAt: cache.source.simulatedAt,
      fetchedAt: cache.source.fetchedAt,
    },
  };
}

function sanitizeEquipment(
  equipment: CharacterEquipmentCache | null,
  itemIconUrls: Map<number, string>,
): PublicCharacterEquipment | null {
  if (!equipment) return null;
  const { items, ...metadata } = equipment;
  return {
    ...metadata,
    items: items.map((item) => ({
      ...item,
      iconUrl: itemIconUrls.get(item.itemId) || questionIconUrl,
    })),
  };
}

function sanitizeSimulation(
  report: LocalSimulationReport | null,
  wowDb: WowDbCatalog,
): PublicSimulationReport | null {
  if (!report) return null;
  const spellIds = [
    ...report.damage,
    ...report.castFrequency,
    ...report.actionSequence.precombat,
    ...report.actionSequence.combat,
  ].flatMap((entry) => entry.id ? [entry.id] : []);
  const localized = localizeSimulationReport(report, wowDb.getSpellReferences(spellIds));
  const { profile, ...publicReport } = localized;
  return mapReportIconUrls({ ...publicReport, simcIdentity: parsePublicSimcIdentity(profile) });
}

function parsePublicSimcIdentity(profile: string): PublicSimcIdentity | null {
  const classPattern = /^(?:warrior|paladin|hunter|rogue|priest|deathknight|shaman|mage|warlock|monk|druid|demonhunter|evoker)=/;
  const lines = profile.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const actorLine = lines.find((line) => classPattern.test(line)) || "";
  const value = (key: string) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) || "";
  const identity = { actorLine, race: value("race"), level: value("level"), spec: value("spec"), talents: value("talents") };
  return Object.values(identity).every(Boolean) ? identity : null;
}

function mapReportIconUrls(report: PublicSimulationReport): PublicSimulationReport {
  const mapEntry = <T extends { iconUrl: string | null }>(entry: T): T => ({
    ...entry,
    iconUrl: publicIconUrl(entry.iconUrl),
  });
  return {
    ...report,
    damage: report.damage.map(mapEntry),
    castFrequency: report.castFrequency.map(mapEntry),
    actionSequence: {
      precombat: report.actionSequence.precombat.map(mapEntry),
      combat: report.actionSequence.combat.map(mapEntry),
    },
  };
}

function sanitizeCatalog(
  catalog: LootCatalog,
  itemIconUrls: Map<number, string>,
): Omit<LootCatalog, "databasePath"> {
  const { databasePath: _databasePath, ...publicCatalog } = catalog;
  return {
    ...publicCatalog,
    raids: catalog.raids.map((raid) => ({
      ...raid,
      bosses: raid.bosses.map((boss) => ({
        ...boss,
        items: boss.items.map((item) => sanitizeLootItem(item, itemIconUrls)),
      })),
    })),
  };
}

function sanitizeMythicPlusCatalog(
  catalog: MythicPlusCatalog,
  itemIconUrls: Map<number, string>,
): Omit<MythicPlusCatalog, "databasePath"> {
  const { databasePath: _databasePath, ...publicCatalog } = catalog;
  return {
    ...publicCatalog,
    dungeons: catalog.dungeons.map((dungeon) => ({
      ...dungeon,
      bosses: dungeon.bosses.map((boss) => ({
        ...boss,
        items: boss.items.map((item) => sanitizeLootItem(item, itemIconUrls)),
      })),
    })),
  };
}

function sanitizeLootItem(
  item: LootItemReference,
  itemIconUrls: Map<number, string>,
): LootItemReference {
  return { ...item, iconUrl: itemIconUrls.get(item.itemId) || questionIconUrl };
}

function publicIconUrl(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/^\/api\/loot\/icon\/file\/(\d+)$/);
  return match ? officialIconUrl(Number(match[1])) : url;
}

function officialIconUrl(fileDataId: number | null): string | null {
  return fileDataId ? `${officialIconBase}/${fileDataId}.jpg` : null;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function resolvePublicItemIcons(
  itemIds: number[],
  wowDb: WowDbCatalog,
): Promise<Map<number, string>> {
  const cachePath = join(appRoot, "data", "publication-item-icons.json");
  const cached = await readJsonRecord(cachePath);
  const result = new Map<number, string>();
  const unresolved: number[] = [];
  for (const itemId of new Set(itemIds)) {
    const fileDataId = wowDb.getItemIconFileDataId(itemId);
    const known = officialIconUrl(fileDataId) || cached[String(itemId)];
    if (known) result.set(itemId, known);
    else unresolved.push(itemId);
  }

  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, unresolved.length) }, async () => {
    while (cursor < unresolved.length) {
      const itemId = unresolved[cursor++];
      if (!itemId) continue;
      const iconUrl = await resolveWowheadItemIcon(itemId);
      if (iconUrl) {
        result.set(itemId, iconUrl);
        cached[String(itemId)] = iconUrl;
      }
    }
  }));
  if (unresolved.length) await writeJson(cachePath, cached);
  return result;
}

async function resolveWowheadItemIcon(itemId: number): Promise<string | null> {
  try {
    const response = await fetch(`https://www.wowhead.com/cn/item=${itemId}?xml`, {
      headers: { "user-agent": "wow-loot-allocator-publication/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const xml = await response.text();
    const iconName = xml.match(/<icon(?:\s[^>]*)?>([^<]+)<\/icon>/i)?.[1]?.trim();
    return iconName ? `${wowheadIconBase}/${encodeURIComponent(iconName)}.jpg` : null;
  } catch {
    return null;
  }
}

async function readJsonRecord(path: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, string>
      : {};
  } catch {
    return {};
  }
}
