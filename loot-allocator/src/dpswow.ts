import { gzipSync } from "node:zlib";
import type { MainStat, StatWeights, WeightSnapshot } from "./types.js";
import { isDamageRole } from "./types.js";
import type { LootDatabase } from "./db.js";
import { normalizeCharacterEquipment } from "./equipment.js";
import type { EquippedItem } from "./types.js";

const apiBaseUrl = "https://api.dpswow.com";
const resultIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface CharacterLookup {
  name: string;
  realmName: string;
  realmSlug: string;
  className: string;
  specialization: string;
  level: number;
  averageItemLevel: number;
  equippedItemLevel: number;
  equipment: EquippedItem[];
  rawPayload: unknown;
}

export interface RealmReference {
  id: number;
  name: string;
  slug: string;
}

export interface ImportedWeightResult {
  resultId: string;
  resultUrl: string;
  sourcePlayerName: string;
  sourceRealmName: string;
  sourceCreatedAt: string | null;
  gameVersion: string;
  gameBuild: number | null;
  baselineDps: number | null;
  weights: StatWeights;
  inferredMainStat: MainStat | null;
  sourcePayloadGzip: Buffer;
}

type FetchLike = typeof fetch;

export class DpsWowClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async lookupCharacter(realmSlug: string, characterName: string): Promise<CharacterLookup> {
    const url = new URL("/open/character/character/query", apiBaseUrl);
    url.searchParams.set("realm_slug", realmSlug);
    url.searchParams.set("role_name", characterName);
    const payload = await this.getDpsWowPayload(url);
    const summary = asRecord(asRecord(payload).character_summary);
    const realm = asRecord(summary.realm);
    const characterClass = asRecord(summary.character_class);
    const activeSpec = asRecord(summary.active_spec);
    const name = textValue(summary.name);
    const normalizedRealmSlug = textValue(realm.slug);
    if (!name || !normalizedRealmSlug) {
      throw new IntegrationError("DPSWOW character response is missing identity fields");
    }
    const equipment = normalizeCharacterEquipment(payload);
    return {
      name,
      realmName: textValue(realm.name),
      realmSlug: normalizedRealmSlug,
      className: textValue(characterClass.name),
      specialization: textValue(activeSpec.name),
      level: equipment.level,
      averageItemLevel: equipment.averageItemLevel,
      equippedItemLevel: equipment.equippedItemLevel,
      equipment: equipment.items,
      rawPayload: payload,
    };
  }

  async listRealms(): Promise<RealmReference[]> {
    const payload = await this.getJson(
      new URL("https://public.dpswow.com/wow/data/wow_servers.json"),
    );
    if (!Array.isArray(payload)) {
      throw new IntegrationError("DPSWOW realm list has an invalid format");
    }
    return payload
      .map((entry) => {
        const realm = asRecord(entry);
        return {
          id: numberValue(realm.id),
          name: textValue(realm.name),
          slug: textValue(realm.slug),
        };
      })
      .filter((realm) => realm.name && realm.slug);
  }

  async importWeightResult(resultLinkOrId: string): Promise<ImportedWeightResult> {
    const resultId = parseResultId(resultLinkOrId);
    const metadataUrl = new URL("/app/simc/userSimcRecord/info", apiBaseUrl);
    metadataUrl.searchParams.set("id", resultId);
    const metadataPayload = await this.getDpsWowPayload(metadataUrl);
    const result = asRecord(asRecord(metadataPayload).result);
    const playerInfo = asRecord(result.playerInfo);
    const rawResultUrl = textValue(result.rawResultUrl);
    assertTrustedPublicUrl(rawResultUrl);

    const report = await this.getJson(new URL(rawResultUrl));
    const reportRoot = asRecord(report);
    const sim = asRecord(reportRoot.sim);
    const players = Array.isArray(sim.players) ? sim.players : [];
    const reportPlayer = asRecord(players[0]);
    const scaleFactors = asRecord(reportPlayer.scale_factors);
    const weights = normalizeWeights(scaleFactors);
    if (Object.values(weights).every((value) => value === 0)) {
      throw new IntegrationError("The DPSWOW result does not contain stat weights", 422);
    }

    const options = asRecord(sim.options);
    const dbc = asRecord(options.dbc);
    const versionChannel = textValue(dbc.version_used) || "Live";
    const build = asRecord(dbc[versionChannel]);
    const collectedData = asRecord(reportPlayer.collected_data);
    const dps = asRecord(collectedData.dps);

    return {
      resultId,
      resultUrl: canonicalResultUrl(resultId),
      sourcePlayerName: textValue(playerInfo.playerName) || textValue(reportPlayer.name),
      sourceRealmName: textValue(playerInfo.server),
      sourceCreatedAt: nullableText(result.createTime),
      gameVersion: textValue(build.wow_version) || textValue(reportRoot.version) || "unknown",
      gameBuild: nullableNumber(build.build_level),
      baselineDps: nullableNumber(result.bestDps) ?? nullableNumber(dps.mean),
      weights,
      inferredMainStat: inferMainStat(weights),
      sourcePayloadGzip: gzipSync(
        JSON.stringify({ metadata: metadataPayload, report }),
        { level: 9 },
      ),
    };
  }

  private async getDpsWowPayload(url: URL): Promise<unknown> {
    const envelope = asRecord(await this.getJson(url));
    const code = numberValue(envelope.code);
    if (code !== 1000) {
      throw new IntegrationError(textValue(envelope.message) || "DPSWOW request failed", 422);
    }
    return envelope.data;
  }

  private async getJson(url: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "wow-loot-allocator/0.1",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new IntegrationError(
        `Unable to reach DPSWOW: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new IntegrationError(`DPSWOW returned HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new IntegrationError("DPSWOW returned invalid JSON");
    }
  }
}

