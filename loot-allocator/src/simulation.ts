import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LootDatabase } from "./db.js";
import type { CharacterLookup, DpsWowClient } from "./dpswow.js";
import { IntegrationError } from "./dpswow.js";
import type { LocalSimResult } from "./simc.js";
import { buildSimcArtifactName, formatLocalDate, runLocalSimc } from "./simc.js";
import type { Player } from "./types.js";

const staleWeightAgeMs = 24 * 60 * 60_000;

export type SimulationMode = "single" | "stale";

export interface SimulationFailure {
  playerId: string;
  playerName: string;
  message: string;
}

export interface SimulationStatus {
  running: boolean;
  runId: string | null;
  mode: SimulationMode | null;
  startedAt: string | null;
  finishedAt: string | null;
  currentPlayerId: string | null;
  currentPlayerName: string | null;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  failures: SimulationFailure[];
}

type CharacterClient = Pick<DpsWowClient, "lookupCharacter">;
type SimcRunner = typeof runLocalSimc;

export class SimulationService {
  private status: SimulationStatus = emptyStatus();
  private activeRun: Promise<void> | null = null;

  constructor(
    private readonly database: LootDatabase,
    private readonly dpsWow: CharacterClient,
    private readonly simcPath: string,
    private readonly simcRunsPath: string,
    private readonly runner: SimcRunner = runLocalSimc,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getStatus(): SimulationStatus {
    return structuredClone(this.status);
  }

  startSingle(playerId: string): SimulationStatus {
    this.assertIdle();
    const player = this.database.getPlayer(playerId);
    if (!player) throw new IntegrationError("Player not found", 404);
    if (!player.isActive) {
      throw new IntegrationError("SimC is only available to active players", 422);
    }
    return this.startRun("single", [player]);
  }

  startStale(): SimulationStatus {
    this.assertIdle();
    const cutoff = this.now().getTime() - staleWeightAgeMs;
    const players = this.database.listPlayers().filter((player) =>
      player.isActive
      && isWeightOlderThan(player.latestWeightFetchedAt, cutoff),
    );
    return this.startRun("stale", players);
  }

  async waitForIdle(): Promise<void> {
    await this.activeRun;
  }

  private assertIdle(): void {
    if (this.status.running) {
      throw new IntegrationError("A simulation is already running", 409, "SIMULATION_RUNNING");
    }
  }

  private startRun(mode: SimulationMode, players: Player[]): SimulationStatus {
    const startedAt = this.now();
    this.status = {
      ...emptyStatus(),
      running: players.length > 0,
      runId: randomUUID(),
      mode,
      startedAt: startedAt.toISOString(),
      finishedAt: players.length === 0 ? startedAt.toISOString() : null,
      total: players.length,
    };
    if (players.length === 0) return this.getStatus();

    this.activeRun = this.execute(players, startedAt).finally(() => {
      this.activeRun = null;
    });
    return this.getStatus();
  }

  private async execute(players: Player[], runStartedAt: Date): Promise<void> {
    const outputDirectory = join(this.simcRunsPath, formatLocalDate(runStartedAt));
    for (const player of players) {
      this.status.currentPlayerId = player.id;
      this.status.currentPlayerName = player.name;
      try {
        await this.simulatePlayer(player, outputDirectory);
        this.status.succeeded += 1;
      } catch (error) {
        this.status.failed += 1;
        this.status.failures.push({
          playerId: player.id,
          playerName: player.name,
          message: error instanceof Error ? error.message : String(error),
        });
        console.error(`[simulation] Failed ${player.name}:`, error);
      } finally {
        this.status.completed += 1;
      }
    }
    this.status.currentPlayerId = null;
    this.status.currentPlayerName = null;
    this.status.finishedAt = this.now().toISOString();
    this.status.running = false;
  }

  private async simulatePlayer(player: Player, outputDirectory: string): Promise<void> {
    const season = this.database.getActiveSeason();
    const character = await this.dpsWow.lookupCharacter(player.realmSlug, player.name);
    this.cacheCharacter(player, character, season.id, season.gameVersion);

    const simulationStartedAt = this.now();
    const result = await this.runner({
      simcPath: this.simcPath,
      outputDirectory,
      payload: character.rawPayload,
      artifactName: buildSimcArtifactName({
        playerName: character.name,
        realmName: character.realmName,
        simulatedAt: simulationStartedAt,
      }),
    });
    const simulatedAt = this.now().toISOString();
    this.database.saveWeightSnapshot({
      playerId: player.id,
      seasonId: season.id,
      source: "local-simc",
      sourceResultId: `local-${simulationStartedAt.toISOString()}-${player.id}`,
      sourceUrl: result.reportPath,
      sourcePlayerName: character.name,
      sourceRealmName: character.realmName,
      sourceCreatedAt: simulatedAt,
      fetchedAt: simulatedAt,
      gameVersion: result.gameVersion,
      gameBuild: result.gameBuild,
      baselineDps: result.baselineDps,
      weights: result.weights,
      sourcePayloadGzip: await buildSourcePayload(result),
    }, result.inferredMainStat);
  }

  private cacheCharacter(
    player: Player,
    character: CharacterLookup,
    seasonId: string,
    gameVersion: string,
  ): void {
    this.database.saveCharacterSnapshot({
      playerId: player.id,
      seasonId,
      fetchedAt: this.now().toISOString(),
      gameVersion,
      payloadGzip: gzipSync(JSON.stringify(character.rawPayload), { level: 9 }),
      level: character.level,
      averageItemLevel: character.averageItemLevel,
      equippedItemLevel: character.equippedItemLevel,
      equipment: character.equipment,
      source: "dpswow-cn-armory",
    });
    this.database.updatePlayerFromCharacter(player.id, character);
  }
}

export function isWeightOlderThan(value: string | null | undefined, cutoff: number): boolean {
  if (!value) return true;
  const timestamp = new Date(value).getTime();
  return !Number.isFinite(timestamp) || timestamp < cutoff;
}

async function buildSourcePayload(result: LocalSimResult): Promise<Buffer> {
  return gzipSync(JSON.stringify({
    profile: await readFile(result.profilePath, "utf8"),
    report: result.report,
    simcVersion: result.simcVersion,
  }), { level: 9 });
}

function emptyStatus(): SimulationStatus {
  return {
    running: false,
    runId: null,
    mode: null,
    startedAt: null,
    finishedAt: null,
    currentPlayerId: null,
    currentPlayerName: null,
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    failures: [],
  };
}
