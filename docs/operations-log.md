# WoW Helper 操作日志

> 本文档是运维操作历史的唯一事实来源。操作规范见 [常用运维手册](operations-runbook.md)。最新记录放在最上方；禁止记录密码、Cookie、AccessKey、会话密钥或完整 Token。

## 记录规则

- 只记录已经发生的操作、验证和结果；计划讨论应明确标记环境为“规划”。
- 时间统一使用 `Asia/Shanghai` 并带时区。
- 记录执行人/执行方式、变更前后、验证结果和恢复点。
- 流程变化写入 runbook；执行历史只写入本文，不在 runbook 内追加日志。

## 模板

```markdown
### YYYY-MM-DD HH:mm +08:00 — 操作标题

- 环境：生产 / 测试 / 本地 / 规划
- 执行人：姓名或 GitHub Actor / Codex 辅助
- 变更类型：应用发布 / migration / wow-db / 备份 / 恢复 / 配置 / 密钥 / 故障处置 / 文档
- 变更前：版本、commit、wow-db Build、schema 或相关状态
- 变更后：版本、commit、wow-db Build、schema 或相关状态
- 操作摘要：做了什么，不包含秘密值
- 备份/回滚点：备份 ID、Tag、commit 或数据库归档标识
- 验证结果：数据核对、测试和冒烟结果
- 结果：成功 / 已回滚 / 失败待处理
- 关联：PR、Issue、Release 或故障编号
```

## 日志

### 2026-08-20 17:40 +08:00 — 增加 ProcessHost Windows 行为测试

- 环境：Windows GitHub CI
- 执行人：Codex 辅助
- 变更类型：Windows runtime / 测试
- 变更前：CI 只覆盖 ProcessHost 参数解析，未验证 Windows kernel mutex 和 Job Object 实际行为
- 变更后：新增跨线程 named mutex 互斥测试，以及长运行 `cmd.exe` 被 Job Object 终止的测试
- 操作摘要：测试使用随机对象名和短生命周期进程，不接触业务库、不修改 Task Scheduler
- 备份/回滚点：不适用
- 验证结果：本机无法运行 Windows .NET；已提交给 Windows CI 验证
- 结果：待 CI 验证
- 关联：`runtime/tests/WowHelper.ProcessHost.Tests/WindowsProcessControlTests.cs`

### 2026-08-20 16:57 +08:00 — 实现 backup-health 时间门禁核心

- 环境：本地开发
- 执行人：Codex 辅助
- 变更类型：备份门禁 / 测试
- 变更前：系统健康仅按备份文件 mtime 和两天阈值判断，没有使用 SQLite 内容 `generatedAt` 或双目标 receipt
- 变更后：新增共享 backup-health evaluator，验证双 target receipt、时间顺序和格式；按内容 age 执行 20 小时 warning/禁高风险、22 小时 blocked/禁常规写入、24 小时 recovery-only，并拒绝 future generatedAt、超容差 verifiedAt、backupId 重放和 generatedAt 回拨
- 操作摘要：当前只提供纯门禁核心和测试，尚未替换 legacy system-health 或接入 Web/调度器/publisher
- 备份/回滚点：不适用；未读写真实备份状态
- 验证结果：typecheck、15 个测试文件共 51 个测试和 build 全部通过；覆盖 20/22/24 小时边界、缺失/乱序/未来时间、重复 target 和单调推进
- 结果：核心逻辑成功，receipt writer 和调用方接入待实现
- 关联：`loot-allocator/src/backup-health.ts`、`loot-allocator/tests/backup-health.test.ts`

### 2026-08-20 16:54 +08:00 — 实现双目标备份的 prepare 阶段

- 环境：本地开发 / 隔离测试数据库
- 执行人：Codex 辅助
- 变更类型：备份 / manifest / 测试
- 变更前：现有备份脚本直接输出单个 SQLite 文件，不生成内容清单，且打开数据库时会触发应用内 migration
- 变更后：新增独立 `backup:prepare`，直接使用只读 SQLite 连接和 Backup API 生成唯一 bundle，执行 `quick_check`，记录 schema/migration、版本/commit、关键表计数、bytes/SHA-256 和两个预期 target ID，并以 `wx` 写入上传前 `backup-manifest/v1`
- 操作摘要：prepare manifest 明确不含 repository locator、receipt 或 verified 状态；现有单文件备份尚未替换，双目标上传/读回/receipt adapter 完成前不更新 backup-health
- 备份/回滚点：仅使用测试数据库；未操作真实主库或备份仓库
- 验证结果：typecheck、14 个测试文件共 44 个测试和 build 全部通过；测试核对快照 SHA-256、bytes、row count、quick_check 及双 target 门禁
- 结果：prepare 阶段成功，双目标验证仍待实现
- 关联：`loot-allocator/scripts/prepare-database-backup.mjs`、`loot-allocator/tests/backup-prepare.test.ts`

### 2026-08-20 16:51 +08:00 — 实现 business schema 5 外部 migration baseline

- 环境：本地开发 / 隔离数据库副本
- 执行人：Codex 辅助
- 变更类型：migration / CI 测试
- 变更前：业务 schema 只由应用启动时的内嵌 `migrate()` 管理，没有 migrationId、raw-bytes checksum、attempt 状态或结构指纹
- 变更后：新增不可修改候选 `0005_baseline.mjs` 和外部 runner；ledger 使用 append-only success、running/success/failed/unknown attempt、前后结构指纹、quick_check 和条件完成更新
- 操作摘要：分别通过当前业务库的 SQLite Backup API 一致性副本和全新 schema 5 副本执行 baseline/check/幂等重跑；未对真实主库执行 baseline，应用启动路径暂未切换
- 备份/回滚点：真实业务库未修改；隔离副本位于系统临时目录，由系统临时文件策略清理
- 验证结果：两个合法 schema 5 指纹均通过；checksum 为 `483f0b29e21f37036b0828c21251440ec4c87a388c7698679bd01c2c6a1020e7`；临时干净副本 typecheck、13 个测试文件共 42 个测试和 build 全部通过
- 结果：开发验证成功，生产 baseline/cutover 待备份和实机验收
- 关联：`loot-allocator/migrations/business/0005_baseline.mjs`、`loot-allocator/scripts/migrate-business-database.mjs`、`loot-allocator/tests/business-migration.test.ts`

