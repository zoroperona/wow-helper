# Windows Runtime

`Invoke-WowHelperTask.ps1` 是正式 Task Scheduler 的唯一入口。任务 XML 不得直接拼接 Node、npm、SimC 或业务脚本命令；安装器应把固定绝对路径和 SHA-256 写入受 ACL 保护的 `%ProgramData%\WowHelper\runtime.json`，然后让 Task Scheduler 只调用：

```powershell
pwsh.exe -NoProfile -NonInteractive -File <repo>\ops\windows\Invoke-WowHelperTask.ps1 -Task <daily|daily-check|backup|validate>
```

管理员安装入口为 `Install-WowHelperRuntime.ps1`。它读取 `task-definitions.json`，生成 runtime manifest、设置仅运行账号和 Administrators 可读的 ACL，并注册 03:15/15:15 备份、04:00 每日任务和开机校验任务。首次安装可使用 `-SkipTaskRegistration` 只生成 manifest，避免在未完成人工核对前注册任务。

示例：

```powershell
pwsh.exe -NoProfile -File .\ops\windows\Install-WowHelperRuntime.ps1 `
  -RepoRoot D:\WowHelper `
  -NodeExe 'C:\Program Files\nodejs\node.exe' `
  -SimcExe D:\WowHelper\runtime\simc\simc.exe `
  -WowDbPath D:\WowHelper\wow-db\output\wow.sqlite `
  -ProcessHostExe D:\WowHelper\runtime\ProcessHost\WowHelper.ProcessHost.exe `
  -HandleExe D:\WowHelper\runtime\Sysinternals\handle64.exe
```

安装前必须确认 `wowhelper-runtime` 已创建为本地标准用户，且密码只在交互式 credential prompt 中输入。安装器不会创建管理员用户、不会把密码写入 manifest，也不会自动恢复 Armory profile。

runtime manifest 最小结构如下，所有路径必须是 Windows 绝对路径，`hashes` 的属性名必须对应 `paths` 中的路径名：

```json
{
  "schemaVersion": 1,
  "runAs": "WOWHELPER-RUNTIME\wowhelper-runtime",
  "paths": {
    "repoRoot": "D:\\WowHelper\\loot-allocator",
    "nodeExe": "C:\\Program Files\\nodejs\\node.exe",
    "databasePath": "D:\\WowHelper\\loot-allocator\\data\\loot-allocator.sqlite",
    "wowDbPath": "D:\\WowHelper\\wow-db\\output\\wow.sqlite",
    "simcExe": "D:\\WowHelper\\runtime\\simc\\simc.exe",
    "simcRunsPath": "D:\\WowHelper\\loot-allocator\\data\\simc-runs",
    "backupsPath": "D:\\WowHelper\\loot-allocator\\backups",
    "dailyStatusPath": "D:\\WowHelper\\loot-allocator\\data\\runtime\\daily-sim-status.json",
    "backupHealthPath": "D:\\WowHelper\\loot-allocator\\data\\runtime\\backup-health.json",
    "statusDirectory": "D:\\WowHelper\\loot-allocator\\data\\runtime\\task-status",
    "handleExe": "D:\\WowHelper\\runtime\\Sysinternals\\handle64.exe",
    "processHostExe": "D:\\WowHelper\\runtime\\ProcessHost\\WowHelper.ProcessHost.exe"
  },
  "hashes": {
    "nodeExe": "<64 lowercase hex SHA-256>"
  }
}
```

wrapper 在执行前拒绝缺失/相对路径、错误运行账号、文件不存在或 hash 不匹配；执行后写入原子 status JSON。退出码沿用计划约定，当前脚本错误直接透传，配置或 trust 校验失败返回 `40`。ProcessHost、Job Object、任务 XML 安装器和 named-pipe 管理调用仍需单独实现并验收，不能把本 wrapper 误认为完整的生产调度器。
