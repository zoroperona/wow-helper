import { join } from "node:path";
import { config } from "../dist/config.js";
import { LootDatabase } from "../dist/db.js";

const database = await LootDatabase.open(config.databasePath);
try {
  const season = database.getActiveSeason().seasonKey;
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const destination = join(config.backupsPath, `wow-loot-${season}-${timestamp}.sqlite`);
  await database.backup(destination);
  console.log(`[backup] ${destination}`);
} finally {
  database.close();
}
