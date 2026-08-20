const state = {
  season: null,
  players: [],
  realms: [],
  allocations: [],
  rules: [],
  catalog: null,
  selectedRaidId: null,
  selectedBossId: null,
  selectedItemId: null,
  selectedItemDetailsLoading: false,
  difficulty: "heroic",
  showLegacyRaids: false,
  weightCaches: {},
  simulation: {
    running: false,
    currentPlayerId: null,
    currentPlayerName: null,
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
  },
  publication: {
    configured: false,
    running: false,
    startedAt: null,
    finishedAt: null,
    lastSucceededAt: null,
    error: null,
  },
  health: null,
  rosterSort: { key: "role", direction: "default" },
  currentView: "allocation",
};

const roleLabels = {
  tank: "坦克",
  melee: "近战",
  ranged: "远程",
  healer: "治疗",
};

const statLabels = {
  intellect: "智力",
  agility: "敏捷",
  strength: "力量",
  versatility: "全能",
  haste: "急速",
  mastery: "精通",
  criticalStrike: "暴击",
};

const classColorKeys = {
  战士: "warrior", Warrior: "warrior", WARRIOR: "warrior",
  圣骑士: "paladin", Paladin: "paladin", PALADIN: "paladin",
  猎人: "hunter", Hunter: "hunter", HUNTER: "hunter",
  潜行者: "rogue", Rogue: "rogue", ROGUE: "rogue",
  牧师: "priest", Priest: "priest", PRIEST: "priest",
  死亡骑士: "death-knight", "Death Knight": "death-knight", DEATHKNIGHT: "death-knight",
  萨满祭司: "shaman", Shaman: "shaman", SHAMAN: "shaman",
  法师: "mage", Mage: "mage", MAGE: "mage",
  术士: "warlock", Warlock: "warlock", WARLOCK: "warlock",
  武僧: "monk", Monk: "monk", MONK: "monk",
  德鲁伊: "druid", Druid: "druid", DRUID: "druid",
  恶魔猎手: "demon-hunter", "Demon Hunter": "demon-hunter", DEMONHUNTER: "demon-hunter",
  唤魔师: "evoker", Evoker: "evoker", EVOKER: "evoker",
};

const classIds = {
  战士: 1, Warrior: 1, WARRIOR: 1,
  圣骑士: 2, Paladin: 2, PALADIN: 2,
  猎人: 3, Hunter: 3, HUNTER: 3,
  潜行者: 4, Rogue: 4, ROGUE: 4,
  牧师: 5, Priest: 5, PRIEST: 5,
  死亡骑士: 6, "Death Knight": 6, DEATHKNIGHT: 6,
  萨满祭司: 7, Shaman: 7, SHAMAN: 7,
  法师: 8, Mage: 8, MAGE: 8,
  术士: 9, Warlock: 9, WARLOCK: 9,
  武僧: 10, Monk: 10, MONK: 10,
  德鲁伊: 11, Druid: 11, DRUID: 11,
  恶魔猎手: 12, "Demon Hunter": 12, DEMONHUNTER: 12,
  唤魔师: 13, Evoker: 13, EVOKER: 13,
};

const elements = {
  rosterBody: document.querySelector("#rosterBody"),
  emptyState: document.querySelector("#emptyState"),
  playerCount: document.querySelector("#playerCount"),
  damageCount: document.querySelector("#damageCount"),
  weightCount: document.querySelector("#weightCount"),
  gameVersion: document.querySelector("#gameVersion"),
  seasonLabel: document.querySelector("#seasonLabel"),
  playerDialog: document.querySelector("#playerDialog"),
  playerForm: document.querySelector("#playerForm"),
  weightDialog: document.querySelector("#weightDialog"),
  weightForm: document.querySelector("#weightForm"),
  weightViewDialog: document.querySelector("#weightViewDialog"),
  equipmentDialog: document.querySelector("#equipmentDialog"),
  allocationDeleteDialog: document.querySelector("#allocationDeleteDialog"),
  allocationDeleteForm: document.querySelector("#allocationDeleteForm"),
  historyList: document.querySelector("#historyList"),
  rulesList: document.querySelector("#rulesList"),
  catalogState: document.querySelector("#catalogState"),
  raidList: document.querySelector("#raidList"),
  toast: document.querySelector("#toast"),
  simulateStaleButton: document.querySelector("#simulateStaleButton"),
  simulationActivity: document.querySelector("#simulationActivity"),
  simulationActivityText: document.querySelector("#simulationActivityText"),
  publishButton: document.querySelector("#publishButton"),
  healthNavButton: document.querySelector("#healthNavButton"),
  healthNavDot: document.querySelector("#healthNavDot"),
  healthOverview: document.querySelector("#healthOverview"),
  healthOverviewDot: document.querySelector("#healthOverviewDot"),
  healthOverviewTitle: document.querySelector("#healthOverviewTitle"),
  healthCheckedAt: document.querySelector("#healthCheckedAt"),
  healthGrid: document.querySelector("#healthGrid"),
  healthIssueCount: document.querySelector("#healthIssueCount"),
  healthIssueList: document.querySelector("#healthIssueList"),
  refreshHealthButton: document.querySelector("#refreshHealthButton"),
};

const hoverTooltip = document.querySelector("#hoverTooltip");
const realmInput = document.querySelector("#realmInput");
const realmOptions = document.querySelector("#realmOptions");
const itemDetailsCache = new Map();

