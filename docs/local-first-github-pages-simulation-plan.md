# 本地优先 GitHub Pages 与匿名模拟申请计划

> 状态：最终协议冻结评审候选稿，尚未进入实施。本文只定义目标协议；在协议 review 通过前，不修改应用代码、不创建 Cloudflare/Pages 资源、不启用公网申请。

## 1. 方案结论与权威边界

生产权威环境固定为管理员本机：

```text
Windows 游戏环境导出 wow-db
  -> Ed25519 签名的版本化交接包
  -> GitHub Release 传输
  -> 管理员本机以固定公钥验签并导入

管理员本机完整版应用
  -> 唯一可写业务 SQLite
  -> 统一 SimC 调度器
  -> 生成公开 DTO 快照
  -> GitHub Pages

游客
  -> 浏览 GitHub Pages
  -> 匿名提交申请到 Cloudflare Worker/D1
  -> 本机 Worker 主动领取并送入统一调度器
  -> 结果回写 Worker
```

本机不开放公网入站端口。GitHub Pages 只保存可重建的脱敏快照；D1 只保存短期任务、脱敏结果及最小控制面 ledger/index，不保存业务权威数据。二者都不是业务主库。

当前仓库固定为：

- 仓库：`https://github.com/zoroperona/wow-helper`
- GitHub 身份：个人账号 `zoroperona`，不是公司账号
- 本地提交身份：`zoroperona <zoroperona@users.noreply.github.com>`
- remote：`git@github.com:zoroperona/wow-helper.git`

提交、Push、Release、Pages、Actions 和 SSH 不得使用公司账号、公司邮箱或公司凭据。首次 commit/Push 前仍须复核上述值和忽略文件。

## 2. 版本与数据库边界

| 数据 | 权威位置 | GitHub 用途 |
|---|---|---|
| `loot-allocator.sqlite` | 管理员本机 | 永不提交；只通过独立备份系统保护 |
| `wow.sqlite` | 管理员本机只读资产 | 数据库不进 Git；签名压缩包经版本化 Release 传输 |
| schema/migration | Git | 代码审查和版本管理 |
| 公开快照 | Pages artifact | 脱敏、可重建、可回滚 |
| 匿名任务/结果 | D1 | 短期中转，不回流为业务权威数据 |
| D1 控制面 ledger/index | D1 + Git 中的 migration | 版本化 schema、状态门禁与可信 artifact 索引，不包含业务主库数据 |

Git 不是 SQLite 备份系统。GitHub Release Asset 可替换或删除，只可作为 wow-db 分发渠道或业务备份的第三份传输副本，不能单独承担真实性、不可变性或灾备；wow-db 来源真实性必须来自独立签名和本机固定信任根。

应用版本使用 SemVer Tag，初始版本为 `0.1.0`，发布 Tag 形如 `v0.1.0`。页面必须显示应用版本、publication revision 和 wow-db Build。

### 2.1 本机 migration 契约

业务 schema 只允许通过仓库内版本化 migration 向前升级。migration 文件名固定为 `<sequence>_<name>.sql|mjs`，`migrationId` 等于 sequence；首次进入该体系时，必须先核对现有 schema 5 的结构指纹并写入不可修改的 `0005_baseline`。已合并或执行过的文件禁止修改、替换、删除或复用 ID，checksum 为文件原始 bytes 的 SHA-256。

业务库使用 `schema_migrations` 保存成功基线，使用 `migration_attempts` 追加记录每次执行的 `attemptId`、migrationId、checksum、from/to schema、`running/success/failed/unknown`、开始/结束时间、升级前后结构指纹和验证结果。状态规则如下：

1. runner 取得全局维护锁、停止 Web/Worker/定时任务并确认无 SQLite 打开者；应用自身必须 `AUTO_MIGRATE=0`，schema 不匹配时 fail closed。
2. runner 先在独立短事务中写入 `running` attempt，再以 `BEGIN IMMEDIATE` 执行单个 migration；禁止 migration 调用网络、文件系统或其他不可事务回滚的外部副作用。
3. schema/data 变更、`schema_migrations` success 行和 attempt 的 `success` 必须在同一事务提交。成功记录不可修改。
4. SQL/runner 报错时先 rollback，再验证升级前结构指纹、关键表数量和 `quick_check`；全部恢复才在新事务把 attempt 标为 `failed`。验证不完整、进程崩溃遗留 `running`、checksum 不符或发现部分结构时标为/视为 `unknown`。
5. `running`、`unknown`、checksum 冲突或部分执行状态一律禁止启动新旧应用，必须恢复发布前 verified 备份或经人工取证证明状态后处理。不得猜测继续执行或 schema 降级。
6. `failed` 仅在已证明完整 rollback 后允许使用相同 migrationId 和相同 checksum 创建新的 attempt；禁止覆盖旧 attempt。`success` 重跑只能验证 checksum 后 no-op。

每个应用版本 N 的 CI 必须验证：N 对升级前 schema 能执行只读预检；migration 后 N 可正常读写；N-1 对升级后 schema 和新数据语义仍可安全读写。migration 采用 expand/contract，破坏性 contract 至少延后一版。若 N/N-1 任一兼容测试失败，或 N 已写入 N-1 无法理解的数据，则升级后故障不能只回退应用，必须停写并恢复发布前业务库；只有兼容门禁通过且尚无不兼容写入时才允许应用 N -> N-1 回退而保留升级后数据库。

## 3. 唯一本机主库的灾备契约

### 3.1 备份拓扑

正式启用前必须建立 3-2-1 备份：

1. 本机在线主库一份。
2. 独立物理磁盘上的加密备份仓库一份。
3. 与本机不同故障域的加密异地仓库一份。

建议可变备份仓库使用版本锁定的 `restic`；异地后端可在实施前从个人云盘、S3 兼容对象存储或 NAS 异地节点中选择，但“异地目标未选定或未完成恢复演练”是上线阻断项。两个备份目标中至少一个还必须满足以下任一条件：把独立加密备份 bundle 写入 WORM/Object Lock 对象且保留期不少于 30 天，或使用备份完成后物理断开的离线介质。不能未经验证就把需要创建/删除锁文件和 prune 的 restic 仓库直接放进 Object Lock；实施时必须单独验证工具兼容性，或采用“可变 restic 仓库 + 不可变加密 bundle”组合。普通可删除仓库、同步盘回收站和 GitHub Release Asset 都不满足不可变副本要求；GitHub Release Asset 只能作为额外副本。

### 3.2 生成流程

定时任务每 12 小时自动执行（本地计划为 03:15 和 15:15）；应用升级、migration、wow-db/赛季切换和大批量导入前额外执行一次：

1. 获取全局维护锁；允许 Web 读取，但备份窗口内禁止 schema 变更。
2. 使用 SQLite Backup API 生成到临时目录，不复制活跃主库/WAL/SHM。
3. 对快照执行 `PRAGMA quick_check`，结果必须为 `ok`。
4. 记录 schema、应用版本、commit、生成时间、源库路径标识、关键表行数、文件 bytes 和 SHA-256。
5. 上传前生成不可变 `backup-manifest/v1`；它只描述备份内容和预期目标，不包含尚不存在的仓库 snapshot/object ID 或上传验证结果。
6. 将快照和 manifest 作为同一个备份单元写入两个加密仓库，并取得各自的 snapshot/object ID。
7. 从两个目标读回并校验 manifest hash、快照 bytes/SHA-256 和 `quick_check` 结果。
8. 上传后生成独立的追加式 `verification-receipt/v1`，记录 manifest SHA-256、两个仓库 locator、验证时间和结果；同一 receipt bytes 再以新对象写入两个仓库，但 receipt 自身不记录自己的仓库 locator，避免再次形成循环。
9. 从两个目标分别读回 receipt，确认 bytes/SHA-256 完全一致，且 receipt 内两个目标均验证成功后，备份才派生为 `verified`。只在一个目标存在 receipt、两个 receipt bytes 不同或任一目标无法读回，都不是 verified。

manifest 和 receipt 都是不可变追加式记录：`backupId`、`receiptId` 和对象名不得覆盖。manifest 至少包含 `backupId`、内容快照时间 `generatedAt`、生成原因、应用版本、commit、schema、源库逻辑标识、关键表数量、原文件 bytes/SHA-256、`quickCheck` 和预期目标标识。receipt 至少包含 `receiptId`、`backupId`、manifest SHA-256、每个目标的仓库标识与 snapshot/object ID、读回时间、最终双目标验证时间 `verifiedAt`、读回 bytes/SHA-256、验证结果和验证器版本。仓库凭据、restic password 和恢复密钥不写入两者、Git 或普通日志。

### 3.3 灾备凭证清单、密钥与保留

- restic password 保存在管理员密码管理器；另存一份离线密封恢复副本。
- 建立独立加密的 `disaster-recovery-inventory/v1` 元数据清单和配套秘密包。清单不含秘密明文，只记录资产名称、用途、版本/epoch、秘密包 locator/SHA-256、恢复负责人和轮换/过期时间；秘密包使用独立灾备密钥加密，实际包含受保留 revision 所需的每赛季随机 `publicPlayerKey` 映射 artifact/keyVersion，以及幂等 tombstone 的历史 HMAC digest key。清单还覆盖 executor/publisher 强制轮换授权、Cloudflare 账户/Worker/D1 恢复入口、GitHub `zoroperona` 管理访问和个人 SSH key 恢复方式、应用/Node/SimC 固定版本、wow-db Build、Task Scheduler XML/脚本 hash、私有 simulation-input artifact 及其加密密钥引用。
- 灾备清单本身使用独立恢复密钥加密，至少两名受信任恢复人或两处物理位置分别保管恢复材料；清单不进入 Git、Pages、D1 或普通业务库备份。恢复时优先强制轮换 executor/publisher 和 Cloudflare/GitHub 短期凭证，不要求把旧运行凭证直接搬到替代电脑。
- 每季度验证离线副本确实能打开两个仓库；密钥轮换必须先验证新旧密钥和旧备份可读。
- 保留策略：14 个每日、8 个每周、12 个每月恢复点；清理后运行仓库一致性检查。不可变目标在锁定期内禁止 prune，锁定到期后的清理由独立保留凭据执行，日常备份写入凭据不得拥有删除或缩短保留期权限。
- 目标 RPO：正常故障不超过 24 小时；实际备份周期为 12 小时，并在 RPO 失守前 fail closed。高风险变更不超过变更开始前的 verified 备份时间。
- 目标 RTO：4 小时内在同机隔离目录恢复；8 小时内在替代电脑恢复。
- 每月恢复到隔离目录并核对 `quick_check`、SHA-256、schema 和关键表数量；每季度在替代电脑完成完整服务恢复演练：恢复业务库、应用版本、wow-db、SimC、Task Scheduler、私有 simulation-input、publicPlayerKey 历史 key，并验证新凭证轮换后能发布静态页、领取/回写 canary 任务。若只恢复数据库而未恢复上述运行资产，不得宣称达成 8 小时完整服务 RTO。
- 实际 RPO/RTO、失败和密钥验证写入 [操作日志](operations-log.md)。

### 3.4 恢复顺序

停止 Web、每日任务、本机 Worker 和统一调度器；按目标操作系统终止完整 SimC 进程树并确认没有 SQLite 打开者。保存事故现场副本后，从选定恢复点解密到临时目录，核对 manifest、覆盖两个目标的 verification receipt、hash、`quick_check` 和 schema，再原子替换主库。随后按灾备凭证清单恢复运行资产，强制轮换服务凭证，重新生成/验证 publication 和私有 simulation-input，再原子开启申请。旧 WAL/SHM 只能在确认所有访问者退出后处理。恢复后核对关键表、管理员操作、公开快照和一条测试模拟；明确记录损失时间窗口。

## 4. 公开快照与隐私

### 4.1 Worker 服务认证与权限域

公网接口采用默认拒绝，严格分为三个互不兼容的权限域：

| 权限域 | 允许操作 | 凭证与限制 |
|---|---|---|
| 游客 | 创建申请；用自己的查询凭证读取状态/结果 | 无服务凭证；查询只接受 requestId + querySecret，不能领取、续租、回写或管理 publication |
| 本机执行 Worker | 领取任务、`leased -> running`、heartbeat、完成/失败回写 | 独立 `executor` 服务凭证；只允许队列执行端点，不能 staged/activate publication、改 key 清单或读取其他游客结果 |
| 本机发布器 | staged key 清单、activate/rollback publication、关闭/开启申请 | 独立 `publisher` 服务凭证；不能领取、续租或回写模拟结果 |
| 本机备份验证器 | 报告新的双目标 verified backup | 独立 `backup-monitor` 服务凭证；只能新增备份 receipt 状态，不能修改队列、publication 或模拟结果 |

`executor`、`publisher` 和 `backup-monitor` 凭证必须分别生成、存储和轮换，不共用管理员 GitHub Token、Cloudflare API Token 或游客查询 secret。每个权限域使用独立的 256 bit HMAC secret：本机保存在 OS 凭据库，Cloudflare 端保存在加密 Worker Secret，不写入 D1；D1 只记录不可变 `credentialId`、scope、创建/过期时间、状态和 `credentialEpoch`。

签名算法固定为 HMAC-SHA-256。签名前先将 body 原始 bytes 计算小写 hex SHA-256；path 使用 RFC 3986 规范化后的绝对路径，不包含 scheme/host/query/fragment，不解码后再编码，也不允许重复斜杠或 dot-segment。canonical signing bytes 固定为 UTF-8、LF 换行、末尾无额外换行：

```text
WOWHELPER-HMAC-V1
<UPPERCASE_HTTP_METHOD>
<canonical_path>
<credentialId>
<credentialEpoch_decimal>
<restoreEpoch_decimal>
<unix_timestamp_seconds>
<nonce_base64url_no_padding>
<body_sha256_lower_hex>
```

请求头必须显式携带上述非 method/path/body 字段和签名；query string 对控制端点一律拒绝。服务端先要求请求 `restoreEpoch` 同时匹配外部 SafetyGate 和 D1，再按 credentialId/scope/credential epoch 和对应 Worker Secret 验签，允许最大 5 分钟时钟偏差并原子记录 `(credentialId, credentialEpoch, restoreEpoch, nonce)` 到凭证过期/至少 10 分钟，防止重放。全链路只允许 HTTPS，日志只记录 credentialId/epoch 和结果，不记录 secret、签名或请求正文。

