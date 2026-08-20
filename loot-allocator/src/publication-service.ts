import { spawn } from "node:child_process";
import { appRoot } from "./config.js";
import { IntegrationError } from "./dpswow.js";

export interface PublicationStatus {
  configured: boolean;
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  lastSucceededAt: string | null;
  error: string | null;
}

export class PublicationService {
  private status: PublicationStatus = {
    configured: Boolean(process.env.PAGES_REPO_URL && process.env.PAGES_GITHUB_OWNER),
    running: false,
    startedAt: null,
    finishedAt: null,
    lastSucceededAt: null,
    error: null,
  };

  getStatus(): PublicationStatus {
    return structuredClone(this.status);
  }

  start(): PublicationStatus {
    if (!this.status.configured) {
      throw new IntegrationError("公开页仓库尚未配置", 409, "PAGES_NOT_CONFIGURED");
    }
    if (this.status.running) {
      throw new IntegrationError("公开页正在发布", 409, "PUBLICATION_RUNNING");
    }

    this.status = {
      ...this.status,
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    void this.run();
    return this.getStatus();
  }

  private async run(): Promise<void> {
    try {
      await runNpmScript("pages:publish");
      const finishedAt = new Date().toISOString();
      this.status = {
        ...this.status,
        running: false,
        finishedAt,
        lastSucceededAt: finishedAt,
        error: null,
      };
    } catch (error) {
      this.status = {
        ...this.status,
        running: false,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function runNpmScript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmExecPath = process.env.npm_execpath;
    const command = npmExecPath ? process.execPath : "npm";
    const args = npmExecPath ? [npmExecPath, "run", script] : ["run", script];
    const child = spawn(command, args, {
      cwd: appRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-8_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(output.trim() || `发布进程退出 (${code})`));
    });
  });
}