document.querySelector("#rosterView thead").addEventListener("click", (event) => {
  const button = event.target.closest("[data-roster-sort]");
  if (!button) return;
  const key = button.dataset.rosterSort;
  state.rosterSort = key === "role"
    ? { key: "role", direction: "default" }
    : {
        key,
        direction: state.rosterSort.key === key && state.rosterSort.direction === "desc"
          ? "asc"
          : "desc",
      };
  renderRoster();
});
document.addEventListener("click", (event) => {
  document.querySelectorAll(".weight-actions-menu[open]").forEach((menu) => {
    if (!menu.contains(event.target)) menu.removeAttribute("open");
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    document.querySelectorAll(".weight-actions-menu[open]").forEach((menu) => menu.removeAttribute("open"));
  }
});
elements.rosterBody.addEventListener("toggle", (event) => {
  const menu = event.target.closest?.(".weight-actions-menu");
  if (!menu?.open) return;
  document.querySelectorAll(".weight-actions-menu[open]").forEach((other) => {
    if (other !== menu) other.removeAttribute("open");
  });
  positionWeightMenu(menu);
}, true);
window.addEventListener("resize", () => {
  document.querySelectorAll(".weight-actions-menu[open]").forEach(positionWeightMenu);
});

function positionWeightMenu(menu) {
  const trigger = menu.querySelector("summary");
  const popover = menu.querySelector(".weight-actions-popover");
  if (!trigger || !popover) return;
  const rect = trigger.getBoundingClientRect();
  const width = 124;
  const estimatedHeight = popover.scrollHeight || 112;
  popover.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
  popover.style.top = `${rect.bottom + estimatedHeight + 8 > window.innerHeight
    ? Math.max(8, rect.top - estimatedHeight - 5)
    : rect.bottom + 5}px`;
}
let lastPointerPosition = { x: 0, y: 0 };
document.addEventListener("pointerover", (event) => {
  const target = event.target.closest?.(".has-tooltip");
  if (!target || !hoverTooltip) return;
  const openDialog = target.closest("dialog[open]");
  const tooltipParent = openDialog || document.body;
  if (hoverTooltip.parentElement !== tooltipParent) tooltipParent.append(hoverTooltip);
  hoverTooltip.innerHTML = renderTooltipHtml({ target });
  hoverTooltip.hidden = !hoverTooltip.textContent.trim();
  lastPointerPosition = { x: event.clientX, y: event.clientY };
  positionHoverTooltip(event.clientX, event.clientY);
  if (target.dataset.itemId) void loadHoverDetails(target);
});
document.addEventListener("pointermove", (event) => {
  if (!hoverTooltip || hoverTooltip.hidden) return;
  lastPointerPosition = { x: event.clientX, y: event.clientY };
  positionHoverTooltip(event.clientX, event.clientY);
});

function positionHoverTooltip(clientX, clientY) {
  if (!hoverTooltip || hoverTooltip.hidden) return;
  const left = Math.min(clientX + 14, window.innerWidth - hoverTooltip.offsetWidth - 12);
  const top = Math.min(clientY + 14, window.innerHeight - hoverTooltip.offsetHeight - 12);
  hoverTooltip.style.left = `${Math.max(12, left)}px`;
  hoverTooltip.style.top = `${Math.max(12, top)}px`;
}
document.addEventListener("pointerout", (event) => {
  if (event.target.closest?.(".has-tooltip") && !event.relatedTarget?.closest?.(".has-tooltip")) {
    if (hoverTooltip) hoverTooltip.hidden = true;
  }
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

document.querySelector("#addPlayerButton").addEventListener("click", () => {
  openPlayerDialog();
});

elements.simulateStaleButton.addEventListener("click", async () => {
  setBusy(elements.simulateStaleButton, true);
  try {
    const status = await api("/api/simulations/stale", { method: "POST" });
    state.simulation = status;
    render();
    showToast(status.running
      ? `已开始模拟 ${status.total} 名超过一天未更新的成员`
      : "没有超过一天未更新的收益");
  } catch (error) {
    showToast(error.message, true);
    await loadSimulationStatus();
  } finally {
    if (!state.simulation.running) setBusy(elements.simulateStaleButton, false);
  }
});

realmInput.addEventListener("input", () => renderRealmOptions(realmInput.value));
realmInput.addEventListener("focus", () => renderRealmOptions(realmInput.value));
realmInput.addEventListener("keydown", (event) => {
  const options = [...realmOptions.querySelectorAll("[data-realm-name]")];
  if (event.key === "Escape") {
    closeRealmOptions();
    return;
  }
  if (event.key === "Enter" && !realmOptions.hidden) {
    const option = realmOptions.querySelector(".is-active") || options[0];
    if (option) {
      event.preventDefault();
      selectRealmOption(option);
    }
    return;
  }
  if (!["ArrowDown", "ArrowUp"].includes(event.key) || !options.length) return;
  event.preventDefault();
  const activeIndex = options.findIndex((option) => option.classList.contains("is-active"));
  const nextIndex = event.key === "ArrowDown"
    ? Math.min(activeIndex + 1, options.length - 1)
    : Math.max(activeIndex < 0 ? 0 : activeIndex - 1, 0);
  options.forEach((option, index) => option.classList.toggle("is-active", index === nextIndex));
  options[nextIndex].scrollIntoView({ block: "nearest" });
});
realmOptions.addEventListener("pointerdown", (event) => {
  const option = event.target.closest("[data-realm-name]");
  if (!option) return;
  event.preventDefault();
  selectRealmOption(option);
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest?.(".realm-field")) closeRealmOptions();
});

document.querySelector("#backupButton").addEventListener("click", () => {
  window.location.href = "/api/backups/export";
});

elements.refreshHealthButton.addEventListener("click", async () => {
  setBusy(elements.refreshHealthButton, true);
  try {
    await loadSystemHealth(true);
    showToast("数据状态已重新检查");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(elements.refreshHealthButton, false);
  }
});

elements.publishButton.addEventListener("click", async () => {
  setBusy(elements.publishButton, true);
  try {
    state.publication = await api("/api/publication", { method: "POST" });
    renderPublicationState();
    showToast("公开页已开始发布");
  } catch (error) {
    showToast(error.message, true);
    await loadPublicationStatus();
  }
});

document.querySelector("#refreshCatalogButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true);
  try {
    await loadWorkspace(true);
    showToast(state.catalog.connected ? "掉落数据已刷新" : "本地 wow-db 尚未生成");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
  }
});

document.querySelectorAll("input[name=lootDifficulty]").forEach((input) => {
  input.addEventListener("change", () => {
    state.difficulty = input.value;
    renderLoot();
    renderCandidates();
  });
});

document.querySelector("#showLegacyRaids").addEventListener("change", (event) => {
  state.showLegacyRaids = event.currentTarget.checked;
  if (!getSelectedRaid()?.isCurrent) {
    state.selectedRaidId = null;
    state.selectedBossId = null;
    state.selectedItemId = null;
  }
  renderCatalog();
});

elements.rulesList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-save-rule]");
  if (!button) return;
  const row = button.closest("[data-rule-key]");
  if (!row) return;
  setBusy(button, true);
  try {
    const updated = await api(`/api/loot/rules/${encodeURIComponent(row.dataset.ruleKey)}`, {
      method: "PUT",
      body: JSON.stringify({
        pickupCount: Number(row.querySelector("[data-rule-count]").value),
        countsTowardTotal: row.querySelector("[data-rule-counts]").checked,
      }),
    });
    state.rules = state.rules.map((rule) => rule.ruleKey === updated.ruleKey ? updated : rule);
    renderRules();
    showToast(`${updated.displayName}规则已保存`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
  }
});

elements.historyList.addEventListener("change", async (event) => {
  const input = event.target.closest("[data-allocation-count]");
  if (!input) return;
  const pickupCount = Number(input.value);
  if (!Number.isFinite(pickupCount) || pickupCount < 0 || pickupCount > 99) {
    renderHistory();
    showToast("拾取数必须在 0 到 99 之间", true);
    return;
  }
  input.disabled = true;
  try {
    const updated = await api(`/api/allocations/${encodeURIComponent(input.dataset.allocationCount)}`, {
      method: "PATCH",
      body: JSON.stringify({ pickupCount }),
    });
    state.allocations = state.allocations.map((entry) => entry.id === updated.id ? updated : entry);
    await loadState();
    render();
    showToast(`${updated.playerName} 的拾取数已更新`);
  } catch (error) {
    renderHistory();
    showToast(error.message, true);
  }
});

elements.historyList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-allocation]");
  if (!button) return;
  const allocation = state.allocations.find((entry) => entry.id === button.dataset.deleteAllocation);
  if (!allocation) return;
  elements.allocationDeleteForm.elements.allocationId.value = allocation.id;
  document.querySelector("#allocationDeleteItem").textContent = allocation.itemName;
  document.querySelector("#allocationDeleteMeta").textContent = [
    allocation.playerName,
    allocationBossLabel(allocation),
    formatDate(allocation.allocatedAt),
  ].join(" · ");
  elements.allocationDeleteDialog.showModal();
});

elements.allocationDeleteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const allocationId = elements.allocationDeleteForm.elements.allocationId.value;
  const allocation = state.allocations.find((entry) => entry.id === allocationId);
  const submit = event.submitter;
  if (!allocation) {
    elements.allocationDeleteDialog.close();
    return;
  }
  setBusy(submit, true);
  try {
    await api(`/api/allocations/${encodeURIComponent(allocationId)}`, { method: "DELETE" });
    state.allocations = state.allocations.filter((entry) => entry.id !== allocationId);
    elements.allocationDeleteDialog.close();
    await loadState();
    showToast(`${allocation.playerName} 的“${allocation.itemName}”拾取记录已删除`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(submit, false);
  }
});

elements.raidList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-raid-id], [data-boss-id]");
  if (!button) return;
  if (button.dataset.raidId) {
    state.selectedRaidId = Number(button.dataset.raidId);
    state.selectedBossId = null;
    state.selectedItemId = null;
  } else {
    state.selectedBossId = Number(button.dataset.bossId);
    state.selectedItemId = null;
  }
  renderCatalog();
});

document.querySelector("#lootList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-item-id]");
  if (!button) return;
  state.selectedItemId = Number(button.dataset.itemId);
  state.selectedItemDetailsLoading = true;
  renderLoot();
  void enrichSelectedLoot();
});

document.querySelector("#candidateList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-allocate-player]");
  if (!button) return;
  const selected = getSelectedLoot();
  const raid = getSelectedRaid();
  const boss = getSelectedBoss();
  const rule = state.rules.find((entry) => entry.ruleKey === selected?.equipmentType);
  if (!selected || !raid || !boss || !rule) return;
  setBusy(button, true);
  try {
    await api("/api/allocations", {
      method: "POST",
      body: JSON.stringify({
        playerId: button.dataset.allocatePlayer,
        raidId: String(raid.id),
        raidName: raid.name,
        bossId: String(boss.id),
        bossName: boss.name,
        itemId: selected.itemId,
        itemName: selected.name,
        equipmentType: selected.equipmentType,
        itemLevel: selected.itemLevels?.[state.difficulty] || selected.itemLevel,
        difficulty: state.difficulty,
        pickupCount: rule.pickupCount,
        countsTowardTotal: rule.countsTowardTotal,
        isSpecialEffect: selected.isSpecialEffect,
      }),
    });
    await Promise.all([loadState(), loadWorkspace()]);
    showToast(`${button.dataset.playerName} 已记录拾取`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
  }
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector(`#${button.dataset.closeDialog}`).close();
  });
});

