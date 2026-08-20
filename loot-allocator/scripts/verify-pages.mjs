import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.PAGES_VERIFY_URL || "http://127.0.0.1:5080";
const artifacts = new URL("../artifacts/pages/", import.meta.url);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch();
const failures = [];

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  captureErrors(desktop, failures, "desktop");
  await desktop.goto(baseUrl, { waitUntil: "networkidle" });
  await desktop.locator(".team-row").first().waitFor();
  await desktop.screenshot({ path: new URL("team-desktop.png", artifacts).pathname, fullPage: true });
  await desktop.locator(".team-row").first().click();
  await desktop.locator(".player-hero").waitFor();
  await waitForVisibleImages(desktop);
  await desktop.screenshot({ path: new URL("player-desktop.png", artifacts).pathname, fullPage: true });
  await desktop.getByRole("link", { name: "团本掉落" }).click();
  await desktop.locator(".loot-layout").waitFor();
  if (!(await desktop.locator(".loot-item").count())) failures.push("desktop: boss loot is empty");
  await waitForVisibleImages(desktop);
  await desktop.screenshot({ path: new URL("loot-desktop.png", artifacts).pathname, fullPage: true });
  await desktop.getByRole("link", { name: "大秘境" }).click();
  await desktop.locator("#dungeonItems").waitFor();
  if (!(await desktop.locator("#dungeonItems .loot-item").count())) failures.push("desktop: mythic+ loot is empty");
  if (await desktop.locator("#dungeonBossSelect").inputValue() !== "all") failures.push("desktop: mythic+ does not default to all bosses");
  const dungeonItemIds = await desktop.locator("#dungeonItems .loot-item").evaluateAll((items) => items.map((item) => item.dataset.itemId));
  if (new Set(dungeonItemIds).size !== dungeonItemIds.length) failures.push("desktop: all-boss mythic+ list contains duplicate item IDs");
  await desktop.locator("#dungeonCategorySelect").selectOption("plate");
  if (!(await desktop.locator("#dungeonItems .loot-item").count())) failures.push("desktop: mythic+ plate filter is empty");
  if (await desktop.locator("#dungeonItems .loot-item").filter({ hasNotText: "板甲" }).count()) failures.push("desktop: mythic+ plate filter includes another category");
  await desktop.locator("#dungeonCategorySelect").selectOption("all");
  await desktop.locator("[data-dungeon-stat=mastery]").click();
  if (!(await desktop.locator("#dungeonItems .loot-item").count())) failures.push("desktop: mythic+ mastery filter is empty");
  await desktop.locator("[data-dungeon-stat=haste]").click();
  if (!(await desktop.locator("#dungeonItems .loot-item").count())) failures.push("desktop: combined mythic+ stat filter is empty");
  if (await desktop.locator("[data-dungeon-stat=mastery]").getAttribute("aria-pressed") !== "true"
    || await desktop.locator("[data-dungeon-stat=haste]").getAttribute("aria-pressed") !== "true") {
    failures.push("desktop: mythic+ stat filters are not multi-select");
  }
  await waitForVisibleImages(desktop);
  await desktop.screenshot({ path: new URL("dungeons-desktop.png", artifacts).pathname, fullPage: true });
  await desktop.getByRole("link", { name: "动态配装" }).click();
  await desktop.locator(".loadout-workbench").waitFor();
  if (await desktop.locator("[data-loadout-slot]").count() !== 16) failures.push("desktop: loadout does not show all equipment slots");
  if (!(await desktop.locator("[data-loadout-choice]").count())) failures.push("desktop: loadout candidate list is empty");
  if (await desktop.locator(".stat-total-strip > span").count() !== 5) failures.push("desktop: loadout does not show five raw stats");
  if ((await desktop.locator(".stat-total-strip").textContent())?.includes("-")) failures.push("desktop: default loadout has missing raw stats");
  await desktop.locator("#openSimcTemplate").click();
  await desktop.locator("#simcDialog[open]").waitFor();
  const simcTemplate = await desktop.locator("#simcTemplateText").inputValue();
  if (!/^(?:warrior|paladin|hunter|rogue|priest|deathknight|shaman|mage|warlock|monk|druid|demonhunter|evoker)=/m.test(simcTemplate)) failures.push("desktop: SimC template has no actor line");
  if (!/^talents=.+/m.test(simcTemplate)) failures.push("desktop: SimC template has no talents");
  if (!/^head=,id=\d+/m.test(simcTemplate)) failures.push("desktop: SimC template has no equipment lines");
  if (simcTemplate.includes("undefined")) failures.push("desktop: SimC template contains undefined values");
  await desktop.screenshot({ path: new URL("loadout-simc-desktop.png", artifacts).pathname, fullPage: false });
  await desktop.locator("#closeSimcDialog").click();
  const selectedCandidateId = (await desktop.locator("[data-loadout-choice]").first().getAttribute("data-loadout-choice"))?.split(":")[1];
  await desktop.locator("[data-loadout-choice]").first().click();
  if ((await desktop.locator(".loadout-summary > div").nth(2).textContent())?.includes("0件")) failures.push("desktop: loadout selection did not update replacement count");
  if (!(await desktop.locator(".stat-total-strip .positive, .stat-total-strip .negative").count())) failures.push("desktop: loadout stat deltas have no positive or negative color");
  await desktop.locator("#openSimcTemplate").click();
  const selectedSimcTemplate = await desktop.locator("#simcTemplateText").inputValue();
  if (selectedCandidateId && !new RegExp(`^head=,id=${selectedCandidateId}(?:,|$)`, "m").test(selectedSimcTemplate)) failures.push("desktop: SimC template did not apply the selected item");
  await desktop.locator("#closeSimcDialog").click();
  await waitForAllImages(desktop);
  await desktop.screenshot({ path: new URL("loadout-desktop.png", artifacts).pathname, fullPage: true });
  await desktop.getByRole("link", { name: "拾取记录" }).click();
  await desktop.locator(".history-layout").waitFor();
  await desktop.screenshot({ path: new URL("history-desktop.png", artifacts).pathname, fullPage: true });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  captureErrors(mobile, failures, "mobile");
  await mobile.goto(`${baseUrl}/#/team`, { waitUntil: "networkidle" });
  await mobile.locator(".team-row").first().waitFor();
  if (await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
    failures.push("mobile: body has horizontal overflow");
  }
  await mobile.screenshot({ path: new URL("team-mobile.png", artifacts).pathname, fullPage: true });
  await mobile.locator(".team-row").first().click();
  await mobile.locator(".player-hero").waitFor();
  if (await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
    failures.push("mobile player: body has horizontal overflow");
  }
  await mobile.screenshot({ path: new URL("player-mobile.png", artifacts).pathname, fullPage: true });
  await mobile.getByRole("link", { name: "动态配装" }).click();
  await mobile.locator(".loadout-workbench").waitFor();
  if (await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
    failures.push("mobile loadout: body has horizontal overflow");
  }
  await waitForAllImages(mobile);
  await mobile.screenshot({ path: new URL("loadout-mobile.png", artifacts).pathname, fullPage: true });

  if (failures.length) throw new Error(failures.join("\n"));
  console.log("Static publication verification passed for desktop and mobile viewports");
} finally {
  await browser.close();
}

function captureErrors(page, target, label) {
  page.on("pageerror", (error) => target.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") target.push(`${label}: console ${message.text()}`);
  });
}

async function waitForVisibleImages(page) {
  await page.waitForFunction(() => [...document.querySelectorAll("img[data-icon]")]
    .filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight;
    })
    .every((image) => image.complete && image.naturalWidth > 0));
}

async function waitForAllImages(page) {
  await page.waitForFunction(() => [...document.querySelectorAll("img[data-icon]")]
    .every((image) => image.complete && image.naturalWidth > 0));
}
