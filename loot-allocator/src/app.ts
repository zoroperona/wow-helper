import express, { type NextFunction, type Request, type Response } from "express";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { z, ZodError } from "zod";
import type { LootDatabase } from "./db.js";
import { DpsWowClient, IntegrationError, WeightImportService } from "./dpswow.js";
import { fullyUpgradedBonusByDifficulty, type WowDbCatalog } from "./wowdb.js";
import { lootDifficulties, mainStats, raidRoles, type LootDifficulty } from "./types.js";
import { ArmoryLoginRequiredError, BlizzardArmoryClient } from "./armory.js";
import type { SimulationService } from "./simulation.js";
import { localizeSimulationReport } from "./simulation-report.js";
import { IconCache } from "./icon-cache.js";
import type { PublicationService } from "./publication-service.js";
import type { SystemHealthService } from "./system-health.js";
import { runLocalCharacterStats } from "./simc.js";

const createPlayerSchema = z.object({
  name: z.string().trim().min(1).max(64),
  realmName: z.string().trim().min(1).max(64),
  realmSlug: z.string().trim().min(1).max(80),
  raidRole: z.enum(raidRoles),
  mainStat: z.enum(mainStats).nullable().optional(),
});

const lookupSchema = z.object({
  realmSlug: z.string().trim().min(1).max(80),
  characterName: z.string().trim().min(1).max(64),
});

const importWeightSchema = z.object({
  resultUrl: z.string().trim().min(1).max(500),
});

const updateLootRuleSchema = z.object({
  pickupCount: z.number().min(0).max(99),
  countsTowardTotal: z.boolean(),
});

const createAllocationSchema = z.object({
  playerId: z.string().uuid(),
  raidId: z.string().max(100).nullable().optional(),
  raidName: z.string().trim().min(1).max(200),
  bossId: z.string().max(100).nullable().optional(),
  bossName: z.string().trim().min(1).max(200),
  itemId: z.number().int().positive().nullable().optional(),
  itemName: z.string().trim().min(1).max(200),
  equipmentType: z.string().trim().min(1).max(80),
  itemLevel: z.number().int().positive().nullable().optional(),
  difficulty: z.enum(lootDifficulties).default("heroic"),
  pickupCount: z.number().min(0).max(99),
  countsTowardTotal: z.boolean(),
  isSpecialEffect: z.boolean(),
  note: z.string().trim().max(500).nullable().optional(),
});

const updateAllocationSchema = z.object({
  pickupCount: z.number().min(0).max(99),
});

