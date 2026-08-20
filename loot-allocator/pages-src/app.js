const app = document.querySelector("#app");
const state = {
  snapshot: null,
  playerDetails: new Map(),
  teamQuery: "",
  teamSort: "role",
  loot: { raidId: "", bossId: "", difficulty: "heroic", query: "" },
  dungeons: { dungeonId: "", bossId: "all", category: "all", stats: [], query: "" },
  loadout: {
    playerId: "", source: "all", difficulty: "heroic", dungeonDifficulty: "heroic", slot: "head",
    stats: [], query: "", selections: {},
  },
  history: { playerId: "", query: "" },
};

const roleLabels = { tank: "坦克", melee: "近战", ranged: "远程", healer: "治疗" };
const roleOrder = { tank: 1, melee: 2, ranged: 3, healer: 4 };
const statLabels = {
  intellect: "智力", agility: "敏捷", strength: "力量", versatility: "全能",
  haste: "急速", mastery: "精通", criticalStrike: "暴击",
};
const difficultyLabels = { lfr: "随机", normal: "普通", heroic: "英雄", mythic: "史诗" };
const categoryLabels = {
  all: "全部装备", cloth: "布甲", leather: "皮甲", mail: "锁甲", plate: "板甲",
  weapon: "武器", trinket: "饰品",
};
const secondaryStatLabels = { mastery: "精通", haste: "急速", criticalStrike: "暴击", versatility: "全能" };
const slotLabels = {
  head: "头部", neck: "颈部", shoulders: "肩部", shoulder: "肩部", back: "背部",
  chest: "胸部", wrists: "腕部", wrist: "腕部", hands: "手部", waist: "腰部",
  legs: "腿部", feet: "脚部", finger1: "戒指 1", finger2: "戒指 2",
  trinket1: "饰品 1", trinket2: "饰品 2", main_hand: "主手", off_hand: "副手",
};
const classMap = {
  战士: "warrior", Warrior: "warrior", 圣骑士: "paladin", Paladin: "paladin",
  猎人: "hunter", Hunter: "hunter", 潜行者: "rogue", Rogue: "rogue",
  牧师: "priest", Priest: "priest", 死亡骑士: "death-knight", "Death Knight": "death-knight",
  萨满祭司: "shaman", Shaman: "shaman", 法师: "mage", Mage: "mage",
  术士: "warlock", Warlock: "warlock", 武僧: "monk", Monk: "monk",
  德鲁伊: "druid", Druid: "druid", 恶魔猎手: "demon-hunter", "Demon Hunter": "demon-hunter",
  唤魔师: "evoker", Evoker: "evoker",
};

initialize().catch((error) => renderError(error));
window.addEventListener("hashchange", renderRoute);
document.addEventListener("error", (event) => {
  const image = event.target.closest?.("img[data-icon]");
  if (!image) return;
  const placeholder = document.createElement("span");
  placeholder.className = `${image.className} missing-icon`;
  placeholder.textContent = "?";
  image.replaceWith(placeholder);
}, true);

async function initialize() {
  const response = await fetch("./data/snapshot.json", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`公开数据读取失败 (${response.status})`);
  state.snapshot = await response.json();
  if (state.snapshot.schemaVersion !== 1) throw new Error("公开数据版本不受支持");
  hydratePublicationChrome();
  if (!location.hash) history.replaceState(null, "", "#/team");
  renderRoute();
}

function hydratePublicationChrome() {
  const snapshot = state.snapshot;
  document.title = `团队数据 · ${snapshot.season.key}`;
  document.querySelector("#seasonLabel").textContent = `赛季 ${snapshot.season.key}`;
  document.querySelector("#publishedAt").textContent = formatDate(snapshot.publishedAt, "short");
  document.querySelector("#footerSeason").textContent = `赛季 ${snapshot.season.key} · ${snapshot.season.gameVersion}`;
  document.querySelector("#footerRevision").textContent = `版本 ${snapshot.revision}`;
  const age = Date.now() - new Date(snapshot.publishedAt).getTime();
  document.querySelector("#staleBanner").hidden = !Number.isFinite(age) || age < 24 * 60 * 60 * 1000;
}

function renderRoute() {
  if (!state.snapshot) return;
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const route = parts[0] || "team";
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const activeRoute = route === "player" ? "team" : route;
    link.classList.toggle("is-active", link.dataset.nav === activeRoute);
    link.toggleAttribute("aria-current", link.dataset.nav === activeRoute);
  });
  window.scrollTo({ top: 0, behavior: "instant" });

  if (route === "player" && parts[1]) {
    void renderPlayer(parts[1]);
    return;
  }
  if (route === "loot") {
    renderLoot();
    return;
  }
  if (route === "dungeons") {
    renderDungeons();
    return;
  }
  if (route === "loadout") {
    void renderLoadout();
    return;
  }
  if (route === "history") {
    renderHistory();
    return;
  }
  renderTeam();
}

function renderTeam() {
  const players = filteredPlayers();
  const damagePlayers = state.snapshot.players.filter((player) => ["melee", "ranged"].includes(player.raidRole));
  const simulated = damagePlayers.filter((player) => player.hasSimulation).length;
  const pickupTotal = state.snapshot.allocations
    .filter((entry) => entry.countsTowardTotal)
    .reduce((total, entry) => total + entry.pickupCount, 0);

  app.innerHTML = `
    <section>
      <div class="view-heading">
        <div><p class="eyebrow">Team snapshot</p><h1>团队成员摘要</h1><p>当前赛季的模拟收益、角色装备与拾取概况。</p></div>
        <span class="heading-meta">${escapeHtml(formatDate(state.snapshot.publishedAt))}</span>
      </div>
      <section class="summary-strip" aria-label="团队摘要">
        ${summaryFact("当前成员", state.snapshot.players.length, "人")}
        ${summaryFact("输出成员", damagePlayers.length, "人")}
        ${summaryFact("模拟覆盖", `${simulated}/${damagePlayers.length}`, damagePlayers.length ? `${Math.round(simulated / damagePlayers.length * 100)}%` : "-")}
        ${summaryFact("计入拾取", pickupTotal, "点")}
      </section>
      <div class="toolbar">
        <label class="search-field"><input id="teamSearch" type="search" placeholder="搜索角色、职业或专精" value="${escapeAttr(state.teamQuery)}" /></label>
        <select id="teamSort" aria-label="成员排序">
          ${option("role", "按职责排序", state.teamSort)}
          ${option("tier", "按当季套装", state.teamSort)}
          ${option("dps", "按模拟 DPS", state.teamSort)}
          ${option("pickup", "按拾取点数", state.teamSort)}
          ${option("updated", "按模拟时间", state.teamSort)}
        </select>
      </div>
      <section class="data-shell" aria-label="团队成员">
        <div class="team-head"><span>角色</span><span>职责 / 专精</span><span>拾取</span><span>当季套装</span><span>模拟输出</span><span>数据状态</span><span></span></div>
        <div id="teamRows">${renderTeamRows(players)}</div>
      </section>
    </section>`;

  document.querySelector("#teamSearch").addEventListener("input", (event) => {
    state.teamQuery = event.target.value;
    document.querySelector("#teamRows").innerHTML = renderTeamRows(filteredPlayers());
  });
  document.querySelector("#teamSort").addEventListener("change", (event) => {
    state.teamSort = event.target.value;
    document.querySelector("#teamRows").innerHTML = renderTeamRows(filteredPlayers());
  });
}