export class WeightImportService {
  constructor(
    private readonly database: LootDatabase,
    private readonly dpsWow: DpsWowClient,
  ) {}

  async importForPlayer(playerId: string, resultUrl: string): Promise<WeightSnapshot> {
    const player = this.database.getPlayer(playerId);
    if (!player) {
      throw new IntegrationError("Player not found", 404);
    }
    if (!isDamageRole(player.raidRole)) {
      throw new IntegrationError("Stat weights are only available to melee and ranged players", 422);
    }
    const imported = await this.dpsWow.importWeightResult(resultUrl);
    if (!sameIdentity(player.name, imported.sourcePlayerName)) {
      throw new IntegrationError(
        `Result belongs to ${imported.sourcePlayerName || "another character"}, not ${player.name}`,
        409,
      );
    }
    const season = this.database.getActiveSeason();
    return this.database.saveWeightSnapshot(
      {
        playerId,
        seasonId: season.id,
        sourceResultId: imported.resultId,
        sourceUrl: imported.resultUrl,
        sourcePlayerName: imported.sourcePlayerName,
        sourceRealmName: imported.sourceRealmName,
        sourceCreatedAt: imported.sourceCreatedAt,
        fetchedAt: new Date().toISOString(),
        gameVersion: imported.gameVersion,
        gameBuild: imported.gameBuild,
        baselineDps: imported.baselineDps,
        weights: imported.weights,
        sourcePayloadGzip: imported.sourcePayloadGzip,
      },
      imported.inferredMainStat,
    );
  }
}

export function parseResultId(value: string): string {
  const trimmed = value.trim();
  if (resultIdPattern.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new IntegrationError("Enter a valid DPSWOW weight result link", 400);
  }
  if (url.hostname !== "www.dpswow.com" || url.pathname !== "/gear/result/weight") {
    throw new IntegrationError("Only DPSWOW weight result links are supported", 400);
  }
  const id = url.searchParams.get("id") || "";
  if (!resultIdPattern.test(id)) {
    throw new IntegrationError("The DPSWOW result link has no valid result ID", 400);
  }
  return id.toLowerCase();
}

export function normalizeWeights(scaleFactors: Record<string, unknown>): StatWeights {
  return {
    intellect: numberValue(scaleFactors.Int),
    agility: numberValue(scaleFactors.Agi),
    strength: numberValue(scaleFactors.Str),
    versatility: numberValue(scaleFactors.Vers),
    haste: numberValue(scaleFactors.Haste),
    mastery: numberValue(scaleFactors.Mastery),
    criticalStrike: numberValue(scaleFactors.Crit),
  };
}

function inferMainStat(weights: StatWeights): MainStat | null {
  const candidates: Array<[MainStat, number]> = [
    ["strength", weights.strength],
    ["agility", weights.agility],
    ["intellect", weights.intellect],
  ];
  candidates.sort((left, right) => right[1] - left[1]);
  return candidates[0] && candidates[0][1] > 0 ? candidates[0][0] : null;
}

function canonicalResultUrl(resultId: string): string {
  const url = new URL("https://www.dpswow.com/gear/result/weight");
  url.searchParams.set("id", resultId);
  url.searchParams.set("fromType", "run");
  return url.toString();
}

function assertTrustedPublicUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IntegrationError("DPSWOW returned an invalid report URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "public.dpswow.com") {
    throw new IntegrationError("DPSWOW returned an untrusted report URL");
  }
}

function sameIdentity(left: string, right: string): boolean {
  return left.normalize("NFKC").toLocaleLowerCase() === right.normalize("NFKC").toLocaleLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  const text = textValue(value).trim();
  return text || null;
}

function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}
