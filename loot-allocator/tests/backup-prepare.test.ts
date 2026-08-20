import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LootDatabase } from "../src/db.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const script = join(projectRoot, "scripts", "prepare-database-backup.mjs");
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("backup prepare", () => {
  it("writes an immutable pre-upload manifest for a consistent SQLite snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "wow-backup-prepare-test-"));
    cleanupPaths.push(root);
    const databasePath = join(root, "business.sqlite");
    const outputPath = join(root, "staging");
    const database = await LootDatabase.open(databasePath);
    database.createPlayer({
      name: "备份测试",
      realmName: "测试服",
      realmSlug: "test-realm",
      raidRole: "ranged",
    });
    database.close();

    const result = runPrepare(databasePath, outputPath, ["local-restic", "offsite-worm"]);
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.status).toBe("prepared");

    const manifestPath = join(summary.bundleDirectory, "backup-manifest.v1.json");
    const snapshotPath = join(summary.bundleDirectory, "business.sqlite");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      manifestVersion: "backup-manifest/v1",
      backupId: summary.backupId,
      reason: "test",
      expectedTargetIds: ["local-restic", "offsite-worm"],
      database: {
        quickCheck: "ok",
        schemaVersion: "5",
        rowCounts: { players: 1 },
      },
    });
    expect(manifest).not.toHaveProperty("verifiedAt");
    expect(manifest).not.toHaveProperty("repositorySnapshotId");
    expect((await stat(snapshotPath)).size).toBe(manifest.database.bytes);
    expect(await sha256File(snapshotPath)).toBe(manifest.database.sha256);
    expect(await sha256File(manifestPath)).toBe(summary.manifestSha256);

    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      expect(snapshot.prepare("PRAGMA quick_check").get()).toMatchObject({ quick_check: "ok" });
    } finally {
      snapshot.close();
    }
  });

  it("rejects a prepare request without two distinct target IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "wow-backup-target-test-"));
    cleanupPaths.push(root);
    const databasePath = join(root, "business.sqlite");
    const database = await LootDatabase.open(databasePath);
    database.close();

    const result = runPrepare(databasePath, join(root, "staging"), ["only-one"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("必须提供两个不同");
  });
});

function runPrepare(databasePath: string, outputPath: string, targets: string[]) {
  const targetArguments = targets.flatMap((target) => ["--target", target]);
  return spawnSync(process.execPath, [
    script,
    "--database", databasePath,
    "--output", outputPath,
    "--reason", "test",
    ...targetArguments,
  ], { cwd: projectRoot, encoding: "utf8" });
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