function filteredPlayers() {
  const query = normalize(state.teamQuery);
  const players = state.snapshot.players.filter((player) => !query || normalize([
    player.name, player.realmName, player.className, player.specialization, roleLabels[player.raidRole],
  ].join(" ")).includes(query));
  return players.sort((left, right) => {
    if (state.teamSort === "dps") return (right.latestSimulationDps || -1) - (left.latestSimulationDps || -1);
    if (state.teamSort === "tier") return (right.tierSet?.equipped ?? -1) - (left.tierSet?.equipped ?? -1);
    if (state.teamSort === "pickup") return right.seasonPickupCount - left.seasonPickupCount;
    if (state.teamSort === "updated") return timestamp(right.latestSimulationAt) - timestamp(left.latestSimulationAt);
    return (roleOrder[left.raidRole] - roleOrder[right.raidRole]) || left.name.localeCompare(right.name, "zh-CN");
  });
}

function renderTeamRows(players) {
  if (!players.length) return `<div class="empty-state">没有符合条件的成员</div>`;
  return players.map((player) => {
    const freshness = dataFreshness(player.latestSimulationAt);
    return `<a class="team-row" href="#/player/${encodeURIComponent(player.id)}">
      <div class="player-cell">
        <span class="player-copy"><strong class="${className(player.className)}">${escapeHtml(player.name)}</strong><small>${escapeHtml(player.realmName)}</small></span>
      </div>
      <span class="role-cell">${escapeHtml(roleLabels[player.raidRole])}<small>${escapeHtml([player.className, player.specialization].filter(Boolean).join(" · ") || "资料未更新")}</small></span>
      <span class="metric-cell pickup-count pickup-cell"><strong>${formatNumber(player.seasonPickupCount)}</strong><small>${player.seasonItemCount} 件装备</small></span>
      <span class="metric-cell tier-cell ${tierSetTone(player.tierSet)}"><strong>${formatTierSet(player.tierSet)}</strong><small>当季套装</small></span>
      <span class="metric-cell dps-cell"><strong>${formatNumber(player.latestSimulationDps)}</strong><small>DPS</small></span>
      <span class="metric-cell status-cell"><strong><i class="status-dot ${freshness.className}"></i>${freshness.label}</strong><small>${formatRelative(player.latestSimulationAt)}</small></span>
      <span class="row-arrow" aria-hidden="true">›</span>
    </a>`;
  }).join("");
}

async function renderPlayer(playerId) {
  const summary = state.snapshot.players.find((player) => player.id === playerId);
  if (!summary) {
    renderError(new Error("找不到这名团队成员"));
    return;
  }
  app.innerHTML = `<section class="loading-view"><span class="loading-line"></span><span class="loading-line short"></span></section>`;
  try {
    let detail = state.playerDetails.get(playerId);
    if (!detail) {
      const response = await fetch(`./data/players/${encodeURIComponent(playerId)}.json`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`成员数据读取失败 (${response.status})`);
      detail = await response.json();
      state.playerDetails.set(playerId, detail);
    }
    renderPlayerDetail(detail);
  } catch (error) {
    renderError(error);
  }
}

function renderPlayerDetail(detail) {
  const { player, weights, equipment, simulation } = detail;
  const source = simulation?.source || weights?.source || {};
  const summary = simulation?.summary || {};
  const equipmentById = new Map((equipment?.items || []).map((item) => [item.itemId, item]));
  const maxWeight = Math.max(1, ...Object.values(weights?.weights || simulation?.weights || {}).map(Number));
  const maxDamage = Math.max(1, ...(simulation?.damage || []).map((entry) => entry.dps));
  app.innerHTML = `
    <section>
      <a class="back-link" href="#/team">← 返回成员摘要</a>
      <header class="player-hero">
        <div class="player-identity"><h1 class="${className(player.className)}">${escapeHtml(player.name)}</h1><p>${escapeHtml(player.realmName)} · ${escapeHtml([player.className, player.specialization].filter(Boolean).join(" / ") || roleLabels[player.raidRole])}</p></div>
        <div class="hero-dps"><span>单体模拟输出</span><strong>${formatNumber(player.latestSimulationDps)}</strong><small>DPS ${summary.dpsError ? `± ${formatNumber(summary.dpsError)}` : ""}</small></div>
      </header>
      <section class="detail-facts" aria-label="模拟条件">
        ${detailFact("战斗类型", fightStyleLabel(summary.fightStyle))}
        ${detailFact("目标 / 时长", summary.targets ? `${summary.targets} 个 · ${Math.round(summary.fightLength || 0)} 秒` : "-")}
        ${detailFact("迭代次数", formatNumber(summary.iterations))}
        ${detailFact("模拟版本", simulation?.source.gameVersion || weights?.gameVersion || "-")}
        ${detailFact("模拟时间", formatDate(source.simulatedAt || source.fetchedAt, "short"))}
        ${detailFact("当季套装", formatTierSet(player.tierSet))}
      </section>
      ${renderWeights(weights?.weights || simulation?.weights, maxWeight)}
      ${renderDamage(simulation?.damage, maxDamage)}
      ${renderFrequency(simulation?.castFrequency)}
      ${renderSequence(simulation?.actionSequence)}
      ${renderEquipment(equipment, simulation?.equipment, equipmentById)}
    </section>`;
}

function renderWeights(weights, maxWeight) {
  if (!weights) return reportEmptySection("属性收益", "暂无属性收益数据");
  const entries = Object.entries(weights).filter(([, value]) => Number(value) > 0);
  return `<section class="report-section">
    ${sectionHeading("Stat weights", "属性收益", "每增加 1 点属性对应的 DPS 收益")}
    <div class="weight-grid">${entries.map(([key, value]) => `<div class="weight-stat"><span>${escapeHtml(statLabels[key] || key)}</span><strong>${Number(value).toFixed(2)}</strong><i style="--value:${Math.max(2, Number(value) / maxWeight * 100)}%"></i></div>`).join("")}</div>
  </section>`;
}

function renderDamage(damage, maxDamage) {
  if (!damage?.length) return reportEmptySection("伤害构成", "暂无本地模拟伤害明细");
  return `<section class="report-section">
    ${sectionHeading("Damage breakdown", "伤害构成", `${damage.length} 个伤害来源`)}
    <div class="damage-table">
      <div class="damage-head"><span>技能</span><span>占比</span><span>DPS</span><span>平均次数</span></div>
      ${damage.map((entry) => `<div class="damage-row">
        <div class="spell-cell" style="--value:${entry.dps / maxDamage * 100}%">${renderIcon(entry.iconUrl, "spell-icon")}<strong>${escapeHtml(entry.name)}</strong></div>
        <span>${Number(entry.percent).toFixed(1)}%</span><span>${formatNumber(entry.dps)}</span><span>${formatDecimal(entry.executes)}</span>
      </div>`).join("")}
    </div>
  </section>`;
}

function renderFrequency(frequency) {
  if (!frequency?.length) return "";
  return `<section class="report-section">
    ${sectionHeading("Cast frequency", "技能施放频率", "整场模拟平均值")}
    <div class="frequency-grid">${frequency.map((entry) => `<div class="frequency-row">
      <div class="spell-cell">${renderIcon(entry.iconUrl, "spell-icon")}<strong>${escapeHtml(entry.name)}</strong></div>
      <span>${formatDecimal(entry.executes)} 次</span><span>${entry.castsPerMinute ? `${entry.castsPerMinute.toFixed(1)} / 分钟` : "-"}</span>
    </div>`).join("")}</div>
  </section>`;
}

function renderSequence(sequence) {
  if (!sequence?.combat?.length) return "";
  return `<section class="report-section">
    ${sectionHeading("Sample sequence", "样本施法顺序", `${sequence.combat.length} 次动作`)}
    <details class="sequence-details"><summary>展开本次 SimC 样本战斗时间轴</summary>
      <div class="sequence-list">${sequence.combat.map((entry) => `<div class="sequence-action"><time>${formatClock(entry.time)}</time>${renderIcon(entry.iconUrl, "spell-icon")}<strong>${escapeHtml(entry.name)}</strong></div>`).join("")}</div>
    </details>
  </section>`;
}