### 2026-08-20 16:41 +08:00 — 将 Windows SimC 接入 ProcessHost 契约

- 环境：本地开发 / Windows CI 待验证
- 执行人：Codex 辅助
- 变更类型：Windows runtime / SimC / 进程控制
- 变更前：ProcessHost 尚未进入 runtime manifest，Windows SimC 仍会走 Node 直接 `spawn/child.kill`
- 变更后：安装器固定 ProcessHost exe 路径/hash，wrapper 注入 ProcessHost 和状态目录；Windows SimC 缺少这些配置时 fail closed，有配置时通过全局 `simc` mutex、固定 timeout 和无 shell 参数数组调用 helper
- 操作摘要：macOS/Linux 开发路径保持不变；每日任务成员级部分失败退出码改为 `10`
- 备份/回滚点：未运行 SimC、未修改业务 SQLite；可回滚至提交 `608de01`
- 验证结果：临时干净副本 `npm ci` 成功，Pages safety、typecheck、12 个测试文件共 40 个测试和 build 全部通过；C# 编译与 Windows 行为待 CI
- 结果：待 Windows CI 与实机验收
- 关联：`loot-allocator/src/simc.ts`、`loot-allocator/tests/simc.test.ts`、`ops/windows/Install-WowHelperRuntime.ps1`

### 2026-08-20 16:36 +08:00 — 新增 WowHelper.ProcessHost 基础实现