elements.playerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  setBusy(submit, true);
  try {
    const form = new FormData(elements.playerForm);
    const playerId = String(form.get("playerId") || "");
    const realmInput = String(form.get("realm") || "").trim();
    const realm = state.realms.find(
      (entry) => entry.name === realmInput || entry.slug === realmInput,
    );
    if (!realm) {
      throw new Error("请选择有效的国服服务器");
    }
    const saved = await api(playerId ? `/api/players/${playerId}` : "/api/players", {
      method: playerId ? "PUT" : "POST",
      body: JSON.stringify({
        name: String(form.get("name") || "").trim(),
        realmName: realm.name,
        realmSlug: realm.slug,
        raidRole: String(form.get("raidRole") || ""),
        mainStat: null,
      }),
    });
    try {
      const result = await refreshCharacter(saved);
      const source = result.source === "blizzard-cn-armory" ? "官方英雄榜" : "DPSWOW 兜底";
      showToast(playerId ? `团员资料已保存，${source}已更新` : `团员已添加，${source}已更新`);
    } catch (error) {
      showToast(`${playerId ? "团员资料已保存" : "团员已添加"}；角色资料读取失败：${error.message}`, true);
    }
    elements.playerDialog.close();
    await loadState();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(submit, false);
  }
});

elements.weightForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  setBusy(submit, true);
  try {
    const form = new FormData(elements.weightForm);
    const playerId = String(form.get("playerId") || "");
    await api(`/api/players/${playerId}/weights/import`, {
      method: "POST",
      body: JSON.stringify({ resultUrl: String(form.get("resultUrl") || "").trim() }),
    });
    elements.weightDialog.close();
    showToast("收益缓存已更新");
    await loadState();
    await showWeight(playerId);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(submit, false);
  }
});

elements.rosterBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  button.closest("details")?.removeAttribute("open");
  const player = state.players.find((entry) => entry.id === button.dataset.playerId);
  if (!player) return;

  if (button.dataset.action === "simulate-player") {
    setBusy(button, true);
    try {
      const status = await api(`/api/players/${player.id}/simulate`, { method: "POST" });
      state.simulation = status;
      render();
      showToast(`${player.name} 已开始更新装备并模拟收益`);
    } catch (error) {
      showToast(error.message, true);
      await loadSimulationStatus();
    }
    return;
  }

  if (button.dataset.action === "refresh-character") {
    setBusy(button, true);
    try {
      const result = await refreshCharacter(player);
      showToast(
        result.source === "blizzard-cn-armory"
          ? `${player.name} 的官方英雄榜资料已更新`
          : `${player.name} 已通过 DPSWOW 兜底更新`,
      );
      await loadState();
      await showEquipment(player.id);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  if (button.dataset.action === "edit-player") {
    openPlayerDialog(player);
  }

  if (button.dataset.action === "delete-player") {
    if (!window.confirm(`确定删除团员“${player.name}”吗？该角色的英雄榜和收益缓存也会被删除。`)) return;
    setBusy(button, true);
    try {
      await api(`/api/players/${player.id}`, { method: "DELETE" });
      showToast(`${player.name} 已删除`);
      await Promise.all([loadState(), loadWorkspace()]);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }

  if (button.dataset.action === "import-weight") {
    elements.weightForm.reset();
    elements.weightForm.elements.playerId.value = player.id;
    document.querySelector("#weightDialogTitle").textContent = `更新 ${player.name} 的收益`;
    elements.weightDialog.showModal();
  }

  if (button.dataset.action === "view-weight") {
    try {
      await showWeight(player.id);
    } catch (error) {
      showToast(error.message, true);
    }
  }


  if (button.dataset.action === "view-equipment") {
    try {
      await showEquipment(player.id);
    } catch (error) {
      showToast(error.message, true);
    }
  }
});

async function loadState() {
  const data = await api("/api/state");
  state.season = data.season;
  state.players = data.players;
  if (state.catalog) render();
}

let simulationPollInFlight = false;
async function loadSimulationStatus(announceCompletion = false) {
  if (simulationPollInFlight) return;
  simulationPollInFlight = true;
  const previous = state.simulation;
  try {
    const status = await api("/api/simulations/status");
    state.simulation = status;
    if (announceCompletion && previous.running && !status.running) {
      await Promise.all([loadState(), loadWorkspace()]);
      showToast(status.failed
        ? `模拟完成：${status.succeeded} 成功，${status.failed} 失败`
        : `模拟完成：${status.succeeded} 名成员收益已更新`, status.failed > 0);
    } else if (state.season && state.catalog) {
      renderSimulationState();
    }
  } catch (error) {
    console.error("Simulation status refresh failed", error);
  } finally {
    simulationPollInFlight = false;
  }
}

let publicationPollInFlight = false;
async function loadPublicationStatus(announceCompletion = false) {
  if (publicationPollInFlight) return;
  publicationPollInFlight = true;
  const previous = state.publication;
  try {
    state.publication = await api("/api/publication/status");
    renderPublicationState();
    if (announceCompletion && previous.running && !state.publication.running) {
      showToast(state.publication.error ? `公开页发布失败：${state.publication.error}` : "公开页发布完成", Boolean(state.publication.error));
    }
  } catch (error) {
    console.error("Publication status refresh failed", error);
  } finally {
    publicationPollInFlight = false;
  }
}

function renderPublicationState() {
  const status = state.publication;
  elements.publishButton.disabled = !status.configured || status.running;
  elements.publishButton.textContent = status.running ? "发布中" : "发布公开页";
  elements.publishButton.title = status.configured
    ? (status.lastSucceededAt ? `上次发布：${formatDate(status.lastSucceededAt)}` : "发布最新只读快照")
    : "需要配置专用个人 GitHub 仓库";
}

async function loadWorkspace(force = false) {
  const [catalog, allocations, rules] = await Promise.all([
    api(force ? "/api/loot/catalog/refresh" : "/api/loot/catalog", force ? { method: "POST" } : {}),
    api("/api/allocations"),
    api("/api/loot/rules"),
  ]);
  state.catalog = catalog;
  state.allocations = allocations;
  state.rules = rules;
  const weightEntries = await Promise.all(
    state.players.filter((player) => player.latestWeightFetchedAt).map(async (player) => {
      try {
        return [player.id, await api(`/api/players/${player.id}/weights/latest`)]
      } catch {
        return [player.id, null];
      }
    }),
  );
  state.weightCaches = Object.fromEntries(weightEntries);
  if (state.season) render();
}

async function loadRealms() {
  try {
    state.realms = await api("/api/reference/realms");
  } catch (error) {
    showToast(`服务器列表读取失败：${error.message}`, true);
  }
}

function openPlayerDialog(player = null) {
  elements.playerForm.reset();
  elements.playerForm.elements.playerId.value = player?.id || "";
  elements.playerForm.elements.name.value = player?.name || "";
  elements.playerForm.elements.realm.value = player?.realmName || "";
  elements.playerForm.elements.raidRole.value = player?.raidRole || "melee";
  document.querySelector("#playerDialogTitle").textContent = player ? `编辑 ${player.name}` : "添加团员";
  document.querySelector("#playerSubmitButton").textContent = player ? "保存并刷新角色" : "添加并读取角色";
  closeRealmOptions();
  elements.playerDialog.showModal();
}

function renderRealmOptions(query = "") {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const matches = state.realms
    .filter((realm) => !normalized || realm.name.toLocaleLowerCase("zh-CN").includes(normalized) || realm.slug.toLowerCase().includes(normalized))
    .slice(0, 80);
  realmOptions.innerHTML = matches.length
    ? matches.map((realm, index) => `<button class="realm-option${index === 0 ? " is-active" : ""}" type="button" role="option" data-realm-name="${escapeHtml(realm.name)}"><strong>${escapeHtml(realm.name)}</strong><span>${escapeHtml(realm.slug)}</span></button>`).join("")
    : `<div class="realm-option-empty">没有匹配的服务器</div>`;
  realmOptions.hidden = false;
  realmInput.setAttribute("aria-expanded", "true");
}

function selectRealmOption(option) {
  realmInput.value = option.dataset.realmName || "";
  closeRealmOptions();
  realmInput.focus();
}

function closeRealmOptions() {
  realmOptions.hidden = true;
  realmInput.setAttribute("aria-expanded", "false");
}

function render() {
  const damagePlayers = state.players.filter(isDamagePlayer);
  const cachedPlayers = state.players.filter((player) => player.latestWeightFetchedAt);
  elements.playerCount.textContent = state.players.length;
  elements.damageCount.textContent = damagePlayers.length;
  elements.weightCount.textContent = `${cachedPlayers.length}/${state.players.length}`;
  elements.gameVersion.textContent = state.season.gameVersion;
  elements.seasonLabel.textContent = `赛季 ${state.season.seasonKey}`;
  elements.emptyState.hidden = state.players.length > 0;
  renderRoster();
  renderSimulationState();
  document.querySelector("#allocationSeason").textContent = state.season.seasonKey;
  document.querySelector("#allocationPlayerCount").textContent = state.players.length;
  document.querySelector("#allocationCount").textContent = state.allocations.length;
  document.querySelector("#allocationPickupTotal").textContent = formatPickupCount(
    state.allocations.reduce(
      (total, entry) => total + (entry.countsTowardTotal ? entry.pickupCount : 0),
      0,
    ),
  );
  document.querySelector("#historyVersion").textContent = state.season.gameVersion;
  document.querySelector("#rulesVersion").textContent = state.season.gameVersion;
  renderCatalog();
  renderHistory();
  renderRules();
  renderSystemHealth();
}

async function loadSystemHealth(force = false) {
  state.health = await api(`/api/system/health${force ? "?refresh=1" : ""}`);
  renderSystemHealth();
}

function renderSystemHealth() {
  const report = state.health;
  const status = report?.status || "unknown";
  const labels = {
    healthy: "数据状态正常",
    warning: "数据存在偏差风险",
    critical: "关键数据不可用",
    unknown: "正在检查数据状态",
  };
  setHealthClass(elements.healthNavDot, status);
  setHealthClass(elements.healthOverviewDot, status);
  setHealthClass(elements.healthOverview, status);
  elements.healthNavButton.title = labels[status];
  elements.healthOverviewTitle.textContent = labels[status];
  elements.healthCheckedAt.textContent = report ? `检查于 ${formatDate(report.checkedAt)}` : "-";

  if (!report) {
    elements.healthGrid.innerHTML = `<div class="health-empty">正在读取版本和依赖信息</div>`;
    elements.healthIssueCount.textContent = "0 项";
    elements.healthIssueList.innerHTML = `<div class="health-empty">尚无检查结果</div>`;
    return;
  }

  elements.healthGrid.innerHTML = report.components.map((component) => `
    <section class="health-component health-${component.status}">
      <div class="health-component-heading">
        <div><span class="health-dot health-${component.status}" aria-hidden="true"></span><h3>${escapeHtml(component.label)}</h3></div>
        <span class="health-status-label">${healthStatusLabel(component.status)}</span>
      </div>
      <p>${escapeHtml(component.summary)}</p>
      <dl>${component.details.map((detail) => `
        <div><dt>${escapeHtml(detail.label)}</dt><dd title="${escapeHtml(detail.value)}">${escapeHtml(formatHealthValue(detail.value))}</dd></div>
      `).join("")}</dl>
    </section>
  `).join("");

  elements.healthIssueCount.textContent = `${report.issues.length} 项`;
  elements.healthIssueList.innerHTML = report.issues.length
    ? report.issues.map((issue) => `
      <div class="health-issue health-${issue.status}">
        <span class="health-dot health-${issue.status}" aria-hidden="true"></span>
        <strong>${escapeHtml(issue.componentLabel)}</strong>
        <p>${escapeHtml(issue.message)}</p>
      </div>
    `).join("")
    : `<div class="health-empty">当前没有发现需要处理的数据问题</div>`;
}

function setHealthClass(element, status) {
  if (!element) return;
  element.classList.remove("health-healthy", "health-warning", "health-critical", "health-unknown");
  element.classList.add(`health-${status}`);
}

function healthStatusLabel(status) {
  return ({ healthy: "正常", warning: "注意", critical: "异常" })[status] || "检查中";
}

function formatHealthValue(value) {
  if (!value) return "-";
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDate(value);
  return value.length > 34 ? `${value.slice(0, 31)}...` : value;
}

function renderRoster() {
  elements.rosterBody.innerHTML = sortedRosterPlayers().map(renderPlayerRow).join("");
  document.querySelectorAll("[data-roster-sort]").forEach((button) => {
    const active = button.dataset.rosterSort === state.rosterSort.key;
    button.classList.toggle("is-active", active);
    button.dataset.direction = active ? state.rosterSort.direction : "";
    const header = button.closest("th");
    if (header) {
      header.setAttribute(
        "aria-sort",
        active && state.rosterSort.direction !== "default"
          ? (state.rosterSort.direction === "asc" ? "ascending" : "descending")
          : "none",
      );
    }
  });
}

function sortedRosterPlayers() {
  const players = state.players.map((player, index) => ({ player, index }));
  if (state.rosterSort.key === "role") return players.map((entry) => entry.player);
  const direction = state.rosterSort.direction === "asc" ? 1 : -1;
  return players
    .sort((left, right) => {
      const leftValue = rosterSortValue(left.player, state.rosterSort.key);
      const rightValue = rosterSortValue(right.player, state.rosterSort.key);
      const leftMissing = leftValue === null;
      const rightMissing = rightValue === null;
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      if (!leftMissing && leftValue !== rightValue) return (leftValue - rightValue) * direction;
      return left.index - right.index;
    })
    .map((entry) => entry.player);
}

function rosterSortValue(player, key) {
  const value = key === "pickup"
    ? player.seasonPickupCount
    : key === "tier"
      ? player.tierSet?.equipped
      : player.latestSimulationDps;
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number) ? null : number;
}