function renderEquipment(equipment, simulatedEquipment, equipmentById) {
  const currentItems = equipment?.items || [];
  const simulationItems = simulatedEquipment || [];
  return `<section class="report-section">
    ${sectionHeading("Equipment", "当前穿戴", equipment ? `装等 ${Math.round(equipment.equippedItemLevel || equipment.averageItemLevel || 0)} · ${formatDate(equipment.source.fetchedAt, "short")}` : "暂无角色快照")}
    ${currentItems.length ? `<div class="equipment-grid">${currentItems.map((item) => equipmentItem(item, item.iconUrl)).join("")}</div>` : `<div class="empty-state">暂无当前装备数据</div>`}
    ${simulationItems.length ? `<div class="section-heading" style="margin-top:30px"><div><p class="eyebrow">Simulated gear</p><h2>模拟使用装备</h2></div><span>${simulationItems.length} 件</span></div>
      <div class="equipment-grid">${simulationItems.map((item) => equipmentItem({ ...item, slotName: slotLabels[item.slot] || item.slot }, equipmentById.get(item.id)?.iconUrl)).join("")}</div>` : ""}
  </section>`;
}

function equipmentItem(item, iconUrl) {
  const extras = item.stats?.map((stat) => `${statLabels[stat.name] || stat.name} +${formatNumber(stat.value)}`).join(" · ")
    || [item.enchantments?.map((entry) => entry.displayString).filter(Boolean).join(" · "), item.sockets?.map((entry) => entry.itemName || entry.displayString).filter(Boolean).join(" · ")].filter(Boolean).join(" · ");
  return `<div class="equipment-item">
    ${renderIcon(iconUrl, "item-icon")}
    <span class="equipment-copy"><span>${escapeHtml(item.slotName || item.slotType || item.slot || "装备")}</span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(extras || "装备属性以角色快照为准")}</small></span>
    <b class="item-level">${item.itemLevel ? Math.round(item.itemLevel) : "-"}</b>
  </div>`;
}

function renderLoot() {
  const catalog = state.snapshot.catalog;
  const raids = catalog.raids || [];
  if (!state.loot.raidId || !raids.some((raid) => String(raid.id) === state.loot.raidId)) {
    state.loot.raidId = String(raids.find((raid) => raid.isCurrent)?.id || raids[0]?.id || "");
  }
  const raid = raids.find((entry) => String(entry.id) === state.loot.raidId);
  if (!state.loot.bossId || !raid?.bosses.some((boss) => String(boss.id) === state.loot.bossId)) {
    state.loot.bossId = String(raid?.bosses[0]?.id || "");
  }
  const boss = raid?.bosses.find((entry) => String(entry.id) === state.loot.bossId);
  const query = normalize(state.loot.query);
  const items = (boss?.items || []).filter((item) => !query || normalize([item.name, item.slotName, item.armorType, item.weaponType, item.description].join(" ")).includes(query));
  app.innerHTML = `
    <section>
      <div class="view-heading"><div><p class="eyebrow">Raid catalog</p><h1>Boss 掉落装备</h1><p>按副本、首领与难度查看本赛季装备目录。</p></div><span class="heading-meta">${escapeHtml(catalog.build ? `数据版本 ${catalog.build}` : "本地 wow-db 快照")}</span></div>
      <div class="loot-layout">
        <aside class="loot-sidebar" aria-label="掉落筛选">
          <label class="filter-control"><span>副本</span><select id="raidSelect">${raids.map((entry) => `<option value="${entry.id}" ${String(entry.id) === state.loot.raidId ? "selected" : ""}>${escapeHtml(entry.name)}${entry.isCurrent ? " · 当前" : ""}</option>`).join("")}</select></label>
          <label class="filter-control"><span>Boss</span><select id="bossSelect">${(raid?.bosses || []).map((entry) => `<option value="${entry.id}" ${String(entry.id) === state.loot.bossId ? "selected" : ""}>${escapeHtml(entry.name)}</option>`).join("")}</select></label>
          <div class="filter-control"><span>难度</span><div class="difficulty-tabs">${Object.entries(difficultyLabels).map(([key, label]) => `<button type="button" data-difficulty="${key}" class="${key === state.loot.difficulty ? "is-active" : ""}">${label}</button>`).join("")}</div></div>
          <label class="filter-control"><span>装备搜索</span><div class="search-field"><input id="lootSearch" type="search" placeholder="名称、部位或类型" value="${escapeAttr(state.loot.query)}" /></div></label>
        </aside>
        <div>
          <div class="loot-context"><strong>${escapeHtml(boss?.name || "暂无 Boss")}</strong><span id="lootCount">${items.length} 件 · ${difficultyLabels[state.loot.difficulty]}</span></div>
          <div class="loot-list" id="lootItems">${renderLootItems(items)}</div>
        </div>
      </div>
    </section>`;
  document.querySelector("#raidSelect")?.addEventListener("change", (event) => { state.loot.raidId = event.target.value; state.loot.bossId = ""; renderLoot(); });
  document.querySelector("#bossSelect")?.addEventListener("change", (event) => { state.loot.bossId = event.target.value; renderLoot(); });
  document.querySelectorAll("[data-difficulty]").forEach((button) => button.addEventListener("click", () => { state.loot.difficulty = button.dataset.difficulty; renderLoot(); }));
  document.querySelector("#lootSearch")?.addEventListener("input", (event) => {
    state.loot.query = event.target.value;
    const filtered = (boss?.items || []).filter((item) => !normalize(state.loot.query) || normalize([item.name, item.slotName, item.armorType, item.weaponType, item.description].join(" ")).includes(normalize(state.loot.query)));
    document.querySelector("#lootItems").innerHTML = renderLootItems(filtered);
    document.querySelector("#lootCount").textContent = `${filtered.length} 件 · ${difficultyLabels[state.loot.difficulty]}`;
  });
}

function renderLootItems(items) {
  if (!items.length) return `<div class="empty-state">没有符合条件的掉落装备</div>`;
  return items.map((item) => {
    const itemLevel = item.itemLevels?.[state.loot.difficulty] || item.itemLevel;
    const stats = Object.entries(item.statValuesByDifficulty?.[state.loot.difficulty] || item.statValues || {})
      .filter(([, value]) => Number(value) > 0).map(([name, value]) => `${name} +${formatNumber(value)}`).join(" · ");
    return `<article class="loot-item">
      ${renderIcon(item.iconUrl, "item-icon")}
      <span class="loot-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml([item.slotName, item.armorType || item.weaponType].filter(Boolean).join(" · "))}</span><small class="${item.isSpecialEffect ? "special-effect" : ""}">${escapeHtml(item.isSpecialEffect ? item.description || "特殊效果装备" : stats || "属性以游戏内为准")}</small></span>
      <b class="item-level">${formatNumber(itemLevel)}</b>
    </article>`;
  }).join("");
}

