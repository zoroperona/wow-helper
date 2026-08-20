import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("../", import.meta.url);

describe("Pages publication safety", () => {
  it("removes the retired direct repository publisher", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("package.json", projectRoot), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["pages:publish"]).toBeUndefined();
    expect(packageJson.scripts?.["sim:daily:publish"]).toBeUndefined();
    await expect(access(
      new URL("scripts/deploy-pages.mjs", projectRoot),
      constants.F_OK,
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes the repository denylist", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [new URL("scripts/check-pages-safety.mjs", projectRoot).pathname],
      { cwd: projectRoot.pathname },
    );
    expect(stdout).toContain("direct repository publishing is disabled");
  });
});
