import { chromium } from "playwright";
import { resolve } from "node:path";

const armoryApiBase = "https://webapi.blizzard.cn/wow-armory-server/api";
const localApiBase = process.env.LOOT_ALLOCATOR_URL || "http://127.0.0.1:5070";
const profilePath = resolve(
  process.env.GUILD_BROWSER_PROFILE || "artifacts/guild-browser-profile",
);
const realmSlug = process.env.GUILD_REALM_SLUG || "kelthuzad";
const guildName = process.env.GUILD_NAME || "暮色之末";
const minimumItemLevel = Number(process.env.MIN_ITEM_LEVEL || 289);
const maximumItemLevel = Number(process.env.MAX_ITEM_LEVEL || 300);
const shouldCommit = process.argv.includes("--commit");

const classNames = new Map([
  [1, "战士"],
  [2, "圣骑士"],
  [3, "猎人"],
  [4, "潜行者"],
  [5, "牧师"],
  [6, "死亡骑士"],
  [7, "萨满祭司"],
  [8, "法师"],
  [9, "术士"],
  [10, "武僧"],
  [11, "德鲁伊"],
  [12, "恶魔猎手"],
  [13, "唤魔师"],
]);

const tankSpecs = new Set(["鲜血", "防护", "守护", "酒仙", "复仇"]);
const healerSpecs = new Set(["神圣", "戒律", "恢复", "织雾", "恩护", "保存"]);
const meleeSpecs = new Set([
  "冰霜", "邪恶", "武器", "狂怒", "惩戒", "野性", "踏风", "浩劫",
  "增强", "生存", "刺杀", "狂徒", "敏锐",
]);
const rangedSpecs = new Set([
  "平衡", "元素", "野兽控制", "射击", "奥术", "火焰", "冰霜",
  "暗影", "痛苦", "恶魔学识", "毁灭", "湮灭", "增辉", "噬灭",
]);

const intellectSpecs = new Set([
  "神圣", "戒律", "暗影", "恢复", "平衡", "元素", "织雾", "恩护", "保存",
  "奥术", "火焰", "冰霜", "痛苦", "恶魔学识", "毁灭", "湮灭", "增辉", "噬灭",
]);
const agilityClasses = new Set([3, 4, 12]);
const strengthClasses = new Set([1, 2, 6]);

const context = await chromium.launchPersistentContext(profilePath, {
  headless: true,
  locale: "zh-CN",
  viewport: { width: 1280, height: 850 },
});

