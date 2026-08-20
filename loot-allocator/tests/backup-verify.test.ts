import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const script = join(projectRoot, "scripts", "verify-database-backup.mjs");
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("backup verification adapter", () => {
  it("requires an explicit prepared bundle", () => {
    const result = spawnSync(process.execPath, [script], { cwd: projectRoot, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("必须指定 --bundle");
  });

  it("rejects an invalid manifest before invoking restic", async () => {
    const root = await mkdtemp(join(tmpdir(), "wow-backup-verify-test-"));
    cleanupPaths.push(root);
    await writeFile(join(root, "backup-manifest.v1.json"), JSON.stringify({ manifestVersion: "wrong" }), "utf8");
    const result = spawnSync(process.execPath, [script, "--bundle", root, "--targets", "[]"], { cwd: projectRoot, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("不支持的 backup manifest 版本");
  });
});