轮换采用短暂双凭证窗口：先创建新 credentialId，部署并验证新凭证，再撤销旧凭证；正常重叠不超过 15 分钟。凭证疑似泄漏时立即提升对应 epoch 并撤销该权限域全部旧凭证，不影响另一权限域或游客已有 querySecret。Cloudflare 部署 Token 只用于部署代码/migration，不作为运行时 publisher 凭证。所有路由必须有 scope 单元测试和“错误权限域返回 403”的集成测试。

### 4.1.1 本机管理认证边界

`127.0.0.1` 只是网络暴露边界，不是管理员身份；同机任意进程都可尝试请求 loopback API。本地 UI 的游客/只读视图可以无管理会话，但任何修改成员、装备、规则、分配、删除记录、修改赛季、手动模拟、备份/恢复、发布或配置的端点都必须先通过后端管理认证与授权，前端隐藏按钮不构成权限。

第一阶段固定为单管理员密码模式：首次 bootstrap 只能在交互式 `wowhelper-runtime` 会话通过仓库内 CLI 从 console 读取密码，使用 Argon2id（至少 64 MiB memory、3 iterations、parallelism 1、16 byte 随机 salt）保存 verifier，256 bit pepper 只存 Windows Credential Manager。密码不进入命令行、环境变量、Git 或日志。登录失败按指数退避并审计；忘记密码只能在停服、已验证备份和本地交互式控制台下重置，重置后撤销全部会话并写操作日志。

登录成功后只生成内存中的 256 bit 随机 session，服务重启全部失效；闲置 30 分钟、绝对 8 小时过期。本地 Web 入口必须使用回环 HTTPS 和受 ACL 保护的本机证书，Cookie 使用 `Secure; HttpOnly; SameSite=Strict; Path=/` 且不进入备份；每个 mutation 另验证会话绑定的 CSRF header/origin，拒绝非精确 loopback Origin。定时任务和 wrapper 不复用浏览器 session，只能经 ACL 限定为 `wowhelper-runtime` 的 Windows named pipe 或独立 Credential Manager service secret 调用最小权限本机接口。本机管理员凭据无法防御已控制该 Windows 用户的恶意软件，该情形属于主机失陷并进入灾备/密钥轮换流程，不把 loopback 当作补救控制。

### 4.2 公开 DTO

发布器必须逐字段构造专用 DTO，禁止从内部对象展开后再删除字段。成员默认不公开；本机业务库保存版本化公开授权，只有当前赛季明确 `opt-in` 且未撤回的成员可以进入成员级 DTO。公开范围仅包含：

- 当前 active season 的职业/职责、5 装等一级的区间、收益区间和分配汇总。
- 赛季内稳定、跨赛季不稳定的随机脱敏成员标识及降精度模拟摘要。
- 页面运行所需的版本和构建信息。

递归禁止字段至少包括：真实角色名、服务器、内部 player/member/allocation ID、完整装备/附魔/宝石组合、精确装等、精确 DPS、原始 profile、SimC HTML/日志、备注、外部账号、管理员审计、会话和非当前赛季数据。DPS 只发布 5% 区间或不小于 5000 的桶，收益只发布 0.5 百分点区间，事件时间降为 `Asia/Shanghai` 自然日或赛季周；分配记录不发布精确时分秒。嵌套对象、数组和动态 key 都必须扫描。

`publicPlayerKey` 是公开标识，不是认证凭证。正式方案使用每赛季独立的 128 bit 随机映射，不使用可跨赛季推导的稳定 HMAC；同一赛季内稳定并记录 `keyVersion`，新赛季必须生成新 key。成员撤回授权后，下一 publication 删除其成员级 DTO、拒绝新申请并使对应 public key 进入仅完成旧任务的 retained 状态；旧 key 至少保留到旧任务和结果到期，随后按 revision 删除门禁清理。

小型团队无法仅靠假名彻底消除再识别风险，因此公开授权必须明确告知：职业/专精、装备区间、收益和分配周仍可能与 Armory、战斗日志或社群信息关联。每个赛季首次发布前及 DTO 字段变化时执行一次重新识别审计：使用公开 Armory/日志尝试关联，任何组合能把成员缩小到少于 3 个候选时，继续分桶或抑制该成员字段；无法降到可接受范围时只发布团队聚合。

成员退出/撤回触发 privacy purge，而不是只发布下一版：立即关闭其新申请并从当前构建、本机 active/retained 回滚集合和所有待发布 bundle 移除成员明细；发布一份不携带含该成员旧 revision 的完整 Pages artifact，使所有已知 `/revisions/<old>/...` 路径从当前站点返回 404/410。随后通过 GitHub API 按 publication/revision/run/deployment 索引删除可控的 Actions artifact、Draft Release asset/Release，停用并在平台允许时删除旧 `github-pages` deployment 记录；撤销这些 revision 的回滚资格和 public key，只为已有未终态任务保留最小私有 input 到统一删除门禁。purge manifest 必须列出所有已知 revision URL、deployment ID、workflow run/artifact ID、Release/asset ID 及删除/不可删除结果，并在无缓存、cache-busting 请求下连续验证。若任何 GitHub 自有旧 URL 或 artifact 在 24 小时后仍可访问，保持游客申请关闭并暂时停用整个 Pages site，提交 GitHub 支持请求；第三方缓存、下载或截图仍无法保证删除，这一限制必须在授权时披露。

CI 必须：

- 对所有公开 fixture 递归扫描禁止字段和内部 ID 格式。
- 验证 DTO schema，禁止未知字段。
- 检查生成物中没有 SQLite、profile、日志、source map 秘密或本机路径。
- 对授权、跨赛季 key 变化、数值/时间分桶、少于 3 个候选的唯一组合和成员撤回建立 fixture 与 CI 门禁。
- 在第一次公开发布前审计旧 Pages 仓库、Actions artifact 和 Git 历史；如曾泄漏，删除部署、重写公开仓库历史并轮换 pseudonym key。仅发布新版不能消除历史泄漏。

### 4.3 GitHub Actions Pages artifact 发布

唯一正式发布路径固定为“本机构建与签名 -> GitHub Draft Release 临时 ingress -> 当前 `zoroperona/wow-helper` 仓库 GitHub Actions 验签 -> Pages artifact deployment”。Actions runner 不读取业务 SQLite，也不生成业务 DTO；Draft Release 只是可变的短期传输通道，不是真实性或不可变信任根。独立 Pages 仓库和直接 `git push` 不是生产路径。协议 review 通过后，第一个且独立的 implementation safety commit 必须删除 `package.json` 的 `pages:publish`、移除或改成硬失败的 `scripts/deploy-pages.mjs`、撤销旧 Pages repo/push 凭证，并新增 CI denylist，拒绝重新出现这些命令、文件、目标 remote 或旧凭证名；该 commit 验收前不得开始其他阶段 2 工作、创建云资源或运行 publication。紧急发布同样不能恢复旧路径。

artifact 内所有业务数据使用内容寻址路径 `/revisions/<publicationRevision>/...`，并包含当前 active 和前 2 个 retained revision；根页面只保留稳定 loader。revision 下 `content/` 内已有 bytes 永不覆盖，`signatures/<signatureSha256>.json` 只能按新 hash 追加。loader 以 `Cache-Control: no-store` 的 Worker current-publication 响应选择 revision 及 current signature hash，随后校验 `publication.json` 和对应签名；Worker 不可用或 revision/hash 不匹配时只显示最后已验证的静态内容并禁用申请。

构建与发布顺序固定为：

1. 从 SQLite Backup API 快照或同一只读事务生成全部 JSON。
2. 在新的临时目录构建，任何文件都不直接写入当前 `pages-dist`。
3. 生成 `publication.json`，至少包含：
   - `publicationRevision`、`generatedAt`
   - 应用版本、commit、业务 schema、wow-db Build
   - `seasonId`、`publicPlayerKeyVersion`
   - 每个公开文件的相对路径、bytes 和 SHA-256
4. 按 4.3.1 生成 revision identity 和 detached Ed25519 signature，并把签名文件写入 `signatures/<signatureSha256>.json`。
5. 按 4.3.2 仅打包公开 allowlist 内容、ingress manifest 和签名，上传唯一命名的 Draft Release assets，然后用签名 hash 触发 `workflow_dispatch`。
6. Actions 在解压前校验 asset ID/name/bytes/SHA-256、ingress manifest、revision identity 和 Ed25519 签名，递归禁止 SQLite、私有 simulation-input、密钥、profile、日志和未知文件。通过后才使用固定 commit SHA 的 `actions/upload-pages-artifact` 上传单一 Pages artifact。
7. deploy job 使用固定 commit SHA 的 `actions/deploy-pages` 取得唯一 Pages deployment ID，再用 cache-busting URL 连续 3 次读取目标 revision 的 `publication.json`、current signature 及全部清单 hash；最长等待 10 分钟。
8. 只有可见性验证成功后才切换 D1 active pointer。部署或验证失败时 D1 保持旧 active，并立即重新部署上一份已验证 artifact；新页面即使短暂可见，也因 revision 仍为 staged 而不能提交申请。

Actions artifact 保留期固定为 90 天；本机不可变 revision bundle 仍按 active + 前 2 个成功 revision 和任务保留门禁保存，不能只依赖 GitHub retention。回滚 job 只接受已在 D1 signature history 和本地灾备索引中的 artifact hash，重新上传完整历史 bundle、部署并完成相同可见性验证后，最后切换 D1 pointer。任何 workflow rerun 都创建新 deployment 记录，不覆盖旧 artifact 或审计。

#### 4.3.1 Detached artifact signature

内容身份固定为 RFC 8785 canonical `publication-identity/v1` JSON，字段为 `identityVersion`、`publicFilesManifestSha256`、`simulationInputManifestSha256`、`applicationVersion`、`commit`、`schema`、`wowDbBuild`、`seasonId`、`publicPlayerKeyVersion`、`generatedAt`。`publicFilesManifest` 逐项覆盖除签名目录外的全部公开内容；私有 simulation-input 只以 manifest SHA-256 绑定，不进入公开 bundle。`publicationRevision` 固定为 `pub-v1-<64 lowercase hex SHA-256(identity canonical bytes)>`，不截断。完全相同 identity 重试可复用 revision；任一内容、私有输入 manifest、`generatedAt` 或 key version 变化都生成新 revision。如已存在同 revision 但 identity bytes/hash 不同，按碰撞或篡改 fail closed，不覆盖。

在线 executor/publisher HMAC 只认证 API 请求，不用于离线 bundle 验证。每个 revision bundle 必须额外生成不可变的 `artifact-signature/v1`，签名算法固定为 Ed25519；当前签名私钥保存在 OS 凭据库及灾备加密秘密包中，历史私钥不作为普通回滚依赖且轮换完成后销毁。签名公钥注册表同时保存在 D1 和灾备凭证清单中，每个版本记录 `keyId`、`keyVersion`、public key、`validFrom`、`validUntil`、`status=active|retired|revoked`、`revokedAt`、`revocationReason` 和可空的 `compromisedFrom`；历史公钥至少保留到全部关联 revision、回滚窗口和审计保留期结束。

签名覆盖的 payload 是 RFC 8785 canonical JSON（UTF-8、无 BOM、无尾部换行），字段固定为：`signatureVersion`、`publicationRevision`、`revisionIdentitySha256`、`contentBundleSha256`、`publicationJsonSha256`、`publicFilesManifestSha256`、`simulationInputManifestSha256`、`applicationVersion`、`commit`、`schema`、`wowDbBuild`、`seasonId`、`generatedAt`、`signedAt`、`expiresAt`、`keyId`、`keyVersion`。`artifact-signature/v1` 另外包含 `payload`、`canonicalization`、`algorithm` 和 base64url 无填充的 `signature`；验证器必须拒绝未知字段、canonical bytes 或 hash 不匹配、`signedAt` 不在 key 有效期内，或已超过 `expiresAt`。签名有效期必须覆盖该 revision 的计划回滚保留期并至少为 90 天。

签名文件先完整生成 bytes，再以整个文件的 SHA-256 作为 `signatureSha256` 和文件名 `signatures/<signatureSha256>.json`。该路径已存在时只允许 bytes 完全相同的 no-op，禁止使用固定文件名覆盖。同 revision 重签只追加新路径并更新 D1 current pointer，不改变 revision identity 或已有内容/签名 bytes。

key 生命周期和紧急回滚语义固定如下：

- 正常轮换把旧 key 标为 `retired`，不撤销其历史签名；`signedAt` 位于该 key 有效期且 bundle 未过期时仍可验证。
- 疑似泄漏时将 key 标为 `revoked` 并记录 `compromisedFrom`。`signedAt >= compromisedFrom` 的签名一律拒绝；更早签名只有在该 bundle 的 artifact/manifest/signature hash 已于 `revokedAt` 之前写入 D1 trusted publication history，且能与灾备清单中的历史索引交叉验证时才可继续用于回滚。没有可信 `compromisedFrom` 时按该 key 的全部签名不可信处理。
- 无法建立上述历史信任时，禁止直接使用旧签名。publisher 只能从不可变备份或本地已验证 revision bundle 重建并核对已受信任的 artifact/manifest hash，再用当前 active key 生成新的 detached signature；若连 bundle hash 也无法建立信任，则进入人工灾备信任锚流程，不得以可用性为由绕过验签。
- 重新签署生成新的不可变 signature 文件，向 `publication_signature_history` 追加新行并把 current pointer 切向它；旧文件、旧历史行及撤销审计永久保留。正常 rollback 不需要历史私钥。

CI 必须覆盖正常轮换、retired key 回滚、泄漏后撤销前可信签名、`compromisedFrom` 之后签名拒绝、过期后重新签署和无法建立信任时 fail closed。

#### 4.3.2 本机 artifact ingress

本机 publisher 只从新建的 staging 目录和显式 allowlist 打包，不允许从 workspace 或数据盘根目录递归打包。上传包只包含完整公开 Pages tree、`publication-identity/v1.json`、`ingress-manifest/v1.json` 和对应 signatures；私有 simulation-input 只留在本机加密 revision bundle，上传包只出现其 manifest SHA-256。打包前和 Actions 解压后都必须递归拒绝 SQLite/WAL/SHM、simulation-input bytes、`.env`、profile/Cookie、密钥、日志、source map、绝对路径、符号链接、未知文件类型和 path traversal。