try {
  const index = await armoryGet("guildIndex", {
    realm_slug: realmSlug,
    guild_name: guildName,
  });
  const token = stringValue(index.token);
  if (!token) throw new Error("公会接口没有返回 token");

  const rosterPayload = await armoryGet("guildDo", { api: "guild_roster", token });
  const roster = findArray(rosterPayload, ["members", "roster"]);
  if (!roster.length) {
    throw new Error(`公会名单为空；返回字段：${Object.keys(rosterPayload).join(", ")}`);
  }

  const levelCapMembers = roster
    .map(normalizeRosterMember)
    .filter((member) => member.level === 90);
  const details = [];
  for (let offset = 0; offset < levelCapMembers.length; offset += 50) {
    const batch = levelCapMembers.slice(offset, offset + 50);
    const payload = await armoryGet("guildDo", {
      api: "guild_roster_detail",
      token,
      attr: JSON.stringify({
        type: "achievement",
        roles: batch.map((member) => ({
          name: member.name,
          character_id: member.characterId,
          slug: member.realmSlug,
        })),
      }),
    });
    const values = findArray(payload, ["roles", "members", "details", "character_details"]);
    if (!values.length) {
      throw new Error(`第 ${offset / 50 + 1} 批详情为空；返回字段：${Object.keys(payload).join(", ")}`);
    }
    details.push(...values);
  }

  const detailById = new Map(details.map((detail) => [stringValue(detail.character_id), detail]));
  const [state, realms] = await Promise.all([
    localGet("/api/state"),
    localGet("/api/reference/realms"),
  ]);
  const realmNames = new Map(realms.map((realm) => [realm.slug, realm.name]));
  const existingKeys = new Set(
    state.players.map((player) => characterKey(player.name, player.realmSlug)),
  );

  const allCandidates = levelCapMembers
    .map((member) => {
      const detail = detailById.get(member.characterId) || {};
      const specialization = stringValue(detail.active_spec);
      const itemLevel = numberValue(detail.average_item_level);
      return {
        ...member,
        className: classNames.get(member.classId) || "",
        specialization,
        itemLevel,
        realmName: realmNames.get(member.realmSlug) || "",
        raidRole: inferRaidRole(member.classId, specialization),
        mainStat: inferMainStat(member.classId, specialization),
      };
    })
    .filter((member) => (
      member.itemLevel !== null
      && member.itemLevel >= minimumItemLevel
      && member.itemLevel <= maximumItemLevel
    ))
    .sort((left, right) => right.itemLevel - left.itemLevel || left.name.localeCompare(right.name));

  const duplicates = allCandidates.filter((member) => (
    existingKeys.has(characterKey(member.name, member.realmSlug))
  ));
  const newCandidates = allCandidates.filter((member) => (
    !existingKeys.has(characterKey(member.name, member.realmSlug))
  ));
  const risks = newCandidates.filter((member) => (
    !member.name
    || !member.realmSlug
    || !member.realmName
    || !member.className
    || !member.specialization
    || !member.raidRole
    || !member.mainStat
  ));

  console.log(JSON.stringify({
    guild: { name: guildName, realmSlug, rosterSize: roster.length },
    filter: { minimumItemLevel, maximumItemLevel },
    counts: {
      levelCap: levelCapMembers.length,
      details: details.length,
      matched: allCandidates.length,
      duplicate: duplicates.length,
      new: newCandidates.length,
      risky: risks.length,
    },
    duplicates: duplicates.map(toReportRow),
    risks: risks.map(toReportRow),
    candidates: newCandidates.map(toReportRow),
  }, null, 2));

  if (!shouldCommit) {
    console.error("\n仅完成审计；确认后使用 --commit 写入。\n");
    process.exitCode = risks.length ? 2 : 0;
  } else if (risks.length) {
    throw new Error(`存在 ${risks.length} 个字段不完整的候选角色，已拒绝写入`);
  } else {
    const backupResponse = await fetch(`${localApiBase}/api/backups/export`);
    if (!backupResponse.ok) throw new Error(`数据库备份失败：HTTP ${backupResponse.status}`);
    await backupResponse.arrayBuffer();
    const backupName = attachmentFilename(backupResponse.headers.get("content-disposition"));
    console.error(`数据库备份完成：${backupName || "文件名未知"}`);

    const imported = [];
    const failed = [];
    for (const [index, candidate] of newCandidates.entries()) {
      try {
        const created = await localPost("/api/players", {
          name: candidate.name,
          realmName: candidate.realmName,
          realmSlug: candidate.realmSlug,
          raidRole: candidate.raidRole,
          mainStat: candidate.mainStat,
        });
        let refreshed = false;
        let refreshError = null;
        try {
          await localPost(`/api/players/${created.id}/character/refresh`);
          refreshed = true;
        } catch (error) {
          refreshError = error instanceof Error ? error.message : String(error);
        }
        imported.push({ ...toReportRow(candidate), id: created.id, refreshed, refreshError });
        console.error(`[${index + 1}/${newCandidates.length}] 已录入 ${candidate.name}-${candidate.realmName}`);
      } catch (error) {
        failed.push({
          ...toReportRow(candidate),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    console.error(JSON.stringify({
      result: {
        backupName,
        imported: imported.length,
        refreshed: imported.filter((entry) => entry.refreshed).length,
        refreshFailed: imported.filter((entry) => !entry.refreshed).length,
        failed: failed.length,
      },
      refreshFailures: imported.filter((entry) => !entry.refreshed),
      failures: failed,
    }, null, 2));
    if (failed.length) process.exitCode = 1;
  }
} finally {
  await context.close();
}

async function armoryGet(path, parameters) {
  const url = new URL(`${armoryApiBase}/${path}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  const response = await context.request.get(url.toString(), {
    headers: {
      Accept: "application/json",
      Referer: "https://wow.blizzard.cn/guild/",
    },
    timeout: 30_000,
  });
  if (!response.ok()) throw new Error(`英雄榜接口 ${path} 返回 HTTP ${response.status()}`);
  const envelope = await response.json();
  if (envelope.code === 20_000) throw new Error("战网登录已失效");
  if (envelope.code !== 0) throw new Error(envelope.message || `英雄榜接口错误 ${envelope.code}`);
  return envelope.data && typeof envelope.data === "object" ? envelope.data : {};
}

async function localGet(path) {
  const response = await fetch(`${localApiBase}${path}`);
  return unwrapLocalResponse(response);
}

async function localPost(path, body) {
  const response = await fetch(`${localApiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return unwrapLocalResponse(response);
}

async function unwrapLocalResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `本地接口返回 HTTP ${response.status}`);
  }
  return payload.data;
}

function normalizeRosterMember(entry) {
  const character = entry?.character || {};
  return {
    characterId: stringValue(character.character_id),
    name: stringValue(character.name),
    realmSlug: stringValue(character.realm?.slug),
    classId: numberValue(character.playable_class?.id),
    level: numberValue(character.level),
  };
}

function findArray(value, preferredKeys) {
  if (Array.isArray(value)) return value;
  for (const key of preferredKeys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  for (const nested of Object.values(value || {})) {
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function inferRaidRole(classId, specialization) {
  if (tankSpecs.has(specialization)) return "tank";
  if (healerSpecs.has(specialization)) return "healer";
  if (specialization === "冰霜") return classId === 8 ? "ranged" : "melee";
  if (meleeSpecs.has(specialization)) return "melee";
  if (rangedSpecs.has(specialization)) return "ranged";
  return null;
}

function inferMainStat(classId, specialization) {
  if (intellectSpecs.has(specialization)) return "intellect";
  if (specialization === "冰霜") return classId === 8 ? "intellect" : "strength";
  if (agilityClasses.has(classId) || classId === 10 || classId === 11 || classId === 7) {
    return "agility";
  }
  if (strengthClasses.has(classId)) return "strength";
  if ([5, 8, 9, 13].includes(classId)) return "intellect";
  return null;
}

function toReportRow(member) {
  return {
    name: member.name,
    realmName: member.realmName,
    realmSlug: member.realmSlug,
    itemLevel: member.itemLevel,
    className: member.className,
    specialization: member.specialization,
    raidRole: member.raidRole,
    mainStat: member.mainStat,
  };
}

function characterKey(name, slug) {
  return `${String(name).trim().toLocaleLowerCase("zh-CN")}\u0000${String(slug).trim().toLowerCase()}`;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function attachmentFilename(header) {
  const match = /filename="?([^";]+)"?/i.exec(header || "");
  return match?.[1] || null;
}
