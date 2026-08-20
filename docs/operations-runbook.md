# WoW Helper 常用运维手册

> 本文档是当前运维操作规范的唯一事实来源；当前架构为管理员本机主库 + GitHub Pages + Cloudflare 中转。每次操作完成后记录到独立的 [操作日志](operations-log.md)。禁止在文档、Git、命令输出或日志中记录密码、Cookie、AccessKey、会话密钥或完整 Token。

## 1. 当前状态

| 项目 | 当前值 |
|---|---|
| 文档状态 | 本地优先方案处于 review 阶段，公网匿名申请尚未实施 |
| 当前应用版本 | `0.1.0` |
| 业务数据库 schema | `5` |
| 生产权威环境 | 管理员本机 |
| 唯一可写业务主库 | 本机 `loot-allocator.sqlite` |
| 公开浏览 | 计划使用 GitHub Pages 脱敏快照 |
| 匿名任务中转 | 计划使用 Cloudflare Worker/D1 |
| 时区 | `Asia/Shanghai` |
| GitHub 仓库 | `https://github.com/zoroperona/wow-helper` |
| GitHub 身份 | 个人账号 `zoroperona`；禁止公司账号/邮箱/凭据 |

阿里云方案因成本和性价比已搁置。[云部署计划](cloud-deployment-and-release-plan.md)、[阿里云规格](aliyun-resource-sizing.md)和 `ops/systemd/` 只作为历史设计保留，不是当前操作依据。

## 2. 运维原则

1. 本机业务 SQLite 是唯一可写主库；Pages、D1、GitHub Release 和备份仓库都不能反向覆盖它。
2. 业务 SQLite、`wow.sqlite`、会话、密钥和本机环境文件不得提交 Git。
3. GitHub 管理源码、migration、CI、版本 Tag、Release 和公开 Pages artifact。
4. Pages 只发布从一致性快照生成的白名单 DTO；D1 只保存短期匿名任务、脱敏结果及控制面 ledger/index，不保存业务权威数据。
5. 所有 SimC 来源必须经过同一个持久化本机调度器；Web、每日任务和 Worker 不得直接并发启动 SimC。
6. 高风险变更先生成并验证双目标备份，再变更，后验证，并保留明确恢复点。
7. 未标注“已实现并验证”的命令和服务都属于计划，不能直接用于生产。
8. 操作流程变化更新本文；真实执行历史只更新 [操作日志](operations-log.md)。
9. D1 restore、migration 或控制状态异常时，必须先在 D1 外部关闭 SafetyGate；任何恢复点内的 open/credential/lease/publication 状态都不自动受信。
10. GitHub Release/Asset 只是传输渠道；wow-db 必须以本机固定公钥验证 detached signature，Pages 只通过当前仓库 GitHub Actions Pages artifact/deployment 发布。

当前方案协议见 [本地优先 GitHub Pages 与匿名模拟申请计划](local-first-github-pages-simulation-plan.md)。

## 3. Git 与发布身份检查

首次 commit、Push、Tag 或 Release 前执行：

```bash
git rev-parse --show-toplevel
git status --short --branch
git remote -v
git config --local --get user.name
git config --local --get user.email
git config --local --get core.sshCommand
```

必须确认：

- 仓库根为当前 workspace。
- 分支为 `main`。
- `origin` 为 `git@github.com:zoroperona/wow-helper.git`。
- 本地身份为 `zoroperona <zoroperona@users.noreply.github.com>`。
- SSH 使用个人 key，不回退到全局公司身份。
- `git status` 中没有 SQLite、zip、会话、密钥、`.env` 或生成目录。

发现身份或 remote 不一致时停止 Push，先修复仓库级配置。不得为“方便”删除本地身份覆盖。

## 4. 每日巡检

### 4.1 当前本机检查

```bash
cd /path/to/wow-helper/loot-allocator
npm run build
node scripts/validate-runtime.mjs
```

检查清单：

- [ ] 本机完整版页面能通过 loopback 正常访问。
- [ ] 主库 `PRAGMA quick_check` 为 `ok`。
- [ ] 最近一次双目标已验证备份不超过 20 小时；超过 22 小时业务必须 fail closed，超过 24 小时只允许恢复/备份操作。
- [ ] 独立备份磁盘和异地仓库均可访问，最近 manifest/verification receipt/hash 一致。
- [ ] 至少一个目标处于 WORM/Object Lock 保留期内或离线介质已物理断开。
- [ ] 磁盘剩余空间充足。
- [ ] 统一调度器只有一个实例，没有长期卡住或遗留 SimC 进程树（Windows Job Object / POSIX 进程组）。
- [ ] 官方英雄榜刷新和每日全团模拟没有集中失败。
- [ ] wow-db Build 与 `wow-db.lock.json` 一致。
- [ ] Pages 显示预期应用版本、publication revision 和 Build。
- [ ] Worker 的 active publication 与 Pages 一致，未终态任务不超过 20。
- [ ] SafetyGate 与 D1 restore epoch 一致，最近 D1 双目标 export 不超过 20 小时。
- [ ] 匿名申请关闭时，页面按钮和 Worker 都 fail closed。
- [ ] `wowhelper-runtime` 任务最近退出码正常；`AUTH_REQUIRED` 时旧英雄榜快照保留且未发布新 revision。

Worker、D1、统一调度器、双目标备份和统一巡检脚本仍待实施；实施前只执行已有本机检查，不得把计划项记为成功。

### 4.2 本机管理认证

- [ ] 本机服务只监听 loopback HTTPS，但不把 `127.0.0.1` 当作身份；所有业务写入、手动模拟、发布、备份/恢复和配置 API 在后端验证管理会话与权限。
- [ ] 首个管理员只能在交互式 `wowhelper-runtime` console 用 CLI bootstrap；密码使用 Argon2id（至少 64 MiB/3 iterations/parallelism 1/16 byte salt），pepper 只存 Windows Credential Manager，不进入命令行、环境变量或日志。
- [ ] session 为内存中 256 bit 随机值，重启即失效，闲置 30 分钟/绝对 8 小时过期；Cookie 使用 `Secure; HttpOnly; SameSite=Strict; Path=/`，每个 mutation 校验 CSRF header 和精确 loopback Origin。
- [ ] Task Scheduler/wrapper 不复用浏览器 session，只通过 ACL 限定 `wowhelper-runtime` 的 named pipe 或独立 Credential Manager service secret 调用最小权限本地接口。
- [ ] 密码重置前停服并取得 verified 备份，只在交互控制台执行；重置后撤销全部会话并记录操作日志。主机用户已被恶意软件控制时按主机失陷处理，不认为 loopback 认证仍可信。

## 5. 代码更新与应用版本

### 5.1 开发与 PR

```text
创建分支 -> 修改代码/migration -> 本地测试 -> PR -> CI -> 合并 main
```

本地验证：

```bash
cd /path/to/wow-helper/loot-allocator
npm ci
npm run typecheck
npm test
npm run build

cd /path/to/wow-helper/wow-db
dotnet restore WowDb.slnx
dotnet test WowDb.slnx -c Release
dotnet build WowDb.slnx -c Release
```