`ingress-manifest/v1` 使用 RFC 8785 canonical JSON，至少包含 revision、revision identity/publication/public files/simulation-input manifest/content bundle/signature 的 SHA-256，完整 asset 名、bytes/SHA-256，源 commit，生成时间和 publisher key version，并由同一 publication Ed25519 key 签署。压缩包必须确定性生成（规范路径顺序、固定时间/权限元数据），以便本机和 Actions 得到相同 hash。

传输顺序固定为：

1. 本机先完成私有 simulation-input、公开 content、identity、签名和 ingress manifest 的本地验证，然后创建唯一 Draft Release/tag `pages-ingress/<publicationRevision>/<ingressManifestSha256>`；同名 Release、tag 或 asset 已存在时只允许所有 ID/bytes/hash 相同的幂等重试，禁止删除后替换。
2. 使用两个独立、仅授权 `zoroperona/wow-helper` 且最长 30 天过期的 fine-grained PAT：`pages-ingress-uploader` 只有 Contents read/write，`pages-ingress-dispatcher` 只有 Actions read/write。两者仅保存在 Windows Credential Manager，不进入环境文件、Git、workflow input 或日志；每 30 天轮换，丢失/泄漏立即撤销。
3. 上传唯一命名的 bundle/manifest/signature assets 后读回 GitHub asset ID、bytes 和 digest；再触发 `publish-pages.yml` `workflow_dispatch`，input 只包含 Draft Release ID/tag、asset IDs、revision 和预期 hash，不包含业务数据或秘密。
4. workflow 只接受存在于受保护 `main` 的源 commit，使用仓库中 pinned publication 公钥和 D1 signing registry 读模式交叉验证。任一 ID/name/hash/signature/revision/commit 不一致都拒绝，不上传 Pages artifact。
5. 部署成功后 Draft Release/assets 保留 30 天作为传输审计，再由独立 retention workflow 删除；本机不可变 revision bundle 和 Actions artifact 仍按更长规则保留。上传失败可幂等重试，不得改为提交生成数据到 Git。

#### 4.3.3 GitHub Actions 供应链与前置条件

目标仓库在第一阶段固定为个人账号 `zoroperona` 下的 public repository；转为 public 是后续需管理员明确确认的外部操作，本轮不执行。全部 tracked source/docs/history 必须按公开信息审查；如不同意仓库公开，则必须先确认个人账号的 private Pages 资格并重新 review，不得默认能用。实施前必须用实际账号验证 Pages 资格、Actions minutes/storage、artifact/Pages 尺寸和部署频率限制，任一超限都保持旧 Pages 并关闭申请，不绕过 workflow。

workflow 约束固定为：

- 所有第三方 Actions 包括 GitHub 官方 Actions 均锁定完整 40 位 commit SHA，Dependabot 或人工 PR 单独升级并审查 release provenance，禁止 `@main`/浮动 Tag。
- workflow 顶层 `permissions: {}`；ingress/verify job 只有 `contents: read`，Pages deploy job 只有 `pages: write` 和 `id-token: write`，其他 job 无 write permission。本机 PAT 不传入 runner，Actions `GITHUB_TOKEN` 不下发本机。
- `main` 启用 PR review、required CI 和禁止 force-push/delete；发布 workflow 文件和 action pin 变更需 CODEOWNERS 审查。`github-pages` Environment 只允许受保护 `main`，reviewer 固定为个人账号 `zoroperona`，且必须在 ingress 验签 job 成功后才可批准 deploy。
- `pages-production` concurrency group 覆盖新发布与回滚，`cancel-in-progress=false`；workflow rerun 仍重做全部 ingress 验签和 Environment 审批。artifact 下载只限同 workflow 的明确 artifact ID/run ID，禁止按“最新同名”选择。
- GitHub 故障、额度用尽或 Pages 限流时，人工操作只能重试同一已签名 ingress 或通过同 workflow 重部署上一已验证 bundle；禁止直接 push Pages、修改 D1 pointer 或跳过签名校验。

### 4.4 Pages 与 Worker 两阶段切换

1. 将新 revision 的有效 `publicPlayerKey` 清单写入 D1，状态为 `staged`。
2. 按 4.3 节上传、部署并验证完整 Pages artifact/deployment ID。
3. 原子地把新 revision 设为 `active`，上一 revision 进入 30 分钟 `grace`。
4. 页面调用 Worker 的 current-publication 接口；只有嵌入 revision 为 `active/grace` 时才启用申请按钮。
5. grace 到期后旧 revision 只是不再接受新申请，状态改为 `retained`；不得据此删除有效 key 清单或私有 simulation-input。

任一步失败都保持旧 revision active；若新 Pages deployment 已可见但 D1 未切换，loader 必须让申请 fail closed，并重新部署旧 artifact。回滚集合至少保留当前 active 和前 2 个成功 revision，且每个 revision 的本地已验证 Pages artifact、`publication.json`、有效 key 清单、私有 simulation-input 和 input hash 必须作为同一 revision bundle 保存。

revision bundle 只有同时满足以下条件才可删除：D1 中该 revision 的未终态任务数为 0；自最后一个任务进入终态后已超过最长任务窗口 24 小时；该 revision 不在 active/grace/staged 状态；不属于当前回滚集合；对应结果/审计保留策略不再要求其 keyVersion。清理顺序固定为：D1 条件事务再次核对全部门禁并写 `deletionApprovedAt`；删除本地 bundle；最后删除 D1 key 清单。任一步失败保持剩余资产并告警；没有 approval 时禁止删除任何一侧，任何情况下都禁止先删 D1 key 清单。

回滚时如果 D1 中旧 key 清单仍在 retained 状态，publisher 将其重新 staged；如果已清理，则必须从本地已验证 revision bundle 读取 `publication.json` 和 key 清单，重新校验所有 SHA-256 与 Ed25519 detached artifact signature 后上传为 staged。随后部署并验证旧 Pages artifact，最后原子切换 D1 active；切换前旧页面请求可能暂时 fail closed，但不得提前接受旧 revision 新申请。本地 revision bundle 缺失或校验失败时禁止回滚到该 revision。

## 5. 匿名申请与两个业务门槛

匿名申请不要求 GitHub 账号，也不采用 IP、浏览器、设备指纹、单角色冷却或 Turnstile 作为业务准入条件。只保留两个全局门槛：

| 门槛 | 契约 |
|---|---|
| 未终态队列 | `queued + leased + running` 最多 20；满时返回 `429 QUEUE_FULL` 和 `Retry-After` |
| 每日成功入队 | `Asia/Shanghai` 自然日配置值 `dailyLimit`；绝对上限 500 |

`dailyLimit` 仍是唯一的每日额度，不增加第三种限制。上线前以目标机器固定 preset 的 p95 实测耗时倒推：

```text
dailyLimit = min(500, floor(每日允许 SimC 秒数 × 0.70 / p95 单任务秒数))
```

基准至少覆盖 30 次代表性模拟，并为手动和每日任务保留 30% 容量。每次 SimC preset 或硬件变化后重测；未完成基准时公网申请保持关闭。队列 20 和每日计数必须在同一 D1 事务中检查并更新。

Cloudflare 的 HTTPS、请求体上限、仅允许 POST、固定 schema、WAF 和平台 DDoS 防护属于协议/基础设施保护，不改变这两个业务门槛。客户端只可提交公开 key、publication 元数据和固定 preset，不能提交 iterations、threads、flags、profile、路径、脚本或自由 JSON。

这是一个明确接受的产品可用性风险：攻击者可以发送格式合法、低速且使用随机 idempotency/query secret 的请求，消耗 20 个游客队列位置或当日游客额度，导致其他游客暂时无法申请。第一阶段不通过 IP、设备、账号、Turnstile 或单角色规则解决该问题，也不宣称 WAF 能阻止全部业务层滥用。

不改变两个业务门槛的缓解措施固定为：WAF/managed rules 只拒绝协议异常和已知攻击；监控每分钟入队速率、队列占满时长、dailyLimit 消耗斜率和来源 ASN 分布但不据此自动封禁合法请求；达到 5 分钟持续满队列、10 分钟消耗 25% 日额度或人工确认滥用时，只关闭游客创建/领取并保留静态浏览。管理员手动和每日任务始终在本机独立优先级队列运行，不消耗 D1 游客额度；攻击期间可以取消尚未运行的游客任务并提升 fencing，但不得伪造结果或清空审计。恢复游客申请必须人工确认队列、额度和告警。若实际运营表明该风险不可接受，必须重新做产品决策 review，而不是私下增加第三个用户门槛。

## 6. 幂等申请与查询凭证

### 6.1 创建申请

浏览器在发送前生成并本地保存：

- 128 bit 以上随机 `idempotencyKey`
- 256 bit 随机 `querySecret`

请求只发送 `querySecretHash = SHA-256(querySecret)`，不发送明文 secret。`payloadHash` 的输入对象固定为申请 JSON 的白名单字段 `seasonId`、`publicationRevision`、`keyVersion`、`publicPlayerKey`、`preset`；先按 UTF-8 RFC 8785 canonical JSON（禁止未知字段、数字统一为 JSON number、Unicode 不做本地化转换）计算 SHA-256 小写 hex。D1 对 `idempotencyKey` 建唯一约束，并在同一事务中执行，顺序固定为：

1. 先按 idempotency key 查找现有记录，不依赖当前 publication 状态。
2. 已存在且 payload hash、querySecretHash 都相同，返回原 `requestId` 和当前状态，不重复计数；即使原 publication 已结束 grace 也允许重试。
3. 已存在但 payload hash 或 querySecretHash 不同，返回 `409 IDEMPOTENCY_CONFLICT`，绝不泄漏原 requestId。
4. 只有不存在时，才验证 `seasonId + publicationRevision + keyVersion + publicPlayerKey` 属于 active/grace 清单。
5. 新申请再执行租约回收、检查队列和每日额度、创建任务并递增计数。

浏览器必须先持久化 secret/key 再发请求，所以响应丢失或双击可安全重试，并能找回同一 requestId。

### 6.2 D1 schema 与串行化合同

生产部署拆为两个 Worker service 和两个互相独立的 Durable Object namespace。公网 gateway 只有独立 `SafetyGate` DO binding 和指向 control service 的 service binding，没有 D1 或 `ControlPlane` namespace binding；独立 control service 承载 `ControlPlane` DO、独占其 namespace 和生产 D1 binding，不暴露普通公网路由。`SafetyGate` 使用唯一 ID `idFromName("wow-helper-safety-v1")`，在 D1 之外持久化 `mode=blocked|open`、单调 `restoreEpoch`、更新时间和恢复事件 ID；状态缺失、DO 不可用或 epoch 不匹配一律 fail closed。所有公网业务 mutation 先通过 SafetyGate open/openNotAfter 门禁，再由 gateway 完成外层 schema/认证并经 service binding 路由到 `ControlPlane` 唯一 ID `idFromName("wow-helper-control-v1")`；backup/recovery/close 等管理 mutation 也必须经过 gateway 的独立 scope、epoch 和审计校验，但允许在业务 gate blocked 时执行其固定 fail-close/恢复动作。本机执行器、publisher 和 backup verifier 也只能经 gateway 调用，不能直连 D1。

`ControlPlane` 在整个“校验 -> D1 read/batch -> 检查结果 -> 响应”期间持有 FIFO async mutex，禁止在 `await D1` 时处理第二个写操作。Cloudflare 配置审计必须证明只有 control service 拥有生产 D1 binding；在同一 Worker 脚本里仅靠代码约定“不直接写 D1”不满足隔离要求。

D1 是持久事实源，DO 内存不保存权威计数。DO 负责执行 D1 `batch()`（D1 保证 batch 内事务原子性）、检查 affected rows 并返回提交后的状态；D1 不可用、batch 失败或结果数量异常时 fail closed。所有 D1 写入都必须来自这一全局单写者；若未来拆分多个 DO，必须重新设计分片不变量并重新 review，不能沿用本合同。

初始化 DDL 固定如下（所有时间为 Unix seconds，所有 token/hash 为 lowercase hex 或 base64url 字符串）。bootstrap 必须在同一初始 migration batch 中向 `environment_identity` 插入且仅插入一行，值来自受审批 target manifest 的环境名、128 bit 随机环境 ID 的 SHA-256 和 account ID SHA-256；环境 ID 在同一环境的 D1 全丢失重建后保持稳定，但 staging/production 永不相同。实际 database ID 不写入这个随 export 恢复的不可变行，而由外部 target manifest/Environment 在每次 API 调用前硬校验；否则导入新 quarantine D1 会天然冲突。占位符不接受应用请求或 workflow input，缺行、多行或不匹配时 control service 在任何网络 mutation 前 fail closed：