function renderSimulationState() {
  const simulation = state.simulation;
  elements.simulateStaleButton.disabled = simulation.running;
  elements.simulationActivity.hidden = !simulation.running;
  if (!simulation.running) return;
  const progress = `${simulation.completed}/${simulation.total}`;
  elements.simulationActivityText.textContent = simulation.currentPlayerName
    ? `正在模拟 ${simulation.currentPlayerName} (${progress})`
    : `正在准备模拟 (${progress})`;
}

function renderCatalog() {
  elements.catalogState.textContent = state.catalog.connected ? "已连接" : "未连接";
  elements.catalogState.classList.toggle("is-connected", state.catalog.connected);
  const raids = visibleRaids();
  if (!raids.length) {
    elements.raidList.className = "panel-empty";
    elements.raidList.textContent = "暂无副本数据";
    return;
  }
  if (!getSelectedRaid() || (!state.showLegacyRaids && !getSelectedRaid().isCurrent)) {
    state.selectedRaidId = raids[0].id;
    state.selectedBossId = null;
    state.selectedItemId = null;
  }
  const selectedRaid = getSelectedRaid();
  elements.raidList.className = "raid-list";
  elements.raidList.innerHTML = raids.map((raid) => `
    <div class="raid-group">
      <button class="raid-entry ${raid.id === state.selectedRaidId ? "is-selected" : ""}" type="button" data-raid-id="${escapeHtml(raid.id)}">
        <strong>${escapeHtml(raid.name)} <em class="content-badge content-${raid.isCurrent ? "current" : "legacy"}">${escapeHtml(raid.contentVersion || "12.1")}</em></strong>
        <span>${raid.bosses?.length || 0} 个 Boss</span>
      </button>
      ${raid.id === state.selectedRaidId ? `<div class="boss-list">${raid.bosses.map((boss) => `
        <button class="boss-entry ${boss.id === state.selectedBossId ? "is-selected" : ""}" type="button" data-boss-id="${boss.id}">
          <span>${boss.order}.</span><strong>${escapeHtml(boss.name)}</strong><em>${boss.items.length}</em>
        </button>`).join("")}</div>` : ""}
    </div>`).join("");
  if (!state.selectedBossId && selectedRaid?.bosses[0]) {
    state.selectedBossId = selectedRaid.bosses[0].id;
  }
  renderLoot();
}

function renderLoot() {
  const boss = getSelectedBoss();
  document.querySelector("#lootPanelTitle").textContent = boss ? boss.name : "掉落装备";
  const items = boss?.items || [];
  document.querySelector("#lootCount").textContent = `${items.length} 件`;
  if (!boss) {
    document.querySelector("#lootList").className = "panel-empty";
    document.querySelector("#lootList").textContent = "选择 Boss";
    renderCandidates();
    return;
  }
  document.querySelector("#lootList").className = "loot-list";
  document.querySelector("#lootList").innerHTML = items.map((item) => `
    <button class="loot-entry has-tooltip ${item.itemId === state.selectedItemId ? "is-selected" : ""}" type="button" ${itemHoverAttributes(item, itemTooltip(item))}>
      ${renderItemIcon(item, true)}
      <span class="loot-entry-copy"><strong>${escapeHtml(item.name)}</strong><span>${lootItemSummary(item)}</span></span>
      ${item.isSpecialEffect ? `<span class="effect-reference">特效参考</span>` : ""}
    </button>`).join("");
  renderCandidates();
  void enrichLootItems(items);
}