### 5.2 创建 Tag

- [ ] `main` CI 通过。
- [ ] `package.json` 和网页版本等于目标版本。
- [ ] Tag 格式为 `vX.Y.Z`。
- [ ] migration 已在主库备份副本验证。
- [ ] Release Notes 说明用户变化、schema 和手工升级步骤。
- [ ] 待提交内容没有数据库、秘密或大体积生成物。

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

GitHub Release 只表示构建产物已发布，不表示管理员本机已升级。

### 5.3 管理员本机升级

1. 暂停匿名领取、每日流水线和统一调度器。
2. 等待当前任务完成；必须取消时按第 10 节按平台终止完整进程树。
3. 运行一次双目标发布前备份并取得 verified `backupId`。
4. 拉取并校验指定 Tag/Release artifact 和 SHA-256，不追随未固定的 `latest`。
5. 在隔离目录安装依赖、构建并使用主库副本验证 migration。
6. 停止本机 Web；确认主库无其他打开者。
7. 按第 5.4 节执行版本化 migration；应用启动不得隐式修改 schema。
8. 启动新版并检查版本、schema、成员、规则、分配和一条无破坏性模拟。
9. 重新生成并发布 Pages revision；确认 D1 revision 切换成功后恢复匿名领取。
10. 失败时按 schema 兼容性决定回退应用或恢复发布前主库，不允许直接猜测降级。

应用启动隐式 migration、正式本机安装/回滚脚本和 Release workflow 目前仍待改造。

### 5.4 本机 migration 状态机

- [ ] migration 文件命名为 `<sequence>_<name>.sql|mjs`；migrationId 唯一，checksum 为原始文件 bytes 的 SHA-256。
- [ ] 已合并/执行文件禁止修改、替换、删除或复用 ID；现有 schema 5 先核对结构指纹并登记 `0005_baseline`。
- [ ] `schema_migrations` 保存成功基线；`migration_attempts` 以不可变 attemptId 追加记录 `running/success/failed/unknown`、checksum、from/to schema、时间和前后结构指纹。
- [ ] runner 持有全局维护锁，停止 Web/Worker/定时任务并确认无 SQLite 打开者；`AUTO_MIGRATE=0`，应用 schema 不匹配时 fail closed。
- [ ] runner 先记录 running，再以 `BEGIN IMMEDIATE` 执行单个 migration；migration 禁止外部网络/文件副作用。
- [ ] schema/data、success 基线和 attempt success 在同一事务提交。
- [ ] 报错 rollback 后核对升级前结构指纹、关键表和 `quick_check`；完全恢复才记 failed。
- [ ] 遗留 running、验证不完整、checksum 冲突或部分执行均视为 unknown；新旧应用一律禁止启动，恢复发布前 verified 备份或人工取证。
- [ ] failed 只有确认完整 rollback 后才能以相同 migrationId/checksum 新建 attempt 重试；success 重跑只校验 checksum 后 no-op。
- [ ] CI 已验证 N 对旧 schema 的预检和升级后读写，以及 N-1 对升级后 schema/数据语义的读写兼容。

回滚决策：N/N-1 兼容门禁通过且 N 尚未写入 N-1 无法理解的数据时，允许只回退应用；否则停止写入并恢复发布前业务库。生产不做 schema 降级，migration 使用 expand/contract，破坏性 contract 至少延后一版。

## 6. 业务主库备份

### 6.1 自动计划

- 每 12 小时在 03:15 和 15:15 各生成一次备份。
- 应用发布、migration、批量成员导入和赛季切换前额外生成。
- 备份必须写入独立物理磁盘和异地加密仓库；任一目标失败则不是 verified。
- 至少一个目标必须保存不少于 30 天的 WORM/Object Lock 加密 bundle，或在备份后物理离线；日常写入凭据不能删除或缩短保留期。不得未经兼容性验证就把需维护锁/prune 的 restic 仓库直接置于 Object Lock。
- GitHub Release Asset 只能是额外副本，不能替代上述两个目标。

### 6.2 生成与验证

当前已有 SQLite Backup API 脚本：

```bash
cd /path/to/wow-helper/loot-allocator
npm run build
node scripts/backup-database.mjs
```

目标自动化流程：

1. 获取维护锁。
2. 使用 SQLite Backup API 写入临时快照，不复制活跃 WAL/SHM。
3. 执行 `PRAGMA quick_check`。
4. 计算文件 bytes 和 SHA-256。
5. 上传前生成唯一 `backupId` 的不可变 `backup-manifest/v1`；不填仓库 locator 或验证结果。
6. 使用 restic 或 review 通过的等价工具把快照和 manifest 加密写入两个仓库。
7. 分别读回并验证 manifest hash、快照 bytes/SHA-256 和完整性。
8. 上传后生成新的追加式 `verification-receipt/v1`，记录 manifest SHA-256、两个仓库 snapshot/object ID、验证结果和最终双目标验证时间 `verifiedAt`，将相同 receipt bytes 写入两个仓库。
9. 分别读回两个 receipt 并确认 SHA-256 相同、两个目标验证均成功，backupId 才派生为 verified；单目标 receipt 或任一读回失败都不算 verified，禁止回写 manifest。

manifest 记录备份内容事实及 SQLite 快照的 `generatedAt`；receipt 记录上传位置、读回验证事实及 `verifiedAt`。两者的 ID 和对象名都禁止覆盖，receipt 不记录自己的仓库 locator，避免生成循环；不记录密码和恢复密钥。

### 6.3 密钥与保留

- 密码管理器保存主恢复密码，离线密封副本保存灾备恢复信息。
- 独立加密 `disaster-recovery-inventory/v1` 元数据清单必须列出：受保留 revision 所需的每赛季随机 publicPlayerKey 映射 artifact/keyVersion、幂等 tombstone 历史 HMAC digest keyVersion、artifact signing 历史公钥/有效期/撤销时间/`compromisedFrom` 与 trusted bundle hash 索引、配套加密秘密包 locator/SHA-256、executor/publisher 强制轮换授权、Cloudflare/GitHub 管理恢复方式、应用/Node/SimC/wow-db 版本、Task Scheduler XML/hash、私有 simulation-input 和相应密钥引用。历史 HMAC digest key 原值保存在独立灾备密钥加密的秘密包中；清单不保存秘密明文，两者都不进入 Git/Pages/D1。
- 保留 14 个每日、8 个每周、12 个每月恢复点。
- 每月隔离目录恢复；每季度在替代电脑恢复业务库和全部运行资产，轮换服务凭证，并验证发布 Pages 和游客 canary。
- RPO 目标 24 小时，20 小时告警、22 小时 fail closed、24 小时只允许恢复/备份；高风险操作以操作前 verified 备份为准；同机 RTO 4 小时，替代电脑 RTO 8 小时。
- 密钥验证、prune、恢复演练和实际 RPO/RTO 写入 [操作日志](operations-log.md)。

