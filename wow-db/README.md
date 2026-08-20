# wow-db

从本地 World of Warcraft 客户端生成可恢复、可复现的 DB2 数据快照。原始 DB2 是权威产物，SQLite 是可以重新生成的查询层。

## 当前范围

- 从客户端根目录的 `.build.info` 自动读取 product、build config、CDN config 和版本号。
- 使用 TACTSharp 从本地 CASC 按 FileDataID 提取 `DBFilesClient/*.db2`；本地缺失时默认允许 CDN 补全。
- 同步提取装备计算所需的 `CombatRatingsMultByILvl`、`StaminaMultByILvl` 和 `ItemSocketCostPerLevel` GameTable。
- 使用固定版本的 WoWDBDefs 和 DBCD 解析 DB2。
- 每张表独立写入 SQLite 事务，失败不会影响其他表。
- 支持中断恢复、已有文件接管、哈希校验、单表重试和定义更新后重建。

默认输出客户端基础 DB2；通过 `--hotfix <DBCache.bin>` 可校验并应用服务器热修正。热修文件必须与客户端 build 一致，热修 SHA-256 会参与增量判断和交接包身份。

## 目录

```text
wow-db/
├── src/                 CLI 源码
├── tests/               自动化测试
├── scripts/             Windows/macOS/Linux 执行和发布脚本
├── cache/               WoWDBDefs、TACTKeys 和 CASC 下载缓存，不提交
├── output/              按 product/build/locale 分类的快照，不提交
└── artifacts/           发布产物，不提交
```

一次实际快照如下：

```text
output/wow/12.1.0.69299/cn-zhCN/
├── snapshot.json        本次快照的 build、locale、定义和 key 哈希
├── report.json          汇总、失败表、无 FileDataID 表和当前客户端不存在的表
├── metadata/
│   ├── manifest.json
│   ├── all.bdbd
│   ├── SOURCE.txt
│   └── version.txt
├── raw/db2/*.db2        原始 DB2
├── raw/gametables/*.txt 装备属性缩放表
├── parsed/wow.sqlite    SQLite 查询库
└── state/tables/*.json  每张表的恢复点、哈希、尝试次数和错误
```

## Windows 使用

要求客户端已经更新完成，并关闭 WoW 与 Battle.net，避免 CASC 文件被占用。建议预留至少 10 GiB 磁盘和 6 GiB 内存。

安装 .NET 10 SDK 后，在 PowerShell 中执行：

```powershell
cd wow-db
./scripts/wow-db.ps1 -Client "D:\World of Warcraft"
```

应用客户端服务器热修缓存（可选）：

```powershell
./scripts/wow-db.ps1 -Client "D:\World of Warcraft" -Hotfix "D:\path\to\DBCache.bin"
```

`DBCache.bin` 的实际位置随客户端版本和安装方式变化；在游戏目录下搜索该文件后传入完整路径。

带 `-Hotfix` 的命令会使用当前源码构建，避免调用仓库中不支持热修参数的旧版发布程序，因此游戏机需安装 .NET 10 SDK。

中国区正式服默认参数为 `product=wow`、`region=cn`、`locale=zhCN`。其他客户端可以显式指定：

```powershell
./scripts/wow-db.ps1 `
  -Client "D:\World of Warcraft" `
  -Product wow_classic `
  -Region cn `
  -Locale zhCN
```

先检查安装目录中有哪些 product：

```powershell
dotnet run --project src/WowDb.Cli -- doctor --client "D:\World of Warcraft"
```

生成无需安装 .NET 的 Windows x64 单文件程序：

```powershell
./scripts/publish-win-x64.ps1
```

产物为 `artifacts/win-x64/wow-db.exe`。

## Windows 到 Mac 的更新交接

游戏客户端是权威数据源。客户端更新完成后，关闭 WoW 与 Battle.net，在 Windows 游戏机执行：

