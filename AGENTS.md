# WoW Helper 项目记忆

## 运维唯一入口

执行或规划任何生产运维操作前，必须先完整阅读：

- `docs/operations-runbook.md`
- `docs/operations-log.md`
- `docs/local-first-github-pages-simulation-plan.md`

阿里云方案已搁置。`docs/cloud-deployment-and-release-plan.md` 和 `docs/aliyun-resource-sizing.md` 仅作历史设计保留，不是当前实施依据。

`docs/operations-runbook.md` 是当前运维操作规范的唯一事实来源（source of truth）；`docs/operations-log.md` 是实际操作历史的唯一事实来源。部署、发布、数据库迁移、wow-db 更新、备份、恢复、回滚、密钥、监控或故障处置完成后，必须在同一次工作中更新 `docs/operations-log.md`。如果流程本身发生变化，还要同步更新 runbook 的对应操作步骤和检查清单，禁止把实际日志条目写回 runbook。

## 记录规则

- 记录时间、环境、执行人/执行方式、版本、结果、验证和回滚点。
- 使用 Asia/Shanghai 时间并带时区，例如 `2026-08-19 16:30 +08:00`。
- 不在文档、Git、日志或命令输出中记录密码、Cookie、AccessKey、会话密钥或完整 Token。
- 本机 `loot-allocator.sqlite` 是唯一可写业务主库，不提交 Git，也不与 GitHub 或其他数据库双向同步。
- 破坏性或恢复操作执行前先确认目标环境、创建备份并记录恢复点。
- 尚未实现或未经验证的命令必须标注为“计划”，不能当作可直接执行的现成能力。
- 当前生产权威环境是管理员本机，`loot-allocator.sqlite` 是唯一可写业务主库；ECS/OSS/ACR 方案已搁置，不得作为当前运维依据。
- 游客模拟必须使用版本固定的只读输入快照，结果只写 D1，不得更新业务主库；只有管理员和每日任务可写业务模拟数据。
- 本机 executor、publisher 与 backup-monitor 使用不同的最小权限服务凭证；不得复用 GitHub、Cloudflare 部署凭据或游客查询凭证。
- 业务备份使用上传前不可变 manifest + 上传后 verification receipt，且至少一个目标必须 WORM/Object Lock 或物理离线。
- 替代电脑 8 小时 RTO 指完整服务恢复，必须包含灾备凭证清单、历史 publicPlayerKey keyVersion、应用/SimC/wow-db、Task Scheduler 和私有 simulation-input；只恢复业务库不算达标。
- 本机业务 SQLite 与 D1 使用独立 migration 目录、schema version、ledger、锁和恢复点；两者都必须遵循 immutable checksum、attempt 状态和 N/N-1 兼容门禁，`running/unknown`、部分执行或 fingerprint 冲突时 fail closed。
- publication 的 30 分钟 grace 只控制新申请；revision key 清单和私有 simulation-input 必须按未终态任务、24 小时窗口和回滚集合统一保留。
- 公网控制面写入统一由全局单例 Durable Object 串行化，D1 使用版本化 DDL/trigger/条件更新；幂等 key 到期后只保留版本化 HMAC digest tombstone 并返回 410，不永久保存 requestId/payloadHash。为保持永久 410，所有历史 digest key 必须以 match-only 只读 keyring 永久在线且进入灾备；不接受此负担时必须先重新 review 幂等语义。
- D1 外部 SafetyGate 是所有公网业务 mutation 的第一门禁；`gate-closer`、一次性 `epoch-admin`、独立一次性 `gate-opener` 和 `d1-recovery` 权限互不兼容。epoch/open 必须先把 signed committed transition authorization 写入两个 ledger 目标并读回，DO 才能 CAS 消费并保存 applied hash；gateway 禁止 open-without-committed-ledger。DO 丢失后只能用有效来源 max+1 初始化 blocked；无法证明 epoch 单调时保持 503。恢复后旧 lease、credential、nonce、非终态任务和 active publication 都不受信。
- 业务备份每 12 小时执行；RPO 新鲜度只按 SQLite 内容 `generatedAt` 计算，`verifiedAt` 与 D1 `reportedAt` 不能刷新时钟；20 小时告警、22 小时业务 fail closed、24 小时后只允许恢复/备份，验证后上报延迟最多 1 小时且旧报告不得回拨。
- 在线 HMAC 只认证 API 请求；revision bundle 使用独立 Ed25519 detached artifact signature。历史公钥及 signedAt/validity/revokedAt/compromisedFrom 必须保留，疑似泄漏后的回滚只能使用撤销前已进入 trusted history 的可信 hash 或由当前 key 重签可信 bundle。
- publication revision 是未截断的 `pub-v1-<SHA-256(canonical identity)>`，绑定 public/simulation-input manifest、generatedAt 和 key version；同 revision 的 content 永不覆盖，重签只追加 `signatures/<signatureSha256>.json`。D1 `publication_signature_history` 保存全部 payload/hash/key/time 且禁止 UPDATE/DELETE；revision 按 draft -> signed current -> staged 转换，签名一旦选择后任何状态转换都不能清空。选择 current signature 和切 active 时都必须由 trigger 拒绝 revision/signature hash 不一致。
- wow-db GitHub Release 只是传输渠道；交接包使用独立 Ed25519 detached signature，管理员本机 trust store 公钥必须通过 out-of-band 固定，不能信任同包 SHA-256 或从同一 Release 自动更新公钥。
- Pages 唯一正式路径是本机 allowlist 公开 bundle -> 唯一 Draft Release ingress -> GitHub Actions 验签 -> Pages artifact/deployment；私有 simulation-input 只上传 manifest hash。本机 uploader/dispatcher 使用两个 repo-only 30 天 PAT，Actions 锁定 commit SHA/最小 permissions/受保护 Environment；目标 repo 为 public 但转 public 必须后续人工确认。实施首个 safety commit 必须先禁用旧 `pages:publish`/`deploy-pages.mjs`/repo push 凭证并加 CI denylist。
- D1 每 12 小时 export 必须先 SafetyGate blocked，在 ControlPlane FIFO mutex 与 maintenance lock 下使用固定 `wrangler@4.124.0` + API v4 polling 取得单一 `at_bookmark` SQL dump；export budget 600 秒、maintenance hard deadline 900 秒，期间 lease heartbeat/回收/结果写入暂停，清锁后恢复 120 秒 lease，超时则 fencing/终止/回收并保持 blocked。隔离导入并验证 request/counter/lease/publication/credential 不变量后才标 verified；无快照分页 SELECT 不得作恢复包。Time Travel 原地恢复和新 quarantine D1 SQL import 都必须先在独立 staging 实测。Cloudflare D1 Edit Token 不能按 SQL 白名单收权，recovery 必须使用短期 Token、固定 target allowlist、审批的 runner/SQL hash、审计和立即撤销补偿。
- `accepting_requests` 只由 publisher 经 gateway -> ControlPlane 显式开关，ControlPlane 固定 fail-close 可写 0；backup-monitor 和外部监控不能直写。SafetyGate `open_not_after` 只凭 verified backup attestation，通过双目标 committed renewal -> DO CAS 单调推进且不能打开 blocked gate，外部 watchdog 只有 gate-closer。local/staging/production 的 D1、DO namespace、Worker、Pages、Environment 与所有 key 必须独立，并用资源 ID allowlist + D1 environment identity + Environment scope 在网络前阻止 staging 指向 production。
- D1 request DDL 必须强制 publication season/key version 绑定、NOT NULL 64 位 lowercase SHA-256 query secret hash 和有效 expiry；错误请求不能占用 quota。
- 普通游客 lease 为 120 秒、每 30 秒 heartbeat；maintenance 期间不接受 heartbeat/回收/结果写入，900 秒是不可延长的硬截止。
- loopback 不是本机管理身份。所有本地 mutation 需 Argon2id 单管理员会话、CSRF/Origin 校验与 loopback HTTPS；定时任务使用 ACL named pipe 或独立 service secret，不复用浏览器 session。
- Windows 正式任务固定使用标准用户 `wowhelper-runtime`、版本化 wrapper/runtime manifest 和 .NET Job Object helper，不使用 SYSTEM、Unix PATH、`process.kill(pid,0)` 或直接子进程 kill。Armory profile 由同一用户交互重认证，不备份 Cookie。
- 成员级公开默认关闭并要求赛季 opt-in；publicPlayerKey 跨赛季轮换，数值/时间分桶并做少于 3 候选的再识别审计。撤回必须执行 GitHub 可控资源 privacy purge，清除当前 artifact 中旧 revision、Actions artifact、Draft Release 资产和可控 deployment 并验证已知 URL；清不掉则关闭 Pages。匿名合法请求耗尽游客队列/额度是已接受可用性风险，只能暂停游客申请，不得私下增加第三个业务门槛。
- 当前改造按新增 Windows runtime、外部 migration/backup gate、持久化调度器、publication pipeline、SafetyGate/D1 控制面和供应链/灾备系统估算，不视为现有脚本的小幅修改。

## GitHub 身份与仓库归属

- 唯一代码仓库：`https://github.com/zoroperona/wow-helper`。
- GitHub 用户：`zoroperona`，这是个人账号，不是公司账号。
- Git 提交、Push、Release、Pages、Actions、SSH 和 Token 操作均不得使用公司 GitHub 身份、公司邮箱或公司凭据。
- 本仓库本地 Git 身份固定为 `zoroperona <zoroperona@users.noreply.github.com>`；不得删除该仓库级覆盖而回退到全局公司身份。
- `origin` 使用个人账号 SSH remote：`git@github.com:zoroperona/wow-helper.git`。
- 首次提交或 Push 前必须确认 remote、仓库级 user.name/user.email、SSH 公钥归属和待提交文件；不得提交业务 SQLite、wow-db 压缩包、会话、密钥或本地环境文件。