function renderDungeons() {
  const catalog = state.snapshot.mythicPlus;
  const dungeons = catalog?.dungeons || [];
  if (!state.dungeons.dungeonId || !dungeons.some((dungeon) => String(dungeon.id) === state.dungeons.dungeonId)) {
    state.dungeons.dungeonId = String(dungeons[0]?.id || "");
  }
  const dungeon = dungeons.find((entry) => String(entry.id) === state.dungeons.dungeonId);
  if (state.dungeons.bossId !== "all" && !dungeon?.bosses.some((boss) => String(boss.id) === state.dungeons.bossId)) {
    state.dungeons.bossId = "all";
  }
  const boss = dungeon?.bosses.find((entry) => String(entry.id) === state.dungeons.bossId);
  const items = filteredDungeonItems(dungeon);
  const contextName = state.dungeons.bossId === "all" ? "所有 Boss" : boss?.name || "暂无 Boss";

  app.innerHTML = `
    <section>
      <div class="view-heading"><div><p class="eyebrow">Mythic+ catalog</p><h1>大秘境掉落</h1><p>本赛季地下城、Boss 与装备目录；实际装等随钥匙等级变化。</p></div><span class="heading-meta">${dungeons.length} 个地下城 · ${escapeHtml(catalog?.build ? `数据版本 ${catalog.build}` : "本地 wow-db 快照")}</span></div>
      <div class="loot-layout">
        <aside class="loot-sidebar" aria-label="大秘境筛选">
          <label class="filter-control"><span>地下城</span><select id="dungeonSelect">${dungeons.map((entry) => `<option value="${entry.id}" ${String(entry.id) === state.dungeons.dungeonId ? "selected" : ""}>${escapeHtml(entry.name)}</option>`).join("")}</select></label>
          <label class="filter-control"><span>Boss</span><select id="dungeonBossSelect"><option value="all" ${state.dungeons.bossId === "all" ? "selected" : ""}>所有 Boss</option>${(dungeon?.bosses || []).map((entry) => `<option value="${entry.id}" ${String(entry.id) === state.dungeons.bossId ? "selected" : ""}>${escapeHtml(entry.name)}</option>`).join("")}</select></label>
          <label class="filter-control"><span>装备类型</span><select id="dungeonCategorySelect">${Object.entries(categoryLabels).map(([key, label]) => option(key, label, state.dungeons.category)).join("")}</select></label>
          <div class="filter-control"><span>副属性（可多选）</span>${renderStatFilters("dungeon", state.dungeons.stats)}</div>
          <label class="filter-control"><span>装备搜索</span><div class="search-field"><input id="dungeonSearch" type="search" placeholder="名称、部位或类型" value="${escapeAttr(state.dungeons.query)}" /></div></label>
        </aside>
        <div>
          <div class="loot-context"><strong>${escapeHtml(contextName)}</strong><span id="dungeonLootCount">${items.length} 件 · 装等随钥匙等级变化</span></div>
          <div class="loot-list" id="dungeonItems">${renderDungeonItems(items)}</div>
        </div>
      </div>
    </section>`;
  document.querySelector("#dungeonSelect")?.addEventListener("change", (event) => {
    state.dungeons.dungeonId = event.target.value;
    state.dungeons.bossId = "all";
    renderDungeons();
  });
  document.querySelector("#dungeonBossSelect")?.addEventListener("change", (event) => {
    state.dungeons.bossId = event.target.value;
    renderDungeons();
  });
  document.querySelector("#dungeonCategorySelect")?.addEventListener("change", (event) => {
    state.dungeons.category = event.target.value;
    renderDungeons();
  });
  document.querySelectorAll("[data-dungeon-stat]").forEach((button) => button.addEventListener("click", () => {
    state.dungeons.stats = toggleFilter(state.dungeons.stats, button.dataset.dungeonStat);
    renderDungeons();
  }));
  document.querySelector("#dungeonSearch")?.addEventListener("input", (event) => {
    state.dungeons.query = event.target.value;
    const filtered = filteredDungeonItems(dungeon);
    document.querySelector("#dungeonItems").innerHTML = renderDungeonItems(filtered);
    document.querySelector("#dungeonLootCount").textContent = `${filtered.length} 件 · 装等随钥匙等级变化`;
  });
}

function renderDungeonItems(items) {
  if (!items.length) return `<div class="empty-state">没有符合条件的大秘境装备</div>`;
  return items.map((item) => `<article class="loot-item" data-item-id="${item.itemId}">
    ${renderIcon(item.iconUrl, "item-icon")}
    <span class="loot-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml([item.bossName, item.slotName, item.armorType || item.weaponType].filter(Boolean).join(" · "))}</span><small class="${item.isSpecialEffect ? "special-effect" : ""}">${escapeHtml(item.isSpecialEffect ? item.description || "特殊效果装备" : itemStatsText(item) || "装备属性随物品等级缩放")}</small></span>
    <span class="scaling-note">钥石掉落</span>
  </article>`).join("");
}

function filteredDungeonItems(dungeon) {
  const bosses = state.dungeons.bossId === "all"
    ? dungeon?.bosses || []
    : (dungeon?.bosses || []).filter((boss) => String(boss.id) === state.dungeons.bossId);
  const byItemId = new Map();
  for (const boss of bosses) {
    for (const item of boss.items || []) {
      if (!byItemId.has(item.itemId)) byItemId.set(item.itemId, { ...item, bossName: boss.name });
    }
  }
  const query = normalize(state.dungeons.query);
  return [...byItemId.values()].filter((item) => {
    if (!matchesCategory(item, state.dungeons.category)) return false;
    if (!matchesStats(item, state.dungeons.stats)) return false;
    return !query || normalize([
      item.name, item.bossName, item.slotName, item.armorType, item.weaponType, item.description,
    ].join(" ")).includes(query);
  });
}

function renderStatFilters(prefix, selected) {
  return `<div class="filter-chips">${Object.entries(secondaryStatLabels).map(([key, label]) => `<button type="button" data-${prefix}-stat="${key}" class="${selected.includes(key) ? "is-active" : ""}" aria-pressed="${selected.includes(key)}">${label}</button>`).join("")}</div>`;
}

function toggleFilter(filters, value) {
  return filters.includes(value) ? filters.filter((entry) => entry !== value) : [...filters, value];
}

function matchesCategory(item, category) {
  if (category === "all") return true;
  if (["cloth", "leather", "mail", "plate"].includes(category)) {
    return item.armorType === categoryLabels[category];
  }
  if (category === "trinket") return item.equipmentType === "trinket";
  return category === "weapon" && Boolean(item.weaponType || ["one_hand_weapon", "two_hand_weapon", "off_hand"].includes(item.equipmentType));
}

function matchesStats(item, selected) {
  if (!selected.length) return true;
  const itemStats = new Set(Object.keys(normalizedItemStats(item)));
  return selected.every((stat) => itemStats.has(stat));
}

async function renderLoadout() {
  const players = state.snapshot.players.filter((player) => player.hasEquipment);
  if (!state.loadout.playerId || !players.some((player) => player.id === state.loadout.playerId)) {
    state.loadout.playerId = players[0]?.id || "";
    state.loadout.selections = {};
  }
  if (!state.loadout.playerId) {
    app.innerHTML = `<section>${sectionHeading("Dynamic loadout", "动态配装", "")}<div class="empty-state">暂无可用于配装的英雄榜装备</div></section>`;
    return;
  }
  let detail = state.playerDetails.get(state.loadout.playerId);
  if (!detail) {
    app.innerHTML = `<section class="loading-view"><span class="loading-line"></span><span class="loading-line short"></span></section>`;
    const response = await fetch(`./data/players/${encodeURIComponent(state.loadout.playerId)}.json`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`成员数据读取失败 (${response.status})`);
    detail = await response.json();
    state.playerDetails.set(state.loadout.playerId, detail);
  }
  if (!location.hash.startsWith("#/loadout")) return;
  renderLoadoutView(detail, players);
}

