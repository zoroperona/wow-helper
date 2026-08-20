# WoW Helper 云部署与发布计划

> 状态：已搁置。由于成本和性价比原因，本方案暂不作为当前实施依据；当前替代方案见 [本地优先 GitHub Pages 与匿名模拟申请计划](local-first-github-pages-simulation-plan.md)。本文保留作未来重新评估云部署时的历史设计，不应据此采购或部署 ECS/ACR/OSS。

> 本文是已搁置的历史目标设计，不代表所有能力已经实现。当前操作规范见 [常用运维手册](operations-runbook.md)，历史记录见 [操作日志](operations-log.md)。

## 0. 状态和术语

本文使用以下状态：

- **当前事实**：已存在于仓库并经过本地验证的行为。
- **目标**：云端正式环境必须达到的行为。
- **待实现**：尚未完成，不能在生产操作中假设可用。

当前已知事实：仓库已有本地安全 runner `scripts/run-daily-pipeline.mjs`，它不再调用 GitHub Pages，但仍直接执行本地备份，并使用 DPSWOW 完成每日角色刷新和模拟；`src/db.ts` 启动路径仍包含内部 schema 修改，`src/server.ts` 当前监听 `127.0.0.1`，`src/app.ts` 的多个读写路由尚未接入生产鉴权中间件，且 `/api/backups/export` 仍由 Web 进程直接写备份目录。官方英雄榜装备与 DPSWOW 天赋的合并、外部 migration runner、备份 manifest v1、API 权限、容器化、云端 systemd、云端鉴权和部署 CI 都是待实现项。

## 1. 第一阶段唯一生产部署路径

第一阶段只采用下面这一条正式路径，不在 CI 中保留 ACR/Docker 与裸 Node、手工上传等二选一逻辑：

```text
GitHub PR
  -> main CI
  -> 推送 vX.Y.Z Tag
  -> GitHub Actions 构建并扫描 Docker 镜像
  -> 推送阿里云 ACR（immutable digest）
  -> 创建 Draft GitHub Release
  -> GitHub Actions 通过受限 SSH 调用 ECS deploy.sh
  -> ECS 获取部署锁，停止写入任务和旧服务
  -> 生成并校验发布前业务库备份
  -> 拉取指定 ACR digest，安装为 staged 版本
  -> 由 deploy.sh 独占执行 migration
  -> 启动 staged 容器并检查 staged digest
  -> cutover：切换 Nginx upstream 和 current 指针
  -> 启动新 timer，执行 cutover 后健康检查
  -> 成功后发布 GitHub Release
```

正式路径的固定组件：

| 组件 | 第一阶段决定 |
|---|---|
| 运行方式 | Docker 容器 |
| 镜像仓库 | 阿里云 ACR，必须使用 digest 部署 |
| 部署触发 | GitHub Actions 通过受限 SSH 调用 ECS 部署脚本 |
| 进程管理 | ECS systemd 管理容器和 timer |
| 生产入口 | ECS 上的 Nginx + Node 应用 |
| 数据备份 | ECS 生成，OSS 保存 |

ACR、Docker 和部署 SSH 是第一阶段必需组件，不再标注为可选。将来可以评估 Kubernetes、ACK 或无 Docker 部署，但它们属于单独的架构迁移，不得混入当前 CI 契约。

SSH 只负责调用固定路径的部署脚本，不允许 CI 执行任意 root shell。ECS 部署脚本只接受已校验的版本号、commit 和镜像 digest。

### 1.1 发布状态机与 cutover

生产同时维护两个发布指针：

| 指针 | 含义 | 是否接收流量/写入 |
|---|---|---|
| `current` | 当前对外服务的已验证镜像、systemd unit 和配置 | 是 |
| `staged` | 已下载并校验、尚未切流的新版本 | 否 |

发布状态只能按以下顺序推进，不能跳步：

```text
current
  -> staged-pulled（校验 ACR digest、签名、commit、SBOM）
  -> quiescing（取得部署锁，停止 timer、模拟、wow-db 导入和旧 Node）
  -> migrated（写入冻结，外部 migration runner 完成并校验）
  -> staged-healthy（启动 staged 容器，检查其 digest、schema、API 和只读冒烟）
  -> cutover（Nginx 切换到 staged；更新 current 指针）
  -> resumed（启动新服务和 timer，完成 cutover 后检查）
```

`cutover` 是唯一的流量切换点。健康检查在 `staged-healthy` 阶段必须请求 staged 容器，而不是旧容器；在此之前旧服务已经停止且写入被冻结。切换成功后才允许恢复管理员写入、游客模拟和 timer。旧镜像至少保留一个发布周期，但不得在数据库已向前迁移且未通过 N/N-1 兼容验收时自动启动。

发布失败时：

- `staged-pulled` 或 `quiescing` 失败：恢复 `current` 服务和 timer，不恢复数据库。
- migration 未开始且数据库完整：恢复 `current` 服务，不恢复数据库。
- migration 成功后 staged 健康检查失败：只有通过 N/N-1 兼容门禁时才允许旧镜像回切，否则必须修复新版本或恢复数据库。
- `cutover` 后失败：先停止新写入，按 migration 决策表处理；禁止把“切换 Nginx”误认为 migration 可回滚。

### 1.2 首次生产上线（cold start）

第一台 ECS 不使用普通 Tag 发布状态机。首次上线必须由管理员按以下顺序执行，并在每一步保留可恢复点：

```text
准备域名/备案/安全组/ACR/OSS/KMS/RAM
  -> 创建并加密 ECS 系统盘和独立数据盘
  -> 安装 Docker、systemd、Nginx、certbot、SimC 运行依赖
  -> 安装同一 commit 的 release 编排和 systemd units
  -> 通过受控传输导入本地一致性业务库到临时路径
  -> quick_check、hash、关键表数量和 schema 5 结构指纹
  -> 执行 0005-baseline，禁用应用启动隐式迁移
  -> 初始化 wow-db 当前/上一版目录和 SimC 运行目录
  -> 配置初始 Nginx HTTP/HTTPS、证书和健康检查
  -> 以 staged 端口启动首个容器，创建 current 指针
  -> 通过本地受控命令创建第一个管理员
  -> 只读/权限/备份/模拟冒烟通过后开放 DNS 流量
```

