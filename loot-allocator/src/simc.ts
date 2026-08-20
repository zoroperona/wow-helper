import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CharacterStatSnapshot, MainStat, StatWeights } from "./types.js";
import { normalizeWeights } from "./dpswow.js";

type JsonRecord = Record<string, unknown>;

const classTokens: Record<number, string> = {
  1: "warrior", 2: "paladin", 3: "hunter", 4: "rogue", 5: "priest",
  6: "deathknight", 7: "shaman", 8: "mage", 9: "warlock", 10: "monk",
  11: "druid", 12: "demonhunter", 13: "evoker",
};

const specializationTokens: Record<number, string> = {
  62: "arcane", 63: "fire", 64: "frost", 70: "retribution", 71: "arms",
  72: "fury", 73: "protection", 102: "balance", 103: "feral", 104: "guardian",
  105: "restoration", 250: "blood", 251: "frost", 252: "unholy",
  253: "beast_mastery", 254: "marksmanship", 255: "survival", 256: "discipline",
  257: "holy", 258: "shadow", 259: "assassination", 260: "outlaw",
  261: "subtlety", 262: "elemental", 263: "enhancement", 264: "restoration",
  265: "affliction", 266: "demonology", 267: "destruction", 268: "brewmaster",
  269: "windwalker", 270: "mistweaver", 577: "havoc", 581: "vengeance",
  1467: "devastation", 1468: "preservation", 1473: "augmentation", 1480: "devourer",
};

const raceTokens: Record<string, string> = {
  "人类": "human", "矮人": "dwarf", "暗夜精灵": "night_elf", "侏儒": "gnome",
  "德莱尼": "draenei", "狼人": "worgen", "熊猫人": "pandaren", "虚空精灵": "void_elf",
  "光铸德莱尼": "lightforged_draenei", "黑铁矮人": "dark_iron_dwarf",
  "库尔提拉斯人": "kul_tiran", "机械侏儒": "mechagnome", "龙希尔": "dracthyr",
  "土灵": "earthen", "兽人": "orc", "亡灵": "scourge", "牛头人": "tauren",
  "巨魔": "troll", "血精灵": "blood_elf", "地精": "goblin", "夜之子": "nightborne",
  "至高岭牛头人": "highmountain_tauren", "玛格汉兽人": "maghar_orc",
  "赞达拉巨魔": "zandalari_troll", "狐人": "vulpera",
};

const slotTokens: Record<string, string> = {
  HEAD: "head", NECK: "neck", SHOULDER: "shoulder", BACK: "back", CHEST: "chest",
  WRIST: "wrist", HANDS: "hands", WAIST: "waist", LEGS: "legs", FEET: "feet",
  FINGER_1: "finger1", FINGER_2: "finger2", TRINKET_1: "trinket1",
  TRINKET_2: "trinket2", MAIN_HAND: "main_hand", OFF_HAND: "off_hand",
};

export interface LocalSimResult {
  report: JsonRecord;
  weights: StatWeights;
  inferredMainStat: MainStat | null;
  baselineDps: number | null;
  gameVersion: string;
  gameBuild: number | null;
  simcVersion: string;
  profilePath: string;
  reportPath: string;
  htmlPath: string;
  logPath: string;
}

export type CharacterStatsResult = Omit<CharacterStatSnapshot, "calculatedAt">;

export function formatLocalDate(value: Date): string {
  return [
    value.getFullYear(),
    padDatePart(value.getMonth() + 1),
    padDatePart(value.getDate()),
  ].join("-");
}

export function buildSimcArtifactName(input: {
  playerName: string;
  realmName: string;
  simulatedAt: Date;
}): string {
  const time = [
    padDatePart(input.simulatedAt.getHours()),
    padDatePart(input.simulatedAt.getMinutes()),
    padDatePart(input.simulatedAt.getSeconds()),
  ].join("-");
  return safeFilename(
    `${input.playerName}-${input.realmName}-${formatLocalDate(input.simulatedAt)}-${time}`,
  );
}

export function buildSimcProfile(payload: unknown): string {
  return [
    buildSimcCharacterBase(payload),
    "override.bloodlust=1",
    "override.arcane_intellect=1",
    "override.power_word_fortitude=1",
    "override.mark_of_the_wild=1",
    "override.battle_shout=1",
    "override.mystic_touch=1",
    "override.chaos_brand=1",
    "override.skyfury=1",
    "override.hunters_mark=1",
    "override.bleeding=1",
    "override.blessing_of_the_bronze=0",
    "",
    "fight_style=Patchwerk",
    "iterations=1000",
    "desired_targets=1",
    "max_time=300",
    "calculate_scale_factors=1",
    "scale_only=strength,intellect,agility,crit,mastery,vers,haste,weapon_dps,weapon_offhand_dps",
    "",
  ].join("\n");
}

