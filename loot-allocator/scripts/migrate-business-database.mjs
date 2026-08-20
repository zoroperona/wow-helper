import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationPath = resolve(projectRoot, "migrations", "business", "0005_baseline.mjs");
const options = parseArgs(process.argv.slice(2));
const databasePath = resolve(options.database);
await access(databasePath, fsConstants.R_OK | fsConstants.W_OK);
const migrationBytes = await readFile(migrationPath);
const checksum = createHash("sha256").update(migrationBytes).digest("hex");
const migration = (await import(`${pathToFileURL(migrationPath).href}?checksum=${checksum}`)).default;

const database = new DatabaseSync(databasePath);
try {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (options.mode === "fingerprint") {
    console.log(schemaFingerprint(database));
  } else if (options.mode === "baseline") {
    baseline(database, migration, checksum);
  } else {
    check(database, migration, checksum);
  }
} finally {
  database.close();
}

function baseline(database, migration, checksum) {
  const hasMigrations = tableExists(database, "schema_migrations");
  const hasAttempts = tableExists(database, "migration_attempts");
  if (hasMigrations !== hasAttempts) {
    throw new Error("migration ledger 只有部分表存在，schema 状态不可信");
  }
  const existing = hasMigrations
    ? database.prepare("SELECT * FROM schema_migrations WHERE migration_id = ?").get(migration.migrationId)
    : null;
  if (existing) {
    verifySuccess(database, existing, migration, checksum);
    console.log(`[migration] ${migration.migrationId} already applied`);
    return;
  }
  if (hasAttempts) {
    assertNoUntrustedAttempts(database);
  }

  const schemaVersion = database.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get()?.value;
  if (String(schemaVersion) !== String(migration.fromSchema)) {
    throw new Error(`baseline 只接受 schema ${migration.fromSchema}，当前为 ${schemaVersion || "unknown"}`);
  }
  const beforeFingerprint = schemaFingerprint(database);
  if (!migration.acceptedPreFingerprints.includes(beforeFingerprint)) {
    throw new Error(`schema 指纹未获准建立 baseline：${beforeFingerprint}`);
  }

  const attemptId = randomUUID();
  const startedAt = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(migration.sql);
    database.prepare(`
      INSERT INTO migration_attempts (
        attempt_id, migration_id, checksum, from_schema, to_schema, status,
        started_at, before_fingerprint
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(attemptId, migration.migrationId, checksum, migration.fromSchema, migration.toSchema, startedAt, beforeFingerprint);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const afterFingerprint = schemaFingerprint(database);
  const verification = JSON.stringify({ quickCheck: quickCheck(database), schemaVersion: Number(schemaVersion) });
  if (JSON.parse(verification).quickCheck !== "ok") {
    throw new Error("baseline 后 SQLite quick_check 失败，attempt 保持 running");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const finishedAt = new Date().toISOString();
    database.prepare(`
      INSERT INTO schema_migrations (
        migration_id, checksum, from_schema, to_schema, applied_at,
        before_fingerprint, after_fingerprint, verification_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      migration.migrationId, checksum, migration.fromSchema, migration.toSchema,
      finishedAt, beforeFingerprint, afterFingerprint, verification,
    );
    const update = database.prepare(`
      UPDATE migration_attempts
         SET status = 'success', finished_at = ?, after_fingerprint = ?, verification_json = ?
       WHERE attempt_id = ? AND status = 'running' AND checksum = ?
    `).run(finishedAt, afterFingerprint, verification, attemptId, checksum);
    if (Number(update.changes) !== 1) {
      throw new Error("migration attempt 条件更新失败");
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  console.log(`[migration] ${migration.migrationId} applied (${checksum})`);
}

function check(database, migration, checksum) {
  if (!tableExists(database, "schema_migrations") || !tableExists(database, "migration_attempts")) {
    throw new Error("业务库尚未建立外部 migration baseline");
  }
  assertNoUntrustedAttempts(database);
  const row = database.prepare("SELECT * FROM schema_migrations WHERE migration_id = ?").get(migration.migrationId);
  if (!row) throw new Error(`缺少 migration：${migration.migrationId}`);
  verifySuccess(database, row, migration, checksum);
  console.log(`[migration] schema trusted at ${migration.migrationId}`);
}

function verifySuccess(database, row, migration, checksum) {
  if (row.checksum !== checksum) {
    throw new Error(`migration checksum 冲突：${migration.migrationId}`);
  }
  if (Number(row.from_schema) !== migration.fromSchema || Number(row.to_schema) !== migration.toSchema) {
    throw new Error(`migration schema 范围冲突：${migration.migrationId}`);
  }
  const fingerprint = schemaFingerprint(database);
  if (row.after_fingerprint !== fingerprint) {
    throw new Error(`当前 schema 指纹与成功记录不一致：${fingerprint}`);
  }
  if (quickCheck(database) !== "ok") throw new Error("SQLite quick_check 失败");
}

function assertNoUntrustedAttempts(database) {
  const row = database.prepare(`
    SELECT attempt_id, migration_id, status
      FROM migration_attempts
     WHERE status IN ('running', 'unknown')
  ORDER BY started_at DESC LIMIT 1
  `).get();
  if (row) {
    throw new Error(`存在未可信 migration attempt：${row.attempt_id}/${row.migration_id}/${row.status}`);
  }
}

function schemaFingerprint(database) {
  const excluded = new Set(["schema_migrations", "migration_attempts"]);
  const objects = database.prepare(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
       AND type IN ('table', 'index', 'trigger', 'view')
  ORDER BY type, name
  `).all()
    .filter((row) => !excluded.has(String(row.name)))
    .filter((row) => !String(row.name).startsWith("schema_migrations_") && !String(row.name).startsWith("migration_attempts_"))
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      table: String(row.tbl_name),
      sql: normalizeSql(row.sql),
    }));
  const canonical = JSON.stringify(objects);
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizeSql(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function quickCheck(database) {
  return String(database.prepare("PRAGMA quick_check").get()?.quick_check || "unknown");
}

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

function parseArgs(args) {
  const parsed = { database: process.env.LOOT_ALLOCATOR_DB || "", mode: "check" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--database") parsed.database = args[++index] || "";
    else if (argument === "--baseline") parsed.mode = "baseline";
    else if (argument === "--check") parsed.mode = "check";
    else if (argument === "--print-fingerprint") parsed.mode = "fingerprint";
    else throw new Error(`未知参数：${argument}`);
  }
  if (!parsed.database) {
    throw new Error("必须通过 --database 或 LOOT_ALLOCATOR_DB 指定业务库");
  }
  return parsed;
}