首次上线验收门槛：

- 数据盘、系统盘和快照均启用 KMS 加密；目录 owner/group、权限和挂载模式符合第 2.1 节。
- 初始业务库备份已生成并上传 OSS，manifest 签名、解密和恢复测试通过；本地原始数据库保留为离线回滚点。
- `current` 指针、Node/Nginx upstream、实际镜像 digest、schema、wow-db Build 和 `/api/meta` 一致。
- 第一个管理员只通过 ECS 本地 console 或受限 forced-command bootstrap 创建，不通过公网注册接口创建。
- TLS 证书、HTTP→HTTPS 跳转、80/443 安全组、Nginx reload 和到期监控全部通过。
- 失败时关闭公网流量，停止容器，保留事故现场数据库和安装日志；从本地/OSS 备份重建，不把半初始化 ECS 标记为生产。

首次上线未完成前，GitHub Release 只能保持 Draft，不能发布为 Published，也不能启用 03:30/04:00 生产 timer。

## 2. 目标架构

```text
用户
  -> HTTPS / Nginx
  -> ECS 上的 Node 容器（systemd 管理）
      ├── 业务 SQLite：唯一生产主库，可写
      ├── wow-db SQLite：只读当前游戏数据
      ├── SimulationCraft 及短期运行产物
      ├── 管理员会话记录（仅哈希）
      └── 英雄榜会话（独立加密文件）
  -> OSS：业务备份、wow-db 发布资产、恢复清单
```

生产不使用 GitHub Pages 发布业务快照。ECS 应用提供前端静态资源和 API；游客通过只读 API 读取最新数据。`pages:*` 只保留本地/历史导出能力，不能出现在生产 CI 或每日任务中。

### 2.1 Docker、systemd 和 Nginx 运行时契约

这是第一阶段必须实现并在 ECS 验收的运行时契约：

- Web、migration、backup 和 daily job 使用同一 Release 的不可变镜像，但由不同 systemd service/one-shot service 启动；备份和 SimC 不在 Web 进程内隐式执行。
- 容器以固定非 root `UID:GID=10001:10001` 运行，root filesystem 只读，`/tmp` 使用 tmpfs，并启用 `NoNewPrivileges`。
- 主机目录挂载如下：业务库 `/srv/wow-helper/data` 到容器 `/app/data` 可写；当前 wow-db `/srv/wow-helper/wow-db` 只读；SimC 运行目录由 job service 可写；Web 容器对备份目录只读，backup service 才能写入备份目录；会话目录仅按需要以最小权限挂载。
- `/etc/wow-helper/app.env` 只读挂载，不进入镜像。生产密钥由 RAM/KMS/凭据管家注入。
- Node 在容器内监听 `0.0.0.0:3000`，主机只发布到 `127.0.0.1:3100`（staged 可使用 `127.0.0.1:3101`）；Nginx 监听 80/443 并反代到当前 upstream。当前代码监听 `127.0.0.1`，容器化前必须改为可配置监听地址并完成测试。
- systemd 必须设置 `ReadWritePaths`、`WorkingDirectory`、超时、资源限制和 `RequiresMountsFor=/srv/wow-helper`；Web service 与 job service 共享全局部署锁，但不能共享可变容器状态。
- staged 容器只能用于健康检查和只读冒烟，不能启动 timer、后台刷新或模拟；通过 cutover 后才启用新版本 timer。
- 本地备份由专用 `wowhelper-backup` service 用户生成，目录 `0700`、文件 `0600`；备份压缩包使用 KMS `GenerateDataKey` 生成的 per-backup AES-256-GCM 数据密钥加密，manifest 只保存加密数据密钥引用/密文和 KMS key version，不保存明文密钥。ECS 数据盘、系统盘和云盘快照均使用同一受管 KMS 密钥加密。
- 业务库备份使用 SQLite Backup API 生成独立文件，不复制活跃 WAL/SHM；恢复前先停止所有访问者并保存事故现场的 `.sqlite`、`-wal`、`-shm`，确认恢复目标目录无残留 sidecar 后才原子替换。清理任务只能删除已确认不再使用的备份及其 sidecar。
- 主机权限闭环：创建 `wowhelper-db` 组（GID 10001）、Web/job 容器使用 UID/GID 10001 并加入该组；`wowhelper-backup` 使用独立 UID 10002，不加入写组，仅通过明确的 POSIX ACL 对业务目录获得 `x`、对 SQLite/WAL/SHM 获得只读权限。业务目录 owner `root:wowhelper-db`、目录 `0770`、SQLite/WAL/SHM `0660`。备份目录 owner `wowhelper-backup:wowhelper-backup`、目录 `0700`、文件 `0600`，Web 以只读挂载且不加入备份写组；ACL 只在明确需要时授予，不使用 `0777` 或共享 root。

## 3. 数据库边界

| 文件 | 作用 | 生产权威位置 | 更新方式 |
|---|---|---|---|
| `loot-allocator.sqlite` | 成员、分配、规则、模拟结果、会话哈希和审计 | ECS 独立数据盘 | 应用/migration 写入 |
| `wow.sqlite` | DB2、掉落目录和装备计算数据 | ECS 独立数据盘 | 按 Build 发布并原子替换 |

业务库只有一个在线写主库。OSS 是带校验的备份副本，不是在线数据库；本地数据库不能与 ECS 双向同步，也不提交 Git。

## 4. 应用版本和 Release 语义

应用使用 SemVer，初始版本 `v0.1.0`。网页目标显示应用版本、commit、wow-db Build 和业务 schema。

GitHub Release 有两种明确状态：

| 状态 | 含义 | 是否表示生产成功 |
|---|---|---|
| Draft Release | Tag 对应的构建产物、镜像 digest、SBOM 和说明已生成 | 否 |
| Published Release | ECS 部署、migration、timer 和健康检查全部通过 | 是 |

