import type {
  LocalSimulationReport,
  Player,
  SimulationAction,
  SpellReference,
  StatWeights,
  WeightSnapshot,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

export function parseLocalSimulationReport(input: {
  player: Player;
  snapshot: WeightSnapshot;
  payload: unknown;
  equipmentNames?: Map<number, string>;
}): LocalSimulationReport {
  const payload = record(input.payload);
  const report = record(payload.report);
  const sim = record(report.sim);
  const options = record(sim.options);
  const players = array(sim.players);
  const simulatedPlayer = record(players[0]);
  const collected = record(simulatedPlayer.collected_data);
  const dps = record(collected.dps);
  const fightLength = number(record(collected.fight_length).mean);
  const damage = parseDamage(array(simulatedPlayer.stats));

  return {
    schemaVersion: 1,
    player: {
      id: input.player.id,
      name: input.player.name,
      realm: input.player.realmName,
      className: input.player.className,
      specialization: text(simulatedPlayer.specialization) || input.player.specialization,
      mainStat: input.player.mainStat,
      talents: text(simulatedPlayer.talents) || null,
    },
    source: {
      simulatedAt: input.snapshot.sourceCreatedAt,
      fetchedAt: input.snapshot.fetchedAt,
      gameVersion: input.snapshot.gameVersion,
      gameBuild: input.snapshot.gameBuild,
      simcVersion: text(payload.simcVersion) || text(report.version) || "unknown",
    },
    summary: {
      dps: number(dps.mean) ?? input.snapshot.baselineDps,
      dpsMin: number(dps.min),
      dpsMax: number(dps.max),
      dpsError: number(dps.mean_std_dev),
      fightLength,
      iterations: number(options.iterations),
      fightStyle: text(options.fight_style) || "unknown",
      targets: number(options.desired_targets),
    },
    weights: input.snapshot.weights,
    statTotals: parseStatTotals(collected),
    statPercentages: parseStatPercentages(collected),
    damage,
    castFrequency: parseCastFrequency(array(simulatedPlayer.stats), fightLength),
    actionSequence: {
      precombat: parseActions(array(collected.action_sequence_precombat)),
      combat: parseActions(array(collected.action_sequence)),
    },
    equipment: parseEquipment(record(simulatedPlayer.gear), input.equipmentNames, input.player.mainStat),
    profile: text(payload.profile),
  };
}

function parseDamage(stats: unknown[]): LocalSimulationReport["damage"] {
  const result: LocalSimulationReport["damage"] = [];
  const visit = (values: unknown[]) => {
    for (const value of values) {
      const stat = record(value);
      const dps = number(record(stat.portion_aps).mean);
      if (dps && dps > 0) {
        result.push({
          id: number(stat.id),
          name: actionName(stat),
          iconUrl: null,
          dps,
          percent: Math.max(0, number(stat.portion_amount) ?? 0) * 100,
          executes: number(record(stat.num_executes).mean),
        });
      }
      visit(array(stat.children));
    }
  };
  visit(stats);
  return result.sort((left, right) => right.dps - left.dps);
}

function parseCastFrequency(
  stats: unknown[],
  fightLength: number | null,
): LocalSimulationReport["castFrequency"] {
  return stats
    .map((value) => {
      const stat = record(value);
      const executes = number(record(stat.num_executes).mean);
      if (!executes || executes <= 0) return null;
      const interval = number(record(stat.total_intervals).mean);
      return {
        id: number(stat.id),
        name: actionName(stat),
        iconUrl: null,
        executes,
        castsPerMinute: fightLength && fightLength > 0 ? executes / fightLength * 60 : null,
        interval,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) => right.executes - left.executes);
}

function parseActions(values: unknown[]): SimulationAction[] {
  return values.map((value) => {
    const action = record(value);
    const resources = record(action.resources);
    const maximums = record(action.resources_max);
    return {
      time: number(action.time) ?? 0,
      id: number(action.id),
      name: actionName(action),
      iconUrl: null,
      target: text(action.target) || null,
      resources: Object.entries(resources)
        .map(([name, resource]) => ({
          name,
          value: number(resource) ?? 0,
          max: number(maximums[name]),
        }))
        .filter((entry) => entry.max === null || entry.max > 0),
    };
  });
}

export function localizeSimulationReport(
  report: LocalSimulationReport,
  spells: Map<number, SpellReference>,
): LocalSimulationReport {
  const localize = <T extends { id: number | null; name: string; iconUrl: string | null }>(
    entry: T,
  ): T => {
    const spell = entry.id ? spells.get(entry.id) : null;
    return {
      ...entry,
      name: spell?.name || localizeInternalAction(entry.name),
      iconUrl: spell?.iconUrl || null,
    };
  };
  return {
    ...report,
    damage: report.damage.map(localize),
    castFrequency: report.castFrequency.map(localize),
    actionSequence: {
      precombat: report.actionSequence.precombat.map(localize),
      combat: report.actionSequence.combat.map(localize),
    },
  };
}

function localizeInternalAction(name: string): string {
  const normalized = name.trim().toLowerCase();
  const known: Record<string, string> = {
    "auto attack": "自动攻击",
    "melee main hand": "主手近战攻击",
    "melee off hand": "副手近战攻击",
    patchwerk: "木桩目标",
    unknown: "未知动作",
  };
  return known[normalized] || (normalized.startsWith("use item ")
    ? `使用物品：${name.slice("Use Item ".length)}`
    : name);
}

function parseEquipment(
  gear: JsonRecord,
  equipmentNames?: Map<number, string>,
  mainStat?: Player["mainStat"],
): LocalSimulationReport["equipment"] {
  return Object.entries(gear).map(([slot, value]) => {
    const item = record(value);
    const encoded = text(item.encoded_item);
    const idMatch = encoded.match(/(?:^|,)id=(\d+)/);
    const id = idMatch ? Number(idMatch[1]) : null;
    return {
      slot,
      id,
      name: (id && equipmentNames?.get(id)) || humanize(text(item.name) || "unknown"),
      itemLevel: number(item.ilevel),
      stats: [
        ...Object.entries(item)
          .filter(([key, stat]) => key.endsWith("_rating") && number(stat) !== null)
          .map(([name, stat]) => ({ name: humanize(name.replace(/_rating$/, "")), value: number(stat)! })),
        ...gearMainStat(item, mainStat),
      ],
    };
  });
}

function parseStatTotals(collected: JsonRecord): StatWeights {
  const buffed = record(collected.buffed_stats);
  const attributes = record(buffed.attribute);
  const stats = record(buffed.stats);
  return {
    strength: number(attributes.strength) || 0,
    agility: number(attributes.agility) || 0,
    intellect: number(attributes.intellect) || 0,
    haste: number(stats.haste_rating) || 0,
    mastery: number(stats.mastery_rating) || 0,
    criticalStrike: number(stats.crit_rating) || 0,
    versatility: number(stats.versatility_rating) || 0,
  };
}

function parseStatPercentages(collected: JsonRecord): LocalSimulationReport["statPercentages"] {
  const stats = record(record(collected.buffed_stats).stats);
  return {
    haste: (number(stats.haste_pct) || 0) * 100,
    mastery: (number(stats.mastery_pct) || 0) * 100,
    criticalStrike: (number(stats.crit_pct) || 0) * 100,
    versatility: (number(stats.versatility_pct) || 0) * 100,
  };
}

function gearMainStat(item: JsonRecord, mainStat: Player["mainStat"] | undefined): Array<{ name: string; value: number }> {
  if (!mainStat) return [];
  const aliases: Record<NonNullable<Player["mainStat"]>, string[]> = {
    strength: ["strength", "str", "strint", "stragi"],
    agility: ["agility", "agi", "agiint", "stragi"],
    intellect: ["intellect", "int", "strint", "agiint"],
  };
  for (const key of aliases[mainStat]) {
    const value = number(item[key]);
    if (value && value > 0) return [{ name: mainStat, value }];
  }
  return [];
}

function actionName(value: JsonRecord): string {
  return text(value.spell_name) || humanize(text(value.name)) || "Unknown";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