- 环境：本地开发 / Windows CI 待验证
- 执行人：Codex 辅助
- 变更类型：Windows runtime / 进程控制 / CI
- 变更前：SimC 只有 Node 直接子进程 `child.kill()`，没有跨进程单实例或 Windows Job Object helper
- 变更后：新增独立 `runtime/WowHelper.Runtime.slnx`；ProcessHost 提供安全参数解析、Windows named mutex、`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、超时/取消时 `TerminateJobObject`、PID/创建时间状态文件和固定 40/50/60 退出码
- 操作摘要：仅新增 helper 和参数测试，尚未让 Node/SimC 调用该 helper；Windows CI 新增 runtime restore/test/build
- 备份/回滚点：未触碰业务 SQLite、wow-db、SimC 进程或 Windows 任务
- 验证结果：本机无 `dotnet`，仅完成静态 diff/XML 检查；需 Windows CI 编译并运行测试
- 结果：待 Windows CI 验证
- 关联：`runtime/src/WowHelper.ProcessHost`、`runtime/tests/WowHelper.ProcessHost.Tests`、`.github/workflows/ci.yml`

### 2026-08-20 16:28 +08:00 — 增加 Windows runtime 安装器与任务定义

- 环境：本地开发 / Windows runner 待验证
- 执行人：Codex 辅助
- 变更类型：Windows runtime / Task Scheduler / CI
- 变更前：只有手写 wrapper 和 manifest 示例，没有生成 manifest、ACL、任务注册和 XML 交接包的仓库入口
- 变更后：新增 `Install-WowHelperRuntime.ps1` 和 `task-definitions.json`；安装器生成绝对路径/hash manifest、设置运行账号与 Administrators ACL、注册 03:15/15:15 备份、04:00 每日和开机校验任务，并导出任务 XML
- 操作摘要：扩展 Windows CI PowerShell 语法门禁，安装器默认要求管理员交互会话和 `wowhelper-runtime` 凭据；`-SkipTaskRegistration` 可只生成 manifest
- 备份/回滚点：未执行安装器；未触碰业务 SQLite、wow-db 或 Windows 任务
- 验证结果：本机无 PowerShell，仅完成静态 diff 检查；Windows runner 需验证 parser、ACL、任务注册和 XML 导出
- 结果：待 Windows 验收
- 关联：`ops/windows/Install-WowHelperRuntime.ps1`、`ops/windows/task-definitions.json`、`.github/workflows/ci.yml`

### 2026-08-20 16:14 +08:00 — 开始 Windows runtime foundation

- 环境：本地开发
- 执行人：Codex 辅助
- 变更类型：Windows runtime / 配置 / wow-db 导入
- 变更前：每日任务使用 `/usr/local/bin/npm` 和 Unix PATH；wow-db 导入使用 macOS `ditto`、`/usr/bin/which`，Windows 路径解析使用 URL pathname
- 变更后：每日任务使用 `fileURLToPath`、当前平台 npm 命令和 Windows `tasklist.exe`；wow-db zip 按平台选择 PowerShell `Expand-Archive`/`ditto`/`unzip`，Windows 导入无 runtime wrapper 句柄检查时 fail closed；配置支持 `BACKUPS_PATH`
- 操作摘要：新增 `ops/windows/Invoke-WowHelperTask.ps1` 和 runtime manifest 说明；wrapper 校验运行账号、绝对路径、SHA-256，并写原子任务状态 JSON
- 备份/回滚点：不适用；未触碰业务 SQLite、wow-db 或运行产物
- 验证结果：Node 脚本语法检查通过；`npm run ci:pages-safety` 通过；PowerShell 仅完成静态实现，本机无 `pwsh`，Windows runner 需补充验证
- 结果：待 Windows runtime 验收
- 关联：`ops/windows/Invoke-WowHelperTask.ps1`、`ops/windows/README.md`、`loot-allocator/scripts/run-daily-pipeline.mjs`、`loot-allocator/scripts/import-wow-db.mjs`

### 2026-08-20 16:18 +08:00 — 将 Windows wrapper 语法纳入 CI

- 环境：本地 / GitHub CI 配置
- 执行人：Codex 辅助
- 变更类型：CI / Windows runtime
- 变更前：Windows wrapper 只有本地静态文件，CI 未验证 PowerShell 语法
- 变更后：现有 Windows job 在 .NET 测试前解析 `ops/windows/Invoke-WowHelperTask.ps1`，语法错误直接失败
- 操作摘要：复用固定 SHA 的 checkout，不新增权限、云资源或运行凭证
- 备份/回滚点：可回滚至提交 `38370e8`
- 验证结果：本地 `git diff --check`；实际 PowerShell 解析由 Windows runner 执行
- 结果：待 CI 验证
- 关联：`.github/workflows/ci.yml`

### 2026-08-20 15:52 +08:00 — 修复 Windows GameTable 测试的 SQLite 句柄释放

- 环境：本地 / GitHub Actions Windows runner 待验证
- 执行人：Codex 辅助
- 变更类型：测试修复 / CI 故障处置
- 变更前：`GameTableServiceTests.ExportAsyncWritesNormalizedGameTables` 在 Windows runner 清理临时目录时失败，`wow.sqlite` 仍被 SQLite 连接或命令占用
- 变更后：测试将查询连接和命令置于显式 `await using` 作用域，并在删除临时目录前调用 `SqliteConnection.ClearAllPools()`
- 操作摘要：复用 `SqliteTableWriterTests` 的 Windows 句柄清理模式，未改变生产代码或数据库内容
- 备份/回滚点：不适用；仅修改测试
- 验证结果：`git diff --check` 通过；本机未安装 `dotnet`，需由 GitHub Windows CI 验证
- 结果：待 CI 验证
- 关联：`wow-db/tests/WowDb.Tests/GameTableServiceTests.cs`

### 2026-08-20 15:34 +08:00 — 修复首轮 CI 的依赖锁和 Windows SQLite 清理失败

- 环境：本地 / GitHub CI 修复
- 执行人：Codex 辅助
- 变更类型：CI / 测试 / wow-db
- 变更前：Node job 的 `npm ci` 因 Vite peer 需要 `esbuild 0.28.x` 而 lockfile 只有 `0.25.12` 失败；Windows `SqliteTableWriterTests` 在连接仍被池持有时删除临时 `wow.sqlite` 目录失败
- 变更后：将 `esbuild 0.28.2` 作为显式开发依赖并重新生成 lockfile，同时保留 tsx 所需的嵌套 `0.25.12`；写入器禁用 SQLite pooling，测试读取连接作用域化并清理连接池后再删除临时目录
- 操作摘要：不改变业务运行时依赖用途；使用独立临时 npm cache 和临时完整工作副本完成 clean install、typecheck、测试与 build，未清理或重启当前开发服务
- 备份/回滚点：修复前 commit `a7414da`；未操作业务 SQLite、wow-db 生产文件或外部资源
- 验证结果：临时副本 `npm ci --ignore-scripts` 成功安装 135 个包；Pages safety、typecheck、12 个测试文件共 39 个测试和 build 全部通过；本机无 .NET SDK，Windows 测试待 GitHub Actions
- 结果：本地验证成功；Windows CI 待远程复验
- 关联：`loot-allocator/package.json`、`loot-allocator/package-lock.json`、`wow-db/src/WowDb.Cli/Services/SqliteTableWriter.cs`、`wow-db/tests/WowDb.Tests/SqliteTableWriterTests.cs`

### 2026-08-20 14:57 +08:00 — 合并并推送个人 GitHub 仓库历史

- 环境：GitHub / 本地
- 执行人：Codex 辅助
- 变更类型：Git / CI
- 变更前：本地与远端 `main` 没有共同祖先；远端只有 GitHub 创建的初始 README 和通用 `.gitignore`
- 变更后：以普通 unrelated-history merge 保留远端 `33e3150` 和本地全部历史，合并 commit 为 `940d7f4`，并通过个人 SSH remote 正常推送到 `zoroperona/wow-helper`
- 操作摘要：手工保留两边 `.gitignore` 全部规则；未 force-push、未删除远端提交；本机 `gh` 当前活动账号是公司账号 `luhong-xd`，因此没有用它访问或修改个人仓库
- 备份/回滚点：远端推送前 `origin/main=33e3150`；本地 safety commit `012fd1e`
- 验证结果：SSH push 成功；个人仓库对未认证 API 返回 404，本机公司账号无仓库 API 权限，暂时无法读取 Actions 结果。需要管理员以 `zoroperona` 确认 CI 和账户侧旧 Pages PAT/deploy key 状态
- 结果：代码推送成功；远程 CI 验收待管理员确认
- 关联：`https://github.com/zoroperona/wow-helper`、commit `940d7f4`

### 2026-08-20 14:52 +08:00 — 禁用旧 Pages 仓库直推入口

- 环境：本地
- 执行人：Codex 辅助
- 变更类型：应用安全 / CI / 文档
- 变更前：`pages:publish` 可调用 `deploy-pages.mjs` clone、清空并 push 独立 Pages 仓库；本机 UI/API 还能异步触发该路径，仓库没有 CI denylist
- 变更后：删除旧 npm 命令、直推脚本、后端异步发布服务/API和前端发布按钮；只保留本地静态构建/预览；新增仓库 denylist、Vitest 回归测试和固定 action commit SHA/最小权限的 GitHub Actions CI
- 操作摘要：将 plan 标记为协议冻结、阶段 2 实施中；扫描源码、脚本、前端和 workflow，禁止旧凭证名、旧入口、直推路径、浮动 Action 与 `pull_request_target`
- 备份/回滚点：实施前 commit `f10bc54`；未操作业务数据库或外部 Pages/Cloudflare 资源
- 验证结果：`npm run ci:pages-safety`、`npm run typecheck`、12 个测试文件共 39 个测试、`npm run build` 全部通过；旧 Pages 环境变量均未设置；本机未安装 `dotnet`，wow-db 验证留给 Windows GitHub Actions；GitHub 账户侧旧 Pages PAT/deploy key 是否存在仍需管理员确认并在存在时撤销
- 结果：本地代码验收成功；账户侧凭证确认待完成
- 关联：`.github/workflows/ci.yml`、`loot-allocator/scripts/check-pages-safety.mjs`、`docs/local-first-github-pages-simulation-plan.md`

