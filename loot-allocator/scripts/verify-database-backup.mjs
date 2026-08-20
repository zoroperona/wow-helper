import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const options = parseArgs(process.argv.slice(2));
const bundleDirectory = resolve(options.bundle);
const manifestPath = join(bundleDirectory, "backup-manifest.v1.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
validateManifest(manifest);
const snapshotPath = join(bundleDirectory, manifest.database.file);
const manifestSha256 = await sha256File(manifestPath);
if (await sha256File(snapshotPath) !== manifest.database.sha256) {
  throw new Error("备份快照 SHA-256 与 manifest 不一致");
}

const targets = parseTargets(options.targets);
if (targets.length !== 2 || new Set(targets.map((target) => target.targetId)).size !== 2) {
  throw new Error("必须配置两个不同的 restic 目标");
}
if (manifest.expectedTargetIds.some((targetId, index) => targetId !== targets[index]?.targetId)) {
  throw new Error("restic 目标顺序/标识与 backup manifest 不一致");
}
const workDirectory = await mkdtemp(join(tmpdir(), "wow-backup-verify-"));
const uploaded = [];
try {
  for (const target of targets) {
    uploaded.push(await uploadAndVerifyBundle(target, bundleDirectory, manifest, manifestSha256));
  }

  const verifiedAt = new Date().toISOString();
  const receiptId = `receipt-v1-${verifiedAt.replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID()}`;
  const receipt = {
    receiptVersion: "verification-receipt/v1",
    receiptId,
    backupId: manifest.backupId,
    manifestSha256,
    verifiedAt,
    verifierVersion: options.verifierVersion,
    result: "verified",
    targets: uploaded.map((entry) => ({
      targetId: entry.targetId,
      repositoryId: entry.repositoryId,
      snapshotId: entry.snapshotId,
      readBackAt: entry.readBackAt,
      bytes: entry.bytes,
      sha256: entry.sha256,
      quickCheck: entry.quickCheck,
    })),
  };
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const receiptSha256 = sha256Bytes(receiptBytes);
  const receiptDirectory = join(workDirectory, "verification-receipt", "v1");
  await mkdir(receiptDirectory, { recursive: true });
  const receiptPath = join(receiptDirectory, `${receiptId}.json`);
  await writeFile(receiptPath, receiptBytes, { encoding: "utf8", flag: "wx" });

  for (const target of targets) {
    const receiptSnapshotId = await uploadReceipt(target, receiptDirectory);
    const restoredReceipt = await restoreNamedFile(target, receiptSnapshotId, `${receiptId}.json`, workDirectory);
    const restoredBytes = await readFile(restoredReceipt, "utf8");
    if (restoredBytes !== receiptBytes) throw new Error(`${target.targetId} receipt 读回 bytes 不一致`);
  }

  const healthRecord = {
    schemaVersion: 1,
    backupId: manifest.backupId,
    generatedAt: manifest.generatedAt,
    verifiedAt,
    verifierVersion: options.verifierVersion,
    targetReceipts: uploaded.map((entry) => ({
      targetId: entry.targetId,
      receiptSha256,
    })),
  };
  if (options.healthPath) {
    const health = await import("../dist/backup-health.js");
    await health.writeBackupHealthAtomic(resolve(options.healthPath), healthRecord);
  }
  console.log(JSON.stringify({ status: "verified", backupId: manifest.backupId, receiptId, receiptSha256, healthPath: options.healthPath || null }, null, 2));
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}

async function uploadAndVerifyBundle(target, directory, expectedManifest, expectedManifestSha256) {
  const snapshotId = await resticBackup(target, directory, [
    "--tag", "wow-helper:backup-v1",
    "--tag", `backup-id:${expectedManifest.backupId}`,
  ]);
  const restoredDirectory = await mkdtemp(join(workDirectory, `${target.targetId}-restore-`));
  try {
    const restoredManifest = await restoreNamedFile(target, snapshotId, "backup-manifest.v1.json", restoredDirectory);
    const restoredSnapshot = await restoreNamedFile(target, snapshotId, basename(expectedManifest.database.file), restoredDirectory);
    const restoredManifestBytes = await readFile(restoredManifest, "utf8");
    if (sha256Bytes(restoredManifestBytes) !== expectedManifestSha256) {
      throw new Error(`${target.targetId} manifest 读回 hash 不一致`);
    }
    const bytes = await readFile(restoredSnapshot);
    const sha256 = sha256Bytes(bytes);
    if (sha256 !== expectedManifest.database.sha256 || bytes.length !== expectedManifest.database.bytes) {
      throw new Error(`${target.targetId} SQLite 读回 bytes/SHA-256 不一致`);
    }
    const database = new DatabaseSync(restoredSnapshot, { readOnly: true });
    let quickCheck;
    try {
      quickCheck = String(database.prepare("PRAGMA quick_check").get()?.quick_check || "unknown");
    } finally {
      database.close();
    }
    if (quickCheck !== "ok") throw new Error(`${target.targetId} SQLite quick_check 失败：${quickCheck}`);
    return {
      targetId: target.targetId,
      repositoryId: target.repositoryId,
      snapshotId,
      readBackAt: new Date().toISOString(),
      bytes: bytes.length,
      sha256,
      quickCheck,
    };
  } finally {
    await rm(restoredDirectory, { recursive: true, force: true });
  }
}

async function uploadReceipt(target, directory) {
  return resticBackup(target, directory, ["--tag", "wow-helper:verification-receipt-v1"]);
}

async function resticBackup(target, directory, extraArgs) {
  const result = await runRestic(target, ["backup", "--json", ...extraArgs, directory]);
  const records = result.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const snapshot = records.reverse().find((record) => typeof record.snapshot_id === "string");
  if (!snapshot) throw new Error(`${target.targetId} restic backup 未返回 snapshot_id`);
  return snapshot.snapshot_id;
}

async function restoreNamedFile(target, snapshotId, name, outputDirectory) {
  const restoreDirectory = join(outputDirectory, `restore-${randomUUID()}`);
  await mkdir(restoreDirectory, { recursive: true });
  await runRestic(target, ["restore", snapshotId, "--target", restoreDirectory]);
  const found = await findFile(restoreDirectory, name);
  if (!found) throw new Error(`${target.targetId} snapshot 中找不到 ${name}`);
  return found;
}

async function findFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) return found;
    }
  }
  return null;
}

