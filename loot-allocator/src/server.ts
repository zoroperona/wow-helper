import { createApp } from "./app.js";
import { config } from "./config.js";
import { LootDatabase } from "./db.js";
import { DpsWowClient } from "./dpswow.js";
import { WowDbCatalog } from "./wowdb.js";
import { BlizzardArmoryClient } from "./armory.js";
import { SimulationService } from "./simulation.js";
import { SystemHealthService } from "./system-health.js";
import { appRoot } from "./config.js";

const database = await LootDatabase.open(config.databasePath);
const wowDb = new WowDbCatalog(config.wowDbPath, "12.1", "12.1");
const dpsWow = new DpsWowClient();
const simulations = new SimulationService(
  database,
  dpsWow,
  config.simcPath,
  config.simcRunsPath,
);
const app = createApp({
  database,
  armory: new BlizzardArmoryClient(config.armorySessionPath),
  dpsWow,
  wowDb,
  publicPath: config.publicPath,
  backupsPath: config.backupsPath,
  iconCachePath: config.iconCachePath,
  simulations,
  health: new SystemHealthService({
    simcPath: config.simcPath,
    simcRunsPath: config.simcRunsPath,
    wowDbPath: config.wowDbPath,
    databasePath: config.databasePath,
    backupsPath: config.backupsPath,
    backupHealthPath: config.backupHealthPath,
    appRoot,
    dailyTaskStatusPath: config.dailyTaskStatusPath,
    scheduledTaskExpected: config.scheduledTaskExpected,
  }),
  simcPath: config.simcPath,
});

const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(`WoW Loot Allocator: http://127.0.0.1:${config.port}`);
  console.log(`Database: ${config.databasePath}`);
});

function shutdown() {
  server.close(() => {
    wowDb.close();
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