### 2026-08-20 14:42 +08:00 — 本地协议合同与现有代码回归验证

- 环境：本地
- 执行人：Codex 辅助
- 变更类型：测试 / 文档验证
- 变更前：D1 export 与 lease 时间合同已写入计划和 runbook，但尚未在 staging 执行远程验收
- 变更后：本地 plan/runbook 交叉检查确认普通 lease 120 秒、heartbeat 30 秒、export budget 600 秒、maintenance hard deadline 900 秒；现有 Node 项目回归测试和类型检查通过
- 操作摘要：运行 `npm test` 和 `npm run typecheck`；未创建 Cloudflare/Pages 资源，未调用远程 API，未启用公网申请
- 备份/回滚点：不适用，未操作业务数据
- 验证结果：11 个测试文件、37 个测试全部通过；TypeScript 类型检查通过；staging D1 export polling、Time Travel、quarantine import 和 token hard guard 尚未执行
- 结果：成功（本地验证）；staging 验收待资源创建
- 关联：`docs/local-first-github-pages-simulation-plan.md`、`docs/operations-runbook.md`

### 2026-08-20 14:45 +08:00 — 建立本地 Git 初始审计基线

- 环境：本地
- 执行人：Codex 辅助
- 变更类型：仓库初始化 / 文档
- 变更前：仓库已执行 `git init` 并配置个人 remote，但没有 commit，无法建立变更审计基线
- 变更后：以个人账号 `zoroperona` 的仓库级身份创建初始 commit；业务 SQLite、wow-db 压缩包、WAL/SHM、缓存、生成目录和凭证均未纳入
- 操作摘要：核对 `.gitignore`、拟提交文件清单、remote 和仓库级 Git 身份；未推送 GitHub，未创建或修改外部资源
- 备份/回滚点：初始 commit；未操作业务数据
- 验证结果：拟提交清单仅包含源码、文档、测试和仓库规则；个人 remote 为 `git@github.com:zoroperona/wow-helper.git`
- 结果：成功
- 关联：`docs/operations-log.md`、`AGENTS.md`

### 2026-08-20 12:35 +08:00 — 收敛 D1 export 与 lease 时间合同

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：文档 / D1 / 备份 / 租约
- 变更前：D1 export 最长 10 分钟，但 maintenance 只为活跃 lease 延长 5 分钟；D1 export 期间请求会被阻塞，heartbeat、回收和结果回写可能在 export 结束前把任务误判为失联或产生旧结果竞争
- 变更后：`d1_schema_state` 增加不可变语义的 `maintenance_deadline`；普通 lease 固定 120 秒、heartbeat 30 秒；进入 maintenance 时设置 900 秒硬截止并推进现有 lease，窗口内禁止 heartbeat/回收/领取/结果写入；前 600 秒用于 export，后 300 秒用于隔离验证、receipt 和清锁；清锁后恢复 120 秒 lease，超过 900 秒则保持 blocked、fencing、终止进程树并按 queued/failed 回收
- 操作摘要：同步修订 plan、runbook 和项目 memory 的 export polling、maintenance lock、lease 回收、定时任务和故障注入合同；仍未修改应用代码或创建外部资源
- 备份/回滚点：不适用，未操作业务数据、GitHub/Cloudflare 资源或生产环境
- 验证结果：完整 D1 DDL 由 SQLite 3.51 解析通过并生成 49 个 table/trigger/index 对象；`maintenance_deadline` 字段、600/900/120 秒合同和旧 5 分钟口径交叉检查通过；`git diff --check` 通过，未修改应用代码、未创建外部资源
- 结果：成功
- 关联：`docs/local-first-github-pages-simulation-plan.md`、`docs/operations-runbook.md`、`AGENTS.md`

### 2026-08-20 12:08 +08:00 — 闭合 SafetyGate、D1 export 与环境隔离协议

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：文档 / D1 / SafetyGate / Pages / 隐私 / 灾备
- 变更前：SafetyGate 在 DO open 后才追加 committed ledger，存在 open-without-ledger 崩溃窗口；D1 export 依赖未固定的 provider snapshot；request 未绑定 revision season/key version、query secret 可空、staged/active 签名可清空；非生产资源、backup gate 写入边界、旧 Pages 发布器和撤回清理不闭环
- 变更后：SafetyGate v2 改为双目标 committed authorization 先落盘、DO 后 CAS 并保存 applied hash；固定 `wrangler@4.124.0` + API v4 export polling/`at_bookmark`/SQL 隔离导入、Time Travel 与 quarantine import；DDL 增加 environment identity、request 绑定/凭证约束、draft-signed-staged 与 pointer-clear guard；明确 D1 accepting 单写、SafetyGate open expiry、local/staging/production 硬隔离、旧发布入口首个 safety commit 和 GitHub privacy purge
- 操作摘要：查阅 2026-08-20 可用的 Cloudflare 官方 D1 export、Time Travel、Wrangler 和 Workflows 文档，明确原生 export 阻塞请求、持续 polling 与取消语义；同时承认 D1 Edit Token 不能按 SQL 白名单收权，改用短期 Token、固定 target/runner/SQL hash、Environment 审批、审计与立即撤销补偿。计划仍是最终冻结评审候选稿，未修改应用代码、创建资源、提交或推送
- 备份/回滚点：不适用，未操作业务数据、GitHub/Cloudflare 资源或生产环境
- 验证结果：完整 D1 DDL 由 SQLite 3.51 解析通过并生成 49 个 table/trigger/index 对象；正常 request 原子入队且 quota 0 -> 1；错误 season/key version 返回 `PUBLIC_KEY_NOT_ACTIVE`，NULL/格式错误/无效 expiry 的 query secret 分别被 NOT NULL/CHECK 拒绝，active 直接清空或同时转 retained 清空均返回 `PUBLICATION_SIGNATURE_REQUIRED`，environment identity 修改返回 `ENVIRONMENT_IDENTITY_IMMUTABLE`；当前 plan/runbook/memory 的旧协议关键字、尾随空白、remote 和仓库级个人身份检查通过（历史日志保留当时旧口径，不作追改）
- 结果：成功
- 关联：`docs/local-first-github-pages-simulation-plan.md`、`docs/operations-runbook.md`、`AGENTS.md`

