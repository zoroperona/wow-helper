import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const options = parseArgs(process.argv.slice(2));
const sourcePath = resolve(options.database);
const outputRoot = resolve(options.output);
await stat(sourcePath);
await mkdir(outputRoot, { recursive: true });

const generatedAt = new Date().toISOString();
const backupId = `backup-v1-${generatedAt.replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID()}`;
const bundleDirectory = join(outputRoot, backupId);
await mkdir(bundleDirectory);
const incomingPath = join(bundleDirectory, "business.sqlite.incoming");
const snapshotPath = join(bundleDirectory, "business.sqlite");
const manifestPath = join(bundleDirectory, "backup-manifest.v1.json");

const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await sqliteBackup(source, incomingPath);
} finally {
  source.close();
}

const inspection = inspectSnapshot(incomingPath);
if (inspection.quickCheck !== "ok") {
  throw new Error(`备份 SQLite quick_check 失败：${inspection.quickCheck}`);
}
await rename(incomingPath, snapshotPath);
const snapshotStat = await stat(snapshotPath);
const snapshotSha256 = await sha256File(snapshotPath);
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const manifest = {
  manifestVersion: "backup-manifest/v1",
  backupId,
  generatedAt,
  reason: options.reason,
  application: {
    version: String(packageJson.version || "unknown"),
    commit: resolveCommit(),
  },
  database: {
    logicalId: "wow-helper-business-main",
    sourceFileName: basename(sourcePath),
    schemaVersion: inspection.schemaVersion,
    migrationId: inspection.migrationId,
    quickCheck: inspection.quickCheck,
    file: "business.sqlite",
    bytes: snapshotStat.size,
    sha256: snapshotSha256,
    rowCounts: inspection.rowCounts,
  },
  expectedTargetIds: options.targets,
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
const manifestSha256 = await sha256File(manifestPath);

console.log(JSON.stringify({
  status: "prepared",
  backupId,
  generatedAt,
  bundleDirectory,
  snapshotSha256,
  manifestSha256,
}, null, 2));

function inspectSnapshot(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const scalar = (sql) => database.prepare(sql).get()?.value;
    const tableCount = (table) => Number(database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get()?.value || 0);
    const hasMigrations = Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get());
    return {
      quickCheck: String(database.prepare("PRAGMA quick_check").get()?.quick_check || "unknown"),
      schemaVersion: String(scalar("SELECT value FROM app_meta WHERE key = 'schema_version'") || "unknown"),
      migrationId: hasMigrations
        ? String(database.prepare("SELECT migration_id AS value FROM schema_migrations ORDER BY to_schema DESC, migration_id DESC LIMIT 1").get()?.value || "unbaselined")
        : "unbaselined",
      rowCounts: {
        seasons: tableCount("seasons"),
        players: tableCount("players"),
        characterSnapshots: tableCount("character_snapshots"),
        statWeightSnapshots: tableCount("stat_weight_snapshots"),
        lootRules: tableCount("loot_rules"),
        lootAllocations: tableCount("loot_allocations"),
      },
    };
  } finally {
    database.close();
  }
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function resolveCommit() {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: resolve(projectRoot, ".."), encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function parseArgs(args) {
  const parsed = {
    database: process.env.LOOT_ALLOCATOR_DB || "",
    output: process.env.BACKUP_STAGING_PATH || "",
    reason: "scheduled",
    targets: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--database") parsed.database = args[++index] || "";
    else if (argument === "--output") parsed.output = args[++index] || "";
    else if (argument === "--reason") parsed.reason = args[++index] || "";
    else if (argument === "--target") parsed.targets.push(args[++index] || "");
    else throw new Error(`未知参数：${argument}`);
  }
  if (!parsed.database || !parsed.output) {
    throw new Error("必须指定 --database/LOOT_ALLOCATOR_DB 和 --output/BACKUP_STAGING_PATH");
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(parsed.reason)) {
    throw new Error("reason 只能是 lowercase slug");
  }
  if (parsed.targets.length !== 2 || new Set(parsed.targets).size !== 2 || parsed.targets.some((target) => !/^[a-z][a-z0-9-]{0,31}$/.test(target))) {
    throw new Error("必须提供两个不同且格式有效的 --target");
  }
  return parsed;
}
