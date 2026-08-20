export type BackupGateLevel = "healthy" | "warning" | "blocked" | "recovery-only";

export interface BackupHealthTargetReceipt {
  targetId: string;
  receiptSha256: string;
}

export interface BackupHealthRecord {
  schemaVersion: 1;
  backupId: string;
  generatedAt: string;
  verifiedAt: string;
  verifierVersion: string;
  targetReceipts: [BackupHealthTargetReceipt, BackupHealthTargetReceipt];
}

export interface BackupHealthEvaluation {
  level: BackupGateLevel;
  record: BackupHealthRecord | null;
  contentAgeMs: number | null;
  issues: string[];
  allowReads: true;
  allowBackupAndRecovery: true;
  allowRoutineWrites: boolean;
  allowHighRiskChanges: boolean;
}

const hour = 60 * 60 * 1000;
const hashPattern = /^[0-9a-f]{64}$/;
const slugPattern = /^[a-z][a-z0-9-]{0,63}$/;

export function evaluateBackupHealth(value: unknown, now = new Date()): BackupHealthEvaluation {
  const parsed = parseRecord(value);
  if (!parsed.record) return result("recovery-only", null, null, parsed.issues);

  const generatedAt = Date.parse(parsed.record.generatedAt);
  const verifiedAt = Date.parse(parsed.record.verifiedAt);
  const nowMs = now.getTime();
  const issues = [...parsed.issues];
  if (generatedAt > nowMs) issues.push("backup generatedAt 位于未来");
  if (verifiedAt < generatedAt) issues.push("backup verifiedAt 早于 generatedAt");
  if (verifiedAt > nowMs + 5 * 60 * 1000) issues.push("backup verifiedAt 超出时钟容差");
  if (issues.length) return result("recovery-only", parsed.record, null, issues);

  const age = nowMs - generatedAt;
  if (age > 24 * hour) return result("recovery-only", parsed.record, age, ["verified backup 内容已超过 24 小时"]);
  if (age > 22 * hour) return result("blocked", parsed.record, age, ["verified backup 内容已超过 22 小时"]);
  if (age > 20 * hour) return result("warning", parsed.record, age, ["verified backup 内容已超过 20 小时"]);
  return result("healthy", parsed.record, age, []);
}

export function assertMonotonicBackupHealth(previous: unknown, next: unknown): BackupHealthRecord {
  const previousRecord = parseRecord(previous).record;
  const nextParsed = parseRecord(next);
  if (!nextParsed.record || nextParsed.issues.length) {
    throw new Error(`新的 backup-health 无效：${nextParsed.issues.join("；")}`);
  }
  if (Date.parse(nextParsed.record.verifiedAt) < Date.parse(nextParsed.record.generatedAt)) {
    throw new Error("新的 backup-health verifiedAt 不能早于 generatedAt");
  }
  if (previousRecord) {
    if (nextParsed.record.backupId === previousRecord.backupId) {
      throw new Error("backupId 不允许覆盖或重放");
    }
    if (Date.parse(nextParsed.record.generatedAt) <= Date.parse(previousRecord.generatedAt)) {
      throw new Error("backup generatedAt 必须严格递增");
    }
  }
  return nextParsed.record;
}

function parseRecord(value: unknown): {record: BackupHealthRecord | null; issues: string[]} {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { record: null, issues: ["backup-health 缺失或不是对象"] };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) issues.push("backup-health schemaVersion 不受支持");
  if (typeof candidate.backupId !== "string" || !/^backup-v1-[A-Za-z0-9._-]+$/.test(candidate.backupId)) {
    issues.push("backupId 格式无效");
  }
  if (!validTimestamp(candidate.generatedAt)) issues.push("generatedAt 不是有效时间");
  if (!validTimestamp(candidate.verifiedAt)) issues.push("verifiedAt 不是有效时间");
  if (typeof candidate.verifierVersion !== "string" || !candidate.verifierVersion.trim()) {
    issues.push("verifierVersion 缺失");
  }
  const receipts = candidate.targetReceipts;
  if (!Array.isArray(receipts) || receipts.length !== 2) {
    issues.push("targetReceipts 必须包含两个目标");
  } else {
    const targetIds = new Set<string>();
    for (const receipt of receipts) {
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
        issues.push("target receipt 格式无效");
        continue;
      }
      const target = receipt as Record<string, unknown>;
      if (typeof target.targetId !== "string" || !slugPattern.test(target.targetId)) {
        issues.push("targetId 格式无效");
      } else {
        targetIds.add(target.targetId);
      }
      if (typeof target.receiptSha256 !== "string" || !hashPattern.test(target.receiptSha256)) {
        issues.push("receiptSha256 格式无效");
      }
    }
    if (targetIds.size !== 2) issues.push("targetId 必须互不相同");
  }
  return issues.length
    ? { record: null, issues }
    : { record: candidate as unknown as BackupHealthRecord, issues: [] };
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function result(
  level: BackupGateLevel,
  record: BackupHealthRecord | null,
  contentAgeMs: number | null,
  issues: string[],
): BackupHealthEvaluation {
  return {
    level,
    record,
    contentAgeMs,
    issues,
    allowReads: true,
    allowBackupAndRecovery: true,
    allowRoutineWrites: level === "healthy" || level === "warning",
    allowHighRiskChanges: level === "healthy",
  };
}
