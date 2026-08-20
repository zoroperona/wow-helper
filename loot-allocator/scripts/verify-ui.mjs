import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.VERIFY_URL || "http://127.0.0.1:5070";
const artifacts = new URL("../artifacts/", import.meta.url);
await mkdir(artifacts, { recursive: true });

const browser = await chromium.launch();
const failures = [];

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  captureErrors(desktop, failures, "desktop");
  await desktop.goto(baseUrl, { waitUntil: "networkidle" });
  if (!(await desktop.locator("#allocationView").isVisible())) {
    failures.push("desktop: allocation workspace is not the default view");
  }
  await desktop.screenshot({
    path: new URL("allocation-desktop.png", artifacts).pathname,
    fullPage: true,
  });
  const firstLoot = desktop.locator(".loot-entry").first();
  if ((await firstLoot.count()) > 0) {
    await firstLoot.click();
    const headerPositions = await desktop.locator(".candidate-columns > span").evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().x),
    );
    const rowPositions = await desktop.locator(".candidate-row").first().locator(":scope > *").evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().x),
    );
    if (headerPositions.some((position, index) => Math.abs(position - rowPositions[index]) > 1)) {
      failures.push("desktop: candidate headers are not aligned with row values");
    }
    const candidateName = desktop.locator(".candidate-player-name:not(.class-unknown)").first();
    if ((await candidateName.count()) > 0) {
      const color = await candidateName.evaluate((element) => getComputedStyle(element).color);
      if (color === "rgb(240, 238, 232)") failures.push("desktop: candidate name has no class color");
    }
    const calculableLoot = desktop.locator(".loot-entry").filter({
      hasNot: desktop.locator(".effect-reference"),
    }).first();
    if ((await calculableLoot.count()) > 0) {
      await calculableLoot.click();
      const calculation = desktop.locator(".candidate-score-calculation").first();
      if ((await calculation.count()) > 0) {
        await calculation.hover();
        const tooltipText = await desktop.locator("#hoverTooltip").textContent();
        if (!tooltipText?.includes("*") || !tooltipText.includes("=")) {
          failures.push("desktop: candidate score tooltip has no calculation details");
        }
      }
    }
  }
  await desktop.getByRole("button", { name: "团队名单" }).click();
  const namedClassPlayers = desktop.locator(".player-name[class*='class-']:not(.class-unknown)");
  if ((await namedClassPlayers.count()) > 0) {
    const playerColor = await namedClassPlayers.first().evaluate((element) => getComputedStyle(element).color);
    if (playerColor === "rgb(239, 237, 230)") {
      failures.push("desktop: known class player name has no class color");
    }
  }
  const desktopActionHeights = await desktop.locator(".table-action").evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().height),
  );
  if (desktopActionHeights.some((height) => height > 32)) {
    failures.push("desktop: roster action text wrapped to multiple lines");
  }
  const editButton = desktop.getByRole("button", { name: "编辑", exact: true }).first();
  if ((await editButton.count()) > 0) {
    await editButton.click();
    const playerForm = desktop.locator("#playerForm");
    if (!(await playerForm.locator("input[name=playerId]").inputValue())) {
      failures.push("desktop: player edit dialog has no player id");
    }
    if (!(await playerForm.locator("input[name=name]").inputValue())) {
      failures.push("desktop: player edit dialog did not preload the character name");
    }
    await desktop.getByRole("button", { name: "取消" }).click();
  }
  await desktop.screenshot({ path: new URL("roster-desktop.png", artifacts).pathname, fullPage: true });

  const weightButton = desktop.getByRole("button", { name: "查看收益" });
  if ((await weightButton.count()) > 0) {
    await weightButton.first().click();
    await desktop.getByRole("dialog").waitFor();
    await desktop.screenshot({ path: new URL("weight-dialog.png", artifacts).pathname, fullPage: true });
    await desktop.getByRole("button", { name: "完成" }).click();
  }


  const equipmentButton = desktop.getByRole("button", { name: "查看装备" });
  if ((await equipmentButton.count()) > 0) {
    await equipmentButton.first().click();
    const equipmentDialog = desktop.locator("#equipmentDialog");
    await equipmentDialog.waitFor();
    const itemCount = await equipmentDialog.locator(".equipment-item").count();
    const placeholderCount = await equipmentDialog.locator(".missing-item-icon").count();
    const imageCount = await equipmentDialog.locator("img.item-icon").count();
    if (itemCount === 0) failures.push("desktop: equipment dialog has no items");
    if (imageCount !== itemCount) failures.push("desktop: equipment item image mismatch");
    if (placeholderCount > itemCount) failures.push("desktop: equipment icon fallback mismatch");
    const firstEquipment = equipmentDialog.locator(".equipment-item").first();
    if ((await firstEquipment.count()) > 0) {
      const displayedLevel = (await firstEquipment.locator(".equipment-detail").textContent())?.match(/物品等级\s*(\d+)/)?.[1];
      await firstEquipment.hover();
      await desktop.locator("#hoverTooltip").waitFor();
      const tooltipVisibleAboveDialog = await desktop.locator("#hoverTooltip").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.closest("dialog[open]") !== null &&
          !element.hidden && rect.width > 0 && rect.height > 0 &&
          rect.top >= 0 && rect.bottom <= innerHeight;
      });
      if (!tooltipVisibleAboveDialog) {
        failures.push("desktop: equipment tooltip is rendered behind the modal dialog");
      }
      const tooltipLevel = (await desktop.locator("#hoverTooltip").textContent())?.match(/(?:物品等级|英雄榜装等)[：:]?\s*(\d+)/)?.[1];
      if (displayedLevel && tooltipLevel !== displayedLevel) {
        failures.push(`desktop: equipment tooltip level ${tooltipLevel} does not match armory ${displayedLevel}`);
      }
    }
    await desktop.screenshot({
      path: new URL("equipment-dialog.png", artifacts).pathname,
      fullPage: true,
    });
    await equipmentDialog.getByRole("button", { name: "完成" }).click();
  }

  await desktop.getByRole("button", { name: "添加团员" }).click();
  await desktop.getByRole("dialog").waitFor();
  const realmInput = desktop.locator("#realmInput");
  await realmInput.focus();
  const firstRealmOption = desktop.locator(".realm-option").first();
  if ((await firstRealmOption.count()) > 0) {
    await firstRealmOption.hover();
    const optionBackground = await firstRealmOption.evaluate((element) => getComputedStyle(element).backgroundColor);
    if (optionBackground === "rgba(0, 0, 0, 0)" || optionBackground === "transparent") {
      failures.push("desktop: realm option hover background is transparent");
    }
  }
  await desktop.screenshot({ path: new URL("player-dialog.png", artifacts).pathname, fullPage: true });
  await desktop.getByRole("button", { name: "关闭" }).click();

  await desktop.getByRole("button", { name: "拾取记录" }).click();
  if (!(await desktop.locator("#historyView").isVisible())) {
    failures.push("desktop: history view did not open");
  }

  await desktop.getByRole("button", { name: "规则配置" }).click();
  if ((await desktop.locator(".rule-row").count()) === 0) {
    failures.push("desktop: loot rules were not rendered");
  }
  await desktop.screenshot({ path: new URL("rules-desktop.png", artifacts).pathname, fullPage: true });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  captureErrors(mobile, failures, "mobile");
  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await mobile.screenshot({
    path: new URL("allocation-mobile.png", artifacts).pathname,
    fullPage: true,
  });
  await mobile.getByRole("button", { name: "团队名单" }).click();
  const mobileActionHeights = await mobile.locator(".table-action").evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().height),
  );
  if (mobileActionHeights.some((height) => height > 32)) {
    failures.push("mobile: roster action text wrapped to multiple lines");
  }
  const mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  if (mobileOverflow) failures.push("mobile: body has horizontal overflow");
  await mobile.screenshot({ path: new URL("roster-mobile.png", artifacts).pathname, fullPage: true });

  const mobileEquipmentButton = mobile.getByRole("button", { name: "查看装备" });
  if ((await mobileEquipmentButton.count()) > 0) {
    await mobileEquipmentButton.first().click();
    const equipmentDialog = mobile.locator("#equipmentDialog");
    await equipmentDialog.waitFor();
    const dimensions = await equipmentDialog.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    if (dimensions.scrollHeight <= dimensions.clientHeight) {
      failures.push("mobile: equipment dialog is expected to be internally scrollable");
    }
    await equipmentDialog.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await mobile.screenshot({
      path: new URL("equipment-dialog-mobile.png", artifacts).pathname,
      fullPage: false,
    });
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  console.log("UI verification passed for desktop and mobile viewports");
} finally {
  await browser.close();
}

function captureErrors(page, target, label) {
  page.on("pageerror", (error) => target.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") target.push(`${label}: console ${message.text()}`);
  });
}
