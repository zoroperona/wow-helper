import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimePath = join(projectRoot, "data", "runtime");
const lockPath = join(runtimePath, "daily-task.lock");
const statusPath = process.env.DAILY_TASK_STATUS_PATH || join(runtimePath, "daily-sim-status.json");
const simulationStatusPath = join(runtimePath, "daily-sim-detail.json");
const checkOnly = process.argv.includes("--check");
const startedAt = new Date().toISOString();
const taskEnvironment = {
  ...process.env,
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
};
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const stages = [
  stage("build", "构建应用"),
  stage("validate", "校验依赖"),
  stage("backup", "备份业务数据库"),
  stage("simulation", "刷新角色并模拟"),
];
let simulation = emptySimulation();
let failed = false;

await acquireLock();
try {
  await persist("running", "starting");
  await runStage("build", npmCommand, ["run", "build"]);
  await runStage("validate", process.execPath, ["scripts/validate-runtime.mjs"]);

  if (checkOnly) {
    skip("backup");
    skip("simulation");
  } else {
    await runStage("backup", process.execPath, ["scripts/backup-database.mjs"]);
    await rm(simulationStatusPath, { force: true });
    const simulationExit = await runStage("simulation", process.execPath, ["dist/daily-sim.js"], {
      ...taskEnvironment,
      DAILY_TASK_STATUS_PATH: simulationStatusPath,
    }, true);
    simulation = await readSimulationStatus();
    if (simulationExit !== 0 && simulation.completed === 0) {
      throw new Error("模拟任务异常退出，且没有生成成员级运行状态");
    }
  }
} catch (error) {
  failed = true;
  const current = stages.find((entry) => entry.status === "running");
  if (current) {
    current.status = "failed";
    current.finishedAt = new Date().toISOString();
    current.error = errorMessage(error);
  }
  console.error(`[daily-task] ${errorMessage(error)}`);
} finally {
  if (!checkOnly) simulation = await readSimulationStatus();
  await persist(failed || simulation.failed > 0 ? "failed" : "succeeded", failed ? "failed" : "complete");
  await rm(lockPath, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
else if (simulation.failed > 0) process.exitCode = 10;

function stage(id, label) {
  return { id, label, status: "pending", startedAt: null, finishedAt: null, error: null };
}

async function runStage(id, command, args, env = taskEnvironment, continueOnFailure = false) {
  const current = stages.find((entry) => entry.id === id);
  current.status = "running";
  current.startedAt = new Date().toISOString();
  await persist("running", id);
  console.log(`[daily-task] ${current.label}`);
  const status = await run(command, args, env);
  current.finishedAt = new Date().toISOString();
  if (status !== 0) {
    current.status = "failed";
    current.error = `${current.label}存在失败（退出码 ${status}）`;
    await persist("running", id);
    if (!continueOnFailure) throw new Error(current.error);
    return status;
  }
  current.status = "succeeded";
  await persist("running", id);
  return status;
}

function skip(id) {
  const current = stages.find((entry) => entry.id === id);
  current.status = "skipped";
  current.finishedAt = new Date().toISOString();
}

async function acquireLock() {
  await mkdir(runtimePath, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt }, null, 2)}\n`);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readLockOwner();
      if (owner?.host === hostname() && owner.pid && processIsRunning(owner.pid)) {
        throw new Error(`已有每日任务在运行（PID ${owner.pid}）`);
      }
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      if (age < 6 * 60 * 60_000) throw new Error("每日任务锁存在且无法确认已失效");
      console.warn("[daily-task] 清理超过 6 小时的失效任务锁");
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  throw new Error("无法获取每日任务锁");
}

async function readLockOwner() {
  try { return JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")); } catch { return null; }
}

function processIsRunning(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("tasklist.exe", ["/FI", `PID eq ${Number(pid)}`, "/NH"], { encoding: "utf8" });
    return result.status === 0 && new RegExp(`\\b${Number(pid)}\\b`).test(result.stdout || "");
  }
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function readSimulationStatus() {
  try {
    const value = JSON.parse(await readFile(simulationStatusPath, "utf8"));
    return {
      total: Number(value.total) || 0,
      completed: Number(value.completed) || 0,
      succeeded: Number(value.succeeded) || 0,
      failed: Number(value.failed) || 0,
      failures: Array.isArray(value.failures) ? value.failures : [],
    };
  } catch {
    return emptySimulation();
  }
}

function emptySimulation() {
  return { total: 0, completed: 0, succeeded: 0, failed: 0, failures: [] };
}

async function persist(status, phase) {
  await mkdir(runtimePath, { recursive: true });
  const value = {
    schemaVersion: 1,
    status,
    mode: checkOnly ? "check" : "daily",
    phase,
    startedAt,
    finishedAt: status === "running" ? null : new Date().toISOString(),
    ...simulation,
    stages,
  };
  const temporary = `${statusPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, statusPath);
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