部署失败时 Draft 保留并标记失败，不能把它当作已发布版本；Tag 不重用、不覆盖。只有生产验证成功后，CI 才将 Draft Release 发布。

## 5. Pull Request 和 Tag CI

### 5.1 PR CI

目标流程：

1. 检查 SQLite、压缩包、Cookie、密钥和生产配置未提交。
2. Node 22 执行 typecheck、test、build。
3. .NET 10 执行 restore、test、Release build。
4. 检查 migration 编号、checksum 和升级测试。
5. 构建 Docker 镜像并运行启动/健康检查。
6. 运行静态守卫，确认生产 runner 不引用 `publish-pages`、`deploy-pages` 或 `PAGES_*`。
7. 对 systemd units 执行 `systemd-analyze verify`。

### 5.2 Tag 发布

推送 `v1.1.1` 后：

1. 校验 Tag 与 `package.json` 版本一致，并确认 Tag 指向受保护的 `main` commit。
2. 重跑完整测试。
3. 构建镜像，生成 SBOM 和 SHA-256，推送 ACR 并记录 digest。
4. 创建 Draft GitHub Release，附镜像 digest、migration 列表和回滚说明。
5. 生成并签名 release manifest；GitHub Environment 审批通过后，通过 forced-command SSH 触发 ECS `deploy.sh`。
6. ECS 校验 manifest、ACR digest、commit、签名和部署锁。
7. ECS 停止旧服务、所有业务 timer、模拟和 wow-db 导入，进入写入冻结；由同一 backup service 生成并校验发布前备份。
8. ECS 拉取 digest 作为 `staged`，安装同一 commit 的 units，但不启用新 timer。
9. 外部 migration runner 独占执行 migration；应用启动只允许 schema 检查，不得隐式修改 schema。
10. 启动 staged 容器到临时端口，检查实际 digest、schema、API 权限和只读冒烟。
11. 执行唯一 cutover：切换 Nginx upstream、更新 `current` 指针、启动新服务和 timer，再执行 cutover 后健康检查。
12. 全部通过后将 Draft Release 发布；任一步失败则保留 Draft，按状态机执行应用/timer 回滚或数据库恢复。

生产不得依据 `latest`、可变 tag 或未校验的镜像 URL 部署。

### 5.3 CI 到 ECS 的信任链

“SSH 传 digest”本身不是信任边界。第一阶段必须满足：

1. GitHub `production` Environment 开启 required reviewers；只允许受保护的 `v*` Tag 工作流部署，使用 `concurrency: production-deploy` 串行化发布。
2. GitHub Actions 通过 OIDC 换取阿里云 RAM 短期凭证推送 ACR；ECS 使用实例 RAM 角色只读拉取指定仓库，不在镜像、GitHub 长期 secret 或命令行保存 AccessKey。
3. CI 生成签名的 `release-manifest.json`，至少包含仓库、Tag、commit、镜像 digest、SBOM SHA-256 和 workflow run id。ECS 固定保存发布公钥，先验证签名，再向 ACR 查询 digest、OCI commit label 和仓库路径；任一不一致都拒绝部署。
4. SSH 主机指纹固定在 GitHub Environment 的 `known_hosts` 中并启用严格校验。部署密钥只能访问专用账号；`authorized_keys` 使用 forced command，只允许提交 manifest 引用，不能执行任意 shell。专用账号仅能通过 sudoers 调用固定 `deploy.sh`。
5. `deploy.sh` 不信任 SSH 参数中的版本或 digest 字符串，必须从签名 manifest 和 ACR 查询结果重建部署参数。部署锁由 ECS `flock` 持有，和 systemd job 锁互斥。
6. SSH、OIDC/RAM、ACR pull role 和发布签名密钥均需有轮换与撤销记录；默认每 90 天轮换，发生泄露时立即吊销并在运维日志记录。

GitHub Release 只有在 ECS 回传带有 manifest digest、实际容器 digest、migration 状态和 cutover 检查结果的成功证明后才从 Draft 变为 Published。

## 6. Migration 规则与回滚决策

### 6.1 迁移原则

- migration 只允许向前执行，不支持生产 schema 降级。
- 使用 `schema_migrations` 表记录编号、checksum、开始/完成时间和状态。
- 每个 migration 尽量在单一 SQLite 事务中完成；非事务操作必须拆成可恢复步骤并单独验证。
- runner 在开始前持久化 `running` 记录；成功后才写入 `success`，事务失败后只有在回滚和完整性检查都通过时才能写入 `failed`。进程中断或无法证明回滚完成时保留 `running`/未知状态，按部分执行处理。
- 只有 ECS `deploy.sh` 调用 migration runner；Web 容器和旧版本应用不得执行 migration。应用启动时只检查 schema，不得自动创建、升级或修改表。
- migration runner 必须先取得 `/run/lock/wow-helper-deploy.lock`，再取得 SQLite `BEGIN IMMEDIATE`；第二个 deploy/runner 直接失败并保留现状，不能排队同时执行。
- 使用 expand/contract：先增加兼容结构，再发布代码，确认稳定后才删除旧结构。
- 新代码必须兼容旧 schema，直到 migration 完成；旧代码不保证兼容新 schema。
- CI 必须在生产备份副本上演练升级，并验证重复执行不会破坏数据。

### 6.2 现有 schema 基线转换

当前代码事实是 `app_meta.schema_version=5`，并且 `db.ts` 启动路径仍包含内部迁移逻辑。上线前必须执行一次人工批准的基线转换：

1. 停止写入，生成并校验最终备份，确认 `app_meta.schema_version` 为 `5`。
2. 对表、索引、触发器和关键列执行结构指纹校验；与预期 schema 5 不一致时停止，不得猜测基线。
3. 运行一次 bootstrap migration，在事务中创建 `schema_migrations`，写入不可重复执行的 `0005-baseline`、文件 SHA-256、状态 `success` 和基线时间；bootstrap 不改业务数据。
4. 在隔离副本上验证基线后的重复执行是幂等的，再切换生产配置 `AUTO_MIGRATE=0`（或等价开关）。
5. 代码删除/禁用 `db.ts` 的隐式 schema 修改；启动时发现 schema 不匹配直接 fail closed，并提示由 deploy script 执行 migration。

