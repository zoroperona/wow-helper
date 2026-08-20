# Windows Runtime

`Invoke-WowHelperTask.ps1` 是正式 Task Scheduler 的唯一入口。任务 XML 不得直接拼接 Node、npm、SimC 或业务脚本命令；安装器应把固定绝对路径和 SHA-256 写入受 ACL 保护的 `%ProgramData%\WowHelper\runtime.json`，然后让 Task Scheduler 只调用：

```powershell
pwsh.exe -NoProfile -NonInteractive -File <repo>\ops\windows\Invoke-WowHelperTask.ps1 -Task <daily|daily-check|backup|validate>
```

runtime manifest 最小结构如下，所有路径必须是 Windows 绝对路径，`hashes` 的属性名必须对应 `paths` 中的路径名：

```json
{
  "schemaVersion": 1,
  "runAs": "WOWHELPER-RUNTIME\wowhelper-runtime",
  "paths": {
    "repoRoot": "D:\\WowHelper",
    "nodeExe": "C:\\Program Files\\nodejs\\node.exe",
    "databasePath": "D:\\WowHelper\\loot-allocator\\data\\loot-allocator.sqlite",
    "wowDbPath": "D:\\WowHelper\\wow-db\\output\\wow.sqlite",
    "simcExe": "D:\\WowHelper\\runtime\\simc\\simc.exe",
    "simcRunsPath": "D:\\WowHelper\\loot-allocator\\data\\simc-runs",
    "backupsPath": "D:\\WowHelper\\loot-allocator\\backups",
    "dailyStatusPath": "D:\\WowHelper\\loot-allocator\\data\\runtime\\daily-sim-status.json",
    "statusDirectory": "D:\\WowHelper\\loot-allocator\\data\\runtime\\task-status",
    "handleExe": "D:\\WowHelper\\runtime\\Sysinternals\\handle64.exe"
  },
  "hashes": {
    "nodeExe": "<64 lowercase hex SHA-256>"
  }
}
```

wrapper 在执行前拒绝缺失/相对路径、错误运行账号、文件不存在或 hash 不匹配；执行后写入原子 status JSON。退出码沿用计划约定，当前脚本错误直接透传，配置或 trust 校验失败返回 `40`。ProcessHost、Job Object、任务 XML 安装器和 named-pipe 管理调用仍需单独实现并验收，不能把本 wrapper 误认为完整的生产调度器。
