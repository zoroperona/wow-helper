import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const dbPath = resolve(repoRoot, "wow-db/output/wow.sqlite");

const bosses = [
  { folder: "H1", encounterId: 2888, name: "盘魂者内克扎莉" },
  { folder: "H2", encounterId: 2874, name: "陵寝哨兵" },
  { folder: "H3", encounterId: 2882, name: "万毒邪祟者瓦什尼克" },
  { folder: "H4", encounterId: 2894, name: "迷失的探险者" },
  { folder: "H5", encounterId: 2871, name: "斯索拉克" },
  { folder: "H6", encounterId: 2887, name: "双子毒牙" },
  { folder: "H7", encounterId: 2883, name: "盘卷祭坛" },
  { folder: "H8", encounterId: 2895, name: "乌拉特克" },
  { folder: "H9", encounterId: 2849, name: "尼姆瑞莎·唤波者" },
];

const query = `
WITH RECURSIVE tree(EncounterID, SectionID, Allowed) AS (
  SELECT s.JournalEncounterID,
         s.ID,
         CASE
           WHEN NOT EXISTS (
             SELECT 1 FROM JournalSectionXDifficulty x
             WHERE x.JournalEncounterSectionID = s.ID
           ) OR EXISTS (
             SELECT 1 FROM JournalSectionXDifficulty x
             WHERE x.JournalEncounterSectionID = s.ID AND x.DifficultyID = 15
           ) THEN 1 ELSE 0
         END
  FROM JournalEncounterSection s
  WHERE s.JournalEncounterID IN (${bosses.map((boss) => boss.encounterId).join(",")})
    AND s.ParentSectionID = 0

  UNION ALL

  SELECT tree.EncounterID,
         child.ID,
         tree.Allowed AND CASE
           WHEN NOT EXISTS (
             SELECT 1 FROM JournalSectionXDifficulty x
             WHERE x.JournalEncounterSectionID = child.ID
           ) OR EXISTS (
             SELECT 1 FROM JournalSectionXDifficulty x
             WHERE x.JournalEncounterSectionID = child.ID AND x.DifficultyID = 15
           ) THEN 1 ELSE 0
         END
  FROM tree
  JOIN JournalEncounterSection child
    ON child.JournalEncounterID = tree.EncounterID
   AND child.ParentSectionID = tree.SectionID
),
spells AS (
  SELECT tree.EncounterID AS encounterId,
         section.SpellID AS spellId,
         MIN(section.OrderIndex) AS orderIndex,
         COALESCE(name.Name_lang, '未命名技能') AS skill,
         MAX(COALESCE(spell.Description_lang, '')) AS description,
         MAX(COALESCE(spell.AuraDescription_lang, '')) AS aura
  FROM tree
  JOIN JournalEncounterSection section ON section.ID = tree.SectionID
  LEFT JOIN SpellName name ON name.ID = section.SpellID
  LEFT JOIN Spell spell ON spell.ID = section.SpellID
  WHERE tree.Allowed = 1 AND section.SpellID > 0
  GROUP BY tree.EncounterID, section.SpellID
)
SELECT * FROM spells ORDER BY encounterId, orderIndex, spellId;
`;

const rows = JSON.parse(
  execFileSync("sqlite3", ["-json", dbPath, query], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }),
);

const nameRows = JSON.parse(
  execFileSync("sqlite3", ["-json", dbPath, "SELECT ID, Name_lang FROM SpellName;"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  }),
);
const spellNames = new Map(nameRows.map((row) => [String(row.ID), row.Name_lang]));