export function createApp(options: {
  database: LootDatabase;
  armory: BlizzardArmoryClient;
  dpsWow: DpsWowClient;
  wowDb: WowDbCatalog;
  publicPath: string;
  backupsPath: string;
  iconCachePath: string;
  simulations: SimulationService;
  publication: PublicationService;
  health: SystemHealthService;
  simcPath: string;
}) {
  const app = express();
  const weightImporter = new WeightImportService(options.database, options.dpsWow);
  const iconCache = new IconCache(options.iconCachePath);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/state", (_request, response) => {
    const players = options.database.listPlayers().map((player) => ({
      ...player,
      tierSet: options.wowDb.getCurrentTierSetSummary(
        options.database.getLatestCharacterEquipment(player.id),
      ),
    }));
    response.json({
      data: {
        season: options.database.getActiveSeason(),
        players,
      },
    });
  });

  app.get("/api/simulations/status", (_request, response) => {
    response.json({ data: options.simulations.getStatus() });
  });

  app.get("/api/publication/status", (_request, response) => {
    response.json({ data: options.publication.getStatus() });
  });

  app.get(
    "/api/system/health",
    asyncRoute(async (request, response) => {
      const force = request.query.refresh === "1";
      response.json({ data: await options.health.getReport(force) });
    }),
  );

  app.post("/api/publication", (_request, response) => {
    response.status(202).json({ data: options.publication.start() });
  });

  app.post("/api/simulations/stale", (_request, response) => {
    response.status(202).json({ data: options.simulations.startStale() });
  });

  app.post("/api/players/:id/simulate", (request, response) => {
    response.status(202).json({
      data: options.simulations.startSingle(routeParam(request.params.id)),
    });
  });

  app.get("/api/loot/catalog", (_request, response) => {
    response.json({ data: options.wowDb.getCatalog() });
  });

  app.post("/api/loot/catalog/refresh", (_request, response) => {
    response.json({ data: options.wowDb.getCatalog(true) });
  });

  app.get(
    "/api/loot/icon/:itemId",
    asyncRoute(async (request, response) => {
      const itemId = Number(routeParam(request.params.itemId));
      if (!Number.isInteger(itemId) || itemId <= 0) {
        response.status(400).end();
        return;
      }
      const itemCacheKey = `item:${itemId}`;
      const cachedItemIcon = await iconCache.get(itemCacheKey);
      if (cachedItemIcon) {
        sendIconResponse(response, cachedItemIcon);
        return;
      }
      const fileDataId = options.wowDb.getItemIconFileDataId(itemId);
      if (fileDataId) {
        await sendIcon(response, iconCache, String(fileDataId), true);
        return;
      }
      const iconName = await resolveWowheadIconName(itemId);
      if (!iconName) {
        await sendIcon(response, iconCache, "inv_misc_questionmark", false, undefined, false);
        return;
      }
      await sendIcon(response, iconCache, iconName, false, itemCacheKey);
    }),
  );

  app.get(
    "/api/loot/icon/file/:fileDataId",
    asyncRoute(async (request, response) => {
      const fileDataId = Number(routeParam(request.params.fileDataId));
      if (!Number.isInteger(fileDataId) || fileDataId <= 0) {
        await sendIcon(response, iconCache, "inv_misc_questionmark", false, undefined, false);
        return;
      }
      await sendIcon(response, iconCache, String(fileDataId), true);
    }),
  );

  app.get(
    "/api/loot/details/:itemId",
    asyncRoute(async (request, response) => {
      const itemId = Number(routeParam(request.params.itemId));
      if (!Number.isInteger(itemId) || itemId <= 0) {
        response.status(400).json({ error: { message: "Invalid item id" } });
        return;
      }
      const difficulty = parseDifficulty(request.query.difficulty);
      const bonusList = parseBonusList(request.query.bonus);
      const xml = await fetchWowheadXml(itemId, difficulty, bonusList);
      if (!xml) {
        response.status(404).json({ error: { message: "Item details unavailable" } });
        return;
      }
      response.json({ data: parseWowheadItemDetails(xml) });
    }),
  );

  app.get("/api/loot/rules", (_request, response) => {
    response.json({ data: options.database.listLootRules() });
  });

  app.put("/api/loot/rules/:ruleKey", (request, response) => {
    const input = updateLootRuleSchema.parse(request.body);
    const rule = options.database.updateLootRule(routeParam(request.params.ruleKey), input);
    if (!rule) {
      response.status(404).json({ error: { message: "Loot rule not found" } });
      return;
    }
    response.json({ data: rule });
  });

  app.get("/api/allocations", (_request, response) => {
    response.json({ data: options.database.listAllocations() });
  });

  app.post("/api/allocations", (request, response) => {
    const input = createAllocationSchema.parse(request.body);
    if (!options.database.getPlayer(input.playerId)) {
      throw new IntegrationError("Player not found", 404);
    }
    response.status(201).json({ data: options.database.createAllocation(input) });
  });

  app.patch("/api/allocations/:id", (request, response) => {
    const input = updateAllocationSchema.parse(request.body);
    const allocation = options.database.updateAllocationPickupCount(
      routeParam(request.params.id),
      input.pickupCount,
    );
    if (!allocation) {
      response.status(404).json({ error: { message: "Allocation not found" } });
      return;
    }
    response.json({ data: allocation });
  });

  app.delete("/api/allocations/:id", (request, response) => {
    if (!options.database.deleteAllocation(routeParam(request.params.id))) {
      response.status(404).json({ error: { message: "Allocation not found" } });
      return;
    }
    response.status(204).end();
  });

  app.get(
    "/api/reference/realms",
    asyncRoute(async (_request, response) => {
      response.json({ data: await options.dpsWow.listRealms() });
    }),
  );

  app.post("/api/players", (request, response) => {
    const input = createPlayerSchema.parse(request.body);
    const player = options.database.createPlayer(input);
    response.status(201).json({ data: player });
  });

  app.put("/api/players/:id", (request, response) => {
    const input = createPlayerSchema.parse(request.body);
    const player = options.database.updatePlayer(routeParam(request.params.id), input);
    if (!player) {
      response.status(404).json({ error: { message: "Player not found" } });
      return;
    }
    response.json({ data: player });
  });

  app.delete("/api/players/:id", (request, response) => {
    const result = options.database.deletePlayer(routeParam(request.params.id));
    if (result === "not-found") {
      response.status(404).json({ error: { message: "Player not found" } });
      return;
    }
    if (result === "has-allocations") {
      response.status(409).json({ error: { message: "该团员已有分配记录，请编辑资料而不是删除" } });
      return;
    }
    response.status(204).end();
  });

  app.post(
    "/api/dpswow/characters/lookup",
    asyncRoute(async (request, response) => {
      const input = lookupSchema.parse(request.body);
      response.json({
        data: await options.dpsWow.lookupCharacter(input.realmSlug, input.characterName),
      });
    }),
  );

  app.post(
    "/api/players/:id/character/refresh",
    asyncRoute(async (request, response) => {
      const player = options.database.getPlayer(routeParam(request.params.id));
      if (!player) {
        throw new IntegrationError("Player not found", 404);
      }
      let source: "blizzard-cn-armory" | "dpswow-cn-armory" = "blizzard-cn-armory";
      let fallbackReason: string | null = null;
      let character;
      try {
        character = await options.armory.lookupCharacter(player.realmSlug, player.name);
      } catch (error) {
        if (error instanceof ArmoryLoginRequiredError) throw error;
        source = "dpswow-cn-armory";
        fallbackReason = error instanceof Error ? error.message : String(error);
        character = await options.dpsWow.lookupCharacter(player.realmSlug, player.name);
      }
      const season = options.database.getActiveSeason();
      const fetchedAt = new Date().toISOString();
      const snapshotId = options.database.saveCharacterSnapshot({
        playerId: player.id,
        seasonId: season.id,
        fetchedAt,
        gameVersion: season.gameVersion,
        payloadGzip: gzipSync(JSON.stringify(character.rawPayload), { level: 9 }),
        level: character.level,
        averageItemLevel: character.averageItemLevel,
        equippedItemLevel: character.equippedItemLevel,
        equipment: character.equipment,
        source,
      });
      const updated = options.database.updatePlayerFromCharacter(player.id, character);
      let characterStatsAvailable = false;
      try {
        const stats = await runLocalCharacterStats({
          simcPath: options.simcPath,
          payload: character.rawPayload,
        });
        characterStatsAvailable = options.database.saveCharacterStats(snapshotId, {
          ...stats,
          calculatedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error(`[character-stats] Failed ${player.name}:`, error);
      }
      response.json({
        data: {
          player: updated,
          character: {
            level: character.level,
            averageItemLevel: character.averageItemLevel,
            equippedItemLevel: character.equippedItemLevel,
          },
          source,
          fallbackReason,
          characterStatsAvailable,
        },
      });
    }),
  );

  app.post(
    "/api/players/:id/character/login",
    asyncRoute(async (request, response) => {
      const player = options.database.getPlayer(routeParam(request.params.id));
      if (!player) {
        throw new IntegrationError("Player not found", 404);
      }
      await options.armory.login(player.realmSlug, player.name);
      response.json({ data: { loggedIn: true } });
    }),
  );

  app.get("/api/players/:id/character/latest", asyncRoute(async (request, response) => {
    const playerId = routeParam(request.params.id);
    let cache = options.database.getLatestCharacterEquipment(playerId);
    if (!cache) {
      response.status(404).json({ error: { message: "No character snapshot found" } });
      return;
    }
    if (!cache.characterStats) {
      const snapshot = options.database.getLatestCharacterSnapshotPayload(playerId);
      if (snapshot) {
        try {
          const stats = await runLocalCharacterStats({ simcPath: options.simcPath, payload: snapshot.payload });
          options.database.saveCharacterStats(snapshot.id, {
            ...stats,
            calculatedAt: new Date().toISOString(),
          });
          cache = options.database.getLatestCharacterEquipment(playerId) || cache;
        } catch (error) {
          console.error(`[character-stats] Failed on demand for ${cache.player.name}:`, error);
        }
      }
    }
    response.json({ data: cache });
  }));

  app.post(
    "/api/players/:id/weights/import",
    asyncRoute(async (request, response) => {
      const input = importWeightSchema.parse(request.body);
      const snapshot = await weightImporter.importForPlayer(
        routeParam(request.params.id),
        input.resultUrl,
      );
      response.status(201).json({ data: snapshot });
    }),
  );

  app.get("/api/players/:id/weights/latest", (request, response) => {
    const cache = options.database.getLatestWeightCache(routeParam(request.params.id));
    if (!cache) {
      response.status(404).json({ error: { message: "No weight cache found" } });
      return;
    }
    response.json({ data: cache });
  });

  app.get("/api/players/:id/weights/latest.json", (request, response) => {
    const cache = options.database.getLatestWeightCache(routeParam(request.params.id));
    if (!cache) {
      response.status(404).json({ error: { message: "No weight cache found" } });
      return;
    }
    const filename = `${safeFilename(cache.player.name)}-${cache.season}-weights.json`;
    response.attachment(filename).type("application/json").send(`${JSON.stringify(cache, null, 2)}\n`);
  });

  app.get("/api/players/:id/simulations/latest", (request, response) => {
    const report = options.database.getLatestLocalSimulationReport(routeParam(request.params.id));
    if (!report) {
      response.status(404).json({ error: { message: "No local simulation found" } });
      return;
    }
    const spellIds = [
      ...report.damage,
      ...report.castFrequency,
      ...report.actionSequence.precombat,
      ...report.actionSequence.combat,
    ].flatMap((entry) => entry.id ? [entry.id] : []);
    response.json({
      data: localizeSimulationReport(report, options.wowDb.getSpellReferences(spellIds)),
    });
  });

  app.get(
    "/api/backups/export",
    asyncRoute(async (_request, response) => {
      const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      const season = options.database.getActiveSeason().seasonKey;
      const filename = `wow-loot-${season}-${timestamp}.sqlite`;
      const destination = join(options.backupsPath, filename);
      await options.database.backup(destination);
      response.download(destination, filename);
    }),
  );

  app.use(express.static(options.publicPath, { extensions: ["html"] }));

  app.use(
    (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      if (error instanceof ZodError) {
        response.status(400).json({
          error: { message: "Invalid request", details: z.treeifyError(error) },
        });
        return;
      }
      if (error instanceof IntegrationError) {
        response.status(error.status).json({
          error: { message: error.message, code: error.code },
        });
        return;
      }
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        response.status(409).json({ error: { message: "This character is already in the roster" } });
        return;
      }
      console.error(error);
      response.status(500).json({ error: { message: "Internal server error" } });
    },
  );

  return app;
}

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