### 2026-08-20 11:36 +08:00 — 冻结 Pages ingress、SafetyGate 灾备与 publication 身份协议

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：文档 / Pages 发布 / D1 / SafetyGate / 认证 / 灾备
- 变更前：本机公开 artifact 无法进入 Actions；SafetyGate 关闭/打开权限冲突且 DO 无恢复依据；revision 生成/重签路径未固定；D1 允许 revision 与 current signature artifact hash 不一致；日常 export、未来备份时间、tombstone 历史 key、loopback 管理 API 和 Actions 供应链存在协议缺口
- 变更后：选定本机 allowlist bundle -> 唯一 Draft Release ingress -> pinned Actions 验签/Pages 路径；拆分 gate-closer/epoch-admin/gate-opener/d1-recovery 并引入双目标 prepared/committed SafetyGate ledger；revision 改为未截断 canonical identity hash，重签只追加 hash 路径；D1 历史保存全部 payload hash 并在选择/激活两处复验；日常 export 改为停写 + FIFO mutex + provider 单一快照
- 操作摘要：同步补齐未来 backup 时间下界、terminal_at CHECK、永久在线 match-only tombstone keyring、Argon2id 本机管理会话/named pipe ACL、Actions commit SHA/最小 permissions/Environment/仓库可见性前置条件；计划仍是冻结评审候选稿，未修改应用代码或外部资源
- 备份/回滚点：不适用，未操作业务数据、GitHub/Cloudflare 资源或生产环境
- 验证结果：完整 D1 DDL 由本机 SQLite 解析通过；评审复现中 EXPECTED revision 挂接 OTHER signature 现返回 `SIGNATURE_REVISION_MISMATCH`，正常签名可激活；未来 generatedAt 返回 `BACKUP_REPORT_INVALID`；终态无 terminal_at 被 CHECK 拒绝；revision identity 修改返回 `PUBLICATION_IDENTITY_IMMUTABLE`；关键旧口径、尾随空白和 `git diff --check` 通过
- 结果：成功
- 关联：`docs/local-first-github-pages-simulation-plan.md`、`docs/operations-runbook.md`、`AGENTS.md`

### 2026-08-20 02:49 +08:00 — 闭环本地优先方案的恢复、供应链与 Windows 运行合同

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：文档 / D1 灾备 / 供应链 / Windows runtime / Pages / 隐私
- 变更前：D1 回档会恢复旧 gate/lease/credential/publication 状态；artifact 重签会丢失旧受信证据；wow-db 只有同包 hash；Windows/Armory、Pages 原子发布、D1 日常灾备、匿名额度 DoS、tombstone 与重新识别边界不完整
- 变更后：增加 D1 外 SafetyGate/restore epoch 和无公网一次性 recovery runner；新增不可更新/删除的 signature history；wow-db 采用固定 trust store 的 Ed25519 验签；固定 `wowhelper-runtime` + wrapper/Job Object/交互重认证；选定 Actions Pages artifact 唯一正式路径；加入 D1 12 小时双目标导出、已接受可用性风险、digest-only tombstone 和成员授权/分桶/撤回规则
- 操作摘要：根据最新 11 项 review 修订 plan、runbook 和项目 memory，并清理“随机 publicPlayerKey 映射”与旧 HMAC 灾备口径的冲突；仍为最终协议冻结评审候选稿
- 备份/回滚点：不适用，未操作业务数据、Cloudflare/GitHub 资源或生产环境
- 验证结果：文档内完整 D1 DDL 由本机 SQLite 解析通过；restore epoch 字段、digest-only tombstone 和两个 signature history 不可变 trigger 存在；UPDATE 签名历史实际返回 `SIGNATURE_HISTORY_IMMUTABLE`；旧口径、尾随空白、Git remote 和仓库级个人身份检查通过
- 结果：成功
- 关联：`docs/local-first-github-pages-simulation-plan.md`、`docs/operations-runbook.md`、`AGENTS.md`

### 2026-08-20 01:34 +08:00 — 补齐 D1 演进、备份时间与签名撤销协议

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：文档 / D1 migration / 备份 / artifact 签名
- 变更前：D1 只有初始 DDL 而无版本化 migration/部署兼容状态机；backup-monitor 将内容年龄与上报窗口混为 4 小时；撤销 signing key 会阻断受信任旧 revision 的紧急回滚；D1 签名索引边界不明确
- 变更后：定义独立 D1 schema/attempt ledger、maintenance lock、expand/contract、N/N-1 和 recovery point 发布顺序；拆分 generatedAt/verifiedAt/reportedAt 并由 trigger 强制 22 小时内容门禁、1 小时上报延迟和单调推进；加入 signedAt/compromisedFrom/trusted history 撤销语义及 D1 artifact 签名索引字段
- 操作摘要：按最新 review 修订当前 plan、runbook 和项目 memory，仍为最终协议冻结评审候选稿；未修改应用代码、创建 Cloudflare/Pages 资源、提交或推送
- 备份/回滚点：不适用，工作区仍无 commit，未操作业务数据
- 验证结果：完整 D1 DDL 由本机 SQLite 解析通过；maintenance request 返回 `D1_SCHEMA_UNTRUSTED`，无效备份报告返回 `BACKUP_REPORT_INVALID`，有效 receipt 原子推进 `system_gates.backup_generated_at`；关键字交叉检查和 `git diff --check` 通过
- 结果：成功
- 关联：`docs/local-first-github-pages-simulation-plan.md`、`docs/operations-runbook.md`、`AGENTS.md`

