import { gzipSync } from "node:zlib";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { LootDatabase } from "./db.js";
import { DpsWowClient } from "./dpswow.js";
import { buildSimcArtifactName, formatLocalDate, runLocalSimc } from "./simc.js";
import { writeDailyTaskStatus, type DailyTaskStatus } from "./task-status.js";

const database = await LootDatabase.open(config.databasePath);
const dpsWow = new DpsWowClient();
const runStartedAt = new Date();
const runDirectory = join(config.simcRunsPath, formatLocalDate(runStartedAt));
await mkdir(runDirectory, { recursive: true });

let succeeded = 0;
let failed = 0;
const failures: DailyTaskStatus["failures"] = [];
let total = 0;
try {
  const season = database.getActiveSeason();
  const players = database.listPlayers().filter(
    (player) => player.isActive,
  );
  total = players.length;
  await persistStatus("running");
  console.log(`[daily-sim] Starting ${players.length} characters at ${runStartedAt.toISOString()}`);
  for (const player of players) {
    try {
      console.log(`[daily-sim] Refreshing ${player.name}-${player.realmName}`);
      const character = await dpsWow.lookupCharacter(player.realmSlug, player.name);
      const fetchedAt = new Date().toISOString();
      database.saveCharacterSnapshot({
        playerId: player.id,
        seasonId: season.id,
        fetchedAt,
        gameVersion: season.gameVersion,
        payloadGzip: gzipSync(JSON.stringify(character.rawPayload), { level: 9 }),
        level: character.level,
        averageItemLevel: character.averageItemLevel,
        equippedItemLevel: character.equippedItemLevel,
        equipment: character.equipment,
      });
      database.updatePlayerFromCharacter(player.id, character);

      console.log(`[daily-sim] Simulating ${player.name}`);
      const simulationStartedAt = new Date();
      const result = await runLocalSimc({
        simcPath: config.simcPath,
        outputDirectory: runDirectory,
        payload: character.rawPayload,
        artifactName: buildSimcArtifactName({
          playerName: character.name,
          realmName: character.realmName,
          simulatedAt: simulationStartedAt,
        }),
      });
      const simulatedAt = new Date().toISOString();
      database.saveWeightSnapshot({
        playerId: player.id,
        seasonId: season.id,
        source: "local-simc",
        sourceResultId: `local-${runStartedAt.toISOString()}-${player.id}`,
        sourceUrl: result.reportPath,
        sourcePlayerName: character.name,
        sourceRealmName: character.realmName,
        sourceCreatedAt: simulatedAt,
        fetchedAt: simulatedAt,
        gameVersion: result.gameVersion,
        gameBuild: result.gameBuild,
        baselineDps: result.baselineDps,
        weights: result.weights,
        sourcePayloadGzip: gzipSync(JSON.stringify({
          profile: await readFile(result.profilePath, "utf8"),
          report: result.report,
          simcVersion: result.simcVersion,
        }), { level: 9 }),
      }, result.inferredMainStat);
      succeeded += 1;
      console.log(`[daily-sim] Completed ${player.name}: ${Math.round(result.baselineDps || 0)} DPS`);
    } catch (error) {
      failed += 1;
      failures.push({
        playerId: player.id,
        playerName: player.name,
        message: error instanceof Error ? error.message : String(error),
      });
      console.error(`[daily-sim] Failed ${player.name}:`, error);
    }
  }
} finally {
  database.close();
}

await persistStatus(failed > 0 ? "failed" : "succeeded");
console.log(`[daily-sim] Finished: ${succeeded} succeeded, ${failed} failed; artifacts: ${runDirectory}`);
if (failed > 0) process.exitCode = 1;

async function persistStatus(status: DailyTaskStatus["status"]): Promise<void> {
  await writeDailyTaskStatus(config.dailyTaskStatusPath, {
    schemaVersion: 1,
    status,
    mode: "daily",
    phase: status === "running" ? "simulation" : "simulation-complete",
    startedAt: runStartedAt.toISOString(),
    finishedAt: status === "running" ? null : new Date().toISOString(),
    total,
    completed: succeeded + failed,
    succeeded,
    failed,
    failures,
  });
}