```powershell
cd wow-db
./scripts/export-transfer-package.ps1 -Client "D:\World of Warcraft"
```

脚本先生成或恢复当前 `wow/cn/zhCN` 快照。只有 `report.json` 中没有失败表时，才会在
`transfer/` 生成 `wow-db-<build>-cn-zhCN.zip`。交接包包含 SQLite、快照身份、运行报告、
文件大小和 SHA-256，不包含原始 DB2，适合传到运行应用的 Mac。

传输方式不属于数据协议，可以使用局域网共享、移动磁盘或网盘。Mac 端必须使用应用仓库中的
`npm run wowdb:import -- <zip>` 校验和导入，不能直接覆盖 `wow.sqlite`。

未传入 `-Hotfix` 时交接包仍只包含客户端基础 DB2；传入后交接清单会记录热修 build、HTFX 格式版本和 SHA-256，Mac 导入会校验 SQLite 内登记的热修身份。

## 分阶段和小范围执行

只提取原始 DB2：

```powershell
./scripts/wow-db.ps1 -Client "D:\World of Warcraft" -Phase raw
```

之后只构建 SQLite，不重新打开 CASC：

```powershell
./scripts/wow-db.ps1 -Client "D:\World of Warcraft" -Phase sqlite
```

先用少量表验证客户端环境：

```powershell
./scripts/wow-db.ps1 -Client "D:\World of Warcraft" -Table Map,SpellName,ItemSparse
```

## 恢复和增量规则

默认直接重复相同命令即可恢复：

1. DB2 先写为 `.partial`，完整落盘后才原子替换正式文件。
2. 已完成表记录文件长度和 SHA-256；正常恢复先检查文件长度和 DB2 magic，跳过下载。
3. `-VerifyExisting` 会额外重算 SHA-256，适合跨机器复制快照后验证。
4. SQLite 使用 staging table；插入和正式表替换在同一事务内完成。
5. SQLite 内部 `__wowdb_tables` 记录 build、locale、原始哈希和定义哈希。全部一致才跳过。
6. 单张表失败会写入自己的状态文件并继续。程序退出码 `2` 表示存在可重试的表级失败。

WoWDBDefs 是覆盖多个版本和产品分支的定义超集，并非其中每张表都存在于当前客户端。定义有 FileDataID、但该 FileDataID 不在当前客户端 CASC root 中时，会记录为 `not-present` 并正常跳过，不计入失败；定义本身没有 FileDataID 时则记录为 `not-addressable`。两类表名都会写入 `report.json`，方便区分定义覆盖范围与真正的导出错误。

使用旧版工具已经完成过快照时，替换可执行文件后直接重复原命令即可。已有 DB2 和 SQLite 表会跳过，旧的 `File not found in root` 状态会重新判定为 `not-present`。

需要重新处理选中表时使用 `-Force`。最新版定义修复后，可以使用 `-RefreshMetadata`；定义哈希变化会使受选范围内的 SQLite 表重新生成，但不会重新提取 DB2。

`-Offline` 禁止下载元数据和缺失的 CASC 内容，仅使用客户端和本地缓存。

## SQLite 约定

- 每个 DB2 对应同名 SQLite 表。
- 三张装备 GameTable 也会转换为同名 SQLite 表，并使用规范化列名。
- `__id` 是 DB2 record ID；如果原表已经存在该字段，会自动增加下划线避免冲突。
- 数组保存为 JSON 文本。
- `ulong` 和 `decimal` 保存为文本，避免 SQLite 有符号 64 位整数溢出。
- `__wowdb_tables` 是快照内部登记表，不是游戏数据。

## 构建和测试

```powershell
dotnet restore WowDb.slnx
dotnet test WowDb.slnx -c Release
dotnet build WowDb.slnx -c Release
```

依赖版本锁定在项目文件中。TACTSharp 仍是 alpha API，因此客户端访问集中在 `Services/TactClient.cs`，方便后续升级或替换。