### 2026-08-20 00:45 +08:00 — 冻结 D1 并发、RPO 与 artifact 签名协议

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：文档 / D1 / Durable Object / 备份 / 签名
- 变更前：D1 原子性只有目标描述；每日备份和 26 小时门槛无法保证 24 小时 RPO；rollback 引用 publisher 签名但没有离线 artifact 签名协议
- 变更后：选择全局单例 Durable Object + FIFO mutex + D1 固定 DDL/trigger/条件 UPDATE；幂等凭证到期使用永久 tombstone/410；备份改为每 12 小时、20 小时告警、22 小时 fail closed；revision bundle 使用 Ed25519 detached signature
- 操作摘要：按 review 修改当前 plan、runbook 和项目 memory，未开始应用代码或外部资源实施
- 备份/回滚点：不适用，工作区仍无 commit，未操作业务数据
- 验证结果：完整 DDL 已由本机 SQLite 实际解析；正常 request 原子写入 request/counter，超额、非 staged publication 和超过 22 小时 backup 均由 trigger 拒绝；RPO、D1、幂等、签名与 runbook 引用交叉检查及格式检查通过
- 结果：成功
- 关联：`docs/local-first-github-pages-simulation-plan.md`、`docs/operations-runbook.md`、`AGENTS.md`

### 2026-08-19 18:01 +08:00 — 按 review 补齐灾备资产、migration 与 revision 生命周期

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：文档 / 灾备 / migration / 发布 / Task Scheduler
- 变更前：替代电脑恢复只覆盖业务数据库；当前 runbook 缺少本机 migration 状态机；revision grace 与私有输入清理/回滚保留期不闭合；HMAC canonical bytes 和 Windows 补跑契约不完整
- 变更后：加入灾备凭证清单和完整服务 RTO；补齐 migration baseline/checksum/attempt/unknown/N-N-1 门禁；定义 revision bundle 统一保留和从本地 artifact 回滚；固定 HMAC signing bytes；增加 Task Scheduler 开机、唤醒、补跑、重试和异机告警规则
- 操作摘要：根据 review 修订计划、runbook 和项目 memory，仍处于规划阶段，未修改应用代码或创建外部资源
- 备份/回滚点：不适用，工作区无 commit，未操作业务数据
- 验证结果：plan、runbook 和项目 memory 已同步；review 关键字交叉检索与 Markdown whitespace 检查通过；Git 个人身份和 remote 未变化
- 结果：成功
- 关联：`docs/local-first-github-pages-simulation-plan.md`、`docs/operations-runbook.md`

### 2026-08-19 15:56 +08:00 — 按最终协议 review 补齐认证、备份与执行隔离

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：文档 / 安全 / 备份 / 队列 / SimC
- 变更前：本机 Worker/发布器无认证契约；备份 manifest 生成顺序循环；失联回收、幂等顺序、Windows 进程树控制和游客只读边界不完整
- 变更后：定义 executor/publisher 分域 HMAC 凭证；拆分不可变 manifest 与 verification receipt；增加每分钟原子租约回收；幂等查找前置；Windows Job Object 整树取消；游客 simulation-input 只读执行；至少一个备份目标不可变或离线
- 操作摘要：根据 review 修订计划、runbook 和项目 memory，继续保持规划状态，未修改应用代码或创建外部资源
- 备份/回滚点：不适用，工作区仍无 commit，未操作业务数据
- 验证结果：计划、runbook 和项目 memory 已同步；交叉检索及 Markdown whitespace 检查通过，Git 个人身份和 remote 未变化
- 结果：成功
- 关联：`docs/local-first-github-pages-simulation-plan.md`、`docs/operations-runbook.md`、`AGENTS.md`

### 2026-08-19 14:57 +08:00 — 分离运维规范、修订本地优先计划

- 环境：本地 / 规划
- 执行人：Codex 辅助
- 变更类型：文档
- 变更前：运维规范和 11 条历史记录混合存放在 `docs/operations-runbook.md`
- 变更后：runbook 只保存当前操作规范；`docs/operations-log.md` 成为操作历史唯一事实来源
- 操作摘要：原样迁移全部历史记录，更新项目 memory 与交叉引用，并将当前 runbook 切换为本地优先口径
- 备份/回滚点：工作区尚无 commit；修改前内容仍可从当前工作副本差异核对
- 验证结果：文档引用、历史条目数量和 Git 状态检查通过；根 Git 仓库、个人 remote 和仓库级身份保持不变，未提交或推送
- 结果：成功
- 关联：`docs/operations-runbook.md`、`docs/local-first-github-pages-simulation-plan.md`

### 2026-08-19 14:45 +08:00 — 初始化个人 GitHub 仓库元数据