`0005-baseline` 不是伪造历史 migration：它只证明已验收的现有 schema 5 结构，不允许在结构指纹不一致时强行插入。

### 6.3 migration 文件与 checksum 规范

- 文件路径为 `migrations/<六位编号>_<slug>.sql`，编号单调递增且不可复用；每个文件只允许对应一个 schema 版本。
- checksum 是 migration 文件 UTF-8 原始字节的 SHA-256，不做换行或空白规范化；`schema_migrations` 保存十六进制小写值。
- 记录至少包括 `migration_id`、`checksum`、`attempt_id`、`status`、`started_at`、`finished_at`、`runner_version` 和错误摘要；attempt 记录不可变，不能覆盖历史。
- CI 检查编号连续性、重复 checksum、SQL 解析/升级演练和降级禁止规则；checksum 不一致时发布门禁失败。

### 6.4 写入隔离与部分执行判断

migration 前的固定顺序为：取得部署锁 → 停止 daily/backup/maintenance/wow-db timer → 将 Nginx 切到维护响应并阻止管理员写入和游客模拟 → 取消运行中的模拟并向其进程组发送 SIGTERM → 等待 grace period 后对仍存活的进程组发送 SIGKILL → 等待所有子进程退出并确认任务锁释放 → 用 `lsof`/`fuser` 或等价检查确认 SQLite 没有其他打开者 → 停止旧 Node 容器 → 生成发布前备份 → 执行 migration。只写“失败”或更新状态文件不算终止；在 SQLite 仍有打开者时禁止备份、导入和 migration。

锁层级固定为：部署锁 `/run/lock/wow-helper-deploy.lock` → 备份操作锁 `/run/lock/wow-helper-backup.lock` → SQLite `BEGIN IMMEDIATE`。deploy.sh 持有部署锁时，不得再次等待同一个锁：发布前备份以继承的 lock FD（例如 FD 9）调用 backup service，backup service 检测 `WOW_HELPER_LOCK_FD=9` 后只校验该 FD，不重新打开部署锁，再获取备份操作锁。独立的 03:30 backup.timer 直接按上述顺序获取两个锁。CI 必须测试“deploy 持锁调用 backup”不会死锁，以及第二个 deploy/backup 会明确失败。

部署脚本执行 migration 后必须读取 `schema_migrations`：

| 状态 | 判断 | 动作 |
|---|---|---|
| 未开始 | 目标 migration 没有记录 | 允许应用回滚，保留数据库 |
| 已完成 | 所有目标 migration `success` 且 checksum 正确 | 启动新应用并继续验证 |
| 事务失败 | migration 记录为 failed，事务已 rollback，且 `quick_check` 与结构检查通过 | 停止发布，数据库可保留，修复后重新发布 |
| failed 但回滚/完整性无法证明 | `failed` 记录存在，但回滚验证失败或检查无法完成 | 按部分执行处理，禁止启动任一版本并恢复数据库 |
| 部分执行/未知 | 存在 running、checksum 不符、结构检查失败或进程中断 | 禁止启动新旧应用，进入数据库恢复流程 |

禁止通过手工修改 `schema_migrations` 掩盖未知状态。

### 6.5 failed migration 重试状态机

每次执行生成新的 `attempt_id`，但复用同一个不可变 `migration_id`：

```text
pending -> running(attempt-1) -> success
                         \-> failed(已验证 rollback) -> retry(attempt-2)
                         \-> unknown/running 遗留 -> restore required
```

只有 `failed` 且事务回滚、`quick_check`、结构检查均成功时允许 retry；retry 必须使用完全相同的文件 checksum。禁止编辑原文件后重试、删除 failed 记录或用新 checksum 覆盖历史；checksum 变化必须创建新的 migration_id 并重新走 expand/contract。一个 migration 只能有一个 active attempt，旧 attempt 永久只读。

### 6.6 N/N-1 兼容门禁与回滚决策表

自动回滚旧镜像前必须通过 N/N-1 兼容测试：在代表性生产副本上用旧版本读取并写入 expand 后 schema，再用新版本读取这些写入；覆盖游客读取、管理员分配、模拟结果、审计和 session 失效。若新版本已经写入旧版本无法理解的列、枚举或编码，必须通过双写/feature flag 消除差异，否则禁止回切旧镜像。

| 情况 | 回滚应用镜像 | 恢复业务数据库 | 原因和数据窗口 |
|---|---:|---:|---|
| migration 未开始，旧 schema 完整 | 是 | 否 | 旧应用仍可用 |
| migration 成功，健康检查失败且 N/N-1 读写测试通过 | 是 | 否 | 可切回兼容镜像，不丢发布前后的业务写入 |
| migration 成功，但 N/N-1 测试未通过或新写入旧版本不可理解 | 否 | 通常否 | 禁止自动回切；修复新版本并继续向前 |
| migration 成功，但旧应用不兼容新 schema | 否，先修复/继续向前 | 通常否 | 不允许 schema 降级；应发布兼容修复 |
| migration 部分执行或 checksum/结构未知 | 否 | 是 | 从发布前备份恢复，丢失备份完成后的写入 |
| SQLite `quick_check` 非 `ok` 或业务数据校验失败 | 否 | 是 | 视为数据完整性事故 |
| 新应用代码故障，migration 未执行 | 是 | 否 | 只回滚镜像和 timer |

恢复顺序固定为：停止写入 → 保存事故现场库 → 下载并校验发布前备份 → 原子恢复 → 执行允许的向前 migration → 启动兼容版本 → 完整性和业务冒烟。

数据库恢复会丢失“发布前备份完成之后到事故发生前”的业务写入。发布前备份必须记录时间；如果无法接受该窗口，发布必须停止并改用更高等级数据库方案，而不是强行恢复。

## 7. 备份职责和调度

### 7.1 唯一职责