function renderLoadoutView(detail, players) {
  const current = currentLoadout(detail);
  const candidates = loadoutCandidatePool();
  const candidateIndex = new Map(candidates.map((item) => [item.selectionId, item]));
  const selected = selectedLoadout(current, candidateIndex);
  const activeItem = selected.get(state.loadout.slot) || current.get(state.loadout.slot) || null;
  const choices = filteredLoadoutCandidates(detail.player, candidates, state.loadout.slot);
  const weights = detail.weights?.weights || detail.simulation?.weights || {};
  const comparison = compareLoadouts(
    current,
    selected,
    weights,
    detail.player.latestSimulationDps,
    detail.simulation?.statTotals,
    detail.player.mainStat,
  );
  const displayStats = [detail.player.mainStat, "haste", "mastery", "criticalStrike", "versatility"].filter(Boolean);
  const simcTemplate = buildSimcTemplate(detail, selected);

  app.innerHTML = `
    <section>
      <div class="view-heading"><div><p class="eyebrow">Dynamic loadout</p><h1>动态配装</h1><p>以英雄榜当前装备为基线，自由替换团本与大秘境掉落。</p></div><span class="heading-meta">${escapeHtml(detail.player.name)} · ${escapeHtml(detail.player.specialization || roleLabels[detail.player.raidRole])}</span></div>
      <div class="loadout-toolbar">
        <label><span>成员</span><select id="loadoutPlayer">${players.map((player) => `<option value="${escapeAttr(player.id)}" ${player.id === state.loadout.playerId ? "selected" : ""}>${escapeHtml(player.name)} · ${escapeHtml(player.specialization || roleLabels[player.raidRole])}</option>`).join("")}</select></label>
        <label><span>候选来源</span><select id="loadoutSource">${option("all", "团本 + 大秘境", state.loadout.source)}${option("raid", "仅团本", state.loadout.source)}${option("dungeon", "仅大秘境", state.loadout.source)}</select></label>
        <label><span>团本难度</span><select id="loadoutDifficulty">${Object.entries(difficultyLabels).map(([key, label]) => option(key, label, state.loadout.difficulty)).join("")}</select></label>
        <label><span>大秘境模拟档位</span><select id="loadoutDungeonDifficulty">${mythicPlusLevelOptions().map(({ key, label }) => option(key, label, state.loadout.dungeonDifficulty)).join("")}</select></label>
        <button type="button" class="reset-button" id="resetLoadout" ${Object.keys(state.loadout.selections).length ? "" : "disabled"}>恢复英雄榜装备</button>
      </div>
      <section class="loadout-summary" aria-label="配装收益估算">
        ${loadoutSummaryFact("基线模拟", formatNumber(comparison.baseline), "DPS")}
        ${loadoutSummaryFact("副属性权重估算", formatSigned(comparison.gain), comparison.percent === null ? "DPS" : `${formatSigned(comparison.percent, 2)}%` , comparison.gain)}
        ${loadoutSummaryFact("已替换", Object.keys(state.loadout.selections).length, "件")}
        ${loadoutSummaryFact("当前槽位", slotLabels[state.loadout.slot] || state.loadout.slot, activeItem?.name || "未装备")}
      </section>
      <div class="estimate-note">属性收益估算不含饰品特效与套装变化；新装备不自动继承原装备的附魔和宝石。大秘境装备按所选模拟档位计算，最终结果以完整模拟为准。</div>
      <div class="simc-export-bar">
        <span><strong>SimC 配装模板</strong><small>${simcTemplate ? "已按当前角色、天赋和配装生成" : "当前成员缺少完整 SimC 身份数据"}</small></span>
        <button type="button" id="openSimcTemplate" ${simcTemplate ? "" : "disabled"}>查看模板</button>
      </div>
      <div class="loadout-workbench">
        <section>
          <div class="loadout-section-title"><strong>配装方案</strong><span>默认采用最近一次英雄榜快照</span></div>
          <div class="loadout-slots">${renderLoadoutSlots(current, selected)}</div>
          <div class="stat-total-strip">${displayStats.map((key) => `<span><small>${escapeHtml(key === detail.player.mainStat ? `主属性 · ${statLabels[key] || "-"}` : statLabels[key] || key)}</small><strong>${formatNumber(comparison.selectedStats[key])}<em class="${toneForDelta(comparison.statDelta[key])}">${formatSigned(comparison.statDelta[key])}</em></strong></span>`).join("")}</div>
        </section>
        <aside class="candidate-panel">
          <div class="loadout-section-title"><strong>${escapeHtml(slotLabels[state.loadout.slot] || state.loadout.slot)}候选</strong><span id="loadoutCandidateCount">${choices.length} 件</span></div>
          <label class="candidate-search"><input id="loadoutSearch" type="search" placeholder="搜索装备或来源" value="${escapeAttr(state.loadout.query)}" /></label>
          <div class="candidate-stat-filter"><span>副属性</span>${renderStatFilters("loadout", state.loadout.stats)}</div>
          <div class="candidate-list">
            ${current.has(state.loadout.slot) ? renderCurrentCandidate(current.get(state.loadout.slot), !state.loadout.selections[state.loadout.slot]) : ""}
            ${choices.length ? choices.map((item) => renderLoadoutCandidate(item, state.loadout.selections[state.loadout.slot] === item.selectionId)).join("") : `<div class="empty-state">没有符合条件的候选装备</div>`}
          </div>
        </aside>
      </div>
      <dialog class="simc-dialog" id="simcDialog">
        <div class="simc-dialog-heading"><div><strong>SimC 配装模板</strong><span>${escapeHtml(detail.player.name)} · ${Object.keys(state.loadout.selections).length} 件替换</span></div><button type="button" id="closeSimcDialog" aria-label="关闭">×</button></div>
        <textarea id="simcTemplateText" readonly spellcheck="false">${escapeHtml(simcTemplate)}</textarea>
        <div class="simc-dialog-actions"><button type="button" id="copySimcTemplate">复制模板</button><button type="button" id="downloadSimcTemplate">下载 .simc</button></div>
      </dialog>
    </section>`;

  document.querySelector("#loadoutPlayer")?.addEventListener("change", (event) => {
    state.loadout.playerId = event.target.value;
    state.loadout.selections = {};
    state.loadout.slot = "head";
    void renderLoadout();
  });
  document.querySelector("#loadoutSource")?.addEventListener("change", (event) => {
    state.loadout.source = event.target.value;
    renderLoadoutView(detail, players);
  });
  document.querySelector("#loadoutDifficulty")?.addEventListener("change", (event) => {
    state.loadout.difficulty = event.target.value;
    renderLoadoutView(detail, players);
  });
  document.querySelector("#loadoutDungeonDifficulty")?.addEventListener("change", (event) => {
    state.loadout.dungeonDifficulty = event.target.value;
    renderLoadoutView(detail, players);
  });
  document.querySelector("#resetLoadout")?.addEventListener("click", () => {
    state.loadout.selections = {};
    renderLoadoutView(detail, players);
  });
  document.querySelectorAll("[data-loadout-slot]").forEach((button) => button.addEventListener("click", () => {
    state.loadout.slot = button.dataset.loadoutSlot;
    renderLoadoutView(detail, players);
  }));
  document.querySelectorAll("[data-loadout-choice]").forEach((button) => button.addEventListener("click", () => {
    state.loadout.selections[state.loadout.slot] = button.dataset.loadoutChoice;
    if (state.loadout.slot === "main_hand" && candidateIndex.get(button.dataset.loadoutChoice)?.equipmentType === "two_hand_weapon") {
      delete state.loadout.selections.off_hand;
    }
    renderLoadoutView(detail, players);
  }));
  document.querySelector("[data-loadout-current]")?.addEventListener("click", () => {
    delete state.loadout.selections[state.loadout.slot];
    renderLoadoutView(detail, players);
  });
  document.querySelectorAll("[data-loadout-stat]").forEach((button) => button.addEventListener("click", () => {
    state.loadout.stats = toggleFilter(state.loadout.stats, button.dataset.loadoutStat);
    renderLoadoutView(detail, players);
  }));
  document.querySelector("#loadoutSearch")?.addEventListener("input", (event) => {
    state.loadout.query = event.target.value;
    renderLoadoutView(detail, players);
    const search = document.querySelector("#loadoutSearch");
    search?.focus();
    search?.setSelectionRange(search.value.length, search.value.length);
  });
  const simcDialog = document.querySelector("#simcDialog");
  document.querySelector("#openSimcTemplate")?.addEventListener("click", () => simcDialog?.showModal());
  document.querySelector("#closeSimcDialog")?.addEventListener("click", () => simcDialog?.close());
  document.querySelector("#copySimcTemplate")?.addEventListener("click", async () => {
    await copyText(simcTemplate);
    showToast("SimC 模板已复制");
  });
  document.querySelector("#downloadSimcTemplate")?.addEventListener("click", () => {
    downloadText(`${safeFilename(detail.player.name)}-动态配装.simc`, simcTemplate);
    showToast("SimC 模板已下载");
  });
}