- 环境：本地
- 执行人：Codex 辅助
- 变更类型：Git / 身份 / 文档
- 变更前：工作区不是 Git 仓库；全局 Git 身份为公司邮箱；个人 GitHub 仓库已创建但本地未关联
- 变更后：本地初始化 `main`，`origin` 指向 `git@github.com:zoroperona/wow-helper.git`；仓库级身份固定为 `zoroperona <zoroperona@users.noreply.github.com>`；Git SSH 固定使用个人 `~/.ssh/id_rsa` 和 `IdentitiesOnly=yes`
- 操作摘要：新增根 `.gitignore`，忽略 SQLite、wow-db 压缩包、环境密钥和生成目录；将个人仓库归属写入项目 memory、当前方案和运维手册
- 备份/回滚点：仅新增 `.git` 元数据和文档/忽略规则；未移动、删除、暂存或提交现有文件
- 验证结果：业务 SQLite、wow.sqlite、`wow-db.zip` 和 `.DS_Store` 均被忽略；当前网络访问 GitHub 22/443 超时，因此未 fetch、commit 或 push
- 结果：成功
- 关联：`https://github.com/zoroperona/wow-helper`

### 2026-08-19 14:27 +08:00 — 搁置云部署，建立本地优先匿名模拟申请方案

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：架构 / GitHub Pages / 模拟队列 / 文档
- 变更前：当前计划以 ECS/ACR/OSS 为生产方向，游客模拟收口方案仍需 GitHub 账号或多维限制
- 变更后：云部署计划标记为已搁置；新增本地完整版应用 + GitHub Pages 脱敏快照 + Cloudflare Worker/D1 匿名申请 + 本机主动轮询 Worker 的替代计划
- 操作摘要：明确业务 SQLite 只保留本机、不提交 Git；wow-db 通过 GitHub Release Asset 管理；匿名申请不要求 GitHub 账号，只保留待处理队列 20 和 Asia/Shanghai 自然日 500 次两个业务门槛
- 备份/回滚点：不适用，未操作生产数据，未修改代码或创建 Cloudflare 资源
- 验证结果：计划文档已创建，旧云部署文档标记为搁置；当前仍等待 review
- 结果：成功
- 关联：`docs/local-first-github-pages-simulation-plan.md`、`docs/cloud-deployment-and-release-plan.md`

### 2026-08-19 14:35 +08:00 — 根据新 review 补齐首次上线、灾备与业务生命周期

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：cold-start / 灾备 / 备份 / 赛季 / 鉴权 / TLS / 资源隔离 / 文档
- 变更前：KMS 不可用时的本地恢复承诺矛盾；跨地域副本没有重加密；首次 ECS 上线、赛季 rollover、游客资源隔离、管理员 bootstrap、备份 API 和 TLS 前置流程不完整
- 变更后：明确 KMS 不可用时不承诺本地备份 RTO；新增跨地域解密/目标 KMS 重加密/重签名；新增 cold-start bootstrap、season rollover、游客队列与 cgroup、生产删除备份导出路由、管理员 recover/revoke、UID/GID/ACL 和 TLS 实施门槛
- 操作摘要：同步更新云部署计划、运维手册和实施顺序；所有云端能力继续标记为规划/待实现
- 备份/回滚点：不适用，未操作生产数据
- 验证结果：文档交叉检索和本地代码测试完成；未宣称生产已部署
- 结果：成功
- 关联：`docs/cloud-deployment-and-release-plan.md`、`docs/operations-runbook.md`、`docs/aliyun-resource-sizing.md`

### 2026-08-19 14:05 +08:00 — 根据新 review 补齐备份、进程、锁和数据版本契约

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：备份 / migration / 权限 / wow-db / systemd / 文档
- 变更前：manifest 要求签名但缺少字段和 canonical bytes；模拟取消只写状态；发布前备份可能重复获取部署锁；游客模拟仍使用内部 ID；本地备份加密、migration retry、wow-db 重载和 pseudonym key version 未闭环
- 变更后：增加 Ed25519/RFC8785/公钥版本/sequence/过期时间契约；SIGTERM/SIGKILL/进程组/SQLite 打开者检查；继承 lock FD 与备份操作锁；opaque publicPlayerKey；本地 AES-256-GCM/KMS、权限和快照加密；attempt_id 同 checksum 重试；wow-db 更新后重启/显式 reload 并核验 Build；保存 pseudonym key version 和旧 key 保留期
- 操作摘要：同步云部署计划、运维手册、systemd 目录契约和 wow-db 运维手册；所有新增能力仍标记为待实现
- 备份/回滚点：不适用，未操作生产数据
- 验证结果：文档交叉检索完成；当前代码阻断项未被误标为已完成
- 结果：成功
- 关联：`docs/cloud-deployment-and-release-plan.md`、`docs/operations-runbook.md`、`ops/systemd/README.md`、`docs/wow-db-runbook.md`

### 2026-08-19 13:40 +08:00 — 根据新 review 补齐实施契约

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：发布状态机 / migration / 鉴权 / 备份 / 灾备 / 容器运行时 / 文档
- 变更前：发布流程未定义 staged/current cutover、migration 写入隔离和基线转换；API 权限、备份 manifest、RPO/RTO、CI-ECS 信任链及容器运行时契约不足
- 变更后：补充 staged/current 状态机和唯一 cutover；停止旧服务/timer/模拟后由外部 runner 独占 migration；增加 schema 5 bootstrap、checksum/锁、N/N-1 兼容门禁、API 权限矩阵、CSRF/限流/pseudonym、manifest v1、RPO/RTO/跨地域副本、OIDC/forced-command/签名 manifest 和非 root Docker/Nginx 端口契约
- 操作摘要：同步更新云部署计划、运维手册、阿里云资源规格和 systemd 目录契约；明确当前 runner 仍会备份、当前应用仍有启动隐式迁移和 127.0.0.1 监听，均列为上线阻断项
- 备份/回滚点：不适用，未操作生产数据
- 验证结果：文档交叉检索完成；目标能力均标记为待实现，未宣称云端已部署
- 结果：成功
- 关联：`docs/cloud-deployment-and-release-plan.md`、`docs/operations-runbook.md`、`docs/aliyun-resource-sizing.md`、`ops/systemd/README.md`