```sql
PRAGMA foreign_keys = ON;
CREATE TABLE d1_schema_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  restore_epoch INTEGER NOT NULL CHECK (restore_epoch >= 0),
  mutation_mode TEXT NOT NULL CHECK (mutation_mode IN ('open','maintenance','blocked')),
  lock_attempt_id TEXT,
  lock_epoch INTEGER NOT NULL DEFAULT 0,
  maintenance_deadline INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_deadline >= 0),
  updated_at INTEGER NOT NULL
);
INSERT INTO d1_schema_state(singleton,schema_version,restore_epoch,mutation_mode,lock_attempt_id,lock_epoch,maintenance_deadline,updated_at)
VALUES(1,0,0,'maintenance',NULL,0,0,0);
CREATE TABLE environment_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  environment TEXT NOT NULL CHECK (environment IN ('local','staging','production')),
  environment_id_sha256 TEXT NOT NULL UNIQUE
    CHECK (length(environment_id_sha256) = 64 AND environment_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  account_id_sha256 TEXT NOT NULL
    CHECK (length(account_id_sha256) = 64 AND account_id_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL
);
CREATE TRIGGER environment_identity_no_update
BEFORE UPDATE ON environment_identity BEGIN
  SELECT RAISE(ABORT, 'ENVIRONMENT_IDENTITY_IMMUTABLE');
END;
CREATE TRIGGER environment_identity_no_delete
BEFORE DELETE ON environment_identity BEGIN
  SELECT RAISE(ABORT, 'ENVIRONMENT_IDENTITY_IMMUTABLE');
END;
CREATE TABLE d1_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  checksum_sha256 TEXT NOT NULL,
  from_schema INTEGER NOT NULL,
  to_schema INTEGER NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL,
  schema_fingerprint_sha256 TEXT NOT NULL
);
CREATE TABLE d1_migration_attempts (
  attempt_id TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  from_schema INTEGER NOT NULL,
  to_schema INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed','unknown')),
  recovery_point_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  pre_schema_fingerprint_sha256 TEXT NOT NULL,
  post_schema_fingerprint_sha256 TEXT,
  validation_json TEXT
);
CREATE TABLE requests (
  request_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  query_secret_hash TEXT NOT NULL
    CHECK (length(query_secret_hash) = 64 AND query_secret_hash NOT GLOB '*[^0-9a-f]*'),
  restore_epoch INTEGER NOT NULL,
  season_id TEXT NOT NULL,
  publication_revision TEXT NOT NULL,
  key_version TEXT NOT NULL,
  public_player_key TEXT NOT NULL,
  preset TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','leased','running','succeeded','failed','expired')),
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_hash TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  terminal_at INTEGER,
  query_secret_expires_at INTEGER NOT NULL,
  CHECK (
    (status IN ('succeeded','failed','expired') AND terminal_at IS NOT NULL)
    OR (status IN ('queued','leased','running') AND terminal_at IS NULL)
  ),
  CHECK (query_secret_expires_at > created_at)
);
CREATE INDEX requests_queue_idx ON requests(status, created_at);
CREATE INDEX requests_revision_idx ON requests(publication_revision, status);
CREATE TABLE daily_counters (
  day TEXT PRIMARY KEY,
  accepted_count INTEGER NOT NULL CHECK (accepted_count >= 0 AND accepted_count <= daily_limit),
  daily_limit INTEGER NOT NULL CHECK (daily_limit BETWEEN 0 AND 500),
  updated_at INTEGER NOT NULL
);
CREATE TABLE idempotency_tombstones (
  idempotency_digest TEXT PRIMARY KEY,
  digest_key_version TEXT NOT NULL,
  tombstoned_at INTEGER NOT NULL
);
CREATE TABLE service_credentials (
  credential_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('executor','publisher','backup-monitor')),
  credential_epoch INTEGER NOT NULL,
  restore_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE auth_nonces (
  credential_id TEXT NOT NULL,
  credential_epoch INTEGER NOT NULL,
  restore_epoch INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (credential_id, credential_epoch, restore_epoch, nonce),
  FOREIGN KEY (credential_id) REFERENCES service_credentials(credential_id)
);
CREATE TABLE artifact_signing_keys (
  key_id TEXT NOT NULL,
  key_version TEXT NOT NULL,
  public_key_base64url TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active','retired','revoked')),
  revoked_at INTEGER,
  revocation_reason TEXT,
  compromised_from INTEGER,
  PRIMARY KEY (key_id, key_version)
);
CREATE TABLE publication_signature_history (
  revision TEXT NOT NULL,
  signature_sha256 TEXT NOT NULL,
  signature_payload_sha256 TEXT NOT NULL,
  revision_identity_sha256 TEXT NOT NULL,
  content_bundle_sha256 TEXT NOT NULL,
  publication_json_sha256 TEXT NOT NULL,
  public_files_manifest_sha256 TEXT NOT NULL,
  simulation_input_manifest_sha256 TEXT NOT NULL,
  signature_key_id TEXT NOT NULL,
  signature_key_version TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  trusted_at INTEGER NOT NULL,
  PRIMARY KEY (revision, signature_sha256),
  FOREIGN KEY (revision) REFERENCES publication_revisions(revision),
  FOREIGN KEY (signature_key_id, signature_key_version)
    REFERENCES artifact_signing_keys(key_id, key_version)
);
CREATE TABLE publication_revisions (
  revision TEXT PRIMARY KEY,
  revision_identity_sha256 TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft','staged','active','grace','retained','deleted')),
  season_id TEXT NOT NULL,
  public_player_key_version TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  content_bundle_sha256 TEXT NOT NULL,
  publication_json_sha256 TEXT NOT NULL,
  public_files_manifest_sha256 TEXT NOT NULL,
  simulation_input_manifest_sha256 TEXT NOT NULL,
  current_signature_sha256 TEXT,
  signature_selected_at INTEGER,
  created_at INTEGER NOT NULL,
  grace_until INTEGER,
  deletion_approved_at INTEGER,
  CHECK (
    (current_signature_sha256 IS NULL AND signature_selected_at IS NULL)
    OR (current_signature_sha256 IS NOT NULL AND signature_selected_at IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('staged','active')
    OR (current_signature_sha256 IS NOT NULL AND signature_selected_at IS NOT NULL)
  ),
  FOREIGN KEY (revision, current_signature_sha256)
    REFERENCES publication_signature_history(revision, signature_sha256)
);
CREATE TABLE publication_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_revision TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (active_revision) REFERENCES publication_revisions(revision)
);
INSERT INTO publication_control(singleton,active_revision,updated_at) VALUES(1,NULL,0);
CREATE TABLE backup_receipts (
  backup_id TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  reported_at INTEGER NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL UNIQUE
);
CREATE TABLE system_gates (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  accepting_requests INTEGER NOT NULL CHECK (accepting_requests IN (0,1)),
  backup_id TEXT,
  backup_generated_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (backup_id) REFERENCES backup_receipts(backup_id)
);
INSERT INTO system_gates(singleton,accepting_requests,backup_id,backup_generated_at,updated_at)
VALUES(1,0,NULL,NULL,0);
CREATE TABLE public_keys (
  revision TEXT NOT NULL,
  public_player_key TEXT NOT NULL,
  key_version TEXT NOT NULL,
  PRIMARY KEY (revision, public_player_key),
  FOREIGN KEY (revision) REFERENCES publication_revisions(revision)
);
CREATE TRIGGER backup_receipt_guard BEFORE INSERT ON backup_receipts BEGIN
  SELECT CASE WHEN
    NEW.generated_at > NEW.verified_at
    OR NEW.generated_at > NEW.reported_at
    OR NEW.verified_at > NEW.reported_at + 300
    OR NEW.reported_at - NEW.generated_at > 79200
    OR NEW.reported_at - NEW.verified_at > 3600
    OR EXISTS (
      SELECT 1 FROM system_gates
      WHERE singleton = 1 AND backup_generated_at IS NOT NULL
        AND NEW.generated_at <= backup_generated_at
    )
    THEN RAISE(ABORT, 'BACKUP_REPORT_INVALID') END;
END;
CREATE TRIGGER backup_receipt_activate AFTER INSERT ON backup_receipts BEGIN
  UPDATE system_gates
  SET backup_id = NEW.backup_id,
      backup_generated_at = NEW.generated_at,
      updated_at = NEW.reported_at
  WHERE singleton = 1;
END;
CREATE TRIGGER publication_signature_history_no_update
BEFORE UPDATE ON publication_signature_history BEGIN
  SELECT RAISE(ABORT, 'SIGNATURE_HISTORY_IMMUTABLE');
END;
CREATE TRIGGER publication_signature_history_no_delete
BEFORE DELETE ON publication_signature_history BEGIN
  SELECT RAISE(ABORT, 'SIGNATURE_HISTORY_IMMUTABLE');
END;
CREATE TRIGGER publication_revision_identity_no_update
BEFORE UPDATE OF revision_identity_sha256, season_id, public_player_key_version,
  generated_at, content_bundle_sha256, publication_json_sha256,
  public_files_manifest_sha256, simulation_input_manifest_sha256
ON publication_revisions BEGIN
  SELECT RAISE(ABORT, 'PUBLICATION_IDENTITY_IMMUTABLE');
END;
CREATE TRIGGER publication_revision_no_delete
BEFORE DELETE ON publication_revisions BEGIN
  SELECT RAISE(ABORT, 'PUBLICATION_REVISION_IMMUTABLE');
END;
CREATE TRIGGER publication_current_signature_guard
BEFORE UPDATE OF current_signature_sha256, signature_selected_at ON publication_revisions
WHEN NEW.current_signature_sha256 IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM publication_signature_history h
    JOIN artifact_signing_keys k
      ON k.key_id = h.signature_key_id
     AND k.key_version = h.signature_key_version
    WHERE h.revision = NEW.revision
      AND h.signature_sha256 = NEW.current_signature_sha256
      AND h.revision_identity_sha256 = NEW.revision_identity_sha256
      AND h.content_bundle_sha256 = NEW.content_bundle_sha256
      AND h.publication_json_sha256 = NEW.publication_json_sha256
      AND h.public_files_manifest_sha256 = NEW.public_files_manifest_sha256
      AND h.simulation_input_manifest_sha256 = NEW.simulation_input_manifest_sha256
      AND h.signed_at <= NEW.signature_selected_at
      AND h.expires_at >= NEW.signature_selected_at
      AND h.signed_at >= k.valid_from
      AND (k.valid_until IS NULL OR h.signed_at <= k.valid_until)
      AND (
        k.status IN ('active','retired')
        OR (
          k.status = 'revoked'
          AND k.compromised_from IS NOT NULL
          AND h.signed_at < k.compromised_from
          AND k.revoked_at IS NOT NULL
          AND h.trusted_at < k.revoked_at
        )
      )
  ) THEN RAISE(ABORT, 'SIGNATURE_REVISION_MISMATCH') END;
END;
CREATE TRIGGER publication_current_signature_required
BEFORE UPDATE OF status, current_signature_sha256, signature_selected_at
ON publication_revisions
WHEN (
    NEW.status IN ('staged','active')
    AND (NEW.current_signature_sha256 IS NULL OR NEW.signature_selected_at IS NULL)
  ) OR (
    OLD.current_signature_sha256 IS NOT NULL
    AND (NEW.current_signature_sha256 IS NULL OR NEW.signature_selected_at IS NULL)
  ) BEGIN
  SELECT RAISE(ABORT, 'PUBLICATION_SIGNATURE_REQUIRED');
END;
CREATE TRIGGER request_quota_guard BEFORE INSERT ON requests BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM d1_schema_state
    WHERE singleton = 1 AND mutation_mode = 'open'
      AND restore_epoch = NEW.restore_epoch
  ) THEN RAISE(ABORT, 'D1_SCHEMA_UNTRUSTED') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM system_gates
    WHERE singleton = 1 AND accepting_requests = 1
      AND backup_generated_at IS NOT NULL
      AND NEW.created_at >= backup_generated_at
      AND NEW.created_at - backup_generated_at <= 79200
  ) THEN RAISE(ABORT, 'BACKUP_STALE') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM public_keys pk
    JOIN publication_revisions pr ON pr.revision = pk.revision
    WHERE pk.revision = NEW.publication_revision
      AND pk.public_player_key = NEW.public_player_key
      AND pk.key_version = NEW.key_version
      AND pr.season_id = NEW.season_id
      AND pr.public_player_key_version = NEW.key_version
      AND (
        pk.revision = (SELECT active_revision FROM publication_control WHERE singleton = 1)
        OR (pr.status = 'grace' AND pr.grace_until >= NEW.created_at)
      )
  ) THEN RAISE(ABORT, 'PUBLIC_KEY_NOT_ACTIVE') END;
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM requests WHERE status IN ('queued','leased','running')) >= 20
    THEN RAISE(ABORT, 'QUEUE_FULL') END;
  SELECT CASE WHEN NOT EXISTS
    (SELECT 1 FROM daily_counters WHERE day = NEW.quota_day)
    THEN RAISE(ABORT, 'DAILY_COUNTER_MISSING') END;
  SELECT CASE WHEN
    (SELECT accepted_count >= daily_limit FROM daily_counters WHERE day = NEW.quota_day)
    THEN RAISE(ABORT, 'DAILY_LIMIT_REACHED') END;
END;
CREATE TRIGGER request_quota_increment AFTER INSERT ON requests BEGIN
  UPDATE daily_counters
  SET accepted_count = accepted_count + 1, updated_at = NEW.created_at
  WHERE day = NEW.quota_day;
END;
CREATE TRIGGER publication_target_guard BEFORE UPDATE OF active_revision ON publication_control BEGIN
  SELECT CASE WHEN NEW.active_revision IS NULL OR NOT EXISTS (
    SELECT 1
    FROM publication_revisions pr
    JOIN publication_signature_history h
      ON h.revision = pr.revision
     AND h.signature_sha256 = pr.current_signature_sha256
    JOIN artifact_signing_keys k
      ON k.key_id = h.signature_key_id
     AND k.key_version = h.signature_key_version
    WHERE pr.revision = NEW.active_revision
      AND pr.status = 'staged'
      AND pr.current_signature_sha256 IS NOT NULL
      AND h.revision_identity_sha256 = pr.revision_identity_sha256
      AND h.content_bundle_sha256 = pr.content_bundle_sha256
      AND h.publication_json_sha256 = pr.publication_json_sha256
      AND h.public_files_manifest_sha256 = pr.public_files_manifest_sha256
      AND h.simulation_input_manifest_sha256 = pr.simulation_input_manifest_sha256
      AND h.signed_at <= NEW.updated_at
      AND h.expires_at >= NEW.updated_at
      AND h.signed_at >= k.valid_from
      AND (k.valid_until IS NULL OR h.signed_at <= k.valid_until)
      AND (
        k.status IN ('active','retired')
        OR (
          k.status = 'revoked'
          AND k.compromised_from IS NOT NULL
          AND h.signed_at < k.compromised_from
          AND k.revoked_at IS NOT NULL
          AND h.trusted_at < k.revoked_at
        )
      )
  ) THEN RAISE(ABORT, 'PUBLICATION_NOT_STAGED') END;
END;
CREATE TRIGGER publication_status_switch AFTER UPDATE OF active_revision ON publication_control BEGIN
  UPDATE publication_revisions
  SET status = 'grace', grace_until = NEW.updated_at + 1800
  WHERE revision = OLD.active_revision AND status = 'active';
  UPDATE publication_revisions
  SET status = 'active', grace_until = NULL
  WHERE revision = NEW.active_revision AND status = 'staged';
END;
```

`publication_signature_history` 是 trusted publication history：每次首次签名或重签都追加一行，`(revision,signature_sha256)` 唯一，UPDATE/DELETE trigger 永久拒绝修改和删除。它保存完整 canonical payload SHA-256、revision identity、content bundle、publication JSON、public files manifest、simulation-input manifest 的 SHA-256，key/version 及 `signedAt/expiresAt/trustedAt`；`publication_revisions` 的 identity/season/key/generated/content hash 列同样禁止 UPDATE/DELETE，删除只能转状态而不物理删行。新 revision 先以 `draft` 创建，追加可信签名并选择 current signature 后才能显式转为 `staged`；`staged/active` 状态下数据库 CHECK 与 trigger 都禁止缺失签名，并且签名一旦选择后只能原子切换到另一条有效历史签名，任何状态转换都不得重新清空。`current_signature_sha256` 只是当前验签指针。`publication_current_signature_guard` 和 `publication_target_guard` 必须分别在选择签名和激活 revision 时强制全部 hash、identity、key 有效期/撤销语义与签名时间一致；只有外键或 current pointer 非空不够。完整 canonical payload、signature bytes 和历史重签文件仍留在不可变 revision bundle；D1 历史、当前指针与 bundle 任一不一致都 fail closed。

