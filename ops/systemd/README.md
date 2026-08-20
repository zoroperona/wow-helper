# WoW Helper systemd 定时任务目录

> 状态：随阿里云方案一并搁置，仅保留历史设计。当前本机定时任务契约见 `docs/operations-runbook.md` 和 `docs/local-first-github-pages-simulation-plan.md`。

本目录原计划用于版本控制 ECS 生产环境的 systemd service/timer 和安装校验脚本。当前仅完成目录与流程规划，实际单元文件和脚本尚未实现；任何程序不得因为存在本目录就假设定时任务已经可安装。

## 计划目录

```text
ops/systemd/
├── units/
│   ├── wow-helper.service
│   ├── wow-helper-daily-pipeline.service
│   ├── wow-helper-daily-pipeline.timer
│   ├── wow-helper-backup.service
│   ├── wow-helper-backup.timer
│   ├── wow-helper-maintenance.service
│   ├── wow-helper-maintenance.timer
│   ├── wow-helper-health-check.service
│   └── wow-helper-health-check.timer
├── scripts/
│   ├── install-units.sh
│   ├── verify-units.sh
│   └── rollback-units.sh
└── README.md
```

`units/` 中的文件是生产 timer 配置的唯一源码。禁止直接在 ECS 上长期维护未回写 Git 的 `crontab` 或 systemd 单元。

## 任务规划

| 任务 | 计划时间（Asia/Shanghai） | 是否补跑 | 职责 |
|---|---|---|---|
| `daily-pipeline` | 每日 04:00 | 否 | 预检、备份门禁、官方英雄榜刷新、全团模拟、结果验证 |
| `backup` | 每日 03:30；应用发布前由 deploy script 另执行 | 是 | 定时场景唯一生成一致性业务库备份、校验、上传 OSS；不负责 04:00 门禁 |
| `maintenance` | 每日 09:00 | 否 | 清理过期 SimC 产物、本地备份、临时文件和图标缓存 |
| `health-check` | 每 15 分钟 | 是 | 检查服务、数据版本、磁盘、备份新鲜度和任务状态并告警 |

补跑语义在实现时由 `Persistent=` 和任务自身幂等逻辑共同保证。重任务 `daily-pipeline` 不应因部署或服务器白天重启而突然补跑；备份和健康检查可以补跑。

每周深度完整性检查可以作为 `maintenance` 的周日分支，也可以在需求明确后增加独立 service/timer。生产数据库恢复演练只生成提醒，不允许无人值守自动覆盖生产主库。

## 每日流水线边界

每日流水线必须串行执行，而不是为每个成员创建独立 timer：

```text
运行锁
  -> 依赖和磁盘预检
  -> 检查 03:30 备份门禁（不重复生成备份）
  -> 逐个刷新官方英雄榜装备
  -> 获取或复用 DPSWOW 天赋数据
  -> 以官方装备 + 天赋缓存构建 SimC Profile
  -> 全团顺序模拟
  -> 保存收益结果
  -> quick_check 和成员级结果汇总
  -> 上传最终状态并告警
```

官方刷新失败时保留最后一次有效官方装备。DPSWOW 只能补充天赋等字段，不能用较旧装备覆盖官方快照。单个成员失败不能中断其他成员，但任务最终状态必须体现部分失败。

所有业务 timer、发布、wow-db 导入和 migration 共享 `/run/lock/wow-helper-deploy.lock` 的互斥契约。发布取得部署锁后，必须先停止本节所列 timer 和正在运行的模拟，再停止 Node；migration runner 是唯一允许修改 schema 的进程。应用启动只检查 schema，不得隐式执行 migration。

模拟取消必须操作进程组：SIGTERM -> grace period -> SIGKILL -> 等待所有子进程退出 -> 确认任务锁释放 -> `lsof`/`fuser` 确认 SQLite 无其他打开者。只更新任务状态为 failed 不足以继续备份或 migration。

锁层级固定为部署锁 -> 备份操作锁 `/run/lock/wow-helper-backup.lock` -> SQLite `BEGIN IMMEDIATE`。发布脚本调用 backup service 时通过继承 lock FD 复用部署锁，backup service 不重新打开同一部署锁；03:30 独立任务按完整层级获取锁。必须有自动化测试证明不会自死锁。

生产每日流水线不包含生成或部署静态公开页。ECS 应用直接提供前端静态资源和只读 API；游客看到的是最新只读数据视图，唯一需要排队和限流的游客写入例外是模拟任务。

## 发布时更新规则

应用 Tag 发布时，CI/CD 需要同步部署与该 Tag 相同 commit 中的 systemd 单元，并按 `current`/`staged` 状态机切换：

1. 在 CI 执行静态检查和 `systemd-analyze verify`。
2. 在 ECS 保存当前单元文件、启用状态和 timer 列表作为回滚点。
3. 将新单元写到临时目录并再次验证。
4. 原子安装到 `/etc/systemd/system`。
5. 执行 `systemctl daemon-reload`。
6. 新 service 只启动 staged 容器到临时端口，不启用 timer，不执行模拟、刷新或备份。
7. 对 staged 容器核对实际镜像 digest、schema、权限矩阵和只读健康检查。
8. 通过唯一 cutover 切换 Nginx upstream 和 `current` 指针。
9. 启用并启动新 timer；部署动作本身不得直接触发全团模拟。
10. 用 `systemctl list-timers` 核对下次运行时间和时区，运行任务的 `--check` 或等价预检模式。
11. 任一步失败时停止写入，按 migration 兼容门禁决定恢复旧单元/镜像或恢复数据库；不得仅切回 Nginx 就宣称回滚完成。

应用运行代码和 timer 必须来自同一 Release commit，防止旧 timer 调用新版本已删除的命令。timer 只负责调度，实际任务逻辑放在版本化应用脚本中，避免把复杂业务逻辑写进 systemd 单元。

## 实现要求

- 所有单元显式设置 `Environment=TZ=Asia/Shanghai`，服务器系统时区也设置为 Asia/Shanghai。
- 任务使用专用低权限服务账号，不以 root 运行应用脚本。
- 所有任务共享同一个全局运行锁，避免发布、备份、wow-db 导入和模拟互相冲突。
- 发布锁与 SQLite `BEGIN IMMEDIATE` 配合使用，第二个 deploy/runner 必须失败退出，不得并发或隐式排队。
- service 使用明确的 `WorkingDirectory`、环境文件和超时。
- 环境文件只引用路径，不把密码或 Token 提交 Git。
- stdout/stderr 进入 journald，并为失败配置告警入口。
- 备份、清理和刷新脚本必须幂等，清理脚本必须限制在明确目录。
- 重任务设置合理的 CPU/IO 优先级，避免拖慢 Web 请求。
- timer 更新属于应用发布的一部分；若未来重启云方案，实际操作必须写入 `docs/operations-log.md`。
- wow-db 更新必须停止 Web/current 和所有 wow-db 使用者，原子替换后重启 Web 或调用已验证的 reload；健康检查确认应用实际加载的 Build 和 SHA-256。
