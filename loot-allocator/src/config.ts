import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const config = {
  port: Number(process.env.PORT || 5070),
  databasePath: resolve(
    process.env.LOOT_ALLOCATOR_DB || resolve(appRoot, "data", "loot-allocator.sqlite"),
  ),
  publicPath: resolve(appRoot, "public"),
  backupsPath: resolve(appRoot, "backups"),
  iconCachePath: resolve(
    process.env.ICON_CACHE_PATH || resolve(appRoot, "data", "icon-cache"),
  ),
  armorySessionPath: resolve(
    process.env.ARMORY_SESSION_PATH
      || resolve(homedir(), ".wow-loot-allocator", "armory-browser"),
  ),
  wowDbPath: resolve(
    process.env.WOW_DB_PATH || resolve(appRoot, "..", "wow-db", "output", "wow.sqlite"),
  ),
  simcPath: resolve(
    process.env.SIMC_PATH ||
      resolve(homedir(), "Library", "Application Support", "wow-helper", "simc", "1210-01", "simc"),
  ),
  simcRunsPath: resolve(
    process.env.SIMC_RUNS_PATH || resolve(appRoot, "data", "simc-runs"),
  ),
  dailyTaskStatusPath: resolve(
    process.env.DAILY_TASK_STATUS_PATH || resolve(appRoot, "data", "runtime", "daily-sim-status.json"),
  ),
  scheduledTaskExpected: process.env.SCHEDULED_TASK_EXPECTED === "1",
};
