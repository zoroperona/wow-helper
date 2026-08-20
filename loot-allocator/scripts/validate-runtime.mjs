import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { config } from "../dist/config.js";

for (const [label, path] of [
  ["SimulationCraft", config.simcPath],
  ["业务数据库", config.databasePath],
  ["wow-db", config.wowDbPath],
]) {
  await access(path, fsConstants.R_OK);
  console.log(`[runtime] ${label}: ${path}`);
}

const simc = spawnSync(config.simcPath, ["--version"], { encoding: "utf8", timeout: 10_000 });
const simcOutput = `${simc.stdout || ""}${simc.stderr || ""}`;
if (!/SimulationCraft\s+\S+.*World of Warcraft\s+[\d.]+/s.test(simcOutput)) {
  throw new Error("无法读取 SimulationCraft 版本");
}

for (const [label, path] of [["业务数据库", config.databasePath], ["wow-db", config.wowDbPath]]) {
  const sqlite = new DatabaseSync(path, { readOnly: true });
  try {
    const result = String(sqlite.prepare("PRAGMA quick_check").get()?.quick_check || "unknown");
    if (result !== "ok") throw new Error(`${label}完整性检查失败：${result}`);
  } finally {
    sqlite.close();
  }
}