const actions = {
  2888: [
    [/盘魂之井|盘魂仪式|仪式灼烧|盘魂$/, "中场禁入；小怪绝不能进井。触发仪式后立即补血并避免再次触发。"],
    [/溃散之怒/, "满能量狂暴，视为硬性失败条件；必须靠阻止仪式充能避免触发。"],
    [/附身弹幕/, "当前坦克去远点，弹道清空；让弹幕飞足距离再爆。"],
    [/摄魂打击/, "坦克按持续伤害和治疗降低层数换坦并开主动减伤。"],
    [/盘魂点燃/, "全团补满血，按时间轴交团队减伤并躲开击退区域。"],
    [/精华撕裂|潜藏的教徒/, "点名先到边场，治疗确认到位后驱散；永久地板沿外圈整齐放置。"],
    [/墓缚推进|无眠|觉醒宿主|残骸凋零/, "优先破盾、控制并击杀小怪；转阶段用小火烧净尸体。"],
    [/觉醒之缚|灵魂转移|苦痛回响/, "转阶段立即转火两只回响，解除首领保护。"],
    [/噬灭烈焰|蛇行烈焰|焚化/, "按分组处理大圈；未分担者用追踪小火烧尸体，避开人群。"],
    [/解除盘卷|祈求|交织步/, "第二阶段软狂暴，开爆发并继续执行边放、远离和小怪优先。"],
  ],
  2874: [
    [/乌拉特克的统御/, "两只哨兵保持至少 40 码，避免获得 99% 减伤。"],
    [/毒液凝块|污染/, "软泥第一优先转火，尽快停止持续全团伤害。"],
    [/剧毒水滴|剧毒冲击/, "绿队分区主动踩球，错峰承伤，不能让球超时爆炸。"],
    [/活体毒液/, "观察场外到绿色首领的完整射线路径并躲开。"],
    [/强化猛击/, "绿色坦克按叠层承伤；转阶段后换边重置压力。"],
    [/凋零之血/, "治疗错峰驱散并及时补满目标。"],
    [/不稳定的瘴气|鲜血毒液/, "红队集合分担，结算后整队移动，把地板铺在后方。"],
    [/鲜血毒液注射/, "坦克把大地板放到边场，不堵换边路线。"],
    [/酸液印记|鲜血印记/, "转阶段结束后两队换边，避免同一印记持续叠高。"],
    [/强酸静滞/, "两边提前修齐血量；转阶段低血首领会被治疗到高血首领水平。"],
    [/螺旋毒素|培育爆裂/, "先看红球再配对：0 找 4、1 找 3、2 找 2；确认后才相撞。"],
    [/附着幽暗/, "数据库子效果；随对应红色首领技能处理并由治疗关注。"],
  ],
  2882: [
    [/痛饮|毒性蒸汽/, "100 能量前把首领带到指定两喷泉之间；全团预铺减伤，后续压力逐轮上升。"],
    [/恶性爆发|硬化毒液|瘴气涂层/, "软泥绝不能进入中场或拖延过久；控制并优先击杀。"],
    [/滴毒之牙/, "每次施放后换坦，避免带易伤继续承伤。"],
    [/瘟疫泡沫|瘟疫浪潮/, "点名出人群，结算后全团离开其横向和纵向十字线路。"],
    [/恶性催化剂|催化胆汁/, "全场分区接圈，一个都不能漏。"],
    [/猩红坚韧|分裂结块|血液喷射/, "血软泥优先，击杀后继续清完全部分裂体。"],
    [/鲜血灌注|虹吸感染|鲜血虹吸/, "点名离团，治疗优先刷穿治疗吸收。"],
    [/暗影灌注|冥河感染|冥河爆发|幽影喷射|幽暗喷射/, "暗系点名分散并躲落圈；暗软泥群控聚怪后集中破盾击杀。"],
    [/烈焰灌注|爆炸感染|爆燃喷射/, "治疗按点名顺序错峰驱散，避免全团爆炸叠在同一秒。"],
    [/腐蚀爆炸|腐蚀涌动|燃烧领域/, "两只火软泥错开击杀，第一轮持续团伤缓和后再杀第二只。"],
    [/适应性感染/, "根据当前喷泉属性执行血、暗或火感染的对应处理。"],
  ],
  2894: [
    [/联合防御/, "不要让三只首领同时进入 30 码；保持两只可顺劈、第三只拉开。"],
    [/黑暗低语|莫尔扎希的命令|邪眼|恶毒威仪/, "围绕当前被控制的首领作战，准备在满能量前喂鱼打断控制循环。"],
    [/最终扬升|灾变祈求/, "在施法完成前喂给当前受控首领一条鱼；第四次满能量为硬狂暴。"],
    [/投掷垃圾|蘑菇投掷|弹射|真菌爆炸/, "保留蘑菇，冲击波到面前时再踩起飞；不要提前消耗。"],
    [/爆炸惊喜|冲击波/, "炸弹贴边，冲击波接近时利用蘑菇或可靠位移越过。"],
    [/木刺炸裂|遗物爆裂|鱼腥反噬/, "踩箱人员轮换并及时抬血；25 秒内继续踩箱，喂鱼后注意反噬。"],
    [/撕裂碎片/, "贤者坦克按魔法易伤换坦或开主动减伤。"],
    [/冰封烈焰/, "安排打断链；漏断后治疗尽快处理可驱散残留。"],
    [/霜火连射|燃烧烈焰|穿刺冰霜|冰霜区域|火焰区域|延烧之火|元素爆炸/, "火效果踩冰地板，冰效果踩火地板；错峰消除，避免同属性二次命中。"],
    [/闪现新星/, "首领闪现后全团迅速远离目标点，距离越远伤害越低。"],
    [/稳固打击/, "大副坦克按逐渐升高的物理压力换坦或强化减伤。"],
    [/旋壳/, "离开大副正面，避免被扇形攻击眩晕。"],
    [/巨力重击|余震/, "左中右三组各分担一个圈，圈不重叠；落地后躲余震。"],
    [/无情加剧|震荡冲击|粉碎铁锹/, "数据库记录的强化或子效果；随大副主技能处理，避免正面与地面落点。"],
  ],
  2871: [
    [/顶级掠食者|劫掠|毁伤|残毁创伤|风暴/, "两坦分别接坦克刀，甲乙组各接一次团队刀；同一组不能连续分担。"],
    [/侵蚀毒液/, "坦克按物理易伤层数换坦。"],
    [/剧毒涌动|粘稠囊肿/, "点名去发光风道正对面放囊，其他人远离以降低团伤。"],
    [/狂怒侧风|湍流阵风/, "相反箭头玩家让方向线互指，站稳后借击飞在空中相撞。"],
    [/呼啸旋涡|乌拉特克之仪/, "中场集合，按一球、二球、三球风道顺序碰毒囊并反弹回中场。"],
    [/掘地固守/, "首领承伤提高，是爆发窗口；仍以正确处理三次吹风为先。"],
    [/腐蚀利爪|腐蚀残渣/, "躲落点，坦克沿干净扇区整理永久毒水。"],
  ],
  2887: [
    [/永恒毒液|中毒/, "监控永久毒层，按 8 层封顶；只靠盛宴消层。"],
    [/腐蚀洪流|腐蚀液滴/, "地面绿球必须一人一个主动吃掉，漏球会给全团叠毒。"],
    [/碎石击/, "坦克轮流承接，不能空圈，也不要带易伤连续吃。"],
    [/剧毒涌现|腐蚀唾液|浓缩唾液/, "中场小蛇第一优先；直线点名者站定，其他人让线，多线不重合。"],
    [/盘卷脓液|凝结的鲜血|凝血箭/, "红色点名和地板带到边场，避免堵转阶段路线。"],
    [/贪婪盛宴|饱餐/, "连续三次由甲乙丙三组各吃一次，任何人不得连续分担。"],
    [/搅动深渊|剧毒烟气|剧毒粘液/, "躲绿色波和地面危险区，治疗覆盖固定团伤。"],
    [/下潜|邪恶洪流|血色风暴/, "离开落点，看绿球旋转方向，逆向穿过射线起点并同时躲红圈。"],
    [/溃散之怒/, "两只同步修血并尽量同秒击杀，避免一只先死使另一只狂暴。"],
  ],
  2883: [
    [/剧毒洪流|凝结的毒液|烈性毒液|苛性分泌物/, "机动组把毒球搬到中场清理线，避免掉在人群和移动路线。"],
    [/撕裂|凋零撕裂/, "坦克把头前对准待清毒球并每次换坦；团队远离正面。"],
    [/毒液爆裂/, "毒球分批清理，避免叠加持续全团伤害。"],
    [/处斩|冷酷处斩|处决|碎斧/, "甲乙组轮流至少 5 人分担；结算后全团远离斧头 40 码。"],
    [/盘卷祭坛之牙|盘卷祭坛亵渎|亵渎大地|毒牙|双牙毒素/, "固定高压团伤，治疗交团队减伤；避开祭坛正面和地面危险区。"],
    [/寡妇之吻|寡妇之触/, "按点名分散并规避其后续范围效果，首周确认精确判定。"],
    [/腐化毒素|污血/, "坦克或点名目标注意叠层持续伤害，治疗加强并按机制换坦。"],
    [/恐惧行军|恐惧威仪/, "全团脚下集合并快速破除心控吸收盾，不能让玩家走下悬崖。"],
    [/令人不安的凝视/, "目标先背对把灵魂引到中场，再面对灵魂将其定住。"],
    [/灵魂撕裂|墓缚|收回精华|精魂抹除/, "坦克头前清魂；被割裂者在时限内捡回全部个人灵魂残片。"],
    [/幽暗炸弹/, "大紫圈严格出人群，爆炸后立刻收回个人残片。"],
    [/精魂狂笑|恐惧哀嚎|恐惧箭/, "小怪优先转火并安排打断链，漏断会造成全团恐惧或额外压力。"],
    [/暮光之帷|永恒夜幕|窒息黑暗/, "全团转火破盾，破盾后立即打断致命引导；治疗处理吸收。"],
    [/灵魂绑定|亡灵卫兵|惊惧再生|报复恶念/, "转阶段爆发祖尔加；阻止残片接触首领并按口令逐个踩。"],
    [/死亡之拥|死亡低语|被怨恨吞噬/, "第三阶段两只持续修血并尽量同秒击杀，避免死亡强化。"],
  ],
  2895: [
    [/疫鳞卵簇|蠕动孕育|群体孕育|孵化厄运/, "搬蛋避开下一条毒浪；优先转火正在孕育的蛋和幼体。"],
    [/腐蚀浪潮/, "躲开浪潮路径，并提前移走路径上的蛋，避免孵化和永久团伤层。"],
    [/腐臭薄膜|死疽蒸汽|剧毒灼烧|凋萎静脉/, "持续团伤会叠高，治疗减伤向后段倾斜并减少不必要孵化。"],
    [/蛇母之怒|岩石剧毒|步履维艰|无羁之怒/, "副坦提前贴近接手，确保首领始终有近战目标并按连续攻击换坦。"],
    [/幽魂盘卷|灵魂绞杀者/, "按预定组多人分担；受到本轮限制者退出下一轮，由替补补位。"],
    [/恶臭痛击|响尾猛击/, "保持在预定中距离安全带，避开尾部方向并确保坦克近战不断档。"],
    [/被缚之怒|落石|烈毒之心/, "开团队减伤、躲落石，全团爆发高易伤的烈毒之心。"],
    [/厄鳞外壳|守卫的保护|恶性甲壳/, "先杀提供保护的守卫；保护存在时不要强行处理大蛋或受保护目标。"],
    [/攫取毒牙|暗影蜕皮/, "按治疗口令分批打断或解除，避免多个全团持续伤害同时出现。"],
    [/缺陷：虚弱/, "利用承伤提高窗口集中击杀目标。"],
    [/石化钉刺/, "点名周围净空，治疗优先刷穿吸收以解除石化。"],
    [/盘绕猎物/, "迅速转移到剩余平台，开启位移和个人减伤，避免被击退下台。"],
    [/毒蛇呼唤|剧毒撕咬|酸液爆发|剧毒喷吐|酸液喷发|险恶回音|沸腾毒液/, "小怪优先转火；尖啸和关键施法优先打断，避免小怪拖到强化。"],
    [/毒蛇之咬|钙化尸骸|易爆清除/, "指定队友在石化前吸毒；接毒者立即离团，到爆炸区排毒。"],
    [/厄鳞大锅|痛苦哀嚎|绝望鞭笞|恐怖咆哮/, "危险小怪技能，优先击杀或打断；首周依据实际可断性完善分工。"],
    [/乌拉特克之羁绊/, "不同形态共享承伤，按阶段优先级输出即可。"],
    [/怒火释放/, "最终高压团伤，交完剩余治疗、免疫和个人减伤完成击杀。"],
    [/恶意|腐蚀|灵魂/, "数据库子效果；随所属主技能处理，首周用日志确认是否需独立操作。"],
  ],
  2849: [
    [/诱人水泡/, "鱼人进泡前优先转火并控制；已进入水泡的强化小怪最高优先。"],
    [/脉动潮汐/, "水泡存续期间持续团伤，治疗预铺并保持全团健康。"],
    [/嘭！/, "水泡破裂前补满血、开减伤，站位避免被击退到危险区。"],
    [/激荡漩涡/, "躲开漩涡前往水泡的路径，并准备水泡破裂团伤。"],
    [/刺骨寒霜|冰霜宝珠/, "按预定顺序错峰吃球，同一人不要连续叠宝珠易伤。"],
    [/残留冰霜/, "把冰地板放在边场，保留中场和小怪拦截路线。"],
    [/碎裂/, "宝珠不能漏吃；漏球会造成可叠加的全团爆发和持续伤害。"],
    [/冰刃乱舞/, "当前坦克开主动减伤，按叠加易伤换坦。"],
    [/深渊之雨/, "固定持续团伤，安排团队减伤并保持移动中治疗。"],
    [/唤波者之力/, "首领冰霜伤害逐次提高，构成软狂暴，尽量减少总循环数。"],
    [/无尽潮汐/, "后段终结压力；保留治疗大招、个人减伤和爆发尽快击杀。"],
  ],
};

