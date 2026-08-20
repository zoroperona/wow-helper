import { createReadStream, existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { DailyTaskStatus } from "./task-status.js";
import { evaluateBackupHealth } from "./backup-health.js";

export type HealthStatus = "healthy" | "warning" | "critical";

export interface HealthDetail {
  label: string;
  value: string;
}

export interface HealthComponent {
  id: string;
  label: string;
  status: HealthStatus;
  summary: string;
  details: HealthDetail[];
  issues: string[];
}

export interface SystemHealthReport {
  status: HealthStatus;
  checkedAt: string;
  components: HealthComponent[];
  issues: Array<{ componentId: string; componentLabel: string; status: HealthStatus; message: string }>;
}

interface SimcIdentity {
  available: boolean;
  version: string | null;
  gameVersion: string | null;
  gameBuild: number | null;
  revision: string | null;
  hotfixDate: string | null;
  hotfixBuild: number | null;
  sha256: string | null;
  modifiedAt: string | null;
  reportPath: string | null;
  issues: string[];
}

interface WowDbIdentity {
  available: boolean;
  build: string | null;
  buildNumber: number | null;
  locale: string | null;
  completedAt: string | null;
  modifiedAt: string | null;
  integrity: string;
  missingTables: string[];
  hotfixBuild: string | null;
  hotfixSha256: string | null;
  issues: string[];
}

interface AppDbIdentity {
  available: boolean;
  schemaVersion: string | null;
  integrity: string;
  latestCharacterAt: string | null;
  latestSimulationAt: string | null;
  latestSimulationBuilds: Array<{ build: number | null; players: number }>;
  activePlayers: number;
  simulatedPlayers: number;
  issues: string[];
}

const severity: Record<HealthStatus, number> = { healthy: 0, warning: 1, critical: 2 };
const criticalWowDbTables = [
  "JournalInstance", "JournalEncounter", "JournalEncounterItem", "Item", "ItemSparse",
  "ItemBonus", "ItemBonusListGroupEntry", "RandPropPoints", "CombatRatingsMultByILvl",
  "StaminaMultByILvl", "ItemSocketCostPerLevel",
];

export class SystemHealthService {
  private cached: { expiresAt: number; report: SystemHealthReport } | null = null;

  constructor(private readonly options: {
    simcPath: string;
    simcRunsPath: string;
    wowDbPath: string;
    databasePath: string;
    backupsPath: string;
    backupHealthPath?: string;
    appRoot: string;
    cacheMs?: number;
    now?: () => Date;
    dailyTaskStatusPath?: string;
    scheduledTaskExpected?: boolean;
  }) {}

  async getReport(force = false): Promise<SystemHealthReport> {
    const now = (this.options.now || (() => new Date()))();
    if (!force && this.cached && this.cached.expiresAt > now.getTime()) {
      return structuredClone(this.cached.report);
    }

    const [simc, wowDb, appDb, backup, runtime] = await Promise.all([
      inspectSimc(this.options.simcPath, this.options.simcRunsPath, now),
      inspectWowDb(this.options.wowDbPath, now),
      inspectAppDatabase(this.options.databasePath),
      inspectBackups(this.options.backupsPath, now, this.options.backupHealthPath),
      inspectRuntime(
        this.options.appRoot,
        this.options.dailyTaskStatusPath || join(this.options.appRoot, "data", "runtime", "daily-sim-status.json"),
        Boolean(this.options.scheduledTaskExpected),
        now,
      ),
    ]);

    const components = [
      simcComponent(simc, now),
      wowDbComponent(wowDb, now),
      simulationCacheComponent(appDb, simc),
      databaseComponent(appDb, backup),
      runtime,
    ];
    if (simc.gameBuild && wowDb.buildNumber && simc.gameBuild !== wowDb.buildNumber) {
      const difference = simc.gameBuild - wowDb.buildNumber;
      const message = `SimC 使用 build ${simc.gameBuild}，wow-db 使用 ${wowDb.buildNumber}（相差 ${Math.abs(difference)}）`;
      components[1]!.status = maxStatus(components[1]!.status, "warning");
      components[1]!.issues.unshift(message);
    }

    const issues = components.flatMap((component) => component.issues.map((message) => ({
      componentId: component.id,
      componentLabel: component.label,
      status: component.status,
      message,
    })));
    const report: SystemHealthReport = {
      status: components.reduce<HealthStatus>((current, component) => maxStatus(current, component.status), "healthy"),
      checkedAt: now.toISOString(),
      components,
      issues,
    };
    this.cached = {
      expiresAt: now.getTime() + (this.options.cacheMs ?? 5 * 60_000),
      report,
    };
    return structuredClone(report);
  }
}

async function inspectSimc(path: string, runsPath: string, now: Date): Promise<SimcIdentity> {
  const result: SimcIdentity = {
    available: false,
    version: null,
    gameVersion: null,
    gameBuild: null,
    revision: null,
    hotfixDate: null,
    hotfixBuild: null,
    sha256: null,
    modifiedAt: null,
    reportPath: null,
    issues: [],
  };
  if (!existsSync(path)) {
    result.issues.push(`SimC 不存在：${path}`);
    return result;
  }
  try {
    const fileStat = await stat(path);
    result.modifiedAt = fileStat.mtime.toISOString();
    result.sha256 = await sha256File(path);
    const versionOutput = await runForOutput(path, ["--version"], 10_000);
    const identity = versionOutput.match(/SimulationCraft\s+(\S+).*?World of Warcraft\s+([\d.]+)/s);
    result.version = identity?.[1] || null;
    result.gameVersion = identity?.[2] || null;
    result.gameBuild = buildNumber(result.gameVersion);
    result.available = Boolean(result.version && result.gameBuild);
    if (!result.available) result.issues.push("无法从 SimC 二进制读取版本和游戏 build");

    const latestReport = await findLatestFile(runsPath, ".html", 2);
    if (latestReport) {
      result.reportPath = latestReport.path;
      // SimC embeds sizeable styles and scripts before the report title.
      const header = await readPrefix(latestReport.path, 1024 * 1024);
      const reportIdentity = header.match(
        /SimulationCraft\s+([^<\s]+).*?World of Warcraft\s+([\d.]+).*?hotfix\s+([^/<]+)\/(\d+).*?git build[^>]*>\s*([0-9a-f]+)/is,
      );
      if (reportIdentity) {
        result.revision = reportIdentity[5] || null;
        result.hotfixDate = reportIdentity[3]?.trim() || null;
        result.hotfixBuild = Number(reportIdentity[4]) || null;
        if (!result.version) result.version = reportIdentity[1] || null;
        if (!result.gameVersion) result.gameVersion = reportIdentity[2] || null;
        if (!result.gameBuild) result.gameBuild = buildNumber(result.gameVersion);
      } else {
        result.issues.push("最近的 SimC 报告缺少 revision 或 hotfix 身份");
      }
    } else {
      result.issues.push("没有可用于核对 revision 和 hotfix 的 SimC 报告");
    }
    if (daysBetween(result.modifiedAt, now) > 7) {
      result.issues.push("SimC 二进制超过 7 天未更新或重新验证");
    }
  } catch (error) {
    result.issues.push(`读取 SimC 失败：${errorMessage(error)}`);
  }
  return result;
}

async function inspectWowDb(path: string, now: Date): Promise<WowDbIdentity> {
  const result: WowDbIdentity = {
    available: false,
    build: null,
    buildNumber: null,
    locale: null,
    completedAt: null,
    modifiedAt: null,
    integrity: "unavailable",
    missingTables: [],
    hotfixBuild: null,
    hotfixSha256: null,
    issues: [],
  };
  if (!existsSync(path)) {
    result.issues.push(`wow-db 不存在：${path}`);
    return result;
  }
  let sqlite: DatabaseSync | null = null;
  try {
    result.modifiedAt = (await stat(path)).mtime.toISOString();
    sqlite = new DatabaseSync(path, { readOnly: true });
    const metadata = sqlite.prepare(
      "SELECT build, locale, MAX(completed_at) AS completed_at FROM __wowdb_tables",
    ).get() as { build?: string; locale?: string; completed_at?: string } | undefined;
    result.build = metadata?.build || null;
    result.buildNumber = buildNumber(result.build);
    result.locale = metadata?.locale || null;
    result.completedAt = metadata?.completed_at || null;
    result.integrity = String((sqlite.prepare("PRAGMA quick_check").get() as { quick_check?: string })?.quick_check || "unknown");
    const tables = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    result.missingTables = criticalWowDbTables.filter((table) => !tables.has(table));
    const hasHotfixColumn = (sqlite.prepare("PRAGMA table_info('__wowdb_tables')").all() as Array<{ name?: string }>).some((column) => column.name === "hotfix_sha256");
    if (hasHotfixColumn) {
      const hotfix = sqlite.prepare("SELECT hotfix_sha256 FROM __wowdb_tables WHERE hotfix_sha256 IS NOT NULL ORDER BY completed_at DESC LIMIT 1").get() as { hotfix_sha256?: string } | undefined;
      result.hotfixSha256 = hotfix?.hotfix_sha256 || null;
      result.hotfixBuild = result.hotfixSha256 ? result.build : null;
    }
    result.available = Boolean(result.build && result.locale && result.integrity === "ok");
    if (result.integrity !== "ok") result.issues.push(`wow-db 完整性检查结果：${result.integrity}`);
    if (result.missingTables.length) result.issues.push(`缺少关键表：${result.missingTables.join("、")}`);
    if (daysBetween(result.modifiedAt, now) > 7) result.issues.push("wow-db 快照超过 7 天未更新");
    if (!result.hotfixSha256) result.issues.push("wow-db 当前不包含 DBCache.bin 服务器热修正层");
  } catch (error) {
    result.issues.push(`读取 wow-db 失败：${errorMessage(error)}`);
  } finally {
    sqlite?.close();
  }
  return result;
}

async function inspectAppDatabase(path: string): Promise<AppDbIdentity> {
  const result: AppDbIdentity = {
    available: false,
    schemaVersion: null,
    integrity: "unavailable",
    latestCharacterAt: null,
    latestSimulationAt: null,
    latestSimulationBuilds: [],
    activePlayers: 0,
    simulatedPlayers: 0,
    issues: [],
  };
  if (!existsSync(path)) {
    result.issues.push(`业务数据库不存在：${path}`);
    return result;
  }
  let sqlite: DatabaseSync | null = null;
  try {
    sqlite = new DatabaseSync(path, { readOnly: true });
    result.integrity = String((sqlite.prepare("PRAGMA quick_check").get() as { quick_check?: string })?.quick_check || "unknown");
    result.schemaVersion = String((sqlite.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get() as { value?: string })?.value || "unknown");
    result.latestCharacterAt = nullableString((sqlite.prepare("SELECT MAX(fetched_at) AS value FROM character_snapshots").get() as { value?: string | null })?.value);
    result.latestSimulationAt = nullableString((sqlite.prepare("SELECT MAX(fetched_at) AS value FROM stat_weight_snapshots WHERE source = 'local-simc'").get() as { value?: string | null })?.value);
    result.activePlayers = Number((sqlite.prepare("SELECT COUNT(*) AS value FROM players WHERE is_active = 1").get() as { value?: number })?.value || 0);
    result.simulatedPlayers = Number((sqlite.prepare(`
      SELECT COUNT(DISTINCT sw.player_id) AS value
        FROM stat_weight_snapshots sw
        JOIN players p ON p.id = sw.player_id AND p.is_active = 1
       WHERE sw.source = 'local-simc'
    `).get() as { value?: number })?.value || 0);
    result.latestSimulationBuilds = sqlite.prepare(`
      SELECT sw.game_build AS build, COUNT(*) AS players
        FROM stat_weight_snapshots sw
        JOIN players p ON p.id = sw.player_id AND p.is_active = 1
       WHERE sw.source = 'local-simc'
         AND sw.id = (
           SELECT latest.id FROM stat_weight_snapshots latest
            WHERE latest.player_id = sw.player_id AND latest.source = 'local-simc'
         ORDER BY latest.fetched_at DESC, latest.id DESC LIMIT 1
         )
    GROUP BY sw.game_build
    `).all() as Array<{ build: number | null; players: number }>;
    result.available = result.integrity === "ok";
    if (!result.available) result.issues.push(`业务数据库完整性检查结果：${result.integrity}`);
  } catch (error) {
    result.issues.push(`读取业务数据库失败：${errorMessage(error)}`);
  } finally {
    sqlite?.close();
  }
  return result;
}

async function inspectBackups(path: string, now: Date, backupHealthPath?: string): Promise<{ latestAt: string | null; count: number; issues: string[]; status: HealthStatus }> {
  if (backupHealthPath) {
    try {
      const health = evaluateBackupHealth(JSON.parse(await readFile(backupHealthPath, "utf8")), now);
      const files = (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"));
      const status: HealthStatus = health.level === "healthy" ? "healthy" : health.level === "warning" ? "warning" : "critical";
      const issues = health.issues.length ? health.issues : [`backup-health：${health.level}`];
      return {
        latestAt: health.record?.generatedAt || null,
        count: files.length,
        issues,
        status,
      };
    } catch (error) {
      return {
        latestAt: null,
        count: 0,
        issues: [`读取 backup-health 失败：${errorMessage(error)}`],
        status: "critical",
      };
    }
  }
  try {
    const files = (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"));
    const timestamps = await Promise.all(files.map(async (entry) => (await stat(join(path, entry.name))).mtime));
    const latest = timestamps.sort((left, right) => right.getTime() - left.getTime())[0];
    const latestAt = latest?.toISOString() || null;
    const issues = !latestAt
      ? ["尚无数据库备份"]
      : daysBetween(latestAt, now) > 2 ? ["最近一次数据库备份已超过 2 天"] : [];
    return { latestAt, count: files.length, issues, status: issues.length ? "warning" : "healthy" };
  } catch (error) {
    return { latestAt: null, count: 0, issues: [`读取备份目录失败：${errorMessage(error)}`], status: "critical" };
  }
}

async function inspectRuntime(
  appRoot: string,
  dailyTaskStatusPath: string,
  scheduledTaskExpected: boolean,
  now: Date,
): Promise<HealthComponent> {
  const issues: string[] = [];
  const newestSource = await newestModifiedAt(join(appRoot, "src"), ".ts");
  const newestBuild = await newestModifiedAt(join(appRoot, "dist"), ".js");
  if (!newestBuild || (newestSource && newestSource.getTime() > newestBuild.getTime())) {
    issues.push("dist 构建产物落后于源码");
  }
  let taskStatus: DailyTaskStatus | null = null;
  try {
    if (existsSync(dailyTaskStatusPath)) {
      taskStatus = JSON.parse(await readFile(dailyTaskStatusPath, "utf8")) as DailyTaskStatus;
      const taskTimestamp = taskStatus.finishedAt || taskStatus.startedAt;
      if (scheduledTaskExpected && daysBetween(taskTimestamp, now) > 2) {
        issues.push("远端定时流水线状态已超过 2 天未更新");
      }
      if (scheduledTaskExpected && taskStatus.status === "failed") {
        issues.push(`最近远端流水线有 ${taskStatus.failed} 名成员模拟失败`);
      }
      if (scheduledTaskExpected && taskStatus.status === "running" && daysBetween(taskStatus.startedAt, now) > 1) {
        issues.push("远端流水线可能异常中断，状态仍停留在运行中");
      }
    } else if (scheduledTaskExpected) {
      issues.push("尚无远端定时流水线状态");
    }
  } catch (error) {
    if (scheduledTaskExpected) issues.push(`读取远端流水线状态失败：${errorMessage(error)}`);
  }

  return {
    id: "runtime",
    label: "运行与构建",
    status: issues.length ? "warning" : "healthy",
    summary: issues.length ? `${issues.length} 项配置需要关注` : "构建产物正常，本机不执行定时任务",
    details: [
      { label: "调度位置", value: scheduledTaskExpected ? "远端部署环境" : "未启用（本机不调度）" },
      { label: "流水线入口", value: "run-daily-pipeline.mjs" },
      { label: "最近流水线", value: taskStatus?.finishedAt || taskStatus?.startedAt || "无" },
      {
        label: "流水线结果",
        value: taskStatus
          ? taskStatus.mode === "check"
            ? `配置校验${taskStatus.status === "succeeded" ? "成功" : "失败"}`
            : `${taskStatus.status} (${taskStatus.succeeded}/${taskStatus.total})`
          : "无结构化状态",
      },
      { label: "最新源码", value: newestSource?.toISOString() || "未知" },
      { label: "最新构建", value: newestBuild?.toISOString() || "无" },
    ],
    issues,
  };
}

function simcComponent(identity: SimcIdentity, now: Date): HealthComponent {
  const critical = !identity.available;
  return {
    id: "simc",
    label: "SimulationCraft",
    status: critical ? "critical" : identity.issues.length ? "warning" : "healthy",
    summary: identity.available
      ? `${identity.version} / WoW ${identity.gameVersion}`
      : "SimC 不可用或身份不完整",
    details: [
      { label: "Git revision", value: identity.revision || "未知" },
      { label: "游戏 build", value: identity.gameBuild ? String(identity.gameBuild) : "未知" },
      { label: "Hotfix", value: [identity.hotfixDate, identity.hotfixBuild].filter(Boolean).join(" / ") || "未知" },
      { label: "二进制时间", value: identity.modifiedAt || "未知" },
      { label: "SHA-256", value: identity.sha256 ? identity.sha256.slice(0, 16) : "未知" },
      { label: "检查时间", value: now.toISOString() },
    ],
    issues: identity.issues,
  };
}

function wowDbComponent(identity: WowDbIdentity, now: Date): HealthComponent {
  const critical = !identity.available || identity.integrity !== "ok" || identity.missingTables.length > 0;
  return {
    id: "wowdb",
    label: "wow-db",
    status: critical ? "critical" : identity.issues.length ? "warning" : "healthy",
    summary: identity.available ? `${identity.build} / ${identity.locale}` : "wow-db 不可用或校验失败",
    details: [
      { label: "游戏 build", value: identity.build || "未知" },
      { label: "Locale", value: identity.locale || "未知" },
      { label: "快照完成", value: identity.completedAt || "未知" },
      { label: "文件时间", value: identity.modifiedAt || "未知" },
      { label: "完整性", value: identity.integrity },
      { label: "Hotfix", value: identity.hotfixBuild ? `${identity.hotfixBuild} / ${identity.hotfixSha256}` : "未应用" },
      { label: "检查时间", value: now.toISOString() },
    ],
    issues: identity.issues,
  };
}

function simulationCacheComponent(database: AppDbIdentity, simc: SimcIdentity): HealthComponent {
  const issues: string[] = [];
  const currentBuildPlayers = simc.gameBuild
    ? database.latestSimulationBuilds.find((entry) => entry.build === simc.gameBuild)?.players || 0
    : 0;
  const oldBuildPlayers = database.latestSimulationBuilds.reduce((total, entry) => (
    entry.build === simc.gameBuild ? total : total + entry.players
  ), 0);
  const missingPlayers = Math.max(0, database.activePlayers - database.simulatedPlayers);
  if (oldBuildPlayers) issues.push(`${oldBuildPlayers} 名成员的最近模拟来自其他游戏 build`);
  if (missingPlayers) issues.push(`${missingPlayers} 名活动成员尚无本地模拟结果`);
  return {
    id: "simulation-cache",
    label: "模拟缓存",
    status: oldBuildPlayers ? "warning" : "healthy",
    summary: `${currentBuildPlayers}/${database.activePlayers} 名成员使用当前 SimC build`,
    details: [
      { label: "当前 build", value: simc.gameBuild ? String(simc.gameBuild) : "未知" },
      { label: "当前结果", value: String(currentBuildPlayers) },
      { label: "其他 build", value: String(oldBuildPlayers) },
      { label: "无结果", value: String(missingPlayers) },
      { label: "最近模拟", value: database.latestSimulationAt || "无" },
      { label: "最近角色数据", value: database.latestCharacterAt || "无" },
    ],
    issues,
  };
}

function databaseComponent(
  identity: AppDbIdentity,
  backup: { latestAt: string | null; count: number; issues: string[]; status: HealthStatus },
): HealthComponent {
  const issues = [...identity.issues, ...backup.issues];
  return {
    id: "database",
    label: "业务数据库",
    status: !identity.available ? "critical" : maxStatus(backup.status, issues.length ? "warning" : "healthy"),
    summary: identity.available ? `Schema ${identity.schemaVersion} / 完整性正常` : "业务数据库不可用",
    details: [
      { label: "Schema", value: identity.schemaVersion || "未知" },
      { label: "完整性", value: identity.integrity },
      { label: "活动成员", value: String(identity.activePlayers) },
      { label: "备份数量", value: String(backup.count) },
      { label: "最近备份", value: backup.latestAt || "无" },
    ],
    issues,
  };
}

function maxStatus(left: HealthStatus, right: HealthStatus): HealthStatus {
  return severity[left] >= severity[right] ? left : right;
}

function buildNumber(version: string | null): number | null {
  if (!version) return null;
  const match = version.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) || null : null;
}

function daysBetween(value: string | null, now: Date): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? (now.getTime() - timestamp) / 86_400_000 : Number.POSITIVE_INFINITY;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nullableString(value: string | null | undefined): string | null {
  return typeof value === "string" && value ? value : null;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function runForOutput(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`命令超过 ${timeoutMs}ms 未完成`));
    }, timeoutMs);
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-64_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", () => { clearTimeout(timer); resolve(output); });
  });
}

async function readPrefix(path: string, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function findLatestFile(root: string, extension: string, maxDepth: number): Promise<{ path: string; modifiedAt: Date } | null> {
  if (!existsSync(root)) return null;
  let latest: { path: string; modifiedAt: Date } | null = null;
  async function walk(directory: string, depth: number): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < maxDepth) return walk(path, depth + 1);
      if (!entry.isFile() || !entry.name.endsWith(extension)) return;
      const modifiedAt = (await stat(path)).mtime;
      if (!latest || modifiedAt > latest.modifiedAt) latest = { path, modifiedAt };
    }));
  }
  await walk(root, 0);
  return latest;
}

async function newestModifiedAt(root: string, extension: string): Promise<Date | null> {
  const latest = await findLatestFile(root, extension, 4);
  return latest?.modifiedAt || null;
}