export function buildCharacterStatsProfile(payload: unknown): string {
  return [
    buildSimcCharacterBase(payload),
    "optimal_raid=0",
    "flask=disabled",
    "food=disabled",
    "augmentation=disabled",
    "potion=disabled",
    "temporary_enchant=disabled",
    "iterations=1",
    "max_time=1",
    "fixed_time=1",
    "vary_combat_length=0",
    "calculate_scale_factors=0",
    "",
  ].join("\n");
}

function buildSimcCharacterBase(payload: unknown): string {
  const root = asRecord(payload);
  const summary = asRecord(root.character_summary);
  const characterClass = asRecord(summary.character_class);
  const specializations = asRecord(root.specializations);
  const activeSpec = asRecord(specializations.active_specialization);
  const classToken = classTokens[numberValue(characterClass.id)];
  const specId = numberValue(activeSpec.id);
  const specToken = specializationTokens[specId];
  const raceToken = raceTokens[textValue(asRecord(summary.race).name)];
  const playerName = textValue(summary.name);
  const talents = findActiveTalents(specializations, specId);
  if (!classToken || !specToken || !raceToken || !playerName || !talents) {
    throw new Error(`Incomplete SimC identity for ${playerName || "character"}`);
  }

  const equipment = asRecord(root.equipment);
  const items = Array.isArray(equipment.equipped_items) ? equipment.equipped_items : [];
  const itemLines = items.map(buildItemLine).filter((line): line is string => Boolean(line));
  if (itemLines.length < 10) {
    throw new Error(`Not enough equipped items for ${playerName}`);
  }

  return [
    `${classToken}=${sanitizeActorName(playerName)}`,
    `race=${raceToken}`,
    `level=${numberValue(summary.level)}`,
    `spec=${specToken}`,
    `talents=${talents}`,
    "",
    ...itemLines,
    "",
  ].join("\n");
}