双目标仓库、加密工具、定时脚本和 manifest 仍待选择/实现；未完成前，公网匿名申请不得启用。

### 6.4 备份新鲜度写门禁

- [ ] 只有两个目标 receipt 均读回成功时，备份验证器才原子更新只读 `backup-health.json`；至少保存 `backupId`、`generatedAt`、`verifiedAt`、两个 receipt SHA-256 和验证器版本。
- [ ] 管理写 API、统一调度器、publisher 和游客 Worker 领取前都调用同一个 guard。
- [ ] 新鲜度只按内容快照 `generatedAt` 计算；`verifiedAt` 只证明双目标验证完成，`reportedAt` 只表示 D1 接收，二者都不能刷新 RPO 时钟。
- [ ] content age 超过 20 小时告警并禁止高风险变更；超过 22 小时所有业务写入、游客创建/领取和每日模拟返回 `503 BACKUP_STALE`；超过 24 小时提升为 RPO breach。
- [ ] 状态文件缺失/损坏、receipt hash 不符或系统时钟倒退一律按超过 24 小时 fail closed。
- [ ] `accepting_requests` 只存在于 D1 `system_gates`；只有 publisher 能经 gateway -> ControlPlane 显式开关，ControlPlane 内部只能在固定 fail-close 转换写 0，backup-monitor 只新增 receipt，外部监控不得直写 D1。SafetyGate 的 `open_not_after` 只能凭 verified backup attestation，以双目标 committed `renew-open-expiry` authorization -> DO CAS 单调推进，且不能把 blocked 改 open；到期由 gateway 自动 fail closed，外部 watchdog 只有 gate-closer 权限。

## 7. 恢复业务主库

恢复可能丢失恢复点之后的写入，必须人工确认：

- [ ] 先关闭 D1 外部 SafetyGate 和游客申请；业务库恢复不自动恢复或信任 D1 控制状态。
- [ ] 停止本机 Web、每日任务、Worker 和调度器。
- [ ] Windows 使用专属 Job Object 控制完整 SimC 进程树：先优雅停止，10 秒后仍存活才 `TerminateJobObject`；按 PID + 创建时间 + task/Job 标识防止 PID 复用误杀。macOS/Linux 才使用进程组 SIGTERM → SIGKILL。
- [ ] 确认任务锁释放，并用 `lsof`/`fuser` 或平台等价工具确认 SQLite 无打开者。
- [ ] 保存事故现场库；不要在活跃库旁随意删除 WAL/SHM。
- [ ] 选择 verified 恢复点，记录时间、schema、应用版本和预期数据损失窗口。
- [ ] 解密到临时目录并验证 manifest、覆盖两个目标的 verification receipt、SHA-256 和 `quick_check`。
- [ ] 确认恢复库 schema 与将运行的应用兼容。
- [ ] 备份当前目标文件后原子替换主库。
- [ ] 启动应用并核对关键表数量、最近记录、管理员操作和一条模拟。
- [ ] 替代电脑创建 `wowhelper-runtime`、安装 runtime manifest/ProcessHost/SimC/Chromium，按灾备凭证清单恢复应用、wow-db trust store、Task Scheduler、历史 keyVersion 和私有 simulation-input；Armory profile 通过同一用户交互登录重建，不恢复 Cookie。
- [ ] 按第 9.7 节验证或恢复 D1，提升 restore epoch 并强制轮换 executor/publisher/backup-monitor；只恢复业务数据库不算达到 8 小时完整服务 RTO。
- [ ] 重新生成公开快照；不得让旧 D1 结果覆盖恢复后的业务状态。
- [ ] 将恢复点和实际数据损失窗口写入 [操作日志](operations-log.md)。

禁止从 Git、Pages、D1 或来源不明的普通文件副本恢复业务主库。

## 8. wow-db 更新

### 8.1 Windows 生成交接包

```powershell
cd C:\path\to\wow-helper\wow-db
./scripts/export-transfer-package.ps1 -Client "D:\World of Warcraft"
```

如包含服务器热修，显式提供实际 `DBCache.bin`。正式交接包必须生成 RFC 8785 canonical `transfer-manifest/v2.json`、逐文件 SHA-256、包外 zip SHA-256 和独立 `wowdb-transfer-signing` Ed25519 detached signature；只有本地验签、失败表为零且 Build 正确时才能创建 `wowdb-<build>-cn-zhCN` Release。Tag、文件名和资产禁止有意复用或覆盖，但 GitHub Asset 可被替换，真实性不能依赖它。

### 8.2 本机导入

```bash
cd /path/to/wow-helper/loot-allocator
npm run wowdb:import -- /path/to/wow-db-<build>-cn-zhCN.zip --check-only
```

正式切换前：

- [ ] 使用 `%ProgramData%\WowHelper\trust\wowdb-export-keys.json` 中经 out-of-band 核验的固定公钥，先验证 detached signature、key validity/撤销状态和包外 zip hash；trust store 不从同一 Release 自动更新。
- [ ] 解压采用版本锁定的 cross-platform reader并拒绝绝对路径、`..`、符号链接和目录逃逸，不调用 `/usr/bin/ditto`。
- [ ] 验证 manifest 中 `wow.sqlite/snapshot.json/report.json` 的 bytes/SHA-256、Build、关键表和 `quick_check`；同包 manifest 与数据库一起被替换时必须验签失败。
- [ ] 暂停调度器并停止 Web/WowDbCatalog 使用者。
- [ ] 保留上一版 `wow.sqlite`。
- [ ] 导入到临时位置后原子替换。
- [ ] 重启或显式 reload，确认应用实际加载目标 Build。
- [ ] 检查掉落目录、装备详情和一条模拟。
- [ ] 重新发布 Pages；失败则恢复上一版数据库和 publication。
- [ ] 操作日志记录 Tag、asset URL、zip/manifest/signature hash 和 key version。

wow-db signing key 正常轮换必须由旧 key 交叉签署新公钥记录；疑似泄漏时通过独立渠道更新本机 trust store，记录 `compromisedFrom` 并拒绝不可信签名。wow-db 更新不得修改业务 SQLite，也不得自动切换 active season。详细导出说明见 [wow-db 运维手册](wow-db-runbook.md)；其中 ECS/OSS 内容属于历史云方案，不是当前传输契约。

## 9. 公开 Pages 与 Worker

### 9.1 发布快照

