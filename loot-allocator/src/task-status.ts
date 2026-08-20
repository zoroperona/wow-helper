import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DailyTaskStatus {
  schemaVersion: 1;
  status: "running" | "succeeded" | "failed";
  mode?: "daily" | "check";
  phase?: string;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  failures: Array<{ playerId: string; playerName: string; message: string }>;
  stages?: Array<{
    id: string;
    label: string;
    status: "pending" | "running" | "succeeded" | "failed" | "skipped";
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  }>;
}

export async function writeDailyTaskStatus(path: string, status: DailyTaskStatus): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
