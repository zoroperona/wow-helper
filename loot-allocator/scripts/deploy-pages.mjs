import { mkdtemp, cp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

const repositoryUrl = process.env.PAGES_REPO_URL?.trim();
const expectedOwner = process.env.PAGES_GITHUB_OWNER?.trim();
const branch = process.env.PAGES_BRANCH?.trim() || "main";
if (!repositoryUrl || !expectedOwner) {
  throw new Error("PAGES_REPO_URL and PAGES_GITHUB_OWNER are required; use a dedicated personal GitHub repository");
}

const parsed = repositoryUrl.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
if (!parsed || parsed[1]?.toLowerCase() !== expectedOwner.toLowerCase()) {
  throw new Error(`Refusing to publish: repository owner must be ${expectedOwner}`);
}

const projectRoot = new URL("../", import.meta.url).pathname;
const publicationPath = join(projectRoot, "pages-dist");
const temporaryRoot = await mkdtemp(join(tmpdir(), "wow-helper-pages-"));
const checkoutPath = join(temporaryRoot, "publication");

try {
  await run("git", ["clone", "--depth", "1", repositoryUrl, checkoutPath]);
  await run("git", ["checkout", "-B", branch], checkoutPath);
  const existing = await readdir(checkoutPath);
  await Promise.all(existing
    .filter((name) => name !== ".git")
    .map((name) => rm(join(checkoutPath, name), { recursive: true, force: true })));
  await cp(publicationPath, checkoutPath, { recursive: true });
  await run("git", ["config", "user.name", process.env.PAGES_GIT_NAME || "WoW Helper Publisher"], checkoutPath);
  await run("git", ["config", "user.email", process.env.PAGES_GIT_EMAIL || `${expectedOwner}@users.noreply.github.com`], checkoutPath);
  await run("git", ["add", "--all"], checkoutPath);

  const changed = await run("git", ["diff", "--cached", "--quiet"], checkoutPath, true);
  if (changed === 0) {
    console.log("[pages] No publication changes to push");
  } else {
    const metadata = JSON.parse(await readFile(join(publicationPath, "publication.json"), "utf8"));
    await run("git", ["commit", "-m", `Publish ${metadata.publishedAt}`], checkoutPath);
    await run("git", ["push", "origin", `HEAD:${branch}`], checkoutPath);
    console.log(`[pages] Published revision ${metadata.revision} to ${expectedOwner}/${basename(parsed[2], ".git")}`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd = projectRoot, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: allowFailure ? "ignore" : "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || allowFailure) resolve(code ?? 1);
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}