- [ ] 从 Backup API 快照或同一只读事务生成。
- [ ] 成员级 DTO 默认关闭，只有当前赛季明确 opt-in 且未撤回的成员进入；专用 DTO 逐字段白名单构造，不展开内部对象。
- [ ] publicPlayerKey 每赛季随机生成；装等以 5 级分桶、DPS 以 5% 或至少 5000 分桶、收益以 0.5 百分点分桶、时间降到自然日/赛季周。
- [ ] 递归扫描真实姓名、服务器、内部 ID、完整装备组合、精确装等/DPS/时间、profile、日志、备注、会话和管理员字段；公开 Armory/日志关联后少于 3 个候选的组合继续分桶或抑制。
- [ ] 临时目录完整构建并生成 `publication.json`。
- [ ] manifest 包含版本、commit、schema、Build、season、key version 和每个文件 SHA-256。
- [ ] 以 RFC 8785 `publication-identity/v1` 的完整 SHA-256 生成不截断 `pub-v1-<64hex>` revision；identity 绑定 public files/simulation-input manifest、应用/commit/schema/Build/season/key version/generatedAt。同 identity 可幂等复用，同 revision 不同 identity 立即 fail closed。
- [ ] revision bundle 包含不可变 Ed25519 detached `artifact-signature/v1`；RFC 8785 canonical payload、`signedAt`、keyId/keyVersion、有效期和所有 manifest hash 均通过验证。签名文件只能追加为 `signatures/<signatureSha256>.json`，不覆盖固定路径；在线 HMAC 不替代 artifact signature。
- [ ] D1 与灾备清单中的 signing key registry 一致；正常 retired key 的有效历史签名可回滚，revoked key 只允许 `compromisedFrom` 之前且 `revokedAt` 前已进入 trusted history 的 bundle。无法建立信任时必须用当前 active key 重签可信 bundle 或进入人工灾备流程，禁止绕过验签。
- [ ] 每次签名/重签向 D1 `publication_signature_history` 追加 immutable 行；历史行包含 signature payload、revision identity、content/publication/public files/simulation-input 全部 hash 及 key/time，UPDATE/DELETE 必须被 trigger 拒绝。current signature 选择和 active 切换两个 trigger 都必须拒绝任一 hash/key/time 不一致。
- [ ] 本机 staging 目录按 allowlist 打包，双端拒绝 SQLite/WAL/SHM、私有 simulation-input bytes、profile/Cookie、密钥、日志、source map、符号链接、未知类型和 path traversal；私有输入只上传 manifest hash。
- [ ] 以唯一 `pages-ingress/<revision>/<manifestHash>` Draft Release/tag 上传确定性 bundle/manifest/signature，读回 asset ID/bytes/hash 后再 `workflow_dispatch`。uploader/dispatcher 使用两个 repo-only、30 天过期的 fine-grained PAT，分别只有 Contents write 和 Actions write，仅存 Credential Manager。
- [ ] Actions 以 pinned 公钥、D1 read model、asset ID/name/hash、ingress signature/revision/source commit 验源；只通过当前仓库 `upload-pages-artifact` + `deploy-pages` 发布，停用独立 repo push 和现有 `deploy-pages.mjs`。
- [ ] 实施的首个 safety commit 已删除 `pages:publish`，移除或硬失败 `deploy-pages.mjs`，撤销旧 push 凭证，并由 CI denylist 阻止旧命令、脚本、remote/credential 名称重新出现；未满足时不得进行其他实施或创建云资源。
- [ ] 所有 Actions 锁定完整 commit SHA，workflow 顶层 permissions 为空；verify job 只 `contents: read`，deploy job 只 `pages: write/id-token: write`。`main` 和 `github-pages` Environment 受保护，reviewer 为个人账号 `zoroperona`，`pages-production` concurrency 不取消运行中发布。
- [ ] 仓库目标状态为 public；变更前必须人工确认并完成公开内容审计。实际账号 Pages 资格、Actions minutes/storage、artifact/Pages 尺寸和频率限制已验证；超限时保持旧页并关闭申请，不走绕过路径。
- [ ] artifact 使用 `/revisions/<revision>/` 不可覆盖路径，包含 active + 前 2 个 retained；Actions artifact 保留 90 天，本机仍保存完整回滚 bundle。
- [ ] 新有效 key 清单先进入 D1 staged。
- [ ] 取得 Pages deployment ID 后，用 cache-busting URL 连续 3 次验证目标 manifest/全部 hash，最长 10 分钟；成功后 D1 才原子切 active，旧 revision grace 30 分钟。
- [ ] grace 结束只停止新申请，不删除旧 key 清单或 simulation-input；旧 revision 至少保留 active/grace/staged 与前 2 个成功 revision 的完整 bundle。
- [ ] 删除 revision 前确认未终态任务为 0、最后任务终态已超过 24 小时且不在回滚集合；顺序固定为 D1 条件事务写 deletionApprovedAt → 删除本地 bundle → 删除 D1 key 清单。无 approval 禁止删除，且禁止先删 key 清单。
- [ ] 旧 revision 已清理时，回滚只能从本地已验证 bundle 重建并校验 `publication.json`、key 清单和 SHA-256 后 staged。
- [ ] 任一步失败保持旧 D1 active；新 Pages deployment 可见但未激活时 loader 必须禁止申请，并重新部署旧 artifact。回滚先 staged、部署/验证旧 Pages artifact，最后切换 D1 active。
- [ ] 成员撤回后执行 privacy purge：新 artifact 不携带含其明细的旧 revision，当前和全部本地回滚集合移除明细；按 purge manifest 删除 Actions artifact、Draft Release asset/Release，停用/尽可能删除旧 Pages deployment，验证所有已知 revision URL 404/410。24 小时后 GitHub 自有路径仍可访问则关闭整个 Pages site 并升级支持请求；第三方缓存/截图无法保证撤回，必须在授权时披露。

### 9.2 匿名申请门槛

只有两个业务门槛：

- 未终态 `queued + leased + running` 最多 20。
- 每日成功入队额度为压测计算值，绝对不超过 500。

不得加入 GitHub 登录、IP、浏览器、设备指纹、单角色冷却或 Turnstile 作为业务准入。WAF、HTTPS、POST-only、body/schema 上限属于安全协议，不增加用户配额规则。

已接受的风险：合法格式低速请求可占满游客队列/日额度，第一阶段不声称能防止。监控持续满队列、额度消耗斜率和来源分布；满队列 5 分钟、10 分钟消耗 25% 日额度或人工确认滥用时关闭游客创建/领取。管理员和每日任务继续走本机高优先级队列且不消耗游客额度。恢复游客申请需人工确认；不得私自新增第三个业务门槛。

### 9.3 暂停与故障

- 紧急暂停必须同时让页面按钮和 Worker 创建接口 fail closed。
- 已入队任务保留；本机 Worker 停止领取。
- Pages/Worker revision 不一致时禁止新建申请。
- D1 不可用时不影响本机管理员功能和静态浏览。
- 本机离线时任务留在 D1；恢复后只能凭有效 lease/fencing 继续。

Worker/D1 尚未创建；当前不得把上述检查当作已部署能力。

### 9.4 服务凭证