export async function runLocalCharacterStats(input: {
  simcPath: string;
  payload: unknown;
  timeoutMs?: number;
}): Promise<CharacterStatsResult> {
  const directory = await mkdtemp(join(tmpdir(), "wow-character-stats-"));
  const profilePath = join(directory, "character-stats.simc");
  const reportPath = join(directory, "character-stats.json");
  try {
    await writeFile(profilePath, buildCharacterStatsProfile(input.payload), "utf8");
    const result = await runProcess(input.simcPath, [
      profilePath,
      `json2=${reportPath}`,
      "threads=1",
    ], input.timeoutMs ?? 15_000);
    if (result.code !== 0) {
      throw new Error(`SimC character stats exited with code ${result.code}: ${result.stderr.trim()}`);
    }
    const report = JSON.parse(await readFile(reportPath, "utf8")) as JsonRecord;
    return parseCharacterStats(report, inferProfileMainStat(input.payload));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function parseCharacterStats(report: unknown, mainStat: MainStat | null): CharacterStatsResult {
  const root = asRecord(report);
  const sim = asRecord(root.sim);
  const players = Array.isArray(sim.players) ? sim.players : [];
  const player = asRecord(players[0]);
  const buffed = asRecord(asRecord(player.collected_data).buffed_stats);
  const attributes = asRecord(buffed.attribute);
  const stats = asRecord(buffed.stats);
  if (!Object.keys(stats).length) throw new Error("SimC report has no character stats");
  const options = asRecord(sim.options);
  const dbc = asRecord(options.dbc);
  const channel = textValue(dbc.version_used) || "Live";
  const build = asRecord(dbc[channel]);
  const stat = (ratingKey: string, percentKey: string) => ({
    rating: numberValue(stats[ratingKey]),
    percent: numberValue(stats[percentKey]) * 100,
  });
  return {
    schemaVersion: 1,
    gameVersion: textValue(build.wow_version) || textValue(root.version) || "unknown",
    gameBuild: nullableNumber(build.build_level),
    simcVersion: textValue(root.version) || "unknown",
    environment: "character",
    mainStat,
    attributes: {
      strength: numberValue(attributes.strength),
      agility: numberValue(attributes.agility),
      intellect: numberValue(attributes.intellect),
      stamina: numberValue(attributes.stamina),
    },
    secondary: {
      criticalStrike: stat("crit_rating", "crit_pct"),
      haste: stat("haste_rating", "haste_pct"),
      mastery: stat("mastery_rating", "mastery_pct"),
      versatility: stat("versatility_rating", "versatility_pct"),
    },
  };
}

export function inferProfileMainStat(payload: unknown): MainStat | null {
  const specializationId = numberValue(
    asRecord(asRecord(asRecord(payload).specializations).active_specialization).id,
  );
  const strengthSpecs = new Set([70, 71, 72, 73, 250, 251, 252]);
  const agilitySpecs = new Set([103, 104, 253, 254, 255, 259, 260, 261, 263, 268, 269, 577, 581]);
  const intellectSpecs = new Set([
    62, 63, 64, 102, 105, 256, 257, 258, 262, 264, 265, 266, 267, 270,
    1467, 1468, 1473, 1480,
  ]);
  if (strengthSpecs.has(specializationId)) return "strength";
  if (agilitySpecs.has(specializationId)) return "agility";
  if (intellectSpecs.has(specializationId)) return "intellect";
  return null;
}

export async function runLocalSimc(input: {
  simcPath: string;
  outputDirectory: string;
  payload: unknown;
  artifactName: string;
  threads?: number;
  timeoutMs?: number;
}): Promise<LocalSimResult> {
  await mkdir(input.outputDirectory, { recursive: true });
  const prefix = safeFilename(input.artifactName);
  const profilePath = join(input.outputDirectory, `${prefix}.simc`);
  const reportPath = join(input.outputDirectory, `${prefix}.json`);
  const htmlPath = join(input.outputDirectory, `${prefix}.html`);
  const logPath = join(input.outputDirectory, `${prefix}.log`);
  await writeFile(profilePath, buildSimcProfile(input.payload), "utf8");

  const result = await runProcess(input.simcPath, [
    profilePath,
    `json2=${reportPath}`,
    `html=${htmlPath}`,
    `threads=${input.threads ?? 6}`,
  ], input.timeoutMs ?? 30 * 60_000);
  await writeFile(logPath, `${result.stdout}\n${result.stderr}`, "utf8");
  if (result.code !== 0) {
    throw new Error(`SimC exited with code ${result.code}; see ${logPath}`);
  }

  const report = JSON.parse(await readFile(reportPath, "utf8")) as JsonRecord;
  const sim = asRecord(report.sim);
  const players = Array.isArray(sim.players) ? sim.players : [];
  const player = asRecord(players[0]);
  const weights = normalizeWeights(asRecord(player.scale_factors));
  if (Object.values(weights).every((value) => value === 0)) {
    throw new Error(`SimC report has no stat weights: ${basename(reportPath)}`);
  }
  const options = asRecord(sim.options);
  const dbc = asRecord(options.dbc);
  const channel = textValue(dbc.version_used) || "Live";
  const build = asRecord(dbc[channel]);
  const dps = asRecord(asRecord(player.collected_data).dps);
  return {
    report,
    weights,
    inferredMainStat: inferProfileMainStat(input.payload) || inferMainStat(weights),
    baselineDps: nullableNumber(dps.mean),
    gameVersion: textValue(build.wow_version) || textValue(report.version) || "unknown",
    gameBuild: nullableNumber(build.build_level),
    simcVersion: textValue(report.version) || "unknown",
    profilePath,
    reportPath,
    htmlPath,
    logPath,
  };
}

function buildItemLine(value: unknown): string | null {
  const item = asRecord(value);
  const slot = slotTokens[textValue(asRecord(item.slot).type)];
  const itemId = numberValue(asRecord(item.media).id);
  if (!slot || !itemId) return null;
  const attributes = [`id=${itemId}`];
  const bonuses = numberArray(item.bonus_list);
  const gems = recordArray(item.sockets).map((socket) => numberValue(asRecord(socket.media).id)).filter(Boolean);
  const enchants = recordArray(item.enchantments).map((entry) => numberValue(entry.enchantment_id)).filter(Boolean);
  const craftedStats = recordArray(item.modified_crafting_stat).map((entry) => numberValue(entry.id)).filter(Boolean);
  if (bonuses.length) attributes.push(`bonus_id=${bonuses.join("/")}`);
  if (gems.length) attributes.push(`gem_id=${gems.join("/")}`);
  if (enchants.length) attributes.push(`enchant_id=${enchants.join("/")}`);
  if (craftedStats.length) attributes.push(`crafted_stats=${craftedStats.join("/")}`);
  return `${slot}=,${attributes.join(",")}`;
}

function findActiveTalents(specializations: JsonRecord, specId: number): string {
  const specs = Array.isArray(specializations.specializations) ? specializations.specializations : [];
  for (const value of specs) {
    const spec = asRecord(value);
    if (numberValue(asRecord(spec.specialization).id) !== specId) continue;
    const loadouts = Array.isArray(spec.loadouts) ? spec.loadouts : [];
    const active = loadouts.map(asRecord).find((loadout) => loadout.is_active === true);
    return textValue(active?.talent_loadout_code);
  }
  return "";
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<{code: number; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

function inferMainStat(weights: StatWeights): MainStat | null {
  const candidates: Array<[MainStat, number]> = [
    ["strength", weights.strength], ["agility", weights.agility], ["intellect", weights.intellect],
  ];
  candidates.sort((left, right) => right[1] - left[1]);
  return candidates[0] && candidates[0][1] > 0 ? candidates[0][0] : null;
}

function sanitizeActorName(value: string): string {
  return value.replace(/[=,#\r\n]/g, "_");
}

function safeFilename(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!sanitized) throw new Error("SimC artifact name is empty");
  return sanitized;
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(numberValue).filter(Boolean) : [];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown): number | null {
  const number = numberValue(value);
  return Number.isFinite(number) && number !== 0 ? number : null;
}
