import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const workspaceRoot = resolve(projectRoot, "..");
const retiredPublisher = resolve(projectRoot, "scripts", "deploy-pages.mjs");

try {
  await access(retiredPublisher, constants.F_OK);
  fail("retired direct Pages publisher still exists");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
for (const scriptName of ["pages:publish", "sim:daily:publish"]) {
  if (packageJson.scripts?.[scriptName]) fail(`retired npm script exists: ${scriptName}`);
}

const forbidden = [
  "PAGES_REPO_URL",
  "PAGES_GITHUB_OWNER",
  "PAGES_BRANCH",
  "PAGES_GIT_NAME",
  "PAGES_GIT_EMAIL",
  "pages:publish",
  "deploy-pages.mjs",
];
const scanRoots = [
  resolve(projectRoot, "package.json"),
  resolve(projectRoot, "README.md"),
  resolve(projectRoot, "src"),
  resolve(projectRoot, "public"),
  resolve(projectRoot, "scripts"),
  resolve(workspaceRoot, ".github"),
];

for (const scanRoot of scanRoots) {
  for (const file of await listFiles(scanRoot)) {
    if (file === scriptPath) continue;
    const source = await readFile(file, "utf8");
    for (const marker of forbidden) {
      if (source.includes(marker)) fail(`${relative(workspaceRoot, file)} contains retired marker ${marker}`);
    }
    if (/\bgit\s+push\b|["']push["']\s*\]/u.test(source)) {
      fail(`${relative(workspaceRoot, file)} contains a direct Git push path`);
    }
  }
}

const workflowPath = resolve(workspaceRoot, ".github", "workflows", "ci.yml");
const workflow = await readFile(workflowPath, "utf8");
if (!/^permissions:\s*\{\}\s*$/mu.test(workflow)) {
  fail("CI workflow must default to no permissions");
}
if (/^\s*pull_request_target\s*:/mu.test(workflow)) {
  fail("CI workflow must not expose pull_request_target");
}
if (!workflow.includes("npm run ci:pages-safety")) {
  fail("CI workflow does not run the Pages safety guard");
}
for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gmu)) {
  if (!/@[0-9a-f]{40}$/u.test(match[1])) {
    fail(`CI action is not pinned to a full commit SHA: ${match[1]}`);
  }
}

console.log("Pages safety guard passed: direct repository publishing is disabled");

async function listFiles(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOTDIR") return null;
    throw error;
  });
  if (!entries) return [path];
  const nested = await Promise.all(entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => listFiles(resolve(path, entry.name))));
  return nested.flat();
}

function fail(message) {
  console.error(`[pages-safety] ${message}`);
  process.exit(1);
}