function cleanDescription(value) {
  if (!value) return "数据库未提供独立文字说明；该条目是关联技能或子效果。";

  let text = value
    .replace(/\r?\n+/g, " ")
    .replace(/\|c[0-9A-Fa-f]{8}\|Hspell:(\d+)\|h\[([^\]]+)]\|h\|r/g, "$2")
    .replace(/\$@spellname(\d+)/g, (_, id) => spellNames.get(id) ?? `技能 ${id}`)
    .replace(/\$@spelldesc(\d+)/g, (_, id) => `沿用关联技能 ${spellNames.get(id) ?? id} 的说明`)
    .replace(/\$@spellaura\d+/gi, "关联光环效果")
    .replace(/\$\?[^[]*\[([^\]]*)]\[([^\]]*)]/gi, "$1")
    .replace(/\$\[[^\]]*]/g, "")
    .replace(/\$[0-9]*a\d+码/g, "一定范围")
    .replace(/\$[0-9]*s\d+%/g, "一定比例")
    .replace(/\$[0-9]*s\d+点/g, "")
    .replace(/\$[0-9]*t\d+秒/g, "一段时间")
    .replace(/\$[0-9]*d/g, "一段时间")
    .replace(/\$[0-9]*[saw]\d*/g, "一定数值")
    .replace(/\$[0-9]+/g, "")
    .replace(/\$[A-Za-z0-9]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "数据库未提供独立文字说明；该条目是关联技能或子效果。";
  return text;
}