`ControlPlane` 的关键条件操作固定为：

- 新申请：mutex 内先按 active request 的原 idempotency key 和永久 tombstone digest 查找。仅新 key 执行一个 batch：按顺序将超过 24 小时的未终态任务置 expired、回收过期租约、`INSERT OR IGNORE daily_counters(day,0,dailyLimit,now)`、`INSERT requests(...,restore_epoch)`。`querySecretHash` 必须是 64 位 lowercase SHA-256 hex，且查询凭证过期时间严格晚于创建时间；缺失、NULL、错误格式或无效过期时间由 DDL 直接拒绝。请求的 season/key version 必须同时匹配目标 publication revision 和该 revision 的 public key registry，restore epoch 必须同时等于外部 SafetyGate 与 `d1_schema_state`；trigger 在同一事务内强制这些绑定、未终态 `< 20`、额度未满并递增计数。任一 trigger/unique constraint 失败会 rollback 整个 batch。`quota_day` 由 DO 按 `Asia/Shanghai` 计算，客户端不能提交。
- 领取：使用带 `restore_epoch=:restoreEpoch` 条件的 `UPDATE ... RETURNING`，从当前 epoch 的 queued 任务中按 `created_at,request_id` 领取并递增 attempt/fencing；只接受恰好一行。
- `leased -> running`、heartbeat、完成/失败：除 request、attempt、lease hash、fencing、状态和有效期外，都必须同时匹配当前 SafetyGate/D1 restore epoch。epoch 不匹配与其他条件更新返回零行统一视为 `STALE_LEASE`，旧恢复点中的 lease 永远不能回写。
- 回收：同一 batch 先把 `created_at <= now-86400` 的未终态置 expired，写入 `terminal_at=now`、清空 lease 并递增 fencing；如果 `d1_schema_state.mutation_mode='maintenance'` 且 `now < maintenance_deadline`，禁止 lease 回收、heartbeat、领取和结果写入，避免 D1 export 阻塞期间误判租约；deadline 到达后才把剩余 leased/running 按 `attempt < 3` 改为 queued 且保持 `terminal_at=NULL`，否则 failed 并写 `terminal_at=now`。所有 succeeded/failed/expired 必须有 terminal time，所有 queued/leased/running 必须为 NULL，DDL CHECK 和条件 UPDATE 同时强制。
- 凭证/nonce：canonical HMAC 在 `credentialEpoch` 后新增一行 `<restoreEpoch_decimal>`。mutation 前按 `credential_id、scope、credential epoch、restore epoch、status='active'、expires_at>=now` 验证；nonce 复合主键包含 restore epoch，并与业务 mutation 同一 D1 batch。任一恢复都提升 restore epoch、撤销旧 service credential 并发放新凭证，因此恢复出的旧 nonce 行不会使旧签名重新有效。轮换/撤销只经 DO 条件更新；定时清理只删除过期 nonce。
- 备份门禁：`backup-monitor` 只能提交新的 `backupId/generatedAt/verifiedAt/manifestSha256/receiptSha256`，`reportedAt` 由服务端接收时间生成。`generatedAt` 是 SQLite 内容快照时刻，`verifiedAt` 是两个目标及两份 receipt 均写入并读回成功的时刻，`reportedAt` 是 D1 接受报告的时刻；三者不能混用。DO 执行单条参数化 `INSERT INTO backup_receipts(...) VALUES(...,:reportedAt,...) RETURNING backup_id`，必须返回恰好一行；`backup_receipt_guard` 在数据库层强制 `generatedAt <= verifiedAt`、`generatedAt <= reportedAt`、`verifiedAt` 最多领先服务端时钟 5 分钟、content age 不超过 79200 秒、验证后上报不超过 3600 秒、backupId/receipt hash 唯一且 `generatedAt` 严格大于当前门禁。插入成功后 `backup_receipt_activate` 在同一事务原子推进 `system_gates.backup_id/backup_generated_at`，任何 trigger/unique 失败都不改变 receipt 或门禁。游客 request trigger 额外强制 `0 <= createdAt-backupGeneratedAt <= 79200`；未来内容时间不得用作新鲜备份。因此 12 小时周期内延迟完成的备份仍可上报，但报告必须在验证完成后 1 小时内到达；旧内容、旧 receipt 或乱序重放都不能回拨或刷新门禁。
- publication：唯一权威 active 是 `publication_control(singleton=1).active_revision`，所有读取都 join 该 pointer，不能用 `status='active'` 自行推断。切换前 target 必须 staged、拥有指向 append-only history 的 current signature、Pages deployment 可见性已验证且 restore epoch 一致。after trigger 在同一事务把旧 active 改为 grace、新 target 改为 active；语句失败或返回非一行则整体不切换。retained 回滚前先经 publisher/DO 条件更新为 staged，并校验 artifact hash、current signature 和完整历史。
- 删除审批：mutex 内查询该 revision 未终态为 0、`COALESCE(MAX(terminal_at), publication.created_at)` 已超过 24 小时且不在回滚集合，再执行 `UPDATE ... WHERE revision=? AND status='retained' AND deletion_approved_at IS NULL RETURNING revision`；只有一行才批准。本地 bundle 删除成功后，仍经 DO 把 publicKeys 与 revision 标为 deleted。

查询凭证到期时，用独立 Worker Secret 中的版本化 tombstone key 计算 `HMAC-SHA-256(idempotencyKey)`，在同一 batch 只保存 `idempotency_digest + digest_key_version + tombstoned_at`，随后删除 requestId、payloadHash、querySecretHash、request/result。tombstone 不再保存可关联 season/player/preset 的字段；收到能匹配任一保留 key version 的 digest 时返回 `410 IDEMPOTENCY_EXPIRED`，该随机 key 永不复用。

为了实现“永久 410”，所有已使用 tombstone HMAC key version 必须作为专用只读历史 keyring 永久在线保留，同时进入灾备秘密包；只在新增 tombstone 时使用 active version，匹配旧申请时按 key version 列表在 ControlPlane 内恒定时间比较。该 keyring 与 executor/publisher/signing 密钥分离，不可导出到 D1、日志或 Pages；泄漏影响限于对攻击者已知的高熵 idempotency key 进行匹配，不能还原未知 key 或其行为字段。新 key 可轮换，旧 key 只从 active 降为 match-only，不删除；如无法接受该长期密钥负担，则必须改变永久 410 产品语义并重新 review，不得在实施中默默删除历史 key。永久保留的理由是防止已删除任务被重建；每年复核其数据最小化与密钥暴露面。

并发验收必须用至少 100 个并发创建、领取、heartbeat、完成、nonce 重放、publication 切换和删除请求，证明每日计数不超过 `daily_limit`、未终态不超过 20、每个 request 同时最多一个有效 lease、`publication_control` 永远只有一个 active pointer，且 D1/DO 重启后不丢状态。测试还必须在每个 mutation 故障点注入 D1 异常，证明 trigger/batch rollback 后不会出现计数增加但无 request，或 active pointer 与 revision 状态不一致。已通过认证但业务条件不匹配的请求允许消耗 nonce并返回业务错误，但不得改变业务表；同 nonce 重放仍必须拒绝。

### 6.2.1 D1 migration 与部署兼容合同

D1 migration 与第 2.1 节业务 SQLite migration 是两个独立状态机、两套目录和两套 ledger，禁止共用 schema version 或把其中一个的成功当作另一个成功。D1 文件固定为 `d1/migrations/<sequence>_<name>.sql`，`migrationId` 等于 sequence，checksum 为文件原始 bytes 的 SHA-256；已合并、发布或在任一环境执行过的文件禁止修改、替换、删除或复用 ID。`0001_initial` 包含上面的初始 DDL；bootstrap runner 在同一原子 migration batch 中创建 ledger、先插入 bootstrap attempt 的 `running` 记录、执行其余 DDL、写入实际 checksum/success/fingerprint，再把 schema 从 0 更新为 1 并将 mode 置为 open。batch 失败则整个空库初始化回滚并从头重试，不能留下或手工补写 baseline。

每个 control service 构建必须声明 `minD1Schema`/`maxD1Schema`，每次 mutation 都读取 `d1_schema_state`；schema 超出范围、mode 非 open、存在 `running/unknown` attempt 或 fingerprint 不符时返回 `503 D1_SCHEMA_UNTRUSTED`。只读接口也必须声明兼容范围，未经测试不能在 migration 期间继续服务。普通业务写入仍只能经过全局 DO；唯一例外是 GitHub Environment 审批后的 CI `d1-migrator`，它使用不能部署 Pages、不能读取业务秘密的独立最小权限 Cloudflare Token，并只在 DO 已授予 maintenance lock 后执行版本化 D1 migration。

D1 只允许 expand/contract：expand 先添加兼容列、表、索引或双写能力，control service N 与 N-1 都必须能在 migration 前后正确读写；contract 至少延后一版，必须在 N-1 已退出生产和回滚窗口、旧数据完成回填且兼容遥测为零之后单独执行。每个 PR/Tag 必须用真实 D1 migration 链验证“旧 schema + N”“新 schema + N”“新 schema + N-1”，并校验 schema fingerprint、约束、trigger 和关键不变量；只用新建库或内存 mock 不算兼容验收。

生产部署顺序固定为：

1. CI 校验 migration checksum 未被改写，使用生产前后 schema 快照完成 N/N-1 测试，并将兼容旧 schema 的 control service N 作为未接流量的 staged version 部署。
2. 先把 D1 外部 SafetyGate 置 blocked；由现役 control service 把 `accepting_requests=0`、停止领取，等待 leased/running 任务进入终态或按 fencing 取消。全局 DO 排空 FIFO mutation 后，条件更新 `d1_schema_state` 为 maintenance、写入新的 lock epoch/attemptId。
3. 在上述双层停写状态下创建并验证 D1 Time Travel bookmark 和等价逻辑 export，记录 `recoveryPointId`、当前 SafetyGate/restore epoch、预计数据损失窗口和恢复命令；恢复点自身必须包含 maintenance、`accepting_requests=0`，无法验证时停止。
4. CI runner 追加 `running` attempt 后，激活可同时理解旧/新 schema 的 control service N；`d1-migrator` 校验 lock epoch、attemptId、from schema 和 checksum，再以 Cloudflare D1 原子 migration/batch 执行一个 migration，并在同一提交中写 `d1_schema_migrations` success、attempt success、to schema 和新 fingerprint。禁止 migration 发起网络或其他外部副作用。
5. runner 在 maintenance 下验证 DDL fingerprint、trigger、唯一约束、计数/active pointer/lease/restore epoch 不变量和 control service N 健康；随后部署匹配的 gateway N。全部成功后先由 DO 以相同 lock epoch 清锁、保持 `accepting_requests=0`，最后才打开 SafetyGate 和申请开关。
6. 保留 N-1 artifact 和兼容遥测直到至少一个完整发布窗口结束；contract migration 必须走新的审批和恢复点，不能夹在首次启用新字段的同一次发布中。

失败状态和恢复规则固定如下：

- migration batch 明确 rollback，且旧 fingerprint、数据不变量和 recovery point 均验证通过时，把本次 attempt 追加终结为 `failed`；修复 runner 后只允许以同一 migrationId、同一 checksum 创建新 attempt，历史 attempt 不覆盖。
- runner 中断遗留 `running`、checksum 冲突、fingerprint 不明、部分 DDL/数据可见或验证不完整时视为 `unknown`，将 mode 置 blocked；gateway、旧/新 control service 和所有 mutation 都不得启动或重开。
- migration 成功但 N 健康检查失败时，只有 N-1 声明支持新 schema、兼容测试通过且 SafetyGate 仍 blocked、没有不兼容写入，才允许回退 control service 而保留 D1；否则保持停写并向前修复。恢复 D1 recovery point 只用于 unknown/部分执行或无法前进的事故，且必须执行 6.2.3 的 quarantine/fencing，不能因为恢复点内曾是 open 就直接开放。
- `success` migration 重跑只核对相同 checksum 后 no-op；任何已成功 migration 的 checksum 变化、缺失 ledger、schema version/fingerprint 不一致都直接 blocked，禁止自动猜测、schema 降级或跳号。

GitHub workflow 对 D1 migration 使用生产 Environment 人工审批和单一 concurrency group；顺序必须是 staged control N -> SafetyGate blocked -> D1 maintenance/lock -> recovery point -> migration -> invariants -> gateway N -> D1 ready -> SafetyGate open。workflow 失败默认保留双层 blocked，不得在 cleanup 中无条件重开写入。

### 6.2.2 备份新鲜度写门禁

本机维护一个只读状态文件 `backup-health.json`，只由备份验证器在两个 receipt 均读回成功后原子替换，字段至少包括 `backupId`、`generatedAt`、`verifiedAt`、两个 receipt SHA-256 和验证器版本。Web 管理写接口、统一调度器接纳管理员/每日任务、publisher 发布新 revision 和本机 Worker 领取游客任务前都调用同一个 guard；新鲜度固定按 `0 <= now-generatedAt`计算，未来 `generatedAt` 一律按时钟错误 fail closed。`verifiedAt` 只证明双目标验证完成，不能刷新 RPO 时钟：

- `<=20h`：正常运行。
- `>20h && <=22h`：告警，禁止 migration、发布、批量导入等高风险变更。
- `>22h && <=24h`：返回 `503 BACKUP_STALE`，禁止全部业务写入、游客创建/领取和每日模拟，只允许备份、验证和恢复。
- `>24h`：保持相同 fail closed，并提升为 RPO breach 告警。