- [ ] `executor`、`publisher` 与 `backup-monitor` 使用不同的 256 bit HMAC secret、credentialId、scope 和 epoch。
- [ ] 本机 secret 只保存在 OS 凭据库，Cloudflare 副本只保存在 Worker Secret，不进入 D1、Git 或日志。
- [ ] 每个控制请求的 HMAC canonical bytes 包含 credential epoch 和 restore epoch；请求 epoch 必须同时匹配 D1 与外部 SafetyGate，nonce 主键也包含 restore epoch，最大时钟偏差 5 分钟。
- [ ] executor 只能领取、续租和回写；publisher 只能 staged/activate/rollback publication 和控制申请开关。
- [ ] backup-monitor 只能上报新的双目标 verified receipt；请求包含 `generatedAt/verifiedAt`，`reportedAt` 由服务端生成。要求 `generatedAt <= reportedAt`、content age 不超过 22 小时、验证后 1 小时内上报；只对 `verifiedAt` 接受最多 5 分钟服务端时钟容差，且 `generatedAt` 严格单调递增。旧 backupId/receipt hash/乱序重放不能刷新 `backup_generated_at`。
- [ ] Cloudflare 部署 Token、GitHub Token 和游客 querySecret 不得作为运行时控制凭证。
- [ ] 正常轮换重叠不超过 15 分钟；泄漏时提升对应 epoch 并撤销该权限域旧凭证。

### 9.5 D1 / Durable Object 控制面

- [ ] gateway Worker 只有独立 `SafetyGate` DO 和 control service binding，无 D1/ControlPlane binding；control service 独占生产 D1/ControlPlane 且没有普通公网路由。
- [ ] SafetyGate 在 D1 外保存 blocked/open 与单调 restore epoch；状态缺失/不可达/epoch 不符时 gateway 对 mutation 返回 503，不能读取恢复点内的 open 状态自动开放。
- [ ] local、staging、production 使用两两不同的 D1 database、SafetyGate/ControlPlane DO namespace、Worker、Pages project/Environment 和 signing/service/recovery/ledger credential；target manifest、D1 environment identity、Environment scope 和 resource ID 四重 hard guard 均匹配后才能远程写。staging 注入任一 production ID 必须在网络请求前失败。
- [ ] DO 在完整异步写操作期间持有 FIFO mutex；D1 为事实源，内存不保存权威配额或状态。
- [ ] DDL、唯一索引、quota trigger、条件 UPDATE/RETURNING 与 plan 6.2 完全一致并由独立 D1 migration 安装。
- [ ] `service_credentials` 固定 executor/publisher scope、epoch、状态和有效期；nonce 与业务 mutation 同一 batch，重放会整体 rollback。
- [ ] 新申请的 request 插入与 daily counter 增量由同一 D1 事务/trigger 完成；队列上限 20 和 dailyLimit 不能先查后裸写。
- [ ] request trigger 同时强制 revision season/key version 与 request 一致；`query_secret_hash` 为 NOT NULL 的 64 位 lowercase SHA-256 hex，`query_secret_expires_at > created_at`。错误 season/key version、NULL/错误 hash 或无效过期时间都不得占 quota。
- [ ] 领取、heartbeat、终态回写必须依赖 attempt、lease hash、fencing、状态、过期时间和 affected rows；普通 lease 为 120 秒/30 秒 heartbeat，maintenance 窗口为 900 秒硬截止，期间不得 heartbeat 或回收，退出时恢复 120 秒 lease。
- [ ] `publication_control(singleton=1)` 是唯一 active pointer；target 的 current signature 必须与 revision identity/content/publication/public files/simulation-input 全部 hash、signing key 和有效时间一致，并且 Pages deployment 已验证。current signature 选择和 active 切换均有 D1 trigger 复验，切换和删除审批只允许 DO 串行执行。
- [ ] revision 只能按 draft -> 选择可信 current signature -> staged 转换；DDL CHECK/trigger 禁止 staged/active 缺失 current signature，且签名一旦选择后任何状态转换都不能清空，只能原子换成另一条有效历史签名。pointer-clear 测试必须失败。
- [ ] payloadHash 使用 RFC 8785 白名单对象；查询凭证到期后 tombstone 只保存版本化 HMAC digest 和时间，不保存 requestId/payloadHash，同 key 返回 410 且永不复用。所有历史 digest key 作为 match-only 只读 keyring 永久在线且写入灾备秘密包；旧 key 不再生成 tombstone，但不得删除。
- [ ] `backup_receipt_guard/activate` 原子强制 `generatedAt <= verifiedAt`、`generatedAt <= reportedAt`、verified 时钟 5 分钟容差、22 小时 content age、1 小时上报延迟和严格单调 `backup_generated_at`；request trigger 强制 `0 <= createdAt-backupGeneratedAt <= 22h`，未来快照不可当作新鲜备份。
- [ ] DDL CHECK 保证 succeeded/failed/expired 必须有 `terminal_at`，queued/leased/running 必须为 NULL；24 小时过期、lease 失败和恢复强制 expired 都在同一条件 batch 写 terminal time、清 lease 并提升 fencing。
- [ ] 至少 100 并发请求及 DO/D1 重启/restore epoch 测试证明不超额、不双领取、不双 active、不接受旧 lease、旧 credential 或 nonce 重放。

### 9.6 D1 migration 与发布

D1 migration 独立于第 5.4 节本机业务 SQLite migration；必须使用 `d1/migrations/`、`d1_schema_migrations`、`d1_migration_attempts` 和 `d1_schema_state`，禁止共用版本号、ledger 或恢复点。

- [ ] migrationId 唯一，checksum 是文件原始 bytes 的 SHA-256；已执行文件不可修改、替换、删除、跳号或复用 ID。
- [ ] control service N 和 N-1 均声明 min/max D1 schema；真实 migration 链已验证旧 schema + N、新 schema + N、新 schema + N-1，并核对 fingerprint、trigger 和关键不变量。
- [ ] migration 采用 expand/contract；contract 至少延后一版，必须等 N-1 退出回滚窗口、回填完成且旧字段兼容遥测为零。
- [ ] GitHub production Environment 已人工审批并取得单一 concurrency；CI `d1-migrator` 使用独立最小权限 Token。
- [ ] 先将 SafetyGate blocked，再关闭游客创建/领取，排空或取消有效 lease；DO 排空 FIFO mutation 后原子进入 maintenance，记录 attemptId 和 lock epoch。
- [ ] 双层停写后创建并验证 D1 Time Travel bookmark + 逻辑 recovery export；确认恢复点内 maintenance/accepting=0、`maintenance_deadline` 已记录且不超过 15 分钟，记录 recoveryPointId、restore epoch、命令和损失窗口。
- [ ] 先 staged 可兼容旧 schema 的 control N，再写 running attempt；每次 migration 校验 lock/from schema/checksum，并在原子提交内写 success ledger、attempt success、to schema 和 fingerprint。
- [ ] maintenance 下验证约束、不变量和 control N 后才部署 gateway N；先清 D1 lock 并保持 accepting=0，最后显式打开 SafetyGate 和申请开关。workflow cleanup 不得重开任一 gate。
- [ ] 明确 rollback 且旧 fingerprint/不变量正常时才记 failed，同 migrationId/checksum 以新 attempt 重试；遗留 running、部分 DDL、checksum/fingerprint 冲突或验证不完整一律 unknown/blocked。
- [ ] 只有 N-1 支持新 schema 且尚无不兼容写入时才可只回退 control service；否则保持停写并向前修复。恢复 D1 recovery point 会丢失其后的任务、结果、nonce 和 publication 变更，必须人工确认并写操作日志。