function renderCandidates() {
  const selected = getSelectedLoot();
  const list = document.querySelector("#candidateList");
  const effectReference = document.querySelector("#effectReference");
  effectReference.hidden = !selected?.isSpecialEffect;
  if (!selected) {
    list.className = "panel-empty";
    list.textContent = "选择一件装备";
    return;
  }
  const candidates = state.players.filter((player) => canPlayerUseItem(player, selected)).map((player) => {
    const benefit = candidateBenefit(player, selected);
    return { player, benefit, score: benefit?.score ?? null };
  }).sort((left, right) => {
    const roleOrder = { tank: 1, melee: 2, ranged: 3, healer: 4 };
    if (left.score !== null && right.score !== null && left.score !== right.score) {
      return right.score - left.score;
    }
    if (left.score !== null) return -1;
    if (right.score !== null) return 1;
    return roleOrder[left.player.raidRole] - roleOrder[right.player.raidRole] || left.player.name.localeCompare(right.player.name);
  });
  list.className = "candidate-list";
  list.innerHTML = candidates.map(({ player, benefit, score }) => `
    <div class="candidate-row">
      <div><strong class="candidate-player-name class-${classColorKeys[player.className] || "unknown"}">${escapeHtml(player.name)}</strong><span>${escapeHtml(player.className || "")}</span></div>
      <span class="role-badge role-${player.raidRole}">${roleLabels[player.raidRole]}</span>
      <span class="candidate-score${benefit ? " candidate-score-calculation has-tooltip" : ""}"${benefit ? ` data-tooltip-kind="calculation" data-tooltip="${escapeHtml(benefit.calculation)}"` : ""}>${score === null ? (selected.isSpecialEffect ? "特效" : state.selectedItemDetailsLoading ? "读取中" : "不计算") : score.toFixed(2)}</span>
      ${renderCandidatePickup(player)}
      <button class="table-action table-action-accent" type="button" data-allocate-player="${player.id}" data-player-name="${escapeHtml(player.name)}">分配</button>
    </div>`).join("");
}

function canPlayerUseItem(player, item) {
  if (!item.allowableClassMask) return true;
  const classId = classIds[player.className];
  if (!classId) return false;
  return (item.allowableClassMask & (1 << (classId - 1))) !== 0;
}

function lootItemSummary(item) {
  return [
    item.armorType,
    item.slotName,
    difficultyLabel(state.difficulty),
    `装等 ${formatItemLevel(item.itemLevels?.[state.difficulty] || item.itemLevel)}`,
  ].filter(Boolean).map(escapeHtml).join(" · ");
}

function candidateBenefit(player, item) {
  if (item.isSpecialEffect) return null;
  const cache = state.weightCaches[player.id];
  const localStats = item.statValuesByDifficulty?.[state.difficulty];
  const statValues = localStats && Object.keys(localStats).length ? localStats : item.statValues;
  if (!cache || !statValues || !Object.keys(statValues).length) return null;
  const effectiveMainStat = player.mainStat || inferMainStat(cache.weights);
  const terms = [];
  let score = 0;
  for (const [stat, rawValue] of Object.entries(statValues)) {
    const weightKey = resolveWeightKey(stat, effectiveMainStat);
    if (!weightKey) continue;
    if (["intellect", "agility", "strength"].includes(weightKey) && effectiveMainStat && weightKey !== effectiveMainStat) {
      continue;
    }
    const value = Number(rawValue);
    const weight = Number(cache.weights[weightKey] || 0);
    if (!Number.isFinite(value) || !Number.isFinite(weight)) continue;
    score += value * weight;
    terms.push(`${formatBenefitFactor(value)}${statLabels[weightKey] || stat} * ${formatBenefitFactor(weight)}`);
  }
  const formulaLines = terms.map((term, index) => index < terms.length - 1 ? `${term} +` : term);
  return {
    score,
    calculation: [...formulaLines, `= ${formatBenefitNumber(score)}`].join("\n"),
  };
}

function resolveWeightKey(stat, effectiveMainStat) {
  const direct = statValueToWeight[stat];
  if (direct) return direct;
  const normalized = String(stat || "").toLowerCase();
  const adaptiveKeys = [
    ["strength", /力量|strength/],
    ["agility", /敏捷|agility/],
    ["intellect", /智力|intellect/],
  ].filter(([, pattern]) => pattern.test(normalized)).map(([key]) => key);
  return adaptiveKeys.includes(effectiveMainStat) ? effectiveMainStat : null;
}

function renderCandidatePickup(player) {
  const ignoredTrinkets = state.allocations.filter((entry) =>
    entry.playerId === player.id && entry.equipmentType === "trinket" && !entry.countsTowardTotal,
  );
  const marker = ignoredTrinkets.length
    ? `<span class="pickup-exception has-tooltip" data-tooltip-kind="records" data-tooltip="${escapeHtml(ignoredTrinkets.map(allocationShortLabel).join("\n"))}" aria-label="查看不计数饰品">?</span>`
    : "";
  return `<span class="candidate-pickup"><span>${formatPickupCount(player.seasonPickupCount || 0)}</span>${marker}</span>`;
}

function formatBenefitFactor(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(2).replace(/\.?0+$/, "");
}