const loadoutSlotOrder = [
  "head", "neck", "shoulders", "back", "chest", "wrists", "hands", "waist",
  "legs", "feet", "finger1", "finger2", "trinket1", "trinket2", "main_hand", "off_hand",
];

function currentLoadout(detail) {
  const result = new Map();
  const simItems = detail.simulation?.equipment || [];
  const usedSimItems = new Set();
  const counters = { finger: 0, trinket: 0 };
  for (const item of detail.equipment?.items || []) {
    const slot = normalizeEquippedSlot(item.slotType, counters);
    if (!slot) continue;
    const simIndex = simItems.findIndex((simItem, index) => !usedSimItems.has(index) && (
      Number(simItem.id) === Number(item.itemId) || normalizeSimSlot(simItem.slot) === slot
    ));
    if (simIndex >= 0) usedSimItems.add(simIndex);
    const simulationItem = simIndex >= 0 ? simItems[simIndex] : null;
    result.set(slot, {
      ...item,
      slot,
      equipmentType: equippedItemType(item, slot),
      stats: normalizedItemStats({ stats: simulationItem?.stats || [] }),
      sourceType: "current",
      sourceLabel: "英雄榜当前装备",
    });
  }
  return result;
}

function loadoutCandidatePool() {
  const result = new Map();
  for (const raid of state.snapshot.catalog.raids || []) {
    for (const boss of raid.bosses || []) {
      for (const item of boss.items || []) {
        const selectionId = `raid:${item.itemId}`;
        if (!result.has(selectionId)) result.set(selectionId, {
          ...item,
          selectionId,
          sourceType: "raid",
          sourceLabel: `${raid.name} · ${boss.name}`,
          itemLevel: item.itemLevels?.[state.loadout.difficulty] || item.itemLevel,
          stats: normalizedItemStats({ statValues: item.statValuesByDifficulty?.[state.loadout.difficulty] || item.statValues }),
        });
      }
    }
  }
  for (const dungeon of state.snapshot.mythicPlus?.dungeons || []) {
    for (const boss of dungeon.bosses || []) {
      for (const item of boss.items || []) {
        const selectionId = `dungeon:${item.itemId}`;
        if (!result.has(selectionId)) result.set(selectionId, {
          ...item,
          selectionId,
          sourceType: "dungeon",
          sourceLabel: `${dungeon.name} · ${boss.name}`,
          itemLevel: item.itemLevels?.[state.loadout.dungeonDifficulty] || null,
          stats: normalizedItemStats({ statValues: item.statValuesByDifficulty?.[state.loadout.dungeonDifficulty] || item.statValues }),
        });
      }
    }
  }
  return [...result.values()];
}

function selectedLoadout(current, candidateIndex) {
  const result = new Map();
  for (const slot of loadoutSlotOrder) {
    const selected = candidateIndex.get(state.loadout.selections[slot]);
    const item = selected || current.get(slot);
    if (item) result.set(slot, item);
  }
  if (result.get("main_hand")?.equipmentType === "two_hand_weapon") result.delete("off_hand");
  return result;
}

function filteredLoadoutCandidates(player, candidates, slot) {
  const query = normalize(state.loadout.query);
  const weights = state.playerDetails.get(player.id)?.weights?.weights || state.playerDetails.get(player.id)?.simulation?.weights || {};
  return candidates.filter((item) => {
    if (state.loadout.source !== "all" && item.sourceType !== state.loadout.source) return false;
    if (!slotAcceptsItem(slot, item)) return false;
    if (!playerCanEquip(player, item)) return false;
    if (!matchesStats(item, state.loadout.stats)) return false;
    return !query || normalize([item.name, item.sourceLabel, item.slotName, item.armorType, item.weaponType].join(" ")).includes(query);
  }).sort((left, right) => itemWeightScore(right, weights) - itemWeightScore(left, weights) || left.name.localeCompare(right.name, "zh-CN"));
}

function renderLoadoutSlots(current, selected) {
  const mainHandIsTwoHanded = selected.get("main_hand")?.equipmentType === "two_hand_weapon";
  return loadoutSlotOrder.map((slot) => {
    const item = selected.get(slot);
    const changed = Boolean(state.loadout.selections[slot]);
    const occupied = slot === "off_hand" && mainHandIsTwoHanded;
    return `<button type="button" class="loadout-slot ${state.loadout.slot === slot ? "is-active" : ""} ${changed ? "is-changed" : ""}" data-loadout-slot="${slot}">
      ${item ? renderIcon(item.iconUrl, "item-icon", true) : `<span class="item-icon missing-icon">${occupied ? "2H" : "-"}</span>`}
      <span><small>${escapeHtml(slotLabels[slot] || slot)}${changed ? " · 已替换" : ""}</small><strong>${escapeHtml(item?.name || (occupied ? "双手武器占用" : "未装备"))}</strong><em>${escapeHtml(item ? [item.sourceType === "current" ? "英雄榜" : item.sourceType === "raid" ? difficultyLabels[state.loadout.difficulty] + "团本" : "大秘境模拟档位", item.itemLevel ? `装等 ${item.itemLevel}` : "装等随钥石"].join(" · ") : "")}</em></span>
    </button>`;
  }).join("");
}

function renderCurrentCandidate(item, selected) {
  return `<button type="button" class="loadout-candidate ${selected ? "is-selected" : ""}" data-loadout-current>
    ${renderIcon(item.iconUrl, "item-icon", true)}
    <span><strong>${escapeHtml(item.name)}</strong><small>英雄榜当前装备 · 装等 ${formatNumber(item.itemLevel)}</small><em>${escapeHtml(itemStatsText(item) || "属性来自最近模拟")}</em></span>
    <b>${selected ? "当前" : "恢复"}</b>
  </button>`;
}

function renderLoadoutCandidate(item, selected) {
  return `<button type="button" class="loadout-candidate ${selected ? "is-selected" : ""}" data-loadout-choice="${escapeAttr(item.selectionId)}">
    ${renderIcon(item.iconUrl, "item-icon", true)}
    <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.sourceLabel)} · ${item.itemLevel ? `装等 ${formatNumber(item.itemLevel)}` : "装等随钥石"}</small><em>${escapeHtml(itemStatsText(item) || (item.isSpecialEffect ? "特殊效果装备" : "属性以游戏内为准"))}</em></span>
    <b>${selected ? "已选" : "选择"}</b>
  </button>`;
}

function loadoutSummaryFact(label, value, meta, gain = 0) {
  return `<div><span>${escapeHtml(label)}</span><strong class="${toneForDelta(gain)}">${escapeHtml(String(value))}</strong><small>${escapeHtml(meta)}</small></div>`;
}

