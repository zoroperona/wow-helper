import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  access, copyFile, link, mkdir, mkdtemp, readFile, rename, rm, stat,
} from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultTarget = resolve(projectRoot, "../wow-db/output/wow.sqlite");
const criticalTables = [
  "__wowdb_tables", "JournalInstance", "JournalEncounter", "JournalEncounterItem",
  "Item", "ItemSparse", "ItemSet", "ItemSetSpell", "SpellName", "ItemBonus",
  "ItemBonusListGroupEntry", "RandPropPoints", "CombatRatingsMultByILvl",
  "StaminaMultByILvl", "ItemSocketCostPerLevel",
];

const options = parseArgs(process.argv.slice(2));
if (!options.source) usage();
const source = resolve(options.source);
const target = resolve(options.target || process.env.WOW_DB_PATH || defaultTarget);
let temporary = null;

try {
  const packageRoot = extname(source).toLowerCase() === ".zip"
    ? await extractZip(source)
    : source;
  if (!(await isReadable(packageRoot))) throw new Error(`交接包不存在：${packageRoot}`);
  const result = await validatePackage(packageRoot, target, options.allowDowngrade);
  console.log(`[wow-db] 交接包校验通过：${result.build} / ${result.locale}`);
  console.log(`[wow-db] SQLite：${formatBytes(result.databaseBytes)} / ${result.sha256}`);
  if (result.hotfixLayerIncluded === false) {
    console.warn("[wow-db] 注意：该快照不包含 DBCache.bin 热修正层");
  } else if (result.hotfixLayerIncluded === true) {
    console.log(`[wow-db] 热修：build ${result.hotfixBuild || "未知"} / HTFX v${result.hotfixFormatVersion || "未知"} / ${result.hotfixSha256}`);
  }
  if (options.checkOnly) process.exit(0);

  assertTargetNotOpen(target);
  await installDatabase(result.databasePath, target, result.currentBuild);
  console.log(`[wow-db] 已原子切换：${target}`);
  console.log("[wow-db] 请重启本地应用，使其打开新的数据库文件");
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}

async function extractZip(path) {
  temporary = await mkdtemp(join(tmpdir(), "wow-db-import-"));
  const result = extractZipWithPlatformTool(path, temporary);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "无法解压交接包");
  return temporary;
}

function extractZipWithPlatformTool(path, destination) {
  if (process.platform === "win32") {
    const powershell = process.env.WOWHELPER_PWSH_PATH || "pwsh.exe";
    const env = {
      ...process.env,
      WOWHELPER_ZIP_PATH: path,
      WOWHELPER_ZIP_DESTINATION: destination,
    };
    return spawnSync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:WOWHELPER_ZIP_PATH -DestinationPath $env:WOWHELPER_ZIP_DESTINATION -Force",
    ], { encoding: "utf8", env });
  }
  if (process.platform === "darwin") {
    return spawnSync("ditto", ["-x", "-k", path, destination], { encoding: "utf8" });
  }
  return spawnSync("unzip", ["-q", path, "-d", destination], { encoding: "utf8" });
}

async function validatePackage(root, targetPath, allowDowngrade) {
  const manifestPath = join(root, "transfer-manifest.json");
  const snapshotPath = join(root, "snapshot.json");
  const reportPath = join(root, "report.json");
  const manifest = await readJson(manifestPath);
  const snapshot = await readJson(snapshotPath);
  const report = await readJson(reportPath);
  if (manifest.schemaVersion !== 1) throw new Error("不支持的交接包版本");
  if (manifest.product !== "wow" || manifest.region !== "cn" || manifest.locale !== "zhCN") {
    throw new Error(`交接包身份不符：${manifest.product}/${manifest.region}/${manifest.locale}`);
  }
  if (!snapshot.completedAt) throw new Error("快照尚未完成");
  if (snapshot.build !== manifest.build || snapshot.locale !== manifest.locale) {
    throw new Error("交接清单与 snapshot.json 身份不一致");
  }
  if ((manifest.hotfixLayerIncluded === true) !== Boolean(snapshot.hotfixSha256)) {
    throw new Error("交接清单与 snapshot.json 热修身份不一致");
  }
  if (manifest.hotfixLayerIncluded === true && String(manifest.hotfixSha256).toLowerCase() !== String(snapshot.hotfixSha256).toLowerCase()) {
    throw new Error("交接清单与 snapshot.json 热修 SHA-256 不一致");
  }
  if (manifest.hotfixLayerIncluded === true && String(report.hotfixSha256).toLowerCase() !== String(manifest.hotfixSha256).toLowerCase()) {
    throw new Error("交接清单与 report.json 热修 SHA-256 不一致");
  }
  if (manifest.hotfixLayerIncluded === true && Number(report.hotfixFormatVersion) !== Number(manifest.hotfixFormatVersion)) {
    throw new Error("交接清单与 report.json 热修格式版本不一致");
  }
  if (Number(report.failed) !== 0 || (Array.isArray(report.failures) && report.failures.length)) {
    throw new Error(`快照包含失败表：${report.failed || report.failures.length}`);
  }
  const databasePath = join(root, basename(manifest.databaseFile || "wow.sqlite"));
  const databaseStat = await stat(databasePath);
  if (databaseStat.size !== Number(manifest.databaseBytes)) throw new Error("SQLite 文件大小与交接清单不一致");
  const sha256 = await sha256File(databasePath);
  if (sha256 !== String(manifest.databaseSha256).toLowerCase()) throw new Error("SQLite SHA-256 校验失败");

  const identity = inspectDatabase(databasePath);
  if (identity.integrity !== "ok") throw new Error(`SQLite 完整性检查失败：${identity.integrity}`);
  if (identity.locale !== "zhCN" || identity.build !== manifest.build) {
    throw new Error(`SQLite 身份不符：${identity.build}/${identity.locale}`);
  }
  const missing = criticalTables.filter((table) => !identity.tables.has(table));
  if (missing.length) throw new Error(`SQLite 缺少关键表：${missing.join("、")}`);
  if (manifest.hotfixLayerIncluded === true && identity.hotfixSha256 !== String(manifest.hotfixSha256).toLowerCase()) {
    throw new Error("SQLite 与交接清单热修 SHA-256 不一致");
  }
  if (manifest.hotfixLayerIncluded !== true && identity.hotfixSha256) {
    throw new Error("SQLite 包含未在交接清单声明的热修层");
  }

  const current = await isReadable(targetPath) ? inspectDatabase(targetPath) : null;
  if (current && !allowDowngrade && buildNumber(identity.build) < buildNumber(current.build)) {
    throw new Error(`拒绝降级：当前 ${current.build}，交接包 ${identity.build}`);
  }
  return {
    build: identity.build,
    locale: identity.locale,
    databasePath,
    databaseBytes: databaseStat.size,
    sha256,
    hotfixLayerIncluded: manifest.hotfixLayerIncluded,
    hotfixBuild: manifest.hotfixBuild || null,
    hotfixFormatVersion: manifest.hotfixFormatVersion || null,
    hotfixSha256: manifest.hotfixSha256 || null,
    currentBuild: current?.build || null,
  };
}