function parseTargets(value) {
  const raw = value || process.env.BACKUP_RESTIC_TARGETS_JSON || "";
  if (!raw) throw new Error("必须提供 --targets/BACKUP_RESTIC_TARGETS_JSON");
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`restic targets JSON 无效：${error.message}`); }
  if (!Array.isArray(parsed)) throw new Error("restic targets 必须是数组");
  return parsed.map((target) => {
    if (!target || typeof target !== "object" || !/^[a-z][a-z0-9-]{0,31}$/.test(target.targetId || "")) {
      throw new Error("restic targetId 格式无效");
    }
    if (!target.repository || !target.passwordFile) throw new Error(`${target.targetId} 缺少 repository/passwordFile`);
    const repository = String(target.repository);
    return {
      targetId: target.targetId,
      repositoryId: target.repositoryId || target.targetId,
      repository: repository.includes(":") ? repository : resolve(repository),
      passwordFile: resolve(String(target.passwordFile)),
    };
  });
}

function validateManifest(manifest) {
  if (manifest?.manifestVersion !== "backup-manifest/v1") throw new Error("不支持的 backup manifest 版本");
  if (typeof manifest.backupId !== "string" || !manifest.backupId.startsWith("backup-v1-")) throw new Error("backupId 无效");
  if (!manifest.database || manifest.database.quickCheck !== "ok" || !manifest.database.file || !/^[a-zA-Z0-9._-]+$/.test(manifest.database.file)) {
    throw new Error("backup manifest database 字段无效");
  }
  if (!Array.isArray(manifest.expectedTargetIds) || manifest.expectedTargetIds.length !== 2) throw new Error("backup manifest 缺少两个目标");
}

function parseArgs(args) {
  const parsed = { bundle: "", targets: "", healthPath: process.env.BACKUP_HEALTH_PATH || "", verifierVersion: process.env.APP_VERSION || "0.1.0" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--bundle") parsed.bundle = args[++index] || "";
    else if (argument === "--targets") parsed.targets = args[++index] || "";
    else if (argument === "--health-path") parsed.healthPath = args[++index] || "";
    else if (argument === "--verifier-version") parsed.verifierVersion = args[++index] || "";
    else throw new Error(`未知参数：${argument}`);
  }
  if (!parsed.bundle) throw new Error("必须指定 --bundle");
  if (!parsed.verifierVersion.trim()) throw new Error("必须指定 verifier version");
  return parsed;
}

function runRestic(target, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.env.RESTIC_BIN || "restic", args, {
      env: {
        ...process.env,
        RESTIC_REPOSITORY: target.repository,
        RESTIC_PASSWORD_FILE: target.passwordFile,
        RESTIC_PROGRESS_FPS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolveResult({ stdout, stderr })
      : reject(new Error(`${target.targetId} restic 失败（退出码 ${code}）：${stderr.trim().slice(0, 500)}`)));
  });
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
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