function compareLoadouts(current, selected, weights, baseline, statTotals, mainStat) {
  const currentStats = sumItemStats(current.values());
  const selectedGearStats = sumItemStats(selected.values());
  const statDelta = {};
  const selectedStats = {};
  const comparedStats = [mainStat, ...Object.keys(secondaryStatLabels)].filter(Boolean);
  const hasSimulationTotals = statTotals && Object.values(statTotals).some((value) => Number(value) > 0);
  let gain = 0;
  for (const key of comparedStats) {
    statDelta[key] = (selectedGearStats[key] || 0) - (currentStats[key] || 0);
    selectedStats[key] = (hasSimulationTotals ? Number(statTotals[key]) || 0 : currentStats[key] || 0) + statDelta[key];
    gain += statDelta[key] * (Number(weights[key]) || 0);
  }
  const numericBaseline = Number.isFinite(Number(baseline)) ? Number(baseline) : null;
  return {
    baseline: numericBaseline,
    gain,
    percent: numericBaseline ? gain / numericBaseline * 100 : null,
    statDelta,
    selectedStats,
  };
}

function sumItemStats(items) {
  const result = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(normalizedItemStats(item))) result[key] = (result[key] || 0) + Number(value || 0);
  }
  return result;
}

function itemWeightScore(item, weights) {
  return Object.entries(normalizedItemStats(item)).reduce((total, [key, value]) => (
    key in secondaryStatLabels ? total + Number(value || 0) * (Number(weights[key]) || 0) : total
  ), 0);
}

function itemStatsText(item) {
  return Object.entries(normalizedItemStats(item))
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `${statLabels[key] || key} +${formatNumber(value)}`)
    .join(" · ");
}

function normalizedItemStats(item) {
  if (item?.stats && !Array.isArray(item.stats)) return item.stats;
  const result = {};
  const entries = Array.isArray(item?.stats)
    ? item.stats.map((stat) => [stat.name, stat.value])
    : Object.entries(item?.statValues || {});
  for (const [name, value] of entries) {
    const key = normalizeStatKey(name);
    if (key && Number(value) > 0) result[key] = (result[key] || 0) + Number(value);
  }
  return result;
}

function normalizeStatKey(name) {
  const key = normalize(name).replaceAll(" ", "").replaceAll("_", "");
  if (["crit", "criticalstrike", "暴击", "爆击"].includes(key)) return "criticalStrike";
  if (["haste", "急速"].includes(key)) return "haste";
  if (["mastery", "精通"].includes(key)) return "mastery";
  if (["versatility", "全能"].includes(key)) return "versatility";
  if (["strength", "力量"].includes(key)) return "strength";
  if (["agility", "敏捷"].includes(key)) return "agility";
  if (["intellect", "智力"].includes(key)) return "intellect";
  return null;
}

function normalizeEquippedSlot(value, counters) {
  const key = String(value || "").toUpperCase();
  const fixed = {
    HEAD: "head", NECK: "neck", SHOULDER: "shoulders", SHOULDERS: "shoulders", BACK: "back",
    CHEST: "chest", WRIST: "wrists", WRISTS: "wrists", HANDS: "hands", WAIST: "waist",
    LEGS: "legs", FEET: "feet", FINGER_1: "finger1", FINGER_2: "finger2",
    TRINKET_1: "trinket1", TRINKET_2: "trinket2", MAIN_HAND: "main_hand", OFF_HAND: "off_hand",
  };
  if (fixed[key]) return fixed[key];
  if (key === "FINGER") return `finger${Math.min(2, ++counters.finger)}`;
  if (key === "TRINKET") return `trinket${Math.min(2, ++counters.trinket)}`;
  return null;
}

function normalizeSimSlot(value) {
  const key = normalize(value);
  return ({ shoulder: "shoulders", wrist: "wrists" })[key] || key;
}

function equippedItemType(item, slot) {
  const inventoryType = String(item.inventoryType || "").toUpperCase();
  if (slot === "main_hand" && inventoryType.includes("TWO")) return "two_hand_weapon";
  if (slot === "main_hand") return "one_hand_weapon";
  if (slot === "off_hand") return "off_hand";
  if (slot.startsWith("finger")) return "finger";
  if (slot.startsWith("trinket")) return "trinket";
  return ({ shoulders: "shoulder", wrists: "wrist" })[slot] || slot;
}

function slotAcceptsItem(slot, item) {
  if (slot.startsWith("finger")) return item.equipmentType === "finger";
  if (slot.startsWith("trinket")) return item.equipmentType === "trinket";
  if (slot === "main_hand") return ["one_hand_weapon", "two_hand_weapon"].includes(item.equipmentType);
  if (slot === "off_hand") return item.equipmentType === "off_hand";
  return item.equipmentType === (({ shoulders: "shoulder", wrists: "wrist" })[slot] || slot);
}

function playerCanEquip(player, item) {
  const classBits = {
    战士: 1, Warrior: 1, 圣骑士: 2, Paladin: 2, 猎人: 4, Hunter: 4,
    潜行者: 8, Rogue: 8, 牧师: 16, Priest: 16, 死亡骑士: 32, "Death Knight": 32,
    萨满祭司: 64, Shaman: 64, 法师: 128, Mage: 128, 术士: 256, Warlock: 256,
    武僧: 512, Monk: 512, 德鲁伊: 1024, Druid: 1024, 恶魔猎手: 2048, "Demon Hunter": 2048,
    唤魔师: 4096, Evoker: 4096,
  };
  const classBit = classBits[player.className];
  if (item.allowableClassMask && classBit && !(item.allowableClassMask & classBit)) return false;
  const armorByClass = {
    战士: "板甲", Warrior: "板甲", 圣骑士: "板甲", Paladin: "板甲", 死亡骑士: "板甲", "Death Knight": "板甲",
    猎人: "锁甲", Hunter: "锁甲", 萨满祭司: "锁甲", Shaman: "锁甲", 唤魔师: "锁甲", Evoker: "锁甲",
    潜行者: "皮甲", Rogue: "皮甲", 武僧: "皮甲", Monk: "皮甲", 德鲁伊: "皮甲", Druid: "皮甲", 恶魔猎手: "皮甲", "Demon Hunter": "皮甲",
    牧师: "布甲", Priest: "布甲", 法师: "布甲", Mage: "布甲", 术士: "布甲", Warlock: "布甲",
  };
  const armorSlots = ["head", "shoulder", "chest", "wrist", "hands", "waist", "legs", "feet"];
  return !item.armorType || !armorSlots.includes(item.equipmentType) || item.armorType === armorByClass[player.className];
}

function formatSigned(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return "-";
  const number = Number(value);
  const formatted = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Math.abs(number));
  return `${number > 0 ? "+" : number < 0 ? "-" : ""}${formatted}`;
}

function toneForDelta(value) {
  return Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "";
}

function mythicPlusLevelOptions() {
  const item = (state.snapshot.mythicPlus?.dungeons || []).flatMap((dungeon) => dungeon.bosses)
    .flatMap((boss) => boss.items)
    .find((entry) => entry.itemLevels);
  return Object.keys(difficultyLabels).map((key) => ({
    key,
    label: item?.itemLevels?.[key] ? `装等 ${item.itemLevels[key]}` : difficultyLabels[key],
  }));
}

function buildSimcTemplate(detail, selected) {
  const identity = detail.simulation?.simcIdentity;
  if (!identity) return "";
  const lines = [
    "# 团队数据 · 动态配装",
    `# ${detail.player.name} - ${detail.player.realmName}`,
    "# 新装备不继承原装备的附魔和宝石，请在 DPSWOW 中按目标方案补充。",
    "",
    identity.actorLine,
    `race=${identity.race}`,
    `level=${identity.level}`,
    `spec=${identity.spec}`,
    `talents=${identity.talents}`,
    "",
  ];
  for (const slot of loadoutSlotOrder) {
    const item = selected.get(slot);
    if (!item) continue;
    lines.push(`# ${slotLabels[slot] || slot}: ${item.name}`);
    lines.push(simcItemLine(slot, item));
  }
  lines.push(
    "",
    "override.bloodlust=1",
    "override.arcane_intellect=1",
    "override.power_word_fortitude=1",
    "override.mark_of_the_wild=1",
    "override.battle_shout=1",
    "fight_style=Patchwerk",
    "iterations=1000",
    "desired_targets=1",
    "max_time=300",
    "calculate_scale_factors=1",
    "scale_only=strength,intellect,agility,crit,mastery,vers,haste,weapon_dps,weapon_offhand_dps",
    "",
  );
  return lines.join("\n");
}