function inspectDatabase(path) {
  const url = pathToFileURL(path);
  url.searchParams.set("immutable", "1");
  const sqlite = new DatabaseSync(url, { readOnly: true });
  try {
    const integrity = String(sqlite.prepare("PRAGMA quick_check").get()?.quick_check || "unknown");
    const columns = sqlite.prepare("PRAGMA table_info('__wowdb_tables')").all();
    const hasHotfixColumn = columns.some((column) => column.name === "hotfix_sha256");
    const metadata = sqlite.prepare("SELECT build, locale FROM __wowdb_tables ORDER BY completed_at DESC LIMIT 1").get() || {};
    const hotfixRows = hasHotfixColumn
      ? sqlite.prepare("SELECT DISTINCT hotfix_sha256 FROM __wowdb_tables WHERE hotfix_sha256 IS NOT NULL").all()
      : [];
    if (hotfixRows.length > 1) throw new Error("SQLite 包含多个热修 SHA-256，快照已混合");
    const tables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    return {
      integrity,
      build: String(metadata.build || ""),
      locale: String(metadata.locale || ""),
      hotfixSha256: hotfixRows[0]?.hotfix_sha256 ? String(hotfixRows[0].hotfix_sha256).toLowerCase() : null,
      tables,
    };
  } finally {
    sqlite.close();
  }
}

function assertTargetNotOpen(path) {
  if (process.platform === "win32") {
    const handlePath = process.env.WOWHELPER_HANDLE_PATH;
    if (!handlePath) {
      throw new Error("Windows 导入必须由 runtime wrapper 提供 WOWHELPER_HANDLE_PATH，并先完成文件占用检查");
    }
    const result = spawnSync(handlePath, ["-accepteula", "-nobanner", path], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) {
      throw new Error(`目标数据库仍被进程占用，请先停止本地应用：${result.stdout.trim()}`);
    }
    return;
  }
  const result = spawnSync("lsof", ["-t", "--", path], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error(`目标数据库仍被进程 ${result.stdout.trim().split(/\s+/).join("、")} 占用，请先停止本地应用`);
  }
}

async function installDatabase(sourcePath, targetPath, currentBuild) {
  await mkdir(dirname(targetPath), { recursive: true });
  const incoming = `${targetPath}.${process.pid}.incoming`;
  await rm(incoming, { force: true });
  try {
    await copyFile(sourcePath, incoming, fsConstants.COPYFILE_EXCL);
    const copied = inspectDatabase(incoming);
    if (copied.integrity !== "ok") throw new Error("复制后的 SQLite 完整性检查失败");
    if (await isReadable(targetPath)) {
      const walPath = `${targetPath}-wal`;
      if (await isReadable(walPath) && (await stat(walPath)).size > 0) {
        throw new Error("目标数据库仍有未合并的 WAL，请正常停止应用后重试");
      }
      const archive = join(dirname(targetPath), "archive");
      await mkdir(archive, { recursive: true });
      const stamp = new Date().toISOString().replaceAll(":", "-");
      await link(targetPath, join(archive, `wow-${currentBuild || "unknown"}-${stamp}.sqlite`));
    }
    await Promise.all([
      rm(`${targetPath}-wal`, { force: true }),
      rm(`${targetPath}-shm`, { force: true }),
    ]);
    await rename(incoming, targetPath);
  } catch (error) {
    await rm(incoming, { force: true });
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
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

async function isReadable(path) {
  try { await access(path, fsConstants.R_OK); return true; } catch { return false; }
}

function buildNumber(value) {
  return Number(String(value || "").match(/(\d+)(?!.*\d)/)?.[1] || 0);
}

function formatBytes(value) {
  return `${(Number(value) / 1024 / 1024).toFixed(1)} MiB`;
}

function parseArgs(args) {
  const parsed = { source: "", target: "", checkOnly: false, allowDowngrade: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") parsed.target = args[++index] || "";
    else if (arg === "--check-only") parsed.checkOnly = true;
    else if (arg === "--allow-downgrade") parsed.allowDowngrade = true;
    else if (!arg.startsWith("-") && !parsed.source) parsed.source = arg;
    else throw new Error(`未知参数：${arg}`);
  }
  return parsed;
}

function usage() {
  console.error("用法：node scripts/import-wow-db.mjs <交接包.zip|目录> [--check-only] [--target <wow.sqlite>]");
  process.exit(64);
}