业务库备份的唯一“定时任务”生成者是 `backup.timer`，计划每日 03:30 执行：

```text
Backup API -> quick_check -> SHA-256 -> 压缩 -> 上传 OSS -> manifest -> 告警状态
```

04:00 `daily-pipeline` 不再生成第二份备份，只检查 03:30 备份 manifest 是否存在、校验通过且未超过门禁时间；门禁失败则不开始全团模拟并告警。

发布门禁和定时备份是两个不同职责：`backup.timer` 负责按日生成恢复点；`daily-pipeline` 只消费该恢复点并执行门禁；发布脚本只在 Tag 部署前显式生成发布专用恢复点。其他备份：

- 应用 Tag 部署前：由部署脚本显式调用同一 backup service，生成一次发布前备份。
- wow-db 更新：不备份业务库；保留上一版 wow-db 文件和 manifest。
- 手工备份：管理员操作，使用同一 backup service，不复制活跃 WAL。

这样“每日备份”和“发布前备份”是有意的两个时间点，但各自只有一个执行者；每日流水线不重复生成。

### 7.2 备份 manifest 机器契约

每个备份必须生成同名 JSON manifest，版本固定为 `backup-manifest/v1`。至少包含以下字段，缺一项即视为备份失败：

```json
{
  "manifestVersion": "backup-manifest/v1",
  "backupId": "uuid",
  "reason": "daily|release-preflight|manual",
  "generatedAt": "2026-08-19T03:30:00.000Z",
  "database": { "schemaVersion": 5, "migrationId": "0005-baseline" },
  "files": {
    "raw": { "bytes": 0, "sha256": "..." },
    "compressed": { "bytes": 0, "sha256": "...", "ossKey": "...", "ossVersionId": "..." }
  },
  "encryption": {
    "mode": "local+OSS-KMS",
    "keyRef": "alias/wow-helper-backup",
    "keyVersion": "kms-key-version-7",
    "wrappedDataKey": "base64url...",
    "cipher": "AES-256-GCM",
    "nonce": "base64url...",
    "authTag": "base64url..."
  },
  "validation": { "quickCheck": "ok", "integrity": "ok", "validatedAt": "..." },
  "antiReplay": { "sequence": 1234, "expiresAt": "2026-08-20T03:30:00.000Z" },
  "signature": {
    "algorithm": "Ed25519",
    "keyId": "backup-manifest-signing-v3",
    "canonicalization": "RFC8785",
    "signedAt": "2026-08-19T03:30:02.000Z",
    "value": "base64url..."
  }
}
```

签名输入定义为“manifest 全部字段 + `signature` 元数据，但不包含 `signature.value`”组成的对象；该对象使用 RFC 8785 canonical JSON 编码为 UTF-8 canonical bytes 后进行 Ed25519 签名，最终把 base64url 签名值写入 `signature.value`。不能使用未定义的 null/空白占位或签名后修改其他字段。签名私钥只在 backup service 的 KMS/HSM 或受限凭据服务中使用，ECS 只保存公钥和 `keyId` 到公钥版本的映射。

`backupId`、生成时间、原始/压缩文件大小和 SHA-256、schema/migration、OSS 对象版本、加密模式/密钥引用、KMS key version、wrapped data key、nonce/auth tag、验证结果、`antiReplay.sequence` 和 `expiresAt` 均由程序生成，不能由人工编辑。`keyRef` 只能是 KMS 密钥标识，不能写入明文密钥。04:00 门禁必须验证签名算法、canonical bytes、可信 `keyId`/公钥版本、签名时间、sequence 未回退且 `expiresAt` 未过期、OSS 对象版本存在、SHA-256 可重算、`quick_check=ok`、schema 在应用支持范围内且生成时间不超过 26 小时。签名 key 轮换时保留旧公钥至少覆盖所有未过期 manifest 的门禁窗口。

### 7.3 备份职责切换验收

当前代码事实：`run-daily-pipeline.mjs` 仍直接调用 `scripts/backup-database.mjs`。在以下验收全部通过前，不能同时启用新的 `backup.timer` 和旧 runner 的 backup stage：

1. backup service 能生成 `backup-manifest/v1`，并完成 OSS 上传、回读和校验。
2. daily pipeline 的门禁测试覆盖 manifest 缺失、过期、hash 错误、schema 不支持和 OSS 不可用，并在这些情况阻止模拟。
3. 在测试 ECS 连续执行一次 03:30 backup、一次 04:00 `--check` 和一次失败重试，确认无重复写入、无并发锁冲突。
4. 发布一个移除旧 backup stage 的应用版本，并通过静态检查确认 runner 不再调用 `backup-database.mjs`。
5. 仅在上述版本切换成功后启用 03:30/04:00 两个 timer；切换前由旧流程负责备份，切换后由 backup service 负责备份，不能两者并行。

### 7.4 调度表

| 任务 | 时间 | 是否补跑 | 责任 |
|---|---|---|---|
| `backup` | 03:30 | 是 | 唯一生成业务库备份 |
| `daily-pipeline` | 04:00 | 否 | 备份门禁、官方刷新、全团模拟、校验 |
| `maintenance` | 09:00 | 否 | 清理短期产物和旧本地备份 |
| `health-check` | 每 15 分钟 | 是 | 服务、磁盘、版本、备份新鲜度和任务状态 |

所有单元目标存放在 `ops/systemd/`。云端 systemd 尚未实现，不能假设这些 timer 已存在。

## 8. 游客公开数据边界

匿名游客不等于匿名数据公开。上线前必须明确团队同意的隐私策略。目标默认采用“隐私优先”模式：

### 8.1 游客默认可见

- 当前赛季的副本、Boss、装备目录和装备详情。
- 脱敏后的成员标识（稳定 pseudonym，例如“成员 A01”），职责和职业类别。
- 脱敏后的收益分数、装等区间和更新时间。
- 当前赛季的分配汇总和历史记录，但使用 pseudonym，不显示真实服务器、外部链接、原始 SimC 路径或备注。
- 试分配结果，不写入业务库。

### 8.2 默认不可见

