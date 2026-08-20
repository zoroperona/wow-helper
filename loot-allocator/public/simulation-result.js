const statLabels = {
  intellect: "智力",
  agility: "敏捷",
  strength: "力量",
  versatility: "全能",
  haste: "急速",
  mastery: "精通",
  criticalStrike: "暴击",
};

const slotLabels = {
  head: "头部", neck: "颈部", shoulders: "肩部", shoulder: "肩部", back: "背部",
  chest: "胸部", wrists: "腕部", wrist: "腕部", hands: "手部", waist: "腰部",
  legs: "腿部", feet: "脚部", finger1: "戒指 1", finger2: "戒指 2",
  trinket1: "饰品 1", trinket2: "饰品 2", main_hand: "主手", off_hand: "副手",
};

const statNameLabels = {
  crit: "暴击", haste: "急速", mastery: "精通", versatility: "全能",
  avoidance: "闪避", leech: "吸血", speed: "速度",
};

const reportRoot = document.querySelector("#simulationReport");
const profileDialog = document.querySelector("#profileDialog");
let report;

document.querySelector("#printButton").addEventListener("click", () => window.print());
document.querySelector("#toggleProfileButton").addEventListener("click", () => profileDialog.showModal());
document.querySelector("#closeProfileButton").addEventListener("click", () => profileDialog.close());

try {
  const playerId = new URLSearchParams(window.location.search).get("player");
  if (!playerId) throw new Error("缺少角色参数");
  report = await api(`/api/players/${encodeURIComponent(playerId)}/simulations/latest`);
  document.title = `${report.player.name} - 本地模拟结果`;
  document.querySelector("#profileContent").textContent = report.profile || "本次模拟未保存配置文本。";
  renderReport(report);
} catch (error) {
  reportRoot.innerHTML = `<div class="report-error"><strong>无法读取模拟结果</strong><span>${escapeHtml(error.message)}</span></div>`;
}

function renderReport(data) {
  const damageMax = Math.max(1, ...data.damage.map((entry) => entry.dps));
  const frequencyMax = Math.max(1, ...data.castFrequency.map((entry) => entry.executes));
  const weightMax = Math.max(1, ...Object.values(data.weights).map(Number));
  reportRoot.innerHTML = `
    <header class="result-header">
      <div class="result-identity">
        <p class="eyebrow">本地单体模拟</p>
        <h1>${escapeHtml(data.player.name)}</h1>
        <p>${escapeHtml(data.player.realm)} · ${escapeHtml([data.player.className, data.player.specialization].filter(Boolean).join(" / ") || "未知专精")}</p>
      </div>
      <div class="result-dps">
        <span>模拟输出</span>
        <strong>${formatInteger(data.summary.dps)}</strong>
        <small>DPS ${data.summary.dpsError ? `± ${formatInteger(data.summary.dpsError)}` : ""}</small>
      </div>
    </header>

    <section class="report-facts" aria-label="模拟条件">
      ${fact("战斗类型", fightStyleLabel(data.summary.fightStyle))}
      ${fact("目标", `${data.summary.targets || 1} 个`)}
      ${fact("时长", formatDuration(data.summary.fightLength))}
      ${fact("迭代次数", formatInteger(data.summary.iterations))}
      ${fact("游戏版本", data.source.gameVersion)}
      ${fact("模拟时间", formatDate(data.source.simulatedAt))}
    </section>

    <section class="report-section">
      <div class="report-section-heading"><div><p class="eyebrow">Stat weights</p><h2>属性收益</h2></div><span>每增加 1 点属性对应的 DPS 收益</span></div>
      <div class="report-weight-grid">
        ${Object.entries(data.weights).filter(([, value]) => Number(value) > 0).map(([key, value]) => `
          <div class="report-weight">
            <div><span>${statLabels[key] || key}</span><strong>${Number(value).toFixed(2)}</strong></div>
            <i style="--value:${Math.max(2, Number(value) / weightMax * 100)}%"></i>
          </div>`).join("")}
      </div>
    </section>

    <section class="report-section">
      <div class="report-section-heading"><div><p class="eyebrow">Buffed stats</p><h2>模拟环境属性</h2></div><span>包含本次模拟配置的团队增益与消耗品</span></div>
      <div class="report-weight-grid">
        ${renderSimulatedStat(data, data.player.mainStat, statLabels[data.player.mainStat] || "主属性", false)}
        ${renderSimulatedStat(data, "criticalStrike", "暴击")}
        ${renderSimulatedStat(data, "haste", "急速")}
        ${renderSimulatedStat(data, "mastery", "精通")}
        ${renderSimulatedStat(data, "versatility", "全能")}
      </div>
    </section>

    <section class="report-section">
      <div class="report-section-heading"><div><p class="eyebrow">Damage breakdown</p><h2>伤害构成</h2></div><span>${data.damage.length} 个伤害来源</span></div>
      <div class="damage-table">
        <div class="damage-table-head"><span>技能</span><span>占比</span><span>DPS</span><span>平均次数</span></div>
        ${data.damage.map((entry) => `
          <div class="damage-row">
            <div class="damage-name">${renderSpell(entry)}<i style="--value:${entry.dps / damageMax * 100}%"></i></div>
            <span>${entry.percent.toFixed(1)}%</span><span>${formatInteger(entry.dps)}</span><span>${formatDecimal(entry.executes)}</span>
          </div>`).join("") || `<div class="report-empty">报告没有伤害明细</div>`}
      </div>
    </section>

    <section class="report-section sequence-section">
      <div class="report-section-heading"><div><p class="eyebrow">Sample sequence</p><h2>施法顺序</h2></div><span>SimC 样本战斗 · 共 ${data.actionSequence.combat.length} 次动作</span></div>
      <p class="section-note">这是 SimC 选取的一次真实样本战斗时间轴。随机触发会改变单次顺序，不代表固定循环。</p>
      ${renderPrecombat(data.actionSequence.precombat)}
      <div class="sequence-timeline">${renderSequence(data.actionSequence.combat)}</div>
    </section>

    <section class="report-section">
      <div class="report-section-heading"><div><p class="eyebrow">Cast frequency</p><h2>技能施放频率</h2></div><span>整场模拟平均值</span></div>
      <div class="frequency-grid">
        ${data.castFrequency.map((entry) => `
          <div class="frequency-row">
            <div class="frequency-name">${renderSpell(entry)}<i style="--value:${Math.max(1, entry.executes / frequencyMax * 100)}%"></i></div>
            <span>${formatDecimal(entry.executes)} 次</span><span>${entry.castsPerMinute ? `${entry.castsPerMinute.toFixed(1)} / 分钟` : "-"}</span><span>${entry.interval ? `间隔 ${entry.interval.toFixed(1)} 秒` : "-"}</span>
          </div>`).join("") || `<div class="report-empty">报告没有施放频率</div>`}
      </div>
    </section>

    <section class="report-section">
      <div class="report-section-heading"><div><p class="eyebrow">Equipment</p><h2>模拟装备</h2></div><span>${data.equipment.length} 件</span></div>
      <div class="report-equipment">
        ${data.equipment.map(renderEquipment).join("")}
      </div>
    </section>

    <footer class="report-footer">
      <span>SimulationCraft ${escapeHtml(data.source.simcVersion)}</span>
      <span>${escapeHtml(data.player.name)} · ${escapeHtml(data.player.realm)}</span>
      <span>${escapeHtml(formatDate(data.source.simulatedAt))}</span>
    </footer>`;
}