guard 状态文件缺失、格式/hash 无效或系统时钟倒退时按 `>24h` 处理。`accepting_requests` 的唯一权威位置是 D1 `system_gates`：只有 publisher 可经 gateway -> ControlPlane DO 显式开关，ControlPlane 自身只能在 maintenance/recovery/stale 等固定 fail-close 转换中写 0；backup-monitor 只能新增 verified receipt，不能直接改该开关，外部监控和 GitHub workflow 更不得直写 D1。每份 verified receipt 经 ControlPlane 接受后生成绑定 `backupId/generatedAt/restoreEpoch` 的 attestation；SafetyGate 只能凭该 attestation 把 `open_not_after` 单调推进到不晚于 `generatedAt+22h`，并且该推进本身也必须先按 6.2.3 写入双目标 committed `renew-open-expiry` authorization、再由 DO CAS 消费。renew 操作只能保持同 epoch 的 open -> open，不能把 blocked 改为 open，不能改变 restore epoch。gateway 对业务 mutation 同时要求 SafetyGate `mode=open` 且当前时间不晚于 `open_not_after`，所以监控失联或时钟到期会自动 fail closed。外部 watchdog 只持有 `gate-closer`，可以提前把 SafetyGate open -> blocked，但不能修改 D1、延长 `open_not_after` 或重新开放。备份/恢复等管理端点在 blocked 下走独立 scope 和内部 service route，不绕过 epoch、HMAC 或审计。这样 D1 申请开关、SafetyGate 紧急门禁和外部观测职责不混用，也不依赖管理员看到告警后手动停写。

### 6.2.3 D1 日常灾备、quarantine 与恢复

D1 是控制面事实源，因此除 provider Time Travel 外，每 12 小时在 03:45/15:45 生成一次版本化逻辑 export；每次 D1 migration、publication 激活、signing/credential key 变更前后额外生成。export 包含 schema/ledger、请求与结果、quota、credential 元数据、publication/signature history/public key、backup gate 和删除审批，不包含 Worker Secret 明文；使用独立灾备密钥加密，生成 signed manifest/receipt 后写入与业务库相同的两个备份目标，其中至少一个不可变或离线。保留 14 个每日、8 个每周、12 个每月恢复点；目标 RPO 24 小时，20 小时告警、22 小时由 SafetyGate 关闭新 mutation。每月隔离 D1 恢复、每季度演练一次 D1 全丢失重建并记录 RPO/RTO。

日常 export 必须是一致性恢复点，不允许在多次无快照分页查询中边读边写。第一阶段工具链固定为 lockfile 中精确版本 `wrangler@4.124.0`（2026-08-20 核验版本）以及 Cloudflare API v4 D1 export；升级 Wrangler 或更换 API 前必须在独立 staging 重跑本节合同测试并重新记录版本。官方依据固定为 [Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/)、[Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/)、[Wrangler D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/) 和 [D1 export REST API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)。已核实的边界是：原生 export 在运行期间阻塞其他 D1 请求，初次响应给出 `at_bookmark`，调用者必须持续轮询，否则任务自动取消；Time Travel 是原地覆盖且取消在途事务；SQL import 不接受原始 SQLite 文件，也不能依赖 dump 内的外层 `BEGIN/COMMIT`。

1. `gate-closer` 先把 SafetyGate 在当前 restore epoch 下转为 blocked，ControlPlane 把 `accepting_requests=0` 并停止新领取；随后按 7.2 的 900 秒 maintenance 合同推进现有 lease 截止，不变更 attempt/fencing。
2. `ControlPlane` 持有全局 FIFO mutex，等待先前 mutation 完成，再以条件 batch 进入 `mutation_mode=maintenance`、写入 export ID/lock epoch/`maintenance_deadline=maintenance_started_at+900s`，并把当时 leased/running 的 `lease_expires_at` 推进到同一 deadline。此后所有 mutation、heartbeat、lease 回收和结果写入保持排队或返回 503，禁止跨表分页导出时释放 mutex；该 deadline 是 15 分钟硬上限，不得被 heartbeat 或重试延长。
3. 在无并发写窗口内 POST `https://api.cloudflare.com/client/v4/accounts/{accountId}/d1/database/{databaseId}/export`，首包固定为 `{"output_format":"polling"}`；保存返回的 `at_bookmark`，随后以 `{"current_bookmark":"<at_bookmark>"}` 每 5 秒轮询同一端点直到取得 `signed_url/filename`，立即下载完整 SQL dump。export 本身最多 600s；剩余 300s 只用于下载后校验、写 receipt 和清除 maintenance lock。请求使用独立、短期、只具 D1 导出所需账户权限的 Token；runner 硬校验环境 allowlist 中的 account/database ID，禁止接受 workflow input 覆盖。HTTP 非 2xx、bookmark 改变、轮询中断、signed URL 过期、下载 hash 不符或超过 600s 都取消本次 export；无法在总 900s deadline 内确认取消并清锁时保持 blocked，不能标 verified。
4. export endpoint 自身在整个导出期间阻塞其他数据库请求，配合 SafetyGate blocked、ControlPlane maintenance/FIFO 排空形成恢复点；`at_bookmark` 是导出点身份。普通 SELECT、多次分页、不同 table export 或自行拼接 dump 永不作为恢复包。下载后在隔离的本地 SQLite 上完整导入 dump，运行 `foreign_key_check`、表/trigger/index fingerprint、关键计数和业务不变量；D1 不使用 virtual table，所有整数必须保持在 JavaScript 安全整数范围内，以规避官方列出的 export 限制。
5. 在 300s 校验/清理窗口内校验 schema/fingerprint、request 状态/terminal time、daily counter、每 request 唯一 lease/fencing、active publication/current signature、restore epoch、credential/nonce 和 backup gate 不变量，生成带 REST export endpoint 版本、Wrangler 版本、account/database ID hash、export ID/`at_bookmark`、SQL bytes/SHA-256 和前后状态 hash 的 signed manifest。只有 SQL 隔离导入与全部不变量通过才写双目标 receipt 并标 verified；清锁前将仍有效 lease 的 `lease_expires_at` 重置为 `now+120s`。
6. 成功或失败后都只由相同 lock epoch 的 ControlPlane 条件清锁并把 `maintenance_deadline` 清零；失败不生成 verified export，保持 SafetyGate blocked 并按 20/22 小时门禁处理。若达到 900s 仍未完成，统一递增 fencing、终止本机完整进程树并把 active leases 按回收规则转 queued/failed，不能恢复旧 lease。恢复演练分两条：在实际套餐 Time Travel 可用窗口内（当前官方边界为 Workers Free 7 天、Paid 30 天）用 `npx wrangler@4.124.0 d1 time-travel restore <database> --bookmark=<bookmark>` 原地恢复；每次演练先用 `d1 info` 记录 backend `version=production` 和套餐窗口，不能假定 30 天。超出窗口或全丢失时创建全新、默认无公网 binding 的 quarantine D1，再用 `npx wrangler@4.124.0 d1 execute <quarantine-db> --remote --file=<verified-export.sql>` 导入并验证，最后通过受审批的 binding 切换部署，禁止把逻辑 dump 直接灌入仍接流量的生产 D1。

SafetyGate 自身的恢复依据不是 D1 export，而是独立的追加式 `safety-gate-ledger/v2`。每条事件是不可变的“状态转换授权”，包含 `action=open|renew-open-expiry|advance-epoch`、单调 sequence/restore epoch、from/to mode、`openNotAfter`、event ID/reason、actor role、previous committed event hash、canary/backup attestation hash、`authorizedAt/notBefore/expiresAt` 和 SafetyGate 版本，由独立 recovery-ledger Ed25519 key 签名。不存在“DO 已 open、committed 尚未落盘”的顺序：epoch 变更、blocked -> open 和 open expiry 续期都必须先把同一份 signed committed authorization 写入两个灾备目标并读回，确认 hash-chain 连续，再让 DO 以 previous state/version/event hash 的单次 CAS 消费该 authorization；DO 持久状态保存并返回 `appliedAuthorizationHash`，gateway 仅在 mode=open、当前 epoch/时间有效且该 hash 等于 DO 内已验签的 committed authorization 时放行业务 mutation。authorization 已 committed 但 DO CAS 前崩溃时保持原状态；CAS 后崩溃时 ledger 已存在，重试只允许相同 event/hash 的幂等 no-op；不得用第二条“事后 committed”补记开放或续期。

open authorization 最长 15 分钟内必须被消费且只能消费一次，过期后作废；`openNotAfter` 不能晚于备份 attestation 的 `generatedAt+22h`。自动或人工 close 可以先让 DO 原子 fail closed，再异步追加 signed close observation，但 observation 未在双目标读回前禁止生成任何新的 open authorization。每次转换保留 GitHub Environment workflow run/audit ID。两个 ledger 分叉、签名无效、DO 的 applied hash 不在连续 committed 链中或任一目标不可读时，gateway 保持 503，不承诺恢复 RTO。故障注入必须覆盖双目标第一次/第二次写入、两次读回、DO CAS 前、CAS 成功响应丢失和 CAS 后进程崩溃；每个边界的可接受结果只能是“blocked”或“open 且已有可验证 committed authorization”，绝不允许 open without ledger。

SafetyGate 权限拆分为三个互不兼容的角色：`gate-closer` 是长期最小权限凭证，只能在当前 epoch 执行 open -> blocked；`epoch-admin` 是 production Environment 人工审批后发放、最长 1 小时的一次性 Token，只能设置 blocked 并分配 `max(两个有效 ledger、已验证 D1 export、本机恢复清单中的 epoch)+1`；`gate-opener` 是另一次 Environment 审批后发放的一次性 Token，只能在 epoch 精确匹配且 D1/schema/publication/credential canary attestation hash 完整时执行 blocked -> open。`d1-recovery` 只能修复 D1，不能读写 SafetyGate；`epoch-admin`、`gate-opener` 和 `d1-recovery` 短期 Token 都绑定 event ID/epoch/操作类型，使用一次或超过 1 小时立即失效并记入日志。

SafetyGate DO 丢失、namespace 重建或 provider 恢复后不得从 D1 复制 mode/epoch。先保持 gateway 在 DO 缺失时 fail closed，由 `epoch-admin` 验证两份 ledger 链和恢复来源，以上述 max+1 在新 DO 初始化 blocked，追加/读回新 ledger 事件，再按下述 D1 quarantine 执行。任何恢复点中的 open mode 都不受信，无法证明 epoch 单调时永不自动开放。

恢复或 Time Travel rollback 的顺序固定为：

1. 先由 `gate-closer` 保证 blocked，再由独立审批的 `epoch-admin` 按 ledger max+1 分配新 restore epoch，封存并读回 blocked 事件后才继续。SafetyGate 不可达时 gateway 默认 503，禁止绕过。
2. 停止本机 Worker 领取和 publication，记录旧/新 restore epoch、目标 recoveryPoint/export、损失窗口和当前 Pages deployment。此后才执行 D1 restore。
3. 恢复完成后，`d1-recovery` 在 gateway 仍 blocked 时通过独立恢复通道强制设置 `d1_schema_state.mutation_mode=blocked`、`maintenance_deadline=0`、`restore_epoch=<new>`、`system_gates.accepting_requests=0`；把全部 queued/leased/running 置 expired、写入统一 `terminal_at=<recoveryTime>`、清空 lease/过期时间、递增 fencing，撤销全部旧 service credential，并删除恢复出的 nonce。该通道不经普通 gateway/SafetyGate mutation route，不暴露公网 endpoint；只能由 GitHub production Environment 人工审批的 recovery workflow 使用短期 Cloudflare D1 Edit Token 和固定版本 runner 执行仓库内、hash 已审批的参数化 recovery SQL。Cloudflare 权限模型不能在服务端把该 Token 限制到 SQL 白名单，因此文档不把“白名单外 SQL 不可执行”作为平台保证；补偿控制是 production database ID/account ID 硬编码 allowlist、Token 不接受 workflow input、审批 artifact 绑定 runner commit/SQL hash/new epoch/schema fingerprint、全量 Cloudflare/GitHub 审计、单一 concurrency、运行后立即撤销。Token 不得带 Worker/Pages/SafetyGate/Secret 权限；任何验证或撤销失败都保持 blocked 并按凭证泄漏处置。
4. 验证 migration checksum/fingerprint、quota、append-only signature history、key registry 和 backup receipt；从本机已验证 revision bundle 与当前 Pages deployment 重建或确认目标 publication。不得直接信任恢复出的 active pointer、删除审批或 credential 状态。
5. 为 executor/publisher/backup-monitor 生成绑定新 restore epoch 的全新凭证；验证当前 publication 的 Pages hash、key 清单和 signature history。全 D1 丢失且无法恢复 tombstone/request 时必须生成新 publication revision，旧页面和旧 idempotency retry 返回过期/不可用，不能重新激活原 revision 后裸建任务。
6. 完成创建、领取、heartbeat、旧 lease/旧 HMAC/旧 nonce 拒绝和 publication canary 后，先将 D1 mode 置 open 但保持申请关闭；最后另行申请 `gate-opener` 一次性 Token，核对当前 epoch、`openNotAfter` 和 canary/backup attestation hash，先把 signed committed open authorization 写入两个 ledger 目标并读回，再让 DO 以 CAS 消费其 hash。gateway 确认 DO 的 `appliedAuthorizationHash` 后，才由 publisher 显式设置 `accepting_requests=1`。开放操作必须由管理员进行独立二次确认并写操作日志。

重建优先级固定为：schema/migration ledger -> restore epoch 与双层 gate -> signing key registry 与 append-only signature history -> Pages/publication/key 清单 -> 新 service credentials -> backup gate -> quota -> 新任务。非终态任务不跨恢复继续执行；恢复点之后的任务、结果、nonce、tombstone、publication/删除审批可能丢失，必须在事故记录中量化。D1 export 或恢复演练未实现前，公网匿名申请不得启用。

### 6.3 查询凭证

`querySecret` 是保留期内可重复查询的 bearer credential，不称为“一次性凭证”：

- 只能通过 HTTPS request body 或 `Authorization` header 发送，禁止 URL/query string。
- Worker 只保存 hash，使用恒定时间比较。
- 精确允许正式 Pages Origin；不使用 `*` CORS。
- 查询响应设置 `Cache-Control: no-store`、`Pragma: no-cache` 和 `Referrer-Policy: no-referrer`。
- 页面使用严格 CSP；凭证保存在浏览器本地受控存储，并提供显式删除/导出恢复码。
- 凭证丢失无法由管理员找回，只能等待原任务过期后重新申请。
- 已完成结果保留 30 天，失败/过期保留 7 天；到期同时删除凭证 hash。
- Worker、Pages、浏览器遥测和本机日志必须脱敏 request body、Authorization、secret/hash。