- 真实角色名、服务器和可反推个人身份的组合信息。
- 英雄榜/DPSWOW 原始响应、URL、战网信息和浏览器会话。
- 原始 SimC profile、HTML、日志和内部文件路径。
- 管理员操作人、IP、审计详情和未发布的失败原因。
- 非当前赛季数据，以及其他团队/租户的数据。

### 8.3 明确授权后才可公开

管理员可以在部署配置中选择 `PUBLIC_PRIVACY_MODE=names`，公开真实角色名和服务器；该配置必须经过团队/成员同意并记录在运维日志。默认值必须是 `masked`。所有 API 按 active season 隔离，未来多团支持前不得接受任意 `teamId` 查询。

管理员视图可以显示完整数据。游客 API 和管理员 API 使用不同 DTO，不能仅靠前端隐藏字段。

### 8.4 API 权限矩阵

默认策略是 deny-by-default：目标实现要求路由先经过认证、CSRF、限流和 active-season middleware，未明确列出的 endpoint 一律返回 403/404，不依赖前端隐藏按钮。当前代码尚未满足这一目标，不能在生产开放；`guest` DTO 永远不包含真实角色名、服务器、内部 ID、原始响应或审计字段。

| API 类别 | 游客 | 管理员 | 内部任务 |
|---|---|---|---|
| `GET /api/state`、成员/收益/分配只读查询 | 允许 masked、当前赛季 | 允许完整 DTO | 允许 |
| `GET /api/loot/catalog`、装备详情、图标、规则读取 | 允许公开字段 | 允许完整字段 | 允许 |
| `POST /api/public/players/:publicPlayerKey/simulate` | 允许，IP/key 限流、队列去重，不写分配 | 允许使用管理员 DTO 或内部 ID | 允许 |
| `GET /api/simulations/status`、公开最新模拟结果 | 允许脱敏结果 | 允许完整结果 | 允许 |
| `POST /api/allocations`、`PATCH`、`DELETE` | 拒绝 | 允许，写审计 | 拒绝，除非专用任务授权 |
| `PUT /api/loot/rules/:key`、成员增删改 | 拒绝 | 允许，写审计 | 拒绝 |
| `POST /api/simulations/stale`、英雄榜刷新、天赋/权重导入 | 拒绝 | 允许手动触发 | 允许使用任务凭证 |
| `/api/backups/export`、系统健康细节、原始角色响应 | 拒绝 | 备份导出 API 在生产删除/返回 404；管理员通过受控 backup service 操作 | 仅内部 health token |
| `/api/publication` | 生产禁用 | 生产禁用 | 禁用 |

管理员登录、登出和会话检查使用独立 `/api/admin/*` 路由。Cookie 会话的所有写操作必须通过 CSRF token 加 `Origin/Referer` 校验；`SameSite=Strict` 不能替代 CSRF。Nginx 只信任固定反向代理地址，应用生产环境始终设置 `Secure` Cookie，拒绝通过明文 HTTP 建立会话。

登录失败按 IP 和账号双维度限流（例如 15 分钟 5 次），成功后轮换 session ID；logout、密码轮换、管理员主动撤销、session epoch 变化和数据库恢复都会使旧会话失效。游客模拟不接受 `/api/players/:id` 形式的内部 ID；服务端为当前赛季成员生成不可枚举的随机 `publicPlayerKey`（至少 128 bit，数据库只保存哈希），或发放短期、绑定赛季和操作类型的签名 token。该 key/token 只允许调用模拟，不允许用于成员读取、分配或其他写操作。

pseudonym 使用 KMS 管理的 HMAC-SHA-256 密钥计算 `HMAC(keyVersion:seasonId:playerId)`，取固定长度 Base32，并在成员快照/公开结果中保存 `pseudonymKeyVersion`。同一赛季一旦产生公开 pseudonym，不因 key 轮换而改写；key 轮换只对新赛季生效，旧 key version 至少保留到该赛季及其公开历史保留期结束（当前策略为 24 个月），之后转为离线加密归档或按合规策略销毁。读取历史记录时按记录中的 key version 使用对应 KMS key，不能用当前 key 重新计算旧 pseudonym。

生产 Web 容器不挂载备份目录写权限，且删除 `/api/backups/export` 生产路由；管理员备份、发布前备份和恢复均通过受控 backup service/SSH forced command 执行。若未来需要 Web 发起备份，只能提交 IPC/队列请求，由 backup service 校验管理员会话、写入审计并生成 manifest，不能让 Web 直接创建 SQLite 备份文件。

### 8.5 游客模拟资源隔离

单 ECS 只能接受受控的模拟负载。目标实现固定以下门槛，参数调整必须经过压测和运维日志：

| 控制项 | 目标值 |
|---|---|
| 全局同时运行 | 1 个 SimC 进程；每日全团任务运行时游客模拟暂停 |
| 全局等待队列 | 最多 8 个，满载返回 `429 QUEUE_FULL` 和 `Retry-After` |
| 单 `publicPlayerKey` | 最多 1 个运行中、2 个排队；相同输入去重 |
| IP/Key 配额 | 每 IP 每日 20 次、每 key 每日 5 次；管理员/内部任务走独立配额 |
| 游客参数 | 服务端固定 profile、iterations、线程和超时；拒绝客户端传入 `iterations`、threads、SimC flags、任意路径和输出目录 |
| 游客默认资源 | 最多 300 iterations、2 threads、10 分钟；超时按 SIGTERM → SIGKILL 终止并释放锁 |
| systemd cgroup | guest job `CPUQuota=150%`、`MemoryMax=2G`、`TasksMax=64`、独立 `IOWeight`；具体值需在推荐 ECS 压测后确认 |
| 维护/发布期间 | 队列停止接收新请求，已有游客任务按取消流程终止 |

队列必须持久化最少状态（request id、public key hash、创建时间、状态和结果引用），不保存游客提交的任意文件。管理员和 04:00 全团任务拥有保留队列/锁权限；资源达到 CPU、内存、磁盘或队列阈值时拒绝游客请求并告警，不能让游客任务挤占 Web、备份或发布资源。