bootstrap 使用 `0001_initial` 在同一原子 batch 创建 ledger、插入 bootstrap running attempt、登记实际 checksum/success/fingerprint、把 schema 0 -> 1 并置 open；batch 失败从空库重试，禁止手工补 baseline。任何 unsupported schema、running/unknown、checksum 或 fingerprint 异常均返回 `503 D1_SCHEMA_UNTRUSTED`；Worker/D1 尚未实施前，本节只作为目标操作契约。

### 9.7 D1 日常备份与恢复

- [ ] 每日 03:45/15:45 将版本化 D1 logical export 加密写入两个备份目标；migration、publication、credential/signing key 变更前后额外执行。manifest/receipt 签名，至少一份不可变或离线。
- [ ] export 包含 schema/ledger、任务/结果、quota、credential 元数据、publication/signature history/public keys、backup gate 和删除审批，不包含 Worker Secret；保留 14 日、8 周、12 月。
- [ ] export 前由 `gate-closer` 在当前 epoch blocked，关闭新建/领取；ControlPlane 持有 FIFO mutex，以 lock epoch 进入 maintenance，写 `maintenance_deadline=startedAt+900s`，并把当时 leased/running 的 lease 截止推进到同一 deadline。窗口内 heartbeat、回收和结果写入都拒绝；固定 `wrangler@4.124.0` 和 API v4 `/accounts/{account}/d1/database/{database}/export`，以 `output_format=polling` 取得 `at_bookmark`，每 5 秒用 `current_bookmark` 轮询并下载 SQL；普通 SELECT/分页/分表拼接禁止作为恢复包。
- [ ] 原生 export 期间会阻塞 D1 请求；export budget 为 600 秒，剩余 300 秒用于隔离 SQLite 导入、SQL/hash/schema/trigger/index/foreign key、request/counter/lease/publication/credential 不变量验证、receipt 和清锁。清锁时仍有效 lease 重置为 `now+120s`，恢复普通 30 秒 heartbeat；总 900 秒未完成或无法确认取消则保持 blocked、递增 fencing、终止本机完整进程树并按回收规则处理 active lease，不能标 verified。
- [ ] Time Travel 前用 `d1 info` 确认 backend `version=production` 和当前套餐窗口；Workers Free 按 7 天、Paid 按 30 天规划，不能固定假定 30 天。超出窗口只用 verified 双目标 SQL export 在新 quarantine D1 恢复。
- [ ] 最后成功 export 超过 20 小时告警，22 小时 SafetyGate 自动/外部确认 blocked；每月隔离恢复、每季度全 D1 丢失重建。
- [ ] SafetyGate 使用 Ed25519 hash-chain `safety-gate-ledger/v2` committed transition authorization；epoch 变更/open/open-expiry 续期必须先把同一 signed authorization 写入两个目标并读回，DO 才能 CAS 消费并保存 `appliedAuthorizationHash`。gateway 只承认引用连续 committed 链且未过期的 open；禁止 DO open/renew 后补 ledger。逐个注入双目标写/读、CAS 前后和响应丢失故障，结果只能保持原状态或得到有 committed ledger 的新状态。
- [ ] 权限严格分为：`gate-closer` 只能当前 epoch open -> blocked；一次性 `epoch-admin` 只能 blocked 并分配 max+1；独立一次性 `gate-opener` 只能在 epoch/canary attestation 匹配后 blocked -> open；`d1-recovery` 不得读写 SafetyGate。两种管理 Token 均需 production Environment 独立审批，绑定 event/epoch/action，最长 1 小时/使用一次即撤销并审计。
- [ ] 恢复前先用 `gate-closer` blocked，再用独立 `epoch-admin` 提升 restore epoch 并封存 ledger；SafetyGate 不可达时 gateway 默认 503。此步骤必须早于 Time Travel/import。
- [ ] 恢复后在 gateway 仍 blocked 时，由 production Environment 人工审批的一次性 recovery workflow 使用固定 runner 与短期 D1 Edit Token，执行 hash 已审批的仓库 recovery SQL，强制 D1 blocked/`maintenance_deadline=0`/new epoch/accepting=0、expire 非终态并写 terminal time、清 lease/增 fencing、撤销 credential/删除 nonce。Cloudflare 不提供 SQL 白名单级 Token，必须用 account/database ID allowlist、runner commit/SQL hash 审批、单一 concurrency、审计和立即撤销补偿；Token 不带 Worker/Pages/SafetyGate/Secret 权限。
- [ ] 不信任恢复出的 active publication、删除审批或 credential；验证 schema/fingerprint、append-only signature history、key registry、backup receipts，并从本机 bundle/Pages deployment 重建目标 publication。
- [ ] 生成绑定新 restore epoch 的 executor/publisher/backup-monitor 凭证。全丢失且 tombstone/request 不可恢复时生成全新 publication revision，旧页面重试返回过期/不可用，不重新激活原 revision。
- [ ] canary 必须证明旧 lease、旧 HMAC、旧 nonce 和旧 epoch 全部拒绝。先置 D1 open 且 accepting=0，再审批 `gate-opener`；核对 epoch/openNotAfter/canary/backup attestation，先双目标 committed authorization、后 DO CAS，确认 applied hash 后才由 publisher 人工打开申请。

重建顺序：schema/ledger -> restore epoch/双层 gate -> signing registry/history -> Pages/publication/key 清单 -> 新 service credential -> backup gate -> quota -> 新任务。恢复会丢失 recovery point 之后的任务、结果、nonce、tombstone 和 publication/审批变更，必须量化并写 [操作日志](operations-log.md)。

## 10. 统一 SimC 调度

所有手动、每日和游客任务进入持久化本机队列；优先级依次为管理员手动、每日全团、游客。全机并发固定为 1，调度器必须持有 OS 文件锁。

取消流程：

1. 标记 task 为 `cancelling`，停止领取新任务。
2. Windows 核对 PID、进程创建时间和 Job Object/task 标识后发送已验证的优雅停止；macOS/Linux 才对整个进程组发送 SIGTERM。
3. 等待 10 秒。
4. 仍存活时，Windows 调用 `TerminateJobObject`，macOS/Linux 对进程组发送 SIGKILL。
5. 确认全部后代进程退出、Job/进程组句柄关闭且锁释放后标记终态。

游客任务运行时每 30 秒续租，普通 lease 120 秒；D1 export maintenance 期间不接受 heartbeat/回收/结果写入，最长 900 秒，清锁后恢复 120 秒 lease。无法续租、lease 已失效或 fencing 不匹配时立即取消完整进程树，旧 attempt 不得回写结果。租约回收由每分钟 cron 和创建/领取事务共同执行，直接原子转换为 queued/failed/expired，不保留 `abandoned`。详细条件更新以当前 plan 第 7、8 节为准。

游客任务必须使用 publicationRevision 对应的只读私有 simulation-input；不得调用会保存装备/权重的现有通用模拟入口。游客执行器使用 `mode=ro`/`query_only=ON` 或完全不打开业务库，结果只写 D1。只有管理员和每日任务可以更新业务主库。