function renderSimulatedStat(data, key, label, showPercent = true) {
  if (!key) return "";
  const rating = Number(data.statTotals?.[key]) || 0;
  const percent = Number(data.statPercentages?.[key]);
  return `<div class="report-weight"><div><span>${escapeHtml(label)}</span><strong>${formatInteger(rating)}</strong></div><small>${showPercent && Number.isFinite(percent) ? `${percent.toFixed(2)}%` : "属性点数"}</small></div>`;
}

function renderPrecombat(actions) {
  if (!actions.length) return "";
  return `<div class="precombat"><span>战前</span>${actions.map((action) => renderSpell(action, "spell-chip")).join("")}</div>`;
}

function renderSequence(actions) {
  if (!actions.length) return `<div class="report-empty">本次报告没有输出样本施法序列</div>`;
  const groups = new Map();
  actions.forEach((action) => {
    const start = Math.floor(action.time / 30) * 30;
    if (!groups.has(start)) groups.set(start, []);
    groups.get(start).push(action);
  });
  return [...groups.entries()].map(([start, entries]) => `
    <div class="sequence-window">
      <div class="sequence-time-range"><strong>${formatClock(start)}</strong><span>至 ${formatClock(start + 30)}</span></div>
      <ol>${entries.map((action) => {
        const resource = action.resources.find((entry) => !["mana", "health"].includes(entry.name));
        return `<li title="${escapeHtml(resource ? `${resource.name}: ${Math.round(resource.value)} / ${Math.round(resource.max || 0)}` : action.target || "")}">
          <time>${formatClock(action.time, true)}</time>${renderSpell(action)}${resource ? `<small>${escapeHtml(resource.name)} ${Math.round(resource.value)}</small>` : ""}
        </li>`;
      }).join("")}</ol>
    </div>`).join("");
}

function renderSpell(entry, extraClass = "") {
  const classes = ["spell-label", extraClass].filter(Boolean).join(" ");
  const icon = entry.iconUrl
    ? `<img src="${escapeHtml(entry.iconUrl)}" alt="" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false" /><i class="spell-icon-placeholder" hidden></i>`
    : `<i class="spell-icon-placeholder"></i>`;
  return `<span class="${classes}" title="${escapeHtml(entry.id ? `${entry.name} · 技能 ID ${entry.id}` : entry.name)}">${icon}<strong>${escapeHtml(entry.name)}</strong></span>`;
}

function renderEquipment(item) {
  const stats = item.stats.map((stat) => `${statNameLabels[stat.name.toLowerCase()] || stat.name} +${formatInteger(stat.value)}`).join(" · ");
  return `<div class="report-item">
    ${item.id ? `<img src="/api/loot/icon/${item.id}" alt="" loading="lazy" />` : `<span class="item-placeholder"></span>`}
    <div><span>${slotLabels[item.slot] || item.slot}</span><strong>${escapeHtml(item.name)}</strong><small>${stats || "装备属性由 SimC 报告提供"}</small></div>
    <b>${item.itemLevel ? Math.round(item.itemLevel) : "-"}</b>
  </div>`;
}

function fact(label, value) {
  return `<div><span>${label}</span><strong>${escapeHtml(value || "-")}</strong></div>`;
}

function fightStyleLabel(value) {
  return value === "Patchwerk" ? "木桩 / 单体" : value;
}

function formatInteger(value) {
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number(value)) : "-";
}

function formatDecimal(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(1) : "-";
}

function formatDuration(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value))} 秒` : "-";
}

function formatClock(value, milliseconds = false) {
  const time = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(time / 60);
  const seconds = time - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(milliseconds ? 1 : 0).padStart(milliseconds ? 4 : 2, "0")}`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function api(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `请求失败 (${response.status})`);
  return payload.data;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