### 2026-08-19 13:17 +08:00 — 按 review 第二轮收敛发布与数据资产契约

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：文档 / migration / 备份 / wow-db 发布
- 变更前：部署路径表述仍可能把 ACR/Docker 与其他方案理解为可选；`failed` migration 状态未区分已验证回滚和未知部分执行；资源清单与 wow-db 运维手册的对象路径、lock 文件名存在差异
- 变更后：明确 ACR + Docker + 受限 SSH 为第一阶段唯一正式路径；补充 `running/failed/success` 状态判定和恢复门禁；03:30 仅负责定时备份、发布脚本负责发布前备份、04:00 只做门禁；统一不可变 wow-db 对象路径和 `wow-db.lock.json`
- 操作摘要：同步修改云部署计划、运维手册、阿里云资源规格、wow-db 运维手册和 systemd 任务说明
- 备份/回滚点：不适用，未操作生产数据
- 验证结果：文档交叉检索无旧 lock 路径；`npm run typecheck` 通过，11 个测试文件共 37 个测试通过
- 结果：成功
- 关联：`docs/cloud-deployment-and-release-plan.md`、`docs/operations-runbook.md`、`docs/aliyun-resource-sizing.md`、`docs/wow-db-runbook.md`、`ops/systemd/README.md`

### 2026-08-19 12:23 +08:00 — 每日生产流水线移除 Pages 发布

- 环境：本地
- 执行人：Codex 辅助
- 变更类型：应用脚本 / 发布流程
- 变更前：`run-daily-and-publish.mjs` 在全团模拟后生成并部署 GitHub Pages 快照
- 变更后：`run-daily-pipeline.mjs` 只构建、校验、备份、模拟和记录状态；生产命令为 `ops:daily`
- 操作摘要：移除 publication/deployment 阶段和 `sim:daily:publish` 命令；保留独立 `pages:*` 作为本地历史导出；新增禁止 Pages 回流生产 runner 的自动化测试
- 备份/回滚点：原脚本逻辑可从版本历史恢复；未操作生产数据
- 验证结果：`npm run typecheck`、`npm run build`、11 个测试文件共 37 个测试全部通过；`npm run ops:daily:check` 成功，状态仅包含 build/validate/backup/simulation，后两项按预期跳过，不含 Pages 阶段且未遗留任务锁
- 结果：成功
- 关联：`loot-allocator/scripts/run-daily-pipeline.mjs`、`loot-allocator/tests/daily-pipeline.test.ts`

### 2026-08-19 11:59 +08:00 — 规划云端定时任务与发布同步

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：配置 / 文档
- 变更前：仅有本地凌晨 04:00 任务，云端 timer 无固定仓库位置和发布契约
- 变更后：规划 `ops/systemd/`，明确 03:30 备份、04:00 每日流水线、09:00 清理、15 分钟巡检和每周完整性检查
- 操作摘要：规定应用 Tag 发布同步验证和原子更新 systemd timer；澄清当前任务实际使用 DPSWOW，官方英雄榜刷新尚待改造
- 备份/回滚点：不适用；未来发布需保存旧单元文件和启用状态
- 验证结果：文档和目录契约已创建；实际 systemd 单元、安装脚本和云端任务尚未实现
- 结果：成功
- 关联：`ops/systemd/README.md`、`docs/cloud-deployment-and-release-plan.md`

### 2026-08-19 12:35 +08:00 — 根据 review 收敛云端发布计划

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：发布流程 / migration / 备份 / 隐私 / 凭证 / 文档
- 变更前：ACR/Docker 与 SSH/裸 Node 二选一；migration、备份职责、游客数据边界、会话存储和 Release 状态定义不完整
- 变更后：第一阶段固定 GitHub Actions -> ACR digest -> 受限 SSH deploy.sh -> ECS systemd；03:30 是唯一备份生成者，04:00 只做门禁；补充 migration 向前兼容和恢复决策、masked 隐私默认、管理员/英雄榜会话闭环、不可变 wow-db 对象和 Draft/Published Release 语义
- 操作摘要：重写云部署与发布计划，并同步运维手册、资源采购清单和 systemd 任务契约；所有云端能力仍按“目标/待实现”标注
- 备份/回滚点：不适用，未操作生产数据
- 验证结果：文档交叉检查完成；实际 Docker、ACR、migration runner、deploy.sh、鉴权和 systemd 尚未实现
- 结果：成功
- 关联：`docs/cloud-deployment-and-release-plan.md`、`docs/operations-runbook.md`、`docs/aliyun-resource-sizing.md`、`ops/systemd/README.md`

### 2026-08-19 — 建立运维手册

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：文档
- 变更前：无统一运维手册
- 变更后：建立常用运维清单、日志模板和项目记忆入口
- 操作摘要：明确业务主库、wow-db、发布、备份恢复、SimC、TLS 和故障处置规则
- 备份/回滚点：不适用
- 验证结果：文档已创建；云端命令仍需在部署实施时验证
- 结果：成功
- 关联：`docs/cloud-deployment-and-release-plan.md`、`docs/aliyun-resource-sizing.md`

### 2026-08-19 12:11 +08:00 — 确认 ECS 取代 GitHub Pages 生产入口

- 环境：规划
- 执行人：Codex 辅助
- 变更类型：发布流程 / 文档
- 变更前：云端发布计划仍可能生成并推送 GitHub Pages 业务快照
- 变更后：ECS 应用提供前端静态资源和只读 API；游客通过权限读取最新数据；GitHub Pages 仅保留本地/历史兼容能力
- 操作摘要：明确生产不配置 Pages 凭据，04:00 流水线不生成 `pages-dist`；记录现有 runner 仍需在上云前移除 publication/deployment 阶段
- 备份/回滚点：不适用
- 验证结果：部署计划、systemd 目录契约、运维手册和应用 README 已同步
- 结果：成功
- 关联：`ops/systemd/README.md`、`docs/cloud-deployment-and-release-plan.md`