当前代码的进程内锁不能满足跨进程互斥；持久化队列、OS 单实例锁和 fencing 完成前，不能启用公网模拟申请。

### 10.1 Windows runtime 与英雄榜身份

- [ ] Task Scheduler 只调用 `ops/windows/Invoke-WowHelperTask.ps1`；安装器把 Node/npm/PowerShell/Chromium/SimC/repo/data/trust store 的绝对路径、版本和 hash 写入受 ACL 保护的 `%ProgramData%\WowHelper\runtime.json`。
- [ ] 正式任务统一使用本地标准用户 `wowhelper-runtime`，不是 SYSTEM、管理员或 S4U；安装器只授予 `Log on as a batch job` 和必要 ACL，不授予管理员/服务登录权限；配置“无论用户是否登录都运行”并加载该用户 profile。仅 Armory 重认证使用该账号的本地交互式会话。
- [ ] `.NET WowHelper.ProcessHost` 提供 named mutex、PID + 创建时间锁恢复、Job Object 整树取消；禁止用 `process.kill(pid,0)` 或直接 `child.kill()` 实现 Windows 生产控制。
- [ ] 所有 zip 通过版本锁定 cross-platform reader 解压并防 path traversal；脚本不含 Unix PATH、`/usr/local/bin/npm`、`/usr/bin/ditto` 或 macOS SimC 默认路径。
- [ ] 退出码固定为 0 成功、10 部分失败、20 AUTH_REQUIRED、30 gate stale、40 config/trust 无效、50 lock busy、60 timeout/cancel、70 integrity/signature、1 unknown；除 10 可保留完成成员结果外，所有非 0 禁止新 publication。
- [ ] Armory session 过期时保留最后有效官方装备并告警，不允许 DPSWOW 覆盖、不发布。管理员暂停任务后交互登录同一 `wowhelper-runtime` 桌面，运行 `Reauth-Armory.ps1`，单角色 headless canary 成功才恢复。
- [ ] 替代电脑新建相同账号并人工重建 Chromium profile；浏览器 profile/Cookie 不进入 Git、普通备份或灾备秘密包。

## 11. 本机定时任务

目标调度定义和安装脚本必须进入仓库，不维护无源码的手工任务：

| 时间 | 任务 | 门禁 |
|---|---|---|
| 03:15 / 15:15 | 双目标业务备份 | 未 verified 或距内容 `generatedAt` 超过 20 小时则告警；超过 22 小时 fail closed |
| 03:45 / 15:45 | D1 加密逻辑 export | 600 秒 export / 900 秒 maintenance deadline；超过 20 小时告警；22 小时 SafetyGate blocked |
| 04:00 | 官方英雄榜、DPSWOW 天赋补齐、全团模拟 | 全部走统一调度器 |
| 成功后 | Pages 快照与两阶段 revision 发布 | 失败保留旧 revision |
| 09:00 | D1/SimC 临时数据与备份保留策略清理 | 不删除未验证恢复点 |
| 每分钟 | D1 过期租约原子回收 | maintenance deadline 内不回收；deadline 超过 3 分钟或无法清锁则暂停新申请 |
| 每 15 分钟 | 应用、Worker、队列、磁盘、备份巡检 | 连续失败告警 |
| 每月/季度 | 隔离目录/替代电脑恢复演练 | 禁止覆盖生产主库 |

Windows 正式环境使用 Task Scheduler 的版本化导入脚本和 `wowhelper-runtime` 标准用户；其他平台只提供开发模板。Task Scheduler 必须配置 AtStartup 常驻、03:15/15:15 业务备份和 03:45/15:45 D1 export 错过后尽快运行并允许唤醒、04:00 重任务不自动补跑、禁止并行、按 1/5/15 分钟有限重试和外部异机告警。业务 backup content age 或 D1 export age 超过 20 小时告警、22 小时相应 gate fail closed、24 小时只允许恢复/备份；`verifiedAt/reportedAt` 不刷新业务 RPO。若不允许机器自动唤醒，24 小时 RPO 不成立且公网申请必须关闭。安装或更新后记录任务 XML/runtime manifest hash、账号、下次运行时间、退出码和测试结果到 [操作日志](operations-log.md)。

官方英雄榜是装备权威来源；DPSWOW 只补充天赋等字段，不能覆盖有效官方装备。单成员失败不阻塞后续成员，但整轮结果必须明确成功、部分失败或失败。

## 12. 赛季切换

1. 暂停游客创建和全部 SimC 领取。
2. 完成 verified 双目标备份。
3. 归档旧赛季规则 hash、最终 publication 和 key version。
4. 校验并导入新 wow-db/SimC Build。
5. 创建新 season、loot rules 和成员映射。
6. 在单事务中切换 active season。
7. 生成新 public key 清单和 Pages staged revision。
8. 验证管理员写入、游客静态页和模拟后启用新 revision。

任一步失败都保持旧 season active，并恢复旧 wow-db/publication；不因 wow-db 更新自动切换赛季。

## 13. 故障处置

### 本机应用不可用

1. 检查磁盘、Node 进程和 loopback 端口。
2. 暂停 Worker 领取和定时任务。
3. 最近升级后发生则对照 Tag、schema 和发布前 backupId。
4. schema 兼容时回退应用；不兼容时按第 7 节恢复数据库。
5. 本机恢复前保持 Pages 最后成功快照，不发布半成品。

### SQLite locked 或写入失败

1. 停止重复 runner、备份、导入和第二应用实例。
2. 查明所有打开者，不手工删除活跃 WAL/SHM。
3. 正常停止后运行一致性检查。
4. 需要恢复时保留事故现场库并按第 7 节处理。

### Pages 或 publication 错误

1. 立即把目标 revision 保持 staged/关闭申请；不要先改 D1 active。
2. 从本机已验证 bundle 重新上传上一完整 Actions Pages artifact，取得新 deployment ID，并连续 3 次验证 manifest/hash。
3. Pages 验证成功后才恢复上一 D1 active；新 artifact 已短暂可见时，loader 必须因 staged/不匹配而禁止申请。
4. 递归扫描授权、再识别和禁止字段；泄漏时删除当前部署、清理可控 Actions artifact/Git 历史并轮换 key。
5. 不从 Pages 数据反向覆盖主库；不使用独立 repo push 或 `deploy-pages.mjs` 紧急绕过。

### D1 migration 失败或 schema 不可信

1. 先保持外部 SafetyGate blocked，再保持游客创建/领取关闭和 `d1_schema_state` maintenance/blocked；不得由 workflow cleanup 自动置 open。
2. 保存 attemptId、migrationId、checksum、lock epoch、recoveryPointId 和前后 fingerprint，不修改已执行 migration 文件。
3. 若原子 batch 已明确 rollback，核对旧 fingerprint、关键不变量和恢复点后记 failed；只能以相同 checksum 新建 attempt 重试。
4. 遗留 running、部分 DDL、checksum/fingerprint 冲突或验证不完整一律视为 unknown，不启动旧/新 control mutation。
5. 只有 N-1 明确支持新 schema 且无不兼容写入时才可只回退 control；否则优先向前修复。必须恢复 recovery point 时，先确认其后任务、结果、nonce 和 publication 变更的损失窗口。
6. 完成真实 schema 兼容与不变量验证后，才用相同 lock epoch 清锁并恢复 gateway；全过程写入 [操作日志](operations-log.md)。