function simcItemLine(slot, item) {
  const simcSlot = ({ shoulders: "shoulder", wrists: "wrist" })[slot] || slot;
  const attributes = [`id=${item.itemId}`];
  if (item.sourceType === "current") {
    if (item.bonusList?.length) attributes.push(`bonus_id=${item.bonusList.join("/")}`);
    const gems = item.sockets?.map((socket) => socket.itemId).filter(Boolean) || [];
    const enchants = item.enchantments?.map((entry) => entry.id).filter(Boolean) || [];
    if (gems.length) attributes.push(`gem_id=${gems.join("/")}`);
    if (enchants.length) attributes.push(`enchant_id=${enchants.join("/")}`);
  } else {
    const difficulty = item.sourceType === "raid" ? state.loadout.difficulty : state.loadout.dungeonDifficulty;
    const bonusId = item.fullyUpgradedBonusLists?.[difficulty];
    if (bonusId) attributes.push(`bonus_id=${bonusId}`);
    else if (item.itemLevel) attributes.push(`ilevel=${item.itemLevel}`);
  }
  return `${simcSlot}=,${attributes.join(",")}`;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back for browsers that deny the async clipboard permission.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function downloadText(filename, value) {
  const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function safeFilename(value) {
  return String(value || "loadout").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 2200);
}

function renderHistory() {
  const query = normalize(state.history.query);
  const iconIndex = catalogItemIndex();
  const records = state.snapshot.allocations.filter((entry) => {
    if (state.history.playerId && entry.playerId !== state.history.playerId) return false;
    return !query || normalize([entry.playerName, entry.raidName, entry.bossName, entry.itemName, entry.note].join(" ")).includes(query);
  });
  app.innerHTML = `
    <section>
      <div class="view-heading"><div><p class="eyebrow">Loot ledger</p><h1>拾取记录</h1><p>当前赛季所有公开分配记录，按时间从新到旧排列。</p></div><span class="heading-meta">${state.snapshot.allocations.length} 条记录</span></div>
      <div class="history-layout">
        <aside class="history-filters" aria-label="拾取筛选">
          <label class="filter-control"><span>成员</span><select id="historyPlayer"><option value="">全部成员</option>${state.snapshot.players.map((player) => `<option value="${escapeAttr(player.id)}" ${player.id === state.history.playerId ? "selected" : ""}>${escapeHtml(player.name)}</option>`).join("")}</select></label>
          <label class="filter-control"><span>记录搜索</span><div class="search-field"><input id="historySearch" type="search" placeholder="装备、Boss 或备注" value="${escapeAttr(state.history.query)}" /></div></label>
        </aside>
        <div class="history-list" id="historyRows">${renderHistoryRows(records, iconIndex)}</div>
      </div>
    </section>`;
  document.querySelector("#historyPlayer").addEventListener("change", (event) => { state.history.playerId = event.target.value; renderHistory(); });
  document.querySelector("#historySearch").addEventListener("input", (event) => {
    state.history.query = event.target.value;
    const nextQuery = normalize(state.history.query);
    const filtered = state.snapshot.allocations.filter((entry) => (!state.history.playerId || entry.playerId === state.history.playerId) && (!nextQuery || normalize([entry.playerName, entry.raidName, entry.bossName, entry.itemName, entry.note].join(" ")).includes(nextQuery)));
    document.querySelector("#historyRows").innerHTML = renderHistoryRows(filtered, iconIndex);
  });
}

function renderHistoryRows(records, iconIndex) {
  if (!records.length) return `<div class="empty-state">没有符合条件的拾取记录</div>`;
  return records.map((entry) => `<article class="history-row">
    <time datetime="${escapeAttr(entry.allocatedAt)}">${escapeHtml(formatDate(entry.allocatedAt, "compact"))}</time>
    <span class="history-player"><strong class="${className(entry.playerClassName)}">${escapeHtml(entry.playerName)}</strong><small>${escapeHtml(roleLabels[entry.playerRole])}</small></span>
    <span class="history-boss"><strong>${escapeHtml(entry.bossName)}</strong><small>${escapeHtml(entry.raidName)} · ${difficultyLabels[entry.difficulty] || entry.difficulty}</small></span>
    <span class="history-item">${renderIcon(iconIndex.get(entry.itemId)?.iconUrl, "item-icon")}<span><strong>${escapeHtml(entry.itemName)}</strong><small>${escapeHtml([entry.equipmentType, entry.itemLevel ? `装等 ${entry.itemLevel}` : "", entry.note].filter(Boolean).join(" · "))}</small></span></span>
    <strong class="history-pickup">${entry.countsTowardTotal ? `+${entry.pickupCount}` : "不计入"}</strong>
  </article>`).join("");
}

function catalogItemIndex() {
  const index = new Map();
  for (const raid of state.snapshot.catalog.raids || []) {
    for (const boss of raid.bosses || []) {
      for (const item of boss.items || []) index.set(item.itemId, item);
    }
  }
  return index;
}

function className(value) {
  return `class-${classMap[value] || "unknown"}`;
}

function renderIcon(url, extraClass, eager = false) {
  return url
    ? `<img class="${extraClass}" data-icon src="${escapeAttr(url)}" alt="" loading="${eager ? "eager" : "lazy"}" referrerpolicy="no-referrer" />`
    : `<span class="${extraClass} missing-icon" aria-hidden="true">?</span>`;
}

function sectionHeading(eyebrow, title, meta) {
  return `<div class="section-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2></div><span>${escapeHtml(meta)}</span></div>`;
}

function reportEmptySection(title, message) {
  return `<section class="report-section">${sectionHeading("Simulation", title, "")}<div class="empty-state">${escapeHtml(message)}</div></section>`;
}

function summaryFact(label, value, suffix) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(suffix)}</small></div>`;
}

function detailFact(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "-")}</strong></div>`;
}

function option(value, label, selected) {
  return `<option value="${value}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function dataFreshness(value) {
  if (!value) return { label: "无模拟", className: "is-empty" };
  const age = Date.now() - timestamp(value);
  if (age > 36 * 60 * 60 * 1000) return { label: "待更新", className: "is-stale" };
  return { label: "已更新", className: "" };
}

function fightStyleLabel(value) {
  return value === "Patchwerk" ? "木桩 / 单体" : value || "-";
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number(value)) : "-";
}

function formatTierSet(tierSet) {
  return tierSet ? `${Number(tierSet.equipped) || 0}/${Number(tierSet.total) || 5}` : "-/5";
}

function tierSetTone(tierSet) {
  const count = Number(tierSet?.equipped) || 0;
  return count >= 4 ? "tier-high" : count >= 2 ? "tier-mid" : "tier-low";
}

function formatDecimal(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(1) : "-";
}

function formatClock(value) {
  const seconds = Math.max(0, Number(value) || 0);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

function formatDate(value, mode = "full") {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  if (mode === "compact") return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
  if (mode === "short") return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatRelative(value) {
  if (!value) return "尚未模拟";
  const age = Math.max(0, Date.now() - timestamp(value));
  if (age < 60 * 60 * 1000) return `${Math.max(1, Math.round(age / 60_000))} 分钟前`;
  if (age < 24 * 60 * 60 * 1000) return `${Math.round(age / 3_600_000)} 小时前`;
  return `${Math.round(age / 86_400_000)} 天前`;
}

function timestamp(value) {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalize(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function renderError(error) {
  app.innerHTML = `<section class="error-view"><strong>页面暂时无法读取</strong><span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span></section>`;
}