function safeFilename(value: string): string {
  return value.replace(/[^\p{Letter}\p{Number}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "player";
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

const wowheadIconCache = new Map<number, string | null>();
const wowheadXmlCache = new Map<string, string | null>();

async function resolveWowheadIconName(itemId: number): Promise<string | null> {
  if (wowheadIconCache.has(itemId)) return wowheadIconCache.get(itemId) || null;
  const xml = await fetchWowheadXml(itemId, "heroic");
  const iconName = xml?.match(/<icon(?:\s[^>]*)?>([^<]+)<\/icon>/i)?.[1]?.trim() || null;
  if (iconName) wowheadIconCache.set(itemId, iconName);
  else wowheadIconCache.delete(itemId);
  return iconName;
}

async function fetchWowheadXml(
  itemId: number,
  difficulty: LootDifficulty,
  bonusList: number[] = [],
): Promise<string | null> {
  const bonus = bonusList.length ? bonusList.join(":") : String(fullyUpgradedBonusByDifficulty[difficulty]);
  const cacheKey = `${itemId}:bonus:${bonus}`;
  if (wowheadXmlCache.has(cacheKey)) return wowheadXmlCache.get(cacheKey) || null;
  try {
    const result = await fetch(`https://www.wowhead.com/cn/item=${itemId}?bonus=${bonus}&xml`, {
      headers: { "user-agent": "wow-loot-allocator/1.0" },
      signal: AbortSignal.timeout(20000),
    });
    if (!result.ok) throw new Error(`Wowhead returned ${result.status}`);
    const xml = await result.text();
    wowheadXmlCache.set(cacheKey, xml);
    return xml;
  } catch {
    wowheadXmlCache.delete(cacheKey);
    return null;
  }
}

function parseBonusList(value: unknown): number[] {
  const input = Array.isArray(value) ? value[0] : value;
  if (typeof input !== "string" || !input.trim()) return [];
  const parts = input.split(":");
  if (parts.length > 64 || parts.some((part) => !/^\d{1,8}$/.test(part))) {
    throw new IntegrationError("Invalid item bonus list", 400);
  }
  return parts.map(Number);
}

function parseDifficulty(value: unknown): LootDifficulty {
  return lootDifficulties.includes(value as LootDifficulty) ? (value as LootDifficulty) : "heroic";
}

async function sendIcon(
  response: Response,
  cache: IconCache,
  icon: string,
  fileDataId = false,
  cacheKey = `${fileDataId ? "file" : "name"}:${icon}`,
  browserCache = true,
): Promise<void> {
  const source = fileDataId
    ? `https://render.worldofwarcraft.com/us/icons/56/${encodeURIComponent(icon)}.jpg`
    : `https://wow.zamimg.com/images/wow/icons/large/${encodeURIComponent(icon)}.jpg`;
  try {
    sendIconResponse(response, await cache.fetch(cacheKey, source), browserCache);
  } catch {
    if (icon !== "inv_misc_questionmark") {
      await sendIcon(response, cache, "inv_misc_questionmark", false, undefined, false);
      return;
    }
    response.status(503).end();
  }
}

function sendIconResponse(response: Response, body: Buffer, browserCache = true): void {
  if (browserCache) {
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  response.type("jpg").send(body);
}

export function parseWowheadItemDetails(xml: string): {
  itemLevel: number | null;
  iconName: string | null;
  tooltipLines: string[];
  statValues: Record<string, number>;
} {
  const itemLevel = Number(xml.match(/<level>(\d+)<\/level>/i)?.[1] || 0) || null;
  const iconName = xml.match(/<icon(?:\s[^>]*)?>([^<]+)<\/icon>/i)?.[1]?.trim() || null;
  const html = xml.match(/<htmlTooltip><!\[CDATA\[(.*?)\]\]><\/htmlTooltip>/is)?.[1] || "";
  const tooltipLines = [...html.matchAll(/<span[^>]*>(.*?)<\/span>/gis)]
    .map((match) => decodeHtmlText((match[1] || "").replace(/<!--.*?-->/gs, "").replace(/<[^>]+>/g, "")))
    .filter((line) => line && !/^\d+$/.test(line));
  const statValues: Record<string, number> = {};
  const statNames = [
    "智力", "敏捷", "力量", "全能", "急速", "精通", "暴击", "耐力", "护甲", "吸血", "闪避",
    "Intellect", "Agility", "Strength", "Versatility", "Haste", "Mastery", "Critical Strike", "Stamina", "Armor", "Leech", "Avoidance",
  ];
  for (const line of tooltipLines) {
    const match = line.match(/^\+?([\d,]+)\s*(.+)$/);
    if (!match) continue;
    const amount = match[1] || "";
    const label = match[2] || "";
    const adaptiveStats = adaptiveMainStats(label);
    if (adaptiveStats.length > 1) {
      const adaptiveAmount = Number(amount.replaceAll(",", ""));
      for (const stat of adaptiveStats) statValues[stat] = adaptiveAmount;
      continue;
    }
    const statName = statNames.find((name) => label === name || label.startsWith(name));
    if (statName) statValues[statName] = Number(amount.replaceAll(",", ""));
  }
  return { itemLevel, iconName, tooltipLines: [...new Set(tooltipLines)], statValues };
}

function adaptiveMainStats(label: string): string[] {
  if (!/(?:\bor\b|或|\/)/i.test(label)) return [];
  return ["智力", "敏捷", "力量", "Intellect", "Agility", "Strength"]
    .filter((stat) => label.includes(stat));
}

function decodeHtmlText(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\s+/g, " ")
    .trim();
}
