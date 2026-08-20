import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const projectRoot = new URL("../", import.meta.url);

describe("production daily pipeline", () => {
  it("does not publish a static data snapshot", async () => {
    const runner = await readFile(new URL("scripts/run-daily-pipeline.mjs", projectRoot), "utf8");

    for (const forbidden of [
      "publish-pages",
      "deploy-pages",
      "PAGES_REPO_URL",
      "PAGES_GITHUB_OWNER",
      'stage("publication"',
      'stage("deployment"',
    ]) {
      expect(runner, `production runner must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("exposes only the production-safe scheduled command", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("package.json", projectRoot), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["ops:daily"]).toBe("node scripts/run-daily-pipeline.mjs");
    expect(packageJson.scripts?.["ops:daily:check"]).toBe(
      "node scripts/run-daily-pipeline.mjs --check",
    );
    expect(packageJson.scripts?.["sim:daily:publish"]).toBeUndefined();
  });
});