## 9. 会话和敏感凭证存储

管理员登录会话和英雄榜会话是两种不同凭证：

| 凭证 | 存储目标 | 备份/失效 |
|---|---|---|
| 管理员 Cookie 原值 | 只在浏览器 | `HttpOnly`、Secure、SameSite=Strict、TTL |
| 管理员会话记录 | 业务 SQLite `admin_sessions`，只存随机 token 哈希、创建/过期/撤销时间 | 会随业务库备份；恢复后必须轮换 session epoch，使旧 Cookie 全部失效 |
| 管理员哈希密钥/epoch | 阿里云 KMS/凭据管家 | 轮换会撤销全部会话 |
| 英雄榜 Playwright storageState | ECS 独立加密文件或 KMS Secret，不在业务库 | 不进入 Git、Docker 或普通业务库备份；替换前验证，失效时单独重授权 |

管理员会话记录不保存明文 Token。业务库恢复后部署脚本必须增加 `AUTH_SESSION_EPOCH` 或等价轮换动作，避免恢复旧备份意外复活已撤销会话。英雄榜会话仅用于官方数据读取，与管理员登录权限无关。

### 9.1 管理员初始引导、找回和紧急撤销

- 首个管理员只能通过 ECS 本地 console 或 SSH forced-command bootstrap 创建；公网没有注册、重置或找回接口。bootstrap 要求一次性 enrollment token、交互式确认和审计记录，成功后立即销毁 token。
- 密码使用 Argon2id（目标参数：`m=64 MiB`、`t=3`、`p=1`，上线前用 ECS 压测确认）和每用户随机 salt；数据库只保存 PHC 字符串，不保存明文或可逆密钥。
- 忘记密码时，管理员在受信任电脑生成一次性恢复请求；通过 GitHub `production` Environment 双人审批或 ECS 本地 console 运行固定 `admin-recover` 命令，设置新密码并轮换 session epoch。恢复过程必须记录 actor、时间、原因和结果摘要，不记录密码/token。
- 所有会话失效时，只允许同一受控 `admin-recover` 路径恢复；禁止临时打开公网免认证模式。紧急撤销使用 `admin-revoke --all`，立即轮换 epoch、撤销会话并停止高风险任务。
- bootstrap/recover/revoke 命令属于版本化运维脚本，使用与 deploy 相同的 forced-command/sudoers 限制，并在测试 ECS 完成演练后才允许生产使用。

## 10. wow-db 发布不可变性

每个 Build 使用独立、不可覆盖的 OSS 对象路径：

```text
releases/wow-db/<build>/<sha256>/wow-db-<build>-cn-zhCN.zip
releases/wow-db/<build>/<sha256>/transfer-manifest.json
```

规则：

- OSS Bucket 开启版本控制、私有访问和对象写入保护；CI 使用 `If-None-Match: *`，禁止覆盖已存在对象。
- `wow-db.lock.json` 同时记录 Build、文件大小、SHA-256、GitHub Release Tag、Release asset digest 和 OSS 对象 key。
- 镜像到 OSS 后，CI 从 GitHub 和 OSS 分别下载/计算 SHA-256；不一致就失败，不创建 lock 更新 PR。
- lock PR 合并前不允许 ECS 下载新版本；ECS 只接受 lock 中的精确 key 和 SHA-256。
- GitHub Release 资产或 OSS 镜像失败时，版本保持未锁定，ECS 继续使用上一版。
- ECS 下载到临时目录，校验 manifest、SHA-256、Build、关键表和 `quick_check` 后才原子替换。
- 当前 Web 进程对 wow-db 持有缓存连接和目录数据；不支持只替换文件而让旧进程继续运行。导入流程必须先停止 Web/current 和所有 wow-db 使用者，原子替换后启动新 Web/staged，再通过 `/api/meta` 或健康接口核对实际加载的 Build、文件 SHA-256 和关键表，成功后才恢复流量。热重载只有在实现并测试显式 `reloadWowDb()` 后才可作为替代，不能假设文件替换会自动生效。

## 11. wow-db 更新流程

```text
Windows 客户端生成交接包
  -> GitHub Release 资产校验
  -> OSS 不可变镜像
  -> lock.json PR
  -> 合并后手动/受控部署
  -> 停止 Web/current 和 wow-db 使用者
  -> ECS 校验、原子替换并重启/重新加载应用
  -> 健康检查确认实际加载 Build
  -> 健康检查失败则恢复上一版
```

wow-db 更新不改变应用版本，不修改业务 SQLite，也不触发业务 migration。

### 11.1 赛季 rollover 流程

赛季切换是独立的受控变更，不等同于 wow-db 发布，也不能只替换 wow-db 文件完成。目标流程：

```text
冻结游客模拟和管理员写入
  -> 获取部署/season lock，停止 daily/backup/wow-db 导入
  -> 生成并校验旧赛季最终业务备份和归档 manifest
  -> 将旧赛季置为 archived，保留只读历史和 pseudonymKeyVersion
  -> 导入/确认新赛季 wow-db Build（按 wow-db 流程重启 Web 并核验）
  -> 创建新 season 记录和 loot rules 草案，保持 active season 不变
  -> 导入新赛季成员映射/初始快照，运行 schema/数量/权限检查
  -> 管理员确认 rules、gameVersion、公开策略和成员名单
  -> 单事务切换 active season，新赛季 pseudonym 使用新 key version
  -> 清理/重建新赛季可再生缓存，恢复服务和 timer
  -> 游客/管理员/API/模拟冒烟及回滚点确认
```

切换前必须记录旧 `seasonId`、wow-db Build、schema、规则 hash、成员数量和最后模拟时间；新 season 必须拥有唯一 `is_active=1`，游客 API 只返回新 active season，旧 season 通过管理员/历史只读路径访问。旧 season 的分配、收益、快照和 pseudonym 不删除，按保留策略归档；新 season 不得复用旧 pseudonym key version。