## 7. D1 状态机、租约与 fencing

状态机：

```text
queued -> leased -> running -> succeeded
                      |      -> failed
queued/leased/running -> expired
过期 leased/running --原子回收--> queued（attempt 未超限）或 failed
```

每次领取生成不可复用的 256 bit `leaseToken` 和单调递增 `fencingToken`，并增加 `attempt`。D1 只保存 lease token 的安全 hash。所有状态更新必须是条件更新：

- `leased -> running`：request、attempt、lease hash、fencing token、当前状态全部匹配且租约未过期。
- heartbeat：同样匹配后延长 `leaseExpiresAt`。
- complete/fail：同样匹配、状态为 running 且租约未过期；否则返回 `409 STALE_LEASE`，不写结果。
- 结果按 request + attempt + fencing token 唯一，旧 attempt 永远不能覆盖新结果。

租约正常状态为：初始 2 分钟，本机 Worker 每 30 秒心跳一次，每次续到当前时间后 2 分钟；连续 3 次心跳失败或剩余租期不足 30 秒时，Worker 必须终止完整 SimC 进程树且不提交结果。D1 export/maintenance 是唯一例外且有独立时间合同：ControlPlane 进入 maintenance 的同一事务写入 `maintenance_deadline = maintenance_started_at + 900s`，并把当时 leased/running 的 `lease_expires_at` 条件推进到该 deadline；10 分钟 export budget + 5 分钟下载校验/清理是唯一允许的 15 分钟窗口。窗口内 heartbeat、lease 回收、领取和 complete/fail 均返回 `D1_MAINTENANCE`，不改变 attempt/fencing；Worker 不得把该窗口当作普通心跳续租。export 成功或被明确取消后，ControlPlane 在相同 lock epoch 内把 `maintenance_deadline` 清零、把仍有效的 leased/running `lease_expires_at` 重置为 `now + 120s`，恢复普通 heartbeat；如果达到 900s 仍未完成或无法确认 export 已停止，则保持 blocked，统一递增 fencing、终止本机完整进程树，并将 active leases 按回收规则转 queued/failed。这样 10 分钟 export 不会被 2 分钟租约提前回收，也不会留下无限延长的 lease。

`abandoned` 不作为持久状态：租约回收在 Cloudflare 每分钟 cron 执行，并且在每次创建/领取事务开头补做；同一事务将已过期 leased/running 直接改为 queued（attempt 未达 3 次）或 failed，同时清空旧 lease hash、递增 fencing token 并重新计算未终态计数。任何 queued/leased/running 任务超过 24 小时在同一回收事务内改为 expired。回收失败则本次创建/领取 fail closed，不使用可能过期的队列计数。

未终态集合始终且仅为 `queued + leased + running`；不存在可长期占位或逃逸计数的中间状态。回收 cron 延迟告警阈值为 3 分钟，超过阈值时暂停新申请，不能等到 09:00 清理。

Worker 重启后先核对本机持久化 attempt 与 D1 token；无法证明仍持有有效租约时不得继续或回写旧进程结果。测试必须覆盖慢于 10/30 分钟的任务、双 Worker 领取、网络分区、心跳失败、崩溃恢复和旧结果回写。

## 8. 本机统一 SimC 调度器

所有 SimC 来源只能入同一个持久化本机队列，Web、每日 runner 和公网 Worker 都不得直接启动 SimC：

| 来源 | 优先级 | 规则 |
|---|---:|---|
| 管理员手动 | 300 | 下一空闲槽优先 |
| 每日全团 | 200 | 成员任务顺序入队 |
| 游客申请 | 100 | 仅在更高优先级无等待任务时运行 |

调度器使用独立 `scheduler.sqlite` 保存 task、source、priority、状态、PID、进程创建时间、Windows Job Object/其他平台进程组标识、attempt 和远端 fencing 信息。它不是业务主库，不提交 Git，可在崩溃后重建任务状态。调度器启动时必须取得 OS 级单实例文件锁；第二实例立即退出。全机并发固定为 1，后续改变必须重新压测和 review。

- 暂停：停止领取新任务，不强杀当前任务。
- Windows 正式环境：创建 SimC 时必须放入专属 Windows Job Object，并启用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；取消时先发送已验证的优雅停止信号/关闭请求，等待 10 秒，再用 `TerminateJobObject` 终止整个进程树。任何终止前必须同时匹配记录的 PID、进程创建时间和 Job Object/task 标识，防止 PID 复用误杀。
- macOS/Linux 开发环境：使用独立进程组；取消时向整个组发送 SIGTERM，等待 10 秒后发送 SIGKILL。该 POSIX 路径不是 Windows 生产契约。
- 两类平台都必须等待所有后代退出、关闭 Job/进程组句柄并释放锁后才标记 cancelled；只调用直接子进程的 `child.kill()` 不满足目标协议。
- 每日任务开始前可暂停游客领取，但不能绕过同一队列直接运行。
- 手动高优先级任务不强制抢占正在运行的 SimC，只影响下一个任务。
- 调度器进程崩溃后根据 PID、进程创建时间、Job Object/进程组、启动标识和 task lease 判断；不能证明归属时不得按 PID 盲杀，先暂停队列并进入人工故障处置。
- Worker 只有拿到 D1 有效租约且本机队列接纳后才能置 running；等待本机调度期间持续 heartbeat。
- 本机断网导致无法续 D1 租约时必须取消游客 SimC；手动和每日本地任务不受 D1 影响。

固定 preset 对 iterations、threads、超时、输入大小和输出 DTO 设白名单。原始 profile、HTML 和日志不上传 D1。

### 8.1 游客模拟只读隔离

游客任务不能调用现有会保存装备或权重结果的通用模拟入口。publication 构建时为每个公开成员同时生成版本固定的本地私有 `simulation-input` 快照，包含 `seasonId + publicationRevision + publicPlayerKey + inputHash + wowDbBuild + simcBuild` 和运行固定 preset 所需的最小装备/天赋数据；快照不进入 Pages 或 D1，并按 publicationRevision 只读保存。

Worker 领取游客任务后只允许按请求中的 revision/key 定位对应私有快照并校验 inputHash。游客执行使用只读业务 SQLite 连接（SQLite `mode=ro`/`query_only=ON`）或完全不打开业务库；数据库写方法不注入游客执行器。结果只写入 D1 对应 attempt，不保存角色装备、权重、收益、历史或任何其他字段到业务主库。目标实现必须有数据库文件 hash/变更计数测试，证明游客任务成功、失败和取消前后业务 SQLite 及 WAL 均无业务写入。

只有管理员手动任务和每日任务可以通过明确的写入服务更新装备、权重和业务模拟结果。私有 simulation-input 与 revision bundle 使用第 4.4 节的统一删除门禁，不能按 30 分钟 grace 单独清理；快照缺失、revision/key/hash/Build 不匹配时任务直接失败为 `INPUT_REVISION_UNAVAILABLE`，禁止回退到当前成员数据运行。

### 8.2 Windows 正式运行合同

Windows 是第一阶段唯一正式运行环境，现有 macOS/POSIX runner 只作为开发参考，不能直接装入 Task Scheduler。仓库必须新增版本化 `ops/windows/` 安装器、任务 XML 和统一 PowerShell 7 wrapper；Task Scheduler 只执行固定入口 `pwsh.exe -NoProfile -NonInteractive -File <repo>\ops\windows\Invoke-WowHelperTask.ps1 -Task <name>`，不得在 XML 中拼接 npm、Node、SimC 或业务脚本命令。

安装器在受信任交互会话中解析并固定 Node、npm、PowerShell、Chromium、SimC、仓库、数据盘和 trust store 的绝对 Windows 路径，写入 ACL 仅允许运行账号和 Administrators 读取的 `%ProgramData%\WowHelper\runtime.json`；每次运行校验版本与文件 SHA-256。代码必须用 `fileURLToPath`/Windows path API，不得依赖 URL pathname、Unix PATH、`/usr/local/bin/npm`、`/usr/bin/ditto` 或 macOS 默认 SimC 路径。zip 导入固定使用 lockfile 中版本化的 cross-platform zip reader，并拒绝绝对路径、`..`、符号链接和解压目录逃逸。

正式运行账号固定为本地标准用户 `wowhelper-runtime`，不是 SYSTEM、管理员账号或 S4U 无网络凭据会话。安装器只为该账号授予 Task Scheduler 所需的 `Log on as a batch job` 和目录 ACL，不加入 Administrators，也不授予“以服务方式登录”。Task Scheduler 使用该账号保存的任务凭据，配置“无论用户是否登录都运行”并加载用户 profile；数据目录 ACL 只授予该账号所需读写，签名 trust store 只读。该标准用户保留本地交互式登录能力，仅用于 Armory 人工重认证；英雄榜浏览器 profile 固定在该用户 profile 下，不进入 Git、普通备份或替代电脑秘密包。

英雄榜 session 过期时，04:00 任务以 `AUTH_REQUIRED` 终止角色刷新和新 publication，保留最后一次有效官方装备快照，DPSWOW 不得覆盖装备；本地管理员功能和基于旧快照的查看继续可用，外部监控立即告警。管理员必须暂停每日/游客领取，交互式登录同一 `wowhelper-runtime` Windows 桌面会话，运行独立 `Reauth-Armory.ps1` 打开 headed Playwright，成功后关闭浏览器并执行单角色 headless canary，才恢复任务。替代电脑恢复同样先创建该账号、安装固定 Chromium，再人工登录重建 profile；不尝试恢复旧浏览器 profile 或 Cookie。

跨进程互斥与进程树控制固定由仓库内 .NET `WowHelper.ProcessHost` helper 提供：使用 Windows named mutex + owner PID/进程创建时间防止误清锁，把每个 SimC 子树放入启用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object，先请求优雅停止，10 秒后 `TerminateJobObject`。Node 的 `process.kill(pid,0)` 和直接子进程 `child.kill()` 不能作为 Windows 存活/取消实现。

wrapper 统一写原子 status JSON 并返回固定退出码：`0` 成功、`10` 成员级部分失败、`20` `AUTH_REQUIRED`、`30` backup/D1 gate stale、`40` 配置或 trust store 无效、`50` 锁已占用、`60` 子进程超时/取消、`70` hash/签名/数据库完整性失败、`1` 未分类错误。Task Scheduler 对任何非 0 均记失败；只有 `10` 可继续保留已完成成员结果，`20/30/40/50/60/70` 不发布新 revision。安装验收必须覆盖重启、未登录运行、错过补跑、锁崩溃恢复、PID 复用、完整进程树取消、zip 导入和每个退出码。

## 9. wow-db 发布与导入

Tag 形如 `wowdb-<build>-cn-zhCN`。GitHub Release/Asset 只是可替换的传输通道，不称为不可变或可信来源；真实性固定使用独立 `wowdb-transfer-signing` Ed25519 key。导出端生成 RFC 8785 canonical `transfer-manifest/v2.json`，逐项记录 `wow.sqlite`、`snapshot.json`、`report.json` 的 bytes/SHA-256、Build、region/locale、createdAt、keyId/keyVersion，并生成 detached `transfer-manifest/v2.sig`。zip 外再发布 zip SHA-256，不能只签 zip 内自带的 hash。

管理员本机在 `%ProgramData%\WowHelper\trust\wowdb-export-keys.json` 保存固定公钥注册表及其离线核验过的 fingerprint；该 trust store 不从同一个 Release 自动更新。首次信任通过当面/独立消息渠道比对 fingerprint；正常轮换由旧 key 对新 key 注册记录交叉签名，旧 key 已泄漏时必须人工 out-of-band 更新并记录 `compromisedFrom`。Importer 必须先验 detached signature 和 key 状态/时间，再校验包外 zip hash、解压后 manifest 与每个文件 hash、Build、关键表和 `quick_check`；只验证同包 manifest/SHA-256 不算来源认证。

每个 Release 使用唯一 Tag 和文件名，运维日志记录 Tag、asset URL、zip hash、manifest hash、签名 hash 和 key version；禁止有意复用或覆盖，但安全性不依赖 GitHub 保证不可替换。导入流程：

1. Windows 游戏环境导出并签署 zip、manifest、report、Build 与逐文件 hash。
2. 本地验签、检查失败表为零后创建 GitHub Release。
3. 管理员本机下载到临时目录，使用固定 trust store 验签并校验包外/包内 hash、Build、关键表和 `quick_check`。
4. 暂停调度器并停止 WowDbCatalog 使用者。
5. 原子替换 `wow.sqlite`，保留上一版。
6. 重启或显式 reload，健康检查确认实际加载新 Build。
7. 重新生成公开快照；失败则继续使用上一版和上一 publication。

wow-db 更新不自动切换 active season。赛季切换必须单独备份、冻结写入、归档旧规则、创建新 season/规则/成员映射，事务切换 active season 后再生成 key 清单和公开快照。

## 10. GitHub CI/CD

### 环境隔离合同

远程验收只允许在独立 staging 资源执行，不能把 production 当测试环境。资源身份在仓库内提交无秘密的 `environments/targets.json`，每个环境固定 account ID、D1 database ID/name、gateway/control Worker name、SafetyGate/ControlPlane DO namespace binding 名、Pages repository/project、GitHub Environment 和允许的 Origin；production ID 与 staging/test ID 必须两两不等。目标布局固定为：

| 环境 | D1 / DO / Worker | Pages 与 GitHub Environment | 凭证与数据 |
|---|---|---|---|
| local/test | Miniflare/本地 D1、临时 DO namespace | 不部署 Pages | fixture、一次性测试 key，无远程 Token |
| staging | 独立 `wow-helper-staging` D1、独立 SafetyGate/ControlPlane namespace、独立 Worker service | 独立的非生产 Pages repository/project 与 `staging` Environment；只发布合成 fixture | staging signing/service/recovery/ledger key，绝不复用 production secret |
| production | 独立生产 D1、DO namespace 与 Worker service | `zoroperona/wow-helper` Pages 与受保护 `production` Environment | 只在人工审批 job 注入 production secret |

个人 GitHub 账号若不具备所需的独立非生产 Pages 能力，则 staging Pages 前置条件不成立：可以继续本地测试，但不得用 production Pages 代测，也不得进入 production publication。创建任何资源前须由管理员明确批准；本节只是未来资源合同。