function escapeTable(value) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function actionFor(encounterId, skill) {
  const match = (actions[encounterId] ?? []).find(([pattern]) => pattern.test(skill));
  return match?.[1] ?? "数据库记录的关联技能或子效果；随所属主技能处理，实战确认是否需要独立应对。";
}

const startMarker = "<!-- DB_SKILLS_START -->";
const endMarker = "<!-- DB_SKILLS_END -->";

for (const boss of bosses) {
  const bossRows = rows.filter((row) => row.encounterId === boss.encounterId);
  const tableRows = bossRows.map((row) => {
    const description = cleanDescription([row.description, row.aura].filter(Boolean).join(" "));
    const action = actionFor(boss.encounterId, row.skill);
    return `| ${row.spellId} | \`${escapeTable(row.skill)}\` | ${escapeTable(description)} | ${escapeTable(action)} |`;
  });

  const appendix = [
    startMarker,
    "",
    `> 数据源：\`wow-db/output/wow.sqlite\`；筛选英雄团队难度（编号 15），按技能编号去重，共 ${bossRows.length} 项。数值变量按游戏内当前版本为准。`,
    "",
    "| 技能编号 | 中文技能名 | 数据库机制说明 | 已知应对 |",
    "|---:|---|---|---|",
    ...tableRows,
    "",
    endMarker,
  ].join("\n");

  const guidePath = resolve(scriptDir, boss.folder, "initial-guide.md");
  const guide = readFileSync(guidePath, "utf8");
  const startIndex = guide.indexOf(startMarker);
  const endIndex = guide.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`${guidePath} 缺少数据库技能标记`);
  }

  const updated = `${guide.slice(0, startIndex)}${appendix}${guide.slice(endIndex + endMarker.length)}`;
  writeFileSync(guidePath, updated, "utf8");
  process.stdout.write(`${boss.folder} ${boss.name}: ${bossRows.length} skills\n`);
}