### D1 恢复、回档或全丢失

1. D1 restore 之前先由 `gate-closer` blocked，再用独立审批的一次性 `epoch-admin` 按两份有效 SafetyGate ledger 的 max+1 提升 restore epoch。ledger 分叉/不可用或 SafetyGate 不可达时保持 gateway 503。
2. 恢复后强制 D1 blocked/accepting=0/new restore epoch，expire 非终态任务并写统一 `terminal_at`、清 lease/过期时间、增 fencing、撤销旧 credential、删除 nonce。`d1-recovery` 不得读写 SafetyGate。
3. 按第 9.7 节验证或重建 schema、append-only signature history、Pages/publication/key、backup gate 和 quota；不得信任恢复出的 active pointer。
4. 发放新 epoch 凭证并验证旧 lease/HMAC/nonce 全部失败。全丢失时使用新 publication revision，不复活旧 revision 创建任务。
5. 先 D1 open/accepting=0，再独立审批一次性 `gate-opener`，核对 epoch/openNotAfter/canary/backup attestation；先将 committed open authorization 写入两个 ledger 目标并读回，再让 DO CAS 消费并核对 applied hash，最后 publisher 人工打开申请。记录实际任务、结果、tombstone 和 publication 损失窗口。

### 队列重复执行或旧结果回写

1. 暂停 Worker 和游客创建。
2. 记录 request、attempt 和 fencing token 的非秘密标识。
3. 按平台终止失效 attempt 的完整进程树；Windows 必须核对创建时间和 Job Object，不能按 PID 盲杀。
4. 拒绝旧 lease 完成写入并核对 D1 条件更新。
5. 在修复和故障测试通过前不恢复公网申请。

### 备份目标或密钥不可用

1. 按最后 verified 备份的内容 `generatedAt` 计算：超过 20 小时立即告警并阻止高风险变更；超过 22 小时禁止管理员写入、游客申请和每日模拟；超过 24 小时只允许恢复/备份。验证完成后 1 小时未成功上报 D1 也告警，但不得用 `reportedAt` 延后 RPO 门禁。
2. 不把单目标成功标记为 verified。
3. 验证密码管理器与离线恢复副本，不在日志打印秘密。
4. 修复后补做双目标备份和隔离恢复。

### 英雄榜授权失效

1. 不用 DPSWOW 装备覆盖最后一次有效官方装备。
2. 04:00 wrapper 返回 20 `AUTH_REQUIRED`，停止角色刷新和 publication，显示数据更新时间并立即告警。
3. 暂停游客领取和每日任务，交互登录同一 `wowhelper-runtime` Windows 桌面运行 `Reauth-Armory.ps1`；不复制/恢复旧 profile 或 Cookie。
4. 单角色 headless canary 成功后再恢复批量任务；替代电脑也按此流程新建 profile。

## 14. 变更后统一验证

- [ ] 本机页面加载，无会话只读、Argon2id 管理登录、CSRF/Origin/session 过期和自动化 named pipe/secret ACL 均符合预期。
- [ ] 页面版本、commit、schema 和 wow-db Build 正确。
- [ ] 成员、规则、分配记录数量合理。
- [ ] 主库 `quick_check` 为 `ok`。
- [ ] 最近 verified 双目标备份存在且可读取 manifest 和覆盖两个目标的 verification receipt；`generatedAt <= verifiedAt`、`generatedAt <= reportedAt`、`verifiedAt <= reportedAt + 5m`，content age 与验证后上报延迟分别符合门禁。
- [ ] 统一调度器只有一个实例，一条模拟可正常完成。
- [ ] 游客模拟前后业务 SQLite/WAL 没有业务写入。
- [ ] executor/publisher 权限隔离、HMAC 防重放和凭证轮换测试通过。
- [ ] SafetyGate/D1 restore epoch 一致；closer/epoch-admin/opener/recovery 错误权限被拒绝，双目标 committed authorization ledger 无分叉，DO applied hash 可验证，CAS 各崩溃窗口无 open-without-ledger，DO 丢失 max+1 blocked 重建通过，旧 lease/credential/nonce 被拒绝。
- [ ] D1 12 小时 export 在 SafetyGate blocked + FIFO mutex + maintenance lock 下通过固定 API polling 取得单一 `at_bookmark` SQL dump；隔离导入、Time Travel、新 quarantine D1 import、request/counter/lease/publication/credential 不变量和全丢失重建通过。
- [ ] Durable Object 单写、D1 quota trigger、digest-only tombstone 和并发验收通过。
- [ ] 错误 season/key version、NULL/错误 query secret hash、无效 secret expiry 和 staged/active signature pointer clear 全部由 DDL/trigger 拒绝且不改变 quota/pointer。
- [ ] D1 migration checksum/attempt/fingerprint、双层 maintenance lock、N/N-1 expand-contract 和 recovery point 演练通过；D1 与本机 migration ledger 没有混用。
- [ ] revision identity 为未截断 content hash，多签名文件只追加；revision/signature 任一 identity/content/publication/public/simulation-input hash 不匹配时 current 选择和 active 切换均失败。retired/revoked/compromisedFrom 和紧急重签回滚符合协议。
- [ ] wow-db 使用固定 trust store 完成 detached signature/轮换/篡改/zip traversal 测试。
- [ ] Windows runtime manifest、`wowhelper-runtime`、wrapper 退出码、Job Object、锁恢复和 Armory re-auth canary 通过。
- [ ] backup-health 写门禁在 `generatedAt/verifiedAt/reportedAt` 乱序/future generatedAt、旧 receipt 重放、1 小时上报延迟、20/22/24 小时边界、状态损坏和时钟倒退测试中 fail closed。所有终态任务有 `terminal_at`，非终态为 NULL。
- [ ] Draft Release asset ID/hash/ingress signature/source commit 验源、私有文件禁止扫描、PAT 权限/过期、pinned Actions 与 Environment 审批通过；Pages deployment ID、连续可见性校验、publication hash、D1 active revision 和 key version 一致，失败回滚未使用 repo push。
- [ ] local/staging/production D1、DO namespace、Worker、Pages、Environment 和全部 key 独立；staging 使用 production ID/credential 在网络前失败。
- [ ] 成员授权、赛季 key 轮换、数值/时间分桶、少于 3 候选再识别审计和撤回 privacy purge 通过；purge manifest 覆盖已知 URL、deployment、Actions artifact 与 Draft Release 资产。
- [ ] 匿名创建关闭/开启状态符合本次操作意图。
- [ ] 日志中没有秘密或新增严重错误。
- [ ] 操作结果、恢复点和验证写入 [操作日志](operations-log.md)。