所有脚本默认目标必须是 local/staging，且同时校验四层 guard：显式 `--environment`、仓库 allowlist 中当前完整 account/database/namespace/project ID、目标 D1 内跨恢复稳定且不可修改的 `environment_identity.environment/environment_id_sha256/account_id_sha256`、对应 GitHub Environment OIDC/secret scope。实际 database ID 变更只能经 recovery 审批更新 target manifest，D1 environment ID 不随之改变。任一缺失或不一致立即退出；禁止通过 workflow input、branch 变量或资源名称猜测覆盖 ID。PR、fork 和普通 `main` job不获得 production secret，也没有 production Environment 权限；production workflow 仅接受受保护 Tag/commit、人工 reviewer、单一 concurrency 和预先生成的目标 manifest。CI 增加 deny-production 测试，向 staging job 注入每个 production ID 都必须在发出网络请求前失败；Cloudflare audit log 和 GitHub deployment log 必须能把每次远程写映射到 environment/run/commit。

### PR/main

- Node 与 .NET 的 typecheck/test/build。
- 检查 SQLite、zip、密钥、会话、本机路径和生成目录未进入 Git。
- 分别检查本机业务 SQLite 与 D1 migration 的 immutable ID/raw-bytes checksum、完整升级链、attempt 状态和 schema fingerprint，禁止混用 ledger。
- 检查公开 DTO schema、递归隐私扫描和 publication hash。
- 测试 D1 原子计数、幂等、revision key 清单、租约/fencing 和失联回收；错误 season、错误 publication key version、NULL/非 64 位/非 lowercase-hex querySecretHash、过期时间不晚于创建时间都必须在同一事务内拒绝且不增加 quota。
- 使用计划中的真实 DDL/trigger 和唯一全局 ControlPlane，完成至少 100 并发与 DO/D1 重启测试；禁止用内存 mock 代替最终并发验收。
- 测试 SafetyGate `gate-closer/epoch-admin/gate-opener/d1-recovery` 错误权限拒绝、ledger 分叉/缺失、DO 全丢失 max+1 重建、一次性 Token 重放和 fail-closed/restore epoch；在 ledger 双目标每次写/读、DO CAS 前、CAS 成功响应丢失和 CAS 后崩溃注入故障，证明不存在 open without committed authorization；测试 D1 expand/contract、N/N-1 schema 兼容、maintenance/blocked、checksum 冲突、部分 migration 和应用回退决策。
- 日常 D1 export 用 staging 实际执行固定 API v4 polling、`at_bookmark`、SQL 隔离导入、Time Travel 与新 quarantine D1 import；故障注入覆盖 mutex 排空前后、export init/轮询/下载/验证中断、600 秒 export 超时和 900 秒 maintenance deadline，恢复后验证 request/counter/lease/publication/credential 不变量，证明无快照分页导出不能被标为 verified。
- 测试 `backup-health.json` 缺失、`generatedAt/verifiedAt/reportedAt` 乱序、future generatedAt、1 小时上报延迟、旧 receipt 重放、20/22/24 小时边界、时钟倒退、D1 `accepting_requests` 单写和 SafetyGate `open_not_after` 自动 fail-closed。
- 测试 Ed25519 artifact signature 的 canonical bytes、未截断 revision identity、多签名追加、append-only signature history、revision/signature 各项 hash 不匹配拒绝、staged/active current signature 清空拒绝、过期、正常轮换、`compromisedFrom` 撤销语义和紧急回滚重签。
- 测试 wow-db transfer manifest detached signature、固定 trust store、轮换/撤销和 zip path traversal；同包 manifest + SQLite 同时篡改必须失败。
- 测试 Draft Release ingress 的 asset 替换、错误 ID/hash/signature/source commit、私有 simulation-input/SQLite 混入、path traversal、PAT 过期与 workflow 错误 permission；测试 GitHub Actions Pages concurrency、staged revision、CDN 可见性超时、失败重部署、retained artifact 回滚和 D1 最后切换；CI denylist 必须拒绝旧 `pages:publish`、`deploy-pages.mjs`、repo push remote/credential 重新出现。
- staging 远程测试必须证明每个 production account/database/namespace/Pages ID 在网络调用前被 hard guard 拒绝；staging 与 production signing/service/recovery/ledger credential 交叉使用全部失败。
- 成员撤回 fixture 必须生成 purge manifest，验证当前/已知旧 revision URL 不再可访问，并覆盖 Actions artifact、Draft Release asset 和可控 deployment 记录删除；无法删除时验证 Pages 全站 fail closed/escalation 路径。
- 测试 executor/publisher 路由 scope、HMAC nonce 防重放、轮换与错误权限域拒绝。
- 在 Windows runner 测试统一 wrapper/runtime manifest、固定退出码、专用用户、单实例、优先级、Job Object 整树取消、PID 复用保护和崩溃恢复。
- 测试本机写 API 无会话、错误 CSRF/Origin、session 闲置/绝对过期、重启撤销、登录限流，以及非 `wowhelper-runtime` 进程访问 named pipe 被 ACL 拒绝。
- 测试 Armory `AUTH_REQUIRED` 保留旧快照、不发布，以及同一 `wowhelper-runtime` 用户交互重认证后的 canary。
- 测试游客 simulation-input 版本锁定，以及游客任务前后业务 SQLite/WAL 无写入。

### Tag `vX.Y.Z`

1. 校验 Tag、应用版本和页面版本一致。
2. 构建可复现的本机应用包并生成 SHA-256。
3. 创建 GitHub Release 和 Release Notes。
4. 不远程接管管理员本机；管理员按 runbook 先备份、停止任务、拉取指定 Tag、验证并切换。
5. 本机更新成功后再生成新的 Pages publication。

Tag 若包含 control/gateway 或 D1 schema 变更，必须使用单独的 production Environment 审批与 concurrency group，严格执行第 6.2.1 节的 SafetyGate blocked、maintenance lock、recovery point、migration、invariants、gateway N、双层显式 open 顺序；D1 job 失败不得影响本机完整版继续运行，也不得自动重开公网申请。

GitHub Release 表示“构建产物已发布”，不表示本机已经升级。实际本机版本和 publication revision 记录到独立 [操作日志](operations-log.md)。

## 11. 本机定时任务

脚本和 OS 调度定义必须在仓库中版本化；Windows 使用 Task Scheduler 导入脚本，macOS/Linux 开发环境只提供等价的 launchd/systemd 模板，不允许手工维护无源码的定时任务。

| 时间（Asia/Shanghai） | 任务 | 失败行为 |
|---|---|---|
| 03:15 / 15:15 | 双目标一致性备份 | 20 小时告警；22 小时业务 fail closed；24 小时只允许恢复/备份 |
| 03:45 / 15:45 | D1 加密逻辑 export 到双目标 | 20 小时告警；22 小时 SafetyGate 关闭 mutation |
| 04:00 | 官方英雄榜刷新、DPSWOW 天赋补齐、全团模拟 | 走统一调度器；成员级失败继续，最终告警 |
| 流水线成功后 | 生成/验证/发布 Pages revision | 失败保留上一 revision |
| 09:00 | 清理 D1 到期状态、本机临时产物、按策略 prune 备份 | 不删除未验证恢复点；失败告警 |
| 每分钟 | D1 租约回收 | 原子转 queued/failed/expired；延迟超过 3 分钟暂停申请 |
| 每 15 分钟 | 本机应用、Worker、队列、备份新鲜度和磁盘巡检 | 连续失败告警 |
| 每月/每季度 | 恢复演练 | 只在隔离路径或替代电脑执行 |

Windows Task Scheduler 契约固定为：

- 统一以第 8.2 节的本地标准用户 `wowhelper-runtime` 运行，不得使用 SYSTEM、管理员账号或 S4U；`AtStartup` 启动 Worker/调度器/巡检守护，交互用户退出不能停止服务。
- 03:15/15:15 备份任务启用“错过后尽快运行”和“唤醒计算机运行”；唤醒后先检查最近 verified backup 的内容快照 `generatedAt`。content age 超过 20 小时立即异机告警并暂停高风险变更，超过 22 小时 fail closed（禁止管理员写入、游客申请和每日模拟），超过 24 小时只允许恢复/备份操作。机器断电无法唤醒时，由不依赖本机的外部监控按 `generatedAt` 告警。
- 04:00 全团流水线不自动补跑：错过后标记 `MISSED` 并告警，需管理员确认后手工入统一队列，避免白天突然占满 SimC。
- 03:45/15:45 D1 export 错过后尽快补跑；距最后成功 export 超过 20 小时告警、22 小时由 SafetyGate 关闭 mutation，恢复前不能只依赖 provider Time Travel。
- 每分钟 lease 回收运行在 Cloudflare cron，不依赖本机 Task Scheduler；本机 Worker 的 AtStartup 恢复不能替代云端回收。
- Task Scheduler 设置 `StartWhenAvailable=true`、禁止同一任务并行（运行中则拒绝新实例）、失败按 1/5/15 分钟有限重试；不得无限重试或并行补跑。
- “仅交流电源运行”和“进入电池停止”默认关闭，除非正式机器没有电池；睡眠策略必须允许 03:15/15:15 唤醒。若管理员选择不允许自动唤醒，则 24 小时 RPO 不成立，公网匿名申请必须关闭或另配常开备份节点。
- 外部监控至少检查：最后 verified backup 的 `generatedAt/verifiedAt/reportedAt`、Worker heartbeat、每日流水线状态和 Task Scheduler 最近结果；content age 超过 20 小时立即异机通知管理员，超过 22 小时确认业务已 fail closed，验证完成后超过 1 小时仍未上报也告警；超过 15 分钟无 Worker heartbeat 同样立即告警。

官方英雄榜是装备权威来源；DPSWOW 只补天赋等缺失字段，不能覆盖最后一次有效官方装备。英雄榜异常或数据明显不完整时保留旧快照并记录告警。

## 12. 实施范围、顺序与验收门槛

这不是对当前脚本的小幅或渐进式对齐，而是新增并替换多个生产子系统。现有启动时内嵌 migration、进程内 SimC `activeRun`、清空 `pages-dist`/Pages repo push、异步 spawn publisher、mtime/两天备份健康检查、POSIX runner 和未签名 wow-db import 都只能作为需求参考，不能直接进入正式链路。

| 工作流 | 目标交付物 | 替换/隔离的现有能力 |
|---|---|---|
| Windows runtime | `ops/windows`、runtime manifest、`WowHelper.ProcessHost`、专用账号、本机管理认证/named pipe、Task XML、退出码 | loopback 无认证、Unix PATH、`process.kill`、直接 `child.kill`、`ditto`、macOS SimC 默认路径 |
| 本机数据层 | 外部 business migration runner、backup-health gate、双目标备份 | 启动时 `database.migrate()`、内嵌 schema 变更、mtime 健康检查 |
| 调度层 | `scheduler.sqlite`、单实例锁、Job Object、来源优先级 | 进程内 `activeRun` 和各入口直接 spawn SimC |
| Publication | 授权/脱敏 DTO、内容寻址 revision/多签名 bundle、Draft Release ingress、pinned Actions Pages deployment | 直接删除重建 `pages-dist`、独立 repo push、异步 npm publisher |
| 控制面 | gateway + SafetyGate 分权/ledger、ControlPlane DO、D1 migration/一致快照 export/recovery、服务凭证 | 当前不存在，属于全新子系统 |
| 供应链/灾备 | wow-db detached signature、trust store、完整服务与 D1 恢复演练 | 同包 SHA-256 校验和手工交接 |

严格按以下阶段推进，每阶段独立验收后才进入下一阶段：

1. plan review；冻结 D1/SafetyGate、Windows、Pages、签名、隐私、备份和恢复协议。
2. 先以独立 safety commit 禁用旧 Pages 直推入口/凭证并启用 CI denylist；验收后才建立 Windows runtime foundation、本机管理认证/自动化调用 ACL、外部 business migration runner、双目标备份/backup-health，完成本机与替代电脑恢复，不接公网。
3. 新建持久化统一调度器与 `WowHelper.ProcessHost`，把管理员/每日任务迁入并完成 Windows 故障测试。
4. 新建授权/脱敏 publication builder、内容寻址多签名 revision bundle、Draft Release ingress 和 pinned GitHub Actions Pages deployment；在管理员明确确认后设置目标仓库可见性，审计并清理旧 Pages/Git 历史，仅启用静态浏览。
5. 经管理员批准后创建严格独立的 staging 资源，先用固定 API/Wrangler 完成 D1 export/Time Travel/quarantine import 和环境 hard guard 合同测试；通过后才新建 production SafetyGate/gateway/ControlPlane/D1 schema、migration、SafetyGate 双目标 ledger、12 小时一致 export 与隔离恢复，production 始终先保持 SafetyGate blocked。
6. 接入只读 simulation-input、executor fencing 和游客结果查询；完成至少 100 并发、恢复 epoch、DoS 暂停和隐私测试，按 30 次以上基准计算 `dailyLimit`。
7. 完成端到端 canary 后人工开放游客申请，观察至少 7 天再决定额度或保留期。

进入阶段 2 前本文必须 review 通过；阶段 2 的旧 Pages 入口 safety commit 未验收前，不得执行该阶段其他工作。进入阶段 4 前，现有公开真实姓名/服务器/内部 ID 的生成和发布路径必须停用并完成历史审计，仓库转 public 必须经管理员单独确认。进入阶段 5 前必须批准 staging 资源清单并证明其所有 ID/namespace/credential 与 production 隔离；不能取得独立 staging Pages 时不得拿 production 代测。进入阶段 7 前，本机管理认证、本机/D1 migration、SafetyGate 分权/ledger/quarantine、固定工具链 D1 一致 export/全丢失恢复、append-only signature history、wow-db 来源验签、Draft Release ingress/Actions Pages 回滚、双目标不可变备份、完整服务恢复、Windows 专用账号/重认证/Job Object、统一调度、游客只读模拟、revision 保留、公开授权/再识别审计/privacy purge 必须全部验收。任何阻断项未通过都保持公网申请关闭。

## 13. 明确不做

- 不要求游客拥有 GitHub 账号。
- 不把业务 SQLite 或 wow.sqlite 提交 Git。
- 不开放管理员本机公网入站端口。
- 不用 IP、浏览器、设备指纹或单角色冷却作为业务拒绝条件。
- 不允许 Worker/D1 修改成员、规则、装备或分配记录。
- 不允许游客提交任意 SimC profile、脚本、线程数或 iterations。
- 不把 GitHub Release Asset 当作唯一业务备份。
- 不在 plan review 通过前开始应用代码或云资源改造。