如果新 Build、规则、成员导入或冒烟失败，保持旧 season active，恢复旧 wow-db/缓存并释放锁；只有 active season 切换事务成功且健康检查通过后，才允许删除临时新赛季数据或开放游客模拟。赛季 rollover 必须有独立操作日志和可恢复备份。

## 12. 生产成功、失败和回滚

应用生产成功的必要条件：

- 镜像 digest 与 Draft Release 一致。
- migration 状态为 success，checksum 正确。
- systemd service/timer 来自同一 commit 且下次触发时间正确。
- Node/Nginx 健康检查通过。
- 游客/管理员权限冒烟通过。
- `quick_check`、版本信息和关键业务数量通过。
- 发布前备份 manifest 已上传 OSS。

任一失败：

1. 阻止发布 Draft → Published。
2. 停止新任务和写入，保存日志及事故现场数据库。
3. 按第 6 节决定只回滚镜像/timer 或恢复数据库。
4. 验证旧版本或恢复版本后再开放流量。
5. 在运维日志记录失败原因、数据窗口和回滚点。

## 13. 灾难恢复边界、RPO/RTO 和演练

第一阶段接受单 ECS 运行，但不能把同地域 OSS 备份描述成地域级高可用。上线前必须接受以下目标，并在资源采购中落实：

| 故障场景 | 目标 RPO | 目标 RTO | 恢复方式/边界 |
|---|---:|---:|---|
| ECS 进程、容器或云盘故障 | ≤ 26 小时；发布前备份可缩短发布窗口 | ≤ 4 小时 | 同地域 OSS 最近 manifest + 新建/重装 ECS；云盘快照只作辅助 |
| ECS 实例所在可用区故障 | ≤ 26 小时 | ≤ 8 小时 | 在同地域另一可用区启动 ECS，恢复 OSS 备份并切 DNS；期间服务不可用 |
| OSS 短时不可用、KMS 可用 | 以 ECS 本地最近 7 份备份为临时恢复点 | ≤ 8 小时 | 不删除本地备份；恢复后补传 OSS |
| KMS 不可用（包括本地备份无法解包） | 无法承诺，必须等待 KMS 恢复或使用已验证的独立灾备密钥 | 不承诺 RTO | 不允许伪造解密、关闭加密或覆盖主库；如业务必须在 KMS 故障时恢复，需另行采购双 KMS/离线密钥方案并重新评审 |
| 整个地域故障且已启用跨地域副本 | ≤ 7 天（跨地域每周加密副本） | ≤ 24 小时，人工重建 | 第二地域独立 OSS/KMS；DNS/备案切换和 ECS 重建为人工流程，不承诺无缝故障转移 |

跨地域副本不是直接复制源地域密文。复制 service 在源地域读取并验证源 manifest，使用源 KMS 解包 data key、在受控内存/临时加密目录中解密压缩包，然后使用目标地域独立 KMS `GenerateDataKey` 重新加密，生成新的 `wrappedDataKey/keyVersion/nonce/authTag/ossVersionId`，更新 `replication.sourceBackupId`、目标地域和复制时间，使用目标地域 manifest signing key 重新签名后再上传目标 Bucket。源 manifest 和目标 manifest 均不可覆盖并互相引用；目标恢复只接受目标地域 manifest 的签名和 hash。复制失败立即告警。若采购阶段不启用跨地域副本，则地域故障的 RPO/RTO 标记为“无保证”，不得宣称第一阶段具备灾备能力。

上线前至少完成一次隔离目录恢复和一次新 ECS 恢复；上线后每月执行恢复可读性演练，每季度验证跨地域副本、KMS 解密和 DNS/ECS 重建步骤。演练只允许写入隔离环境，禁止自动覆盖生产主库；每次记录实际 RPO/RTO 与差距。

## 14. 何时迁移 RDS

第一阶段保持单 ECS、单写 SQLite。出现多实例并发写、需要高可用自动故障切换、写入并发显著增加或无法接受发布/恢复窗口时，再评估 PostgreSQL/RDS。`wow-db` 即使迁移 RDS 也继续作为只读文件发布。

## 15. 实施顺序

1. 完成 API 默认拒绝、游客/管理员 DTO、CSRF、会话撤销、管理员 bootstrap/recover/revoke 和 `masked` 隐私模式。
2. 完成游客模拟队列、参数白名单、配额、cgroup、取消和过载拒绝压测。
3. 完成现有 `app_meta.schema_version=5` 的基线转换，禁用 `db.ts` 启动隐式迁移。
4. 实现 `schema_migrations`、文件规范、checksum、部署锁、写入冻结、expand/contract 和 migration runner。
5. 建立 N/N-1 读写兼容测试和不允许自动回滚的判断门禁。
6. 实现 backup service、manifest v1、本地加密/权限、03:30/04:00 切换验收和恢复校验；删除生产 `/api/backups/export`。
7. 实现跨地域解密、目标 KMS 重加密、目标 manifest 重签名和恢复演练。
8. 完成官方英雄榜装备 + DPSWOW 天赋合并，并实现 season rollover 操作和测试。
9. 创建非 root Docker 镜像、主机 UID/GID/ACL、数据盘挂载、Node/Nginx 端口契约、ACR 信任链和 ECS `deploy.sh`。
10. 落实域名/备案、TLS 证书服务、自动续期、到期告警和 Nginx reload 验收。
11. 创建 staged/current 发布状态机、systemd units、cutover 和回滚演练。
12. 实现 Draft/Published GitHub Release、wow-db 不可变 OSS 镜像和 lock 校验。
13. 编写并演练 cold-start bootstrap runbook；完成同地域/跨地域恢复并记录实际 RPO/RTO 后才允许生产上线。

TLS 第一阶段唯一正式路径固定为 Nginx + certbot systemd timer，运维负责人为生产管理员；阿里云证书服务不进入第一阶段 CI/运维契约。证书申请、HTTP-01 challenge（80 端口仅用于验证和跳转）、首次安装、自动续期 dry-run、到期 30/14/7 天告警、`nginx -t` 和 reload 后外部 HTTPS 检查都是 cold-start 前置门槛；证书未就绪时不得开放公网管理员登录。