function formatBenefitNumber(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function inferMainStat(weights) {
  return ["strength", "agility", "intellect"]
    .map((key) => [key, Number(weights?.[key] || 0)])
    .sort((left, right) => right[1] - left[1])
    .find((entry) => entry[1] > 0)?.[0] || null;
}

const statValueToWeight = {
  智力: "intellect",
  敏捷: "agility",
  力量: "strength",
  全能: "versatility",
  急速: "haste",
  精通: "mastery",
  暴击: "criticalStrike",
  Intellect: "intellect",
  Agility: "agility",
  Strength: "strength",
  Versatility: "versatility",
  Haste: "haste",
  Mastery: "mastery",
  "Critical Strike": "criticalStrike",
};

async function enrichSelectedLoot() {
  const item = getSelectedLoot();
  const difficultyStats = item?.statValuesByDifficulty?.[state.difficulty];
  const localStats = difficultyStats && Object.keys(difficultyStats).length ? difficultyStats : item?.statValues;
  if (!item || item.isSpecialEffect || Object.keys(localStats || {}).length) {
    state.selectedItemDetailsLoading = false;
    renderCandidates();
    return;
  }
  try {
    const details = await getItemDetails(item.itemId, state.difficulty, catalogItemBonusList(item));
    applyItemDetails(item, details);
    state.selectedItemDetailsLoading = false;
    renderCandidates();
  } catch {
    state.selectedItemDetailsLoading = false;
    renderCandidates();
  }
}

async function enrichLootItems(items) {
  const pending = items.filter((item) => {
    const localStats = item.statValuesByDifficulty?.[state.difficulty];
    return item.itemLevelSource !== "difficulty-data" ||
      (!item.isSpecialEffect && !Object.keys(localStats || {}).length);
  }).filter((item) => !itemDetailsCache.has(`${item.itemId}:${state.difficulty}`));
  if (!pending.length) return;
  for (let index = 0; index < pending.length; index += 4) {
    await Promise.all(pending.slice(index, index + 4).map(async (item) => {
      try {
        applyItemDetails(item, await getItemDetails(item.itemId, state.difficulty, catalogItemBonusList(item)));
      } catch {
        // A missing Wowhead record should not prevent the rest of the boss loot from rendering.
      }
    }));
  }
  if (getSelectedBoss()?.items === items) {
    renderLootWithoutRefetch();
  }
}

function renderLootWithoutRefetch() {
  const boss = getSelectedBoss();
  const items = boss?.items || [];
  const list = document.querySelector("#lootList");
  if (!boss || !list) return;
  list.innerHTML = items.map((item) => `
    <button class="loot-entry has-tooltip ${item.itemId === state.selectedItemId ? "is-selected" : ""}" type="button" ${itemHoverAttributes(item, itemTooltip(item))}>
      ${renderItemIcon(item, true)}
      <span class="loot-entry-copy"><strong>${escapeHtml(item.name)}</strong><span>${lootItemSummary(item)}</span></span>
      ${item.isSpecialEffect ? `<span class="effect-reference">特效参考</span>` : ""}
    </button>`).join("");
  renderCandidates();
}

async function getItemDetails(itemId, difficulty, bonusList = []) {
  const normalizedBonus = bonusList.filter((bonus) => Number.isInteger(Number(bonus)) && Number(bonus) > 0);
  const key = normalizedBonus.length ? `${itemId}:bonus:${normalizedBonus.join(":")}` : `${itemId}:${difficulty}`;
  if (itemDetailsCache.has(key)) {
    const cached = itemDetailsCache.get(key);
    if (!cached) throw new Error("Item details unavailable");
    return cached;
  }
  try {
    const query = normalizedBonus.length
      ? `bonus=${encodeURIComponent(normalizedBonus.join(":"))}`
      : `difficulty=${encodeURIComponent(difficulty)}`;
    const details = await api(`/api/loot/details/${itemId}?${query}`);
    itemDetailsCache.set(key, details);
    return details;
  } catch (error) {
    itemDetailsCache.set(key, null);
    throw error;
  }
}

function applyItemDetails(item, details) {
  item.statValues = details.statValues || {};
  if (details.itemLevel) {
    item.itemLevels[state.difficulty] = details.itemLevel;
    item.itemLevelSource = "difficulty-data";
  }
  if (details.iconName && !item.iconUrl) {
    item.iconUrl = `/api/loot/icon/${encodeURIComponent(item.itemId)}`;
  }
}

function catalogItemBonusList(item, difficulty = state.difficulty) {
  const bonusListId = item.fullyUpgradedBonusLists?.[difficulty];
  return bonusListId ? [bonusListId] : [];
}

function getSelectedRaid() {
  return state.catalog?.raids.find((raid) => raid.id === state.selectedRaidId) || null;
}

function getSelectedBoss() {
  return getSelectedRaid()?.bosses.find((boss) => boss.id === state.selectedBossId) || null;
}

function getSelectedLoot() {
  return getSelectedBoss()?.items.find((item) => item.itemId === state.selectedItemId) || null;
}

function visibleRaids() {
  return (state.catalog?.raids || []).filter((raid) => state.showLegacyRaids || raid.isCurrent !== false);
}

function difficultyLabel(value) {
  return ({ lfr: "随机", normal: "普通", heroic: "英雄", mythic: "史诗" })[value] || "英雄";
}

function itemTooltip(item) {
  const level = item.itemLevels?.[state.difficulty] || item.itemLevel;
  return [
    `物品等级：${formatItemLevel(level)}`,
    `物品 ID ${item.itemId} · ${item.slotName}`,
    item.armorType || item.weaponType || "",
    `${difficultyLabel(state.difficulty)}难度`,
    item.isSpecialEffect ? "饰品：特效参考，不计拾取数" : "",
  ].filter(Boolean).join("\n");
}

function equipmentTooltip(item) {
  return [
    `物品 ID ${item.itemId} · ${item.slotName}`,
    `英雄榜装等 ${formatItemLevel(item.itemLevel)}`,
    item.inventoryType ? `装备类型 ${item.inventoryType}` : "",
    ...(item.enchantments || []).map((entry) => entry.displayString).filter(Boolean),
    ...(item.sockets || []).map((entry) => entry.displayString).filter(Boolean),
  ].filter(Boolean).join("\n");
}

function renderTooltipHtml({ target, details = null }) {
  if (target.dataset.tooltipKind === "calculation") {
    const lines = (target.dataset.tooltip || "").split("\n").filter(Boolean);
    return [
      `<div class="tooltip-calculation-title">收益计算</div>`,
      ...lines.map((line) => `<div class="tooltip-calculation-line${line.startsWith("=") ? " is-total" : ""}">${escapeHtml(line)}</div>`),
    ].join("");
  }
  if (target.dataset.tooltipKind === "records") {
    const lines = (target.dataset.tooltip || "").split("\n").filter(Boolean);
    return [
      `<div class="tooltip-calculation-title">不计数饰品</div>`,
      ...lines.map((line) => `<div class="tooltip-record-line">${escapeHtml(line)}</div>`),
    ].join("");
  }
  if (target.dataset.tooltipKind === "tier-set") {
    const lines = (target.dataset.tooltip || "").split("\n").filter(Boolean);
    return [
      `<div class="tooltip-calculation-title">${escapeHtml(target.dataset.tooltipName || "当季套装")}</div>`,
      ...lines.map((line) => `<div class="tooltip-record-line">${escapeHtml(line)}</div>`),
    ].join("");
  }
  const name = target.dataset.tooltipName || "物品";
  const quality = tooltipQuality(target.dataset.tooltipQuality);
  const baseLines = (target.dataset.tooltip || "").split("\n").filter(Boolean);
  const detailLines = details?.tooltipLines || [];
  const hasDetails = detailLines.length > 0;
  const lines = [];
  const descriptionLines = (target.dataset.tooltipDescription || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const seen = new Set();
  const addLine = (line) => {
    const value = String(line || "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    lines.push(value);
  };

  // Wowhead supplies the authoritative level and stat lines after the first hover.
  if (hasDetails) {
    for (const line of detailLines) {
      if (line === quality.label) continue;
      addLine(line);
    }
  }
  for (const line of baseLines) {
    if (hasDetails && (/^物品等级[：:]/.test(line) || /^升级[：:]/.test(line))) continue;
    addLine(line);
  }
  const descriptionsToRender = descriptionLines.filter((line) => !seen.has(line));

  return [
    `<div class="tooltip-name quality-${quality.cssClass}">${escapeHtml(name)}</div>`,
    `<div class="tooltip-line tooltip-quality">${escapeHtml(quality.label)}</div>`,
    ...lines.map((line) => `<div class="tooltip-line ${tooltipLineClass(line)}">${escapeHtml(line)}</div>`),
    ...descriptionsToRender.map((line) => `<div class="tooltip-line tooltip-description">${escapeHtml(line)}</div>`),
  ].join("");
}

function tooltipQuality(value) {
  const normalized = String(value || "").toLowerCase();
  const numeric = Number(value);
  const labels = {
    0: ["poor", "粗糙"],
    1: ["common", "普通"],
    2: ["uncommon", "优秀"],
    3: ["rare", "精良"],
    4: ["epic", "史诗"],
    5: ["legendary", "传说"],
    6: ["artifact", "神器"],
    7: ["heirloom", "传家宝"],
  };
  const fromNumber = labels[numeric];
  if (fromNumber) return { cssClass: fromNumber[0], label: fromNumber[1] };
  const fromName = Object.values(labels).find(([cssClass]) => cssClass === normalized);
  return fromName ? { cssClass: fromName[0], label: fromName[1] } : { cssClass: "epic", label: "史诗" };
}

function tooltipLineClass(line) {
  if (/^品质[：:]/.test(line) || /^(粗糙|普通|优秀|精良|史诗|传说|神器|传家宝)$/.test(line)) return "tooltip-quality";
  if (/^物品等级[：:]|^升级[：:]/.test(line)) return "tooltip-yellow";
  if (/^\+?[\d,]+\s*(暴击|急速|精通|全能|吸血|闪避|速度)/.test(line)) return "tooltip-green";
  if (/^(装备|使用|饰品)[：:]|^附魔|^插槽|^每次|^有一定几率|^你的|^\(\d+\)\s*组合/.test(line)) return "tooltip-green";
  if (/^[“\"]|[”\"]$/.test(line)) return "tooltip-description";
  return "tooltip-white";
}

function renderHistory() {
  if (!state.allocations.length) {
    elements.historyList.innerHTML = `<div class="view-empty">本赛季暂无拾取记录</div>`;
    return;
  }
  elements.historyList.innerHTML = state.allocations.map((entry) => `
    <div class="history-row">
      <span class="history-muted">${formatDate(entry.allocatedAt)}</span>
      <div><strong class="class-${classColorKeys[entry.playerClassName] || "unknown"}">${escapeHtml(entry.playerName)}</strong><span class="cell-subtext">${roleLabels[entry.playerRole]}</span></div>
      <div><strong>${escapeHtml(allocationBossLabel(entry))}</strong><span class="cell-subtext">${escapeHtml(entry.bossName)} · ${escapeHtml(entry.raidName)}</span></div>
      <div class="history-item has-tooltip" ${itemHoverAttributes(allocationItem(entry), allocationItemTooltip(entry), entry.difficulty)}><strong>${escapeHtml(entry.itemName)}</strong><span>${entry.itemLevel ? `${difficultyLabel(entry.difficulty)} · 物品等级 ${entry.itemLevel}` : entry.equipmentType}</span></div>
      <div class="history-controls">
        <label class="history-count"><input class="history-count-input" data-allocation-count="${escapeHtml(entry.id)}" type="number" min="0" max="99" step="0.5" value="${entry.pickupCount}" aria-label="${escapeHtml(entry.playerName)} ${escapeHtml(entry.itemName)}拾取数" />${entry.countsTowardTotal ? "" : `<span>不计入</span>`}</label>
        <button class="table-action table-action-danger" type="button" data-delete-allocation="${escapeHtml(entry.id)}" aria-label="删除 ${escapeHtml(entry.playerName)} 的 ${escapeHtml(entry.itemName)} 拾取记录">删除</button>
      </div>
    </div>`).join("");
}

function allocationItem(entry) {
  return findCatalogItem(entry.itemId) || {
    itemId: entry.itemId,
    name: entry.itemName,
    quality: 4,
    description: "",
  };
}

function allocationItemTooltip(entry) {
  return [
    entry.itemLevel ? `物品等级：${entry.itemLevel}` : "",
    entry.itemId ? `物品 ID ${entry.itemId}` : "",
    `${difficultyLabel(entry.difficulty)}难度`,
  ].filter(Boolean).join("\n");
}

function findCatalogItem(itemId) {
  if (!itemId) return null;
  for (const raid of state.catalog?.raids || []) {
    for (const boss of raid.bosses || []) {
      const item = boss.items?.find((entry) => entry.itemId === itemId);
      if (item) return item;
    }
  }
  return null;
}

function allocationBoss(entry) {
  for (const raid of state.catalog?.raids || []) {
    const boss = raid.bosses?.find((candidate) =>
      String(candidate.id) === String(entry.bossId) || candidate.name === entry.bossName,
    );
    if (boss) return boss;
  }
  return null;
}

function allocationBossLabel(entry) {
  const boss = allocationBoss(entry);
  const order = boss?.order;
  return order ? `${difficultyShortLabel(entry.difficulty)}${order}` : difficultyLabel(entry.difficulty);
}

function allocationShortLabel(entry) {
  return `${allocationBossLabel(entry)}-${entry.itemName}`;
}

function difficultyShortLabel(value) {
  return ({ lfr: "L", normal: "N", heroic: "H", mythic: "M" })[value] || "H";
}

function renderRules() {
  elements.rulesList.innerHTML = state.rules.map((rule) => `
    <div class="rule-row" data-rule-key="${escapeHtml(rule.ruleKey)}">
      <div class="rule-name"><strong>${escapeHtml(rule.displayName)}</strong><span>${escapeHtml(rule.ruleKey)}</span></div>
      <input class="rule-count-input" data-rule-count type="number" min="0" max="99" step="0.5" value="${rule.pickupCount}" aria-label="${escapeHtml(rule.displayName)}拾取数" />
      <label class="rule-toggle"><input data-rule-counts type="checkbox" ${rule.countsTowardTotal ? "checked" : ""} /><span>${rule.countsTowardTotal ? "计入" : "不计入"}</span></label>
      <button class="table-action" type="button" data-save-rule>保存</button>
    </div>`).join("");
}

function renderPlayerRow(player) {
  const damage = isDamagePlayer(player);
  const hasWeight = Boolean(player.latestWeightFetchedAt);
  const canSimulate = player.isActive;
  const simulationRunning = state.simulation.running;
  const isCurrentSimulation = simulationRunning && state.simulation.currentPlayerId === player.id;
  const weightTimestamp = player.latestWeightSourceCreatedAt || player.latestWeightFetchedAt;
  const staleTimestamp = hasWeight && isOlderThanDays(player.latestWeightFetchedAt, 2);
  const cacheLabel = hasWeight ? "已缓存" : "未计算";
  const cacheClass = hasWeight ? "cache-state-ready" : "cache-state-empty";
  const version = player.latestWeightGameVersion
    ? `<span class="version-badge">${escapeHtml(player.latestWeightGameVersion)}</span>`
    : `<span class="cell-subtext">-</span>`;
  const mainStat = player.mainStat ? statLabels[player.mainStat] : "-";
  const classSpec = [player.className, player.specialization].filter(Boolean).join(" / ") || "待读取";
  const classColor = classColorKeys[player.className] || "unknown";
  const tierSet = renderTierSet(player.tierSet);

  return `
    <tr>
      <td data-label="职责"><span class="role-badge role-${player.raidRole}">${roleLabels[player.raidRole]}</span></td>
      <td data-label="角色">
        <span class="player-name class-${classColor}">${escapeHtml(player.name)}</span>
        <span class="player-realm">${escapeHtml(player.realmName)}</span>
      </td>
      <td data-label="职业 / 专精">${escapeHtml(classSpec)}</td>
      <td data-label="主属性">${mainStat}</td>
      <td class="tier-set-column" data-label="当季套装">${tierSet}</td>
      <td data-label="本季拾取">
        <span class="pickup-total">${formatPickupCount(player.seasonPickupCount || 0)}</span>
        <span class="cell-subtext">${player.seasonItemCount || 0} 件装备</span>
      </td>
      <td data-label="收益缓存">
        <span class="cache-state ${cacheClass}">${cacheLabel}</span>
        ${hasWeight ? `<span class="cell-subtext cache-timestamp${staleTimestamp ? " cache-timestamp-stale" : ""}">${formatDate(weightTimestamp)}</span>` : ""}
      </td>
      <td data-label="模拟版本">${version}</td>
      <td data-label="单体模拟输出"><strong class="simulation-dps">${formatDps(player.latestSimulationDps)}</strong></td>
      <td data-label="操作">
        <div class="row-actions">
          <button class="table-action" data-action="edit-player" data-player-id="${player.id}">编辑</button>
          <button class="table-action" data-action="refresh-character" data-player-id="${player.id}">刷新角色</button>
          ${player.latestCharacterFetchedAt ? `<button class="table-action" data-action="view-equipment" data-player-id="${player.id}">查看装备</button>` : ""}
          <button class="table-action table-action-danger" data-action="delete-player" data-player-id="${player.id}">删除</button>
          ${(damage || canSimulate || hasWeight) ? `
            <details class="weight-actions-menu">
              <summary class="table-action weight-actions-trigger" aria-label="收益操作" title="收益操作">▾</summary>
              <div class="weight-actions-popover" role="menu">
                ${hasWeight ? `<button type="button" data-action="view-weight" data-player-id="${player.id}" role="menuitem">查看收益</button>` : ""}
                ${damage ? `<button type="button" data-action="import-weight" data-player-id="${player.id}" role="menuitem">导入收益</button>` : ""}
                ${canSimulate ? `<button type="button" data-action="simulate-player" data-player-id="${player.id}" role="menuitem" ${simulationRunning ? "disabled" : ""}>${isCurrentSimulation ? "模拟中" : "计算收益"}</button>` : ""}
              </div>
            </details>` : ""}
        </div>
      </td>
    </tr>`;
}

function renderTierSet(tierSet) {
  if (!tierSet) return `<span class="tier-set-count tier-set-unknown" title="尚无可确认的装备快照">-/5</span>`;
  const count = Number(tierSet.equipped || 0);
  const tone = count >= 4 ? "high" : count >= 2 ? "mid" : "low";
  const slotLabels = [["head", "头"], ["shoulder", "肩"], ["chest", "胸"], ["hands", "手"], ["legs", "腿"]];
  const slots = slotLabels.map(([key, label]) => `${label} ${tierSet.slots?.[key] ? "✓" : "×"}`).join(" · ");
  const effects = (tierSet.effects || []).filter((effect) => [2, 4].includes(Number(effect.requiredCount)))
    .map((effect) => `${effect.requiredCount}件 ${effect.isActive ? "已激活" : "未激活"}：${effect.displayString}`);
  const tooltip = [slots, ...effects, `英雄榜更新：${formatDate(tierSet.fetchedAt)}`].join("\n");
  return `<span class="tier-set-count tier-set-${tone} has-tooltip" data-tooltip-kind="tier-set" data-tooltip-name="${escapeHtml(tierSet.name || `${state.season.seasonKey} 当季套装`)}" data-tooltip="${escapeHtml(tooltip)}">${count}/5</span>`;
}

const slotOrder = [
  "HEAD", "NECK", "SHOULDER", "BACK", "CHEST", "SHIRT", "TABARD", "WRIST",
  "HANDS", "WAIST", "LEGS", "FEET", "FINGER_1", "FINGER_2", "TRINKET_1",
  "TRINKET_2", "MAIN_HAND", "OFF_HAND",
];

async function showEquipment(playerId) {
  const cache = await api(`/api/players/${playerId}/character/latest`);
  document.querySelector("#equipmentTitle").textContent = `${cache.player.name} 的装备`;
  document.querySelector("#equipmentSummary").innerHTML = `
    <div><span>角色等级</span><strong>${cache.level || "-"}</strong></div>
    <div><span>已装备装等</span><strong>${formatItemLevel(cache.equippedItemLevel)}</strong></div>
    <div><span>英雄榜装等</span><strong>${formatItemLevel(cache.averageItemLevel)}</strong></div>
    <div><span>${cache.source.provider === "blizzard-cn-armory" ? "官方英雄榜" : "DPSWOW 兜底"}</span><strong>${formatDate(cache.source.fetchedAt)}</strong></div>`;
  document.querySelector("#characterStats").innerHTML = renderCharacterStats(cache);
  const items = [...cache.items].sort(
    (left, right) => slotRank(left.slotType) - slotRank(right.slotType),
  );
  document.querySelector("#equipmentList").innerHTML = items.map(renderEquipmentItem).join("");
  elements.equipmentDialog.showModal();
}

function renderCharacterStats(cache) {
  const stats = cache.characterStats;
  if (!stats) {
    return `<div class="character-stats-heading"><div><span>角色属性</span><strong>暂不可用</strong></div><small>轻量 SimC 属性计算未完成</small></div>`;
  }
  const mainStat = stats.mainStat || state.players.find((entry) => entry.id === cache.player.id)?.mainStat;
  const mainValue = mainStat ? stats.attributes[mainStat] : 0;
  const secondary = [
    ["criticalStrike", "暴击"],
    ["haste", "急速"],
    ["mastery", "精通"],
    ["versatility", "全能"],
  ];
  return `
    <div class="character-stats-heading">
      <div><span>角色自身属性</span><strong>装备、天赋、专精与种族被动</strong></div>
      <small>无团队增益与消耗品 · SimC ${escapeHtml(stats.simcVersion)}</small>
    </div>
    <div class="character-stat-grid">
      <div class="character-stat character-stat-main"><span>${statLabels[mainStat] || "主属性"}</span><strong>${formatNumber(mainValue)}</strong><small>属性点数</small></div>
      ${secondary.map(([key, label]) => {
        const value = stats.secondary[key] || { rating: 0, percent: 0 };
        return `<div class="character-stat"><span>${label}</span><strong>${formatNumber(value.rating)}</strong><small>${formatPercent(value.percent)}</small></div>`;
      }).join("")}
    </div>`;
}

function slotRank(slotType) {
  const index = slotOrder.indexOf(slotType);
  return index === -1 ? slotOrder.length : index;
}

function renderEquipmentItem(item) {
  const details = [];
  if (item.enchantments.length) details.push(`${item.enchantments.length} 个附魔`);
  if (item.sockets.length) details.push(`${item.sockets.length} 颗宝石`);
  return `
    <div class="equipment-item quality-${escapeHtml(item.quality.toLowerCase())} has-tooltip" ${itemHoverAttributes(item, equipmentTooltip(item))}>
      ${renderItemIcon(item)}
      <div class="equipment-item-copy">
        <span class="equipment-slot">${escapeHtml(item.slotName)}</span>
        <strong>${escapeHtml(item.name)}</strong>
        <span class="equipment-detail">物品等级 ${formatItemLevel(item.itemLevel)}${details.length ? ` · ${details.join(" · ")}` : ""}</span>
      </div>
    </div>`;
}

function itemHoverAttributes(item, tooltip = "", difficulty = "") {
  const itemDifficulty = difficulty || state.difficulty;
  const bonusList = item.bonusList?.length ? item.bonusList : catalogItemBonusList(item, itemDifficulty);
  return [
    `data-item-id="${escapeHtml(item.itemId)}"`,
    `data-item-bonuses="${escapeHtml(bonusList.join(":"))}"`,
    `data-tooltip-name="${escapeHtml(item.name)}"`,
    `data-tooltip-quality="${escapeHtml(item.quality)}"`,
    `data-tooltip-description="${escapeHtml(item.description || "")}"`,
    `data-tooltip="${escapeHtml(tooltip)}"`,
    difficulty ? `data-item-difficulty="${escapeHtml(difficulty)}"` : "",
  ].filter(Boolean).join(" ");
}

function renderItemIcon(item, small = false) {
  const iconUrl = item.iconUrl || `/api/loot/icon/${encodeURIComponent(item.itemId)}`;
  const className = `missing-item-icon${small ? " small" : ""}`;
  return `<span class="item-icon-shell${small ? " small" : ""}">
    <img class="item-icon" src="${escapeHtml(iconUrl)}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false" />
    <span class="${className}" aria-label="本地图标尚未收录" hidden><span>?</span></span>
  </span>`;
}

async function loadHoverDetails(target) {
  const itemId = Number(target.dataset.itemId);
  if (!itemId) return;
  const bonusList = (target.dataset.itemBonuses || "")
    .split(":")
    .filter(Boolean)
    .map(Number);
  let details;
  try {
    details = await getItemDetails(itemId, target.dataset.itemDifficulty || state.difficulty, bonusList);
  } catch {
    return;
  }
  if (!details || !target.matches(":hover")) return;
  hoverTooltip.innerHTML = renderTooltipHtml({ target, details });
  positionHoverTooltip(lastPointerPosition.x, lastPointerPosition.y);
}

async function showWeight(playerId) {
  const cache = await api(`/api/players/${playerId}/weights/latest`);
  document.querySelector("#weightViewTitle").textContent = `${cache.player.name} 的属性收益`;
  document.querySelector("#weightMeta").innerHTML = `
    <div><span>模拟版本</span><strong>${escapeHtml(cache.gameVersion)}</strong></div>
    <div><span>模拟时间</span><strong>${formatDate(cache.source.simulatedAt)}</strong></div>
    <div><span>基础 DPS</span><strong>${formatNumber(cache.baselineDps)}</strong></div>`;
  document.querySelector("#weightGrid").innerHTML = Object.entries(cache.weights)
    .map(([key, value]) => `
      <div class="weight-card ${key === cache.player.mainStat ? "weight-card-main" : ""}">
        <span>${statLabels[key]}</span>
        <strong>${Number(value).toFixed(2)}</strong>
      </div>`)
    .join("");
  document.querySelector("#weightJsonLink").href = `/api/players/${playerId}/weights/latest.json`;
  const rawSimulationLink = document.querySelector("#rawSimulationLink");
  const player = state.players.find((entry) => entry.id === playerId);
  rawSimulationLink.hidden = !player?.hasLocalSimulation;
  rawSimulationLink.href = `/simulation-result.html?player=${encodeURIComponent(playerId)}`;
  elements.weightViewDialog.showModal();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new ApiError(
      payload.error?.message || `请求失败 (${response.status})`,
      payload.error?.code,
      response.status,
    );
  }
  return payload.data;
}

async function refreshCharacter(player) {
  try {
    return await api(`/api/players/${player.id}/character/refresh`, { method: "POST" });
  } catch (error) {
    if (error.code !== "ARMORY_LOGIN_REQUIRED") throw error;
    showToast("请在打开的官方页面完成战网登录，登录后将自动继续");
    await api(`/api/players/${player.id}/character/login`, { method: "POST" });
    return api(`/api/players/${player.id}/character/refresh`, { method: "POST" });
  }
}

class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function isDamagePlayer(player) {
  return player.raidRole === "melee" || player.raidRole === "ranged";
}

function formatDate(value) {
  if (!value) return "-";
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function parseDate(value) {
  const normalized = String(value).includes("T") ? value : String(value).replace(" ", "T") + "+08:00";
  return new Date(normalized);
}

function isOlderThanDays(value, days) {
  if (!value) return true;
  const timestamp = parseDate(value).getTime();
  return !Number.isFinite(timestamp) || Date.now() - timestamp > days * 24 * 60 * 60_000;
}

function formatNumber(value) {
  return typeof value === "number" ? new Intl.NumberFormat("zh-CN").format(Math.round(value)) : "-";
}

function formatItemLevel(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? String(Math.round(number)) : "-";
}

function formatDps(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Math.round(number))
    : "-";
}

function formatPickupCount(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : "-";
}

function switchView(view) {
  const allowedViews = ["allocation", "roster", "history", "rules", "health"];
  state.currentView = allowedViews.includes(view) ? view : "allocation";
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== state.currentView;
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.currentView);
  });
  window.history.replaceState(null, "", `#${state.currentView}`);
}

function setBusy(button, busy) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = "处理中";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

let toastTimer;
function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("toast-error", isError);
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 5000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const initialView = window.location.hash.slice(1);
switchView(initialView || "allocation");
await Promise.all([loadState(), loadWorkspace(), loadRealms(), loadPublicationStatus(), loadSystemHealth()]);
await loadSimulationStatus();
window.setInterval(() => void loadSimulationStatus(true), 2000);
window.setInterval(() => void loadPublicationStatus(true), 3000);
