import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertMonotonicBackupHealth, evaluateBackupHealth, writeBackupHealthAtomic } from "../src/backup-health.js";

const now = new Date("2026-08-20T12:00:00.000Z");

describe("backup health gate", () => {
  it.each([
    { ageHours: 20, level: "healthy", routine: true, highRisk: true },
    { ageHours: 20.01, level: "warning", routine: true, highRisk: false },
    { ageHours: 22.01, level: "blocked", routine: false, highRisk: false },
    { ageHours: 24.01, level: "recovery-only", routine: false, highRisk: false },
  ])("applies the $ageHours hour content-age boundary", ({ ageHours, level, routine, highRisk }) => {
    const value = record(new Date(now.getTime() - ageHours * 60 * 60 * 1000));
    expect(evaluateBackupHealth(value, now)).toMatchObject({
      level,
      allowRoutineWrites: routine,
      allowHighRiskChanges: highRisk,
    });
  });

  it("fails closed for missing, future or out-of-order timestamps", () => {
    expect(evaluateBackupHealth(null, now).level).toBe("recovery-only");
    expect(evaluateBackupHealth(record(new Date(now.getTime() + 1)), now).issues)
      .toContain("backup generatedAt 位于未来");
    expect(evaluateBackupHealth({
      ...record(now),
      verifiedAt: new Date(now.getTime() - 1).toISOString(),
    }, now).issues).toContain("backup verifiedAt 早于 generatedAt");
  });

  it("rejects malformed or duplicate target receipts", () => {
    const value = record(now);
    value.targetReceipts[1] = { ...value.targetReceipts[0] };
    expect(evaluateBackupHealth(value, now).issues).toContain("targetId 必须互不相同");
  });

  it("requires backup IDs and generatedAt to advance monotonically", () => {
    const previous = record(new Date(now.getTime() - 2 * 60 * 60 * 1000), "backup-v1-previous");
    expect(() => assertMonotonicBackupHealth(previous, { ...record(now), backupId: previous.backupId }))
      .toThrow("backupId 不允许覆盖");
    expect(() => assertMonotonicBackupHealth(previous, record(new Date(now.getTime() - 3 * 60 * 60 * 1000))))
      .toThrow("generatedAt 必须严格递增");
    expect(assertMonotonicBackupHealth(previous, record(now))).toMatchObject({ backupId: "backup-v1-current" });
  });

  it("writes a complete file and atomically advances the health record", async () => {
    const root = await mkdtemp(join(tmpdir(), "wow-backup-health-test-"));
    const path = join(root, "state", "backup-health.json");
    const first = await writeBackupHealthAtomic(path, record(new Date(now.getTime() - 60 * 60 * 1000), "backup-v1-first"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(first);

    const second = await writeBackupHealthAtomic(path, record(now, "backup-v1-second"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(second);
  });

  it("refuses to overwrite malformed existing state", async () => {
    const root = await mkdtemp(join(tmpdir(), "wow-backup-health-test-"));
    const path = join(root, "backup-health.json");
    await writeFile(path, "{not-json", "utf8");

    await expect(writeBackupHealthAtomic(path, record(now))).rejects.toThrow("读取现有 backup-health 失败");
    expect(await readFile(path, "utf8")).toBe("{not-json");
  });

  it("refuses to overwrite a structurally invalid existing record", async () => {
    const root = await mkdtemp(join(tmpdir(), "wow-backup-health-test-"));
    const path = join(root, "backup-health.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1 }), "utf8");

    await expect(writeBackupHealthAtomic(path, record(now))).rejects.toThrow("现有 backup-health 损坏");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schemaVersion: 1 });
  });
});

function record(generatedAt: Date, backupId = "backup-v1-current") {
  return {
    schemaVersion: 1 as const,
    backupId,
    generatedAt: generatedAt.toISOString(),
    verifiedAt: new Date(Math.max(generatedAt.getTime(), now.getTime() - 1000)).toISOString(),
    verifierVersion: "0.1.0",
    targetReceipts: [
      { targetId: "local-restic", receiptSha256: "a".repeat(64) },
      { targetId: "offsite-worm", receiptSha256: "a".repeat(64) },
    ] as [{targetId: string; receiptSha256: string}, {targetId: string; receiptSha256: string}],
  };
}
