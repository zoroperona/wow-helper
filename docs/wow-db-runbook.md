# wow-db 游戏机更新与交接手册

> 本手册只描述在安装了 World of Warcraft 客户端的 Windows 游戏机上生成、验证和上传 `wow-db` 数据。它不保存密码、Cookie、AccessKey、Token 或私钥。

## 1. 适用范围

本手册适用于中国区正式服 `wow / cn / zhCN`。每次游戏客户端更新、正式服热修或应用侧提示 `wow-db` build 落后时，按本手册重新生成交接包。

数据来源是游戏客户端本身：

- 客户端 `.build.info` 决定基础 DB2 的 product、build 和 CDN 配置。
- 客户端 CASC 提供基础 DB2 和 GameTable。
- `DBCache.bin` 提供服务器热修；传入后会校验 HTFX 格式和 BuildId，并逐表应用。
- 交接包只包含 SQLite、snapshot、report 和 manifest，不包含原始 DB2。

当前权威导入目标是管理员本机。云部署计划已搁置；本手册中的 ECS/OSS 段落只保留历史参考，不是当前传输契约。文中的 `<...>` 是必须替换的占位符。

## 2. 必须遵守的规则

1. 更新前必须关闭 WoW 和 Battle.net，避免 CASC 或热修文件在生成期间变化。
2. 只使用已经完成更新的目标客户端；不要从 PTR、测试服或其他地区客户端生成 `cn/zhCN` 包。
3. 基础 DB2 与 `DBCache.bin` 必须来自同一客户端 build。
4. 不直接上传 `output/`、`raw/` 或 SQLite；只上传脚本生成的完整 ZIP。
5. ZIP 生成后不得解压重打包。上传同一个文件，并同时上传 SHA-256。
6. 生成失败或验证失败时停止上传，不要用旧包冒充新包。
7. 上传包不包含任何账号凭据；凭据只从已配置的 SSH agent、Windows Credential Manager 或云端凭据工具读取。

## 3. 游戏机准备

### 3.1 软件要求

- Windows PowerShell 5.1 或 PowerShell 7。
- .NET 10 SDK。带 `-Hotfix` 的脚本会使用当前源码构建，必须安装 SDK。
- Git（如果从源码更新）。
- 可用磁盘空间至少 10 GiB，内存建议至少 6 GiB。
- 上传方式：使用个人 GitHub 账号 `zoroperona` 创建不可变 GitHub Release；管理员本机主动下载并校验。Windows OpenSSH `scp` 仅用于人工恢复或临时交接。

确认工具：

```powershell
dotnet --version
git --version
Get-Command scp -ErrorAction SilentlyContinue
Get-Command ossutil -ErrorAction SilentlyContinue
```

### 3.2 更新源码

在源码目录执行：

```powershell
cd C:\path\to\wow-helper
git pull --ff-only
```

如果游戏机不允许联网，先在其他机器下载并验证源码，再通过可信介质复制完整仓库。不要只复制旧的 `wow-db.exe`，因为热修参数需要当前源码版本。

### 3.3 确认客户端状态

1. 退出 World of Warcraft。
2. 退出 Battle.net，确认任务管理器中没有 Battle.net 更新进程。
3. 打开 Battle.net，等待目标客户端完成更新。
4. 更新完成后再次退出 Battle.net。

检查 product、build 和 CASC：

```powershell
cd C:\path\to\wow-helper\wow-db
dotnet run --project src/WowDb.Cli -- doctor --client "D:\World of Warcraft"
```

输出中应看到：

- product `wow`
- 目标版本号，例如 `12.1.0.69382`
- `CASC data: found`
- 正确的客户端目录

如果 product、地区或版本不对，先修正 Battle.net 客户端，不要继续生成。

## 4. 找到热修缓存

客户端版本和安装方式不同，`DBCache.bin` 的目录可能不同。先在游戏目录搜索：

```powershell
Get-ChildItem -Path "D:\World of Warcraft" -Filter DBCache.bin -File -Recurse -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName
```

如果找到多个文件，优先选择最近修改、位于当前正式服客户端目录下的文件。记录完整路径和修改时间：

```powershell
$Hotfix = Get-ChildItem -Path "D:\World of Warcraft" -Filter DBCache.bin -File -Recurse |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
$Hotfix | Select-Object FullName, Length, LastWriteTimeUtc
```

不要手工修改、合并或重命名文件内容。工具会验证文件头、HTFX 版本和 BuildId；如果 BuildId 与 `.build.info` 不一致，命令会失败。

## 5. 生成前的源码验证

首次使用新版本工具，先执行：

```powershell
cd C:\path\to\wow-helper\wow-db
dotnet restore WowDb.slnx
dotnet test WowDb.slnx -c Release
dotnet build WowDb.slnx -c Release
```

如果测试失败，不生成交接包。记录失败输出并回退到上一个已验证源码版本。

## 6. 小范围热修冒烟

先处理少量关键表，验证客户端、定义、CASC 和热修格式：

```powershell
cd C:\path\to\wow-helper\wow-db
./scripts/wow-db.ps1 `
  -Client "D:\World of Warcraft" `
  -Product wow `
  -Region cn `
  -Locale zhCN `
  -Hotfix $Hotfix `
  -Table Item,ItemSparse,SpellName
```

检查命令输出：

- 没有 `Fatal:`。
- 没有热修 build mismatch。
- 关键表最终显示 `[sql ok]` 或合理的 `[sql skip]`。
- 退出码为 `0`。

小范围验证只用于提前发现环境问题，不是最终交接包。通过后继续执行完整包生成。

## 7. 生成完整交接包

### 7.1 推荐命令：包含服务器热修

```powershell
cd C:\path\to\wow-helper\wow-db
./scripts/export-transfer-package.ps1 `
  -Client "D:\World of Warcraft" `
  -Product wow `
  -Region cn `
  -Locale zhCN `
  -Hotfix $Hotfix `
  -Destination "C:\path\to\wow-helper\wow-db\transfer"
```

也可以直接传完整路径：

```powershell
./scripts/export-transfer-package.ps1 `
  -Client "D:\World of Warcraft" `
  -Hotfix "D:\path\to\DBCache.bin"
```

脚本会：

1. 按客户端 `.build.info` 创建 `output\wow\<build>\cn-zhCN` 快照。
2. 复用未变化的 DB2；热修 SHA-256 变化时重新导出受影响表。
3. 将 `DBCache.bin` 复制到快照的 `raw\DBCache.bin`。
4. 生成 `parsed\wow.sqlite`、`snapshot.json`、`report.json`。
5. 仅当失败表为零时生成 `transfer\wow-db-<build>-cn-zhCN.zip`。

### 7.2 只生成基础 DB2

只有在确认本次不需要服务器热修时才使用：

```powershell
./scripts/export-transfer-package.ps1 `
  -Client "D:\World of Warcraft" `
  -Destination "C:\path\to\wow-helper\wow-db\transfer"
```

交接包会明确标记 `hotfixLayerIncluded = false`，应用健康检查会显示热修未应用。

## 8. 本机验证交接包

### 8.1 查看文件

```powershell
$Package = Get-ChildItem .\transfer\wow-db-*.zip |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
$Package | Select-Object FullName, Length, LastWriteTimeUtc
Get-FileHash $Package.FullName -Algorithm SHA256
```

### 8.2 检查快照报告

找到对应快照并读取身份：

```powershell
$Snapshot = Get-ChildItem .\output -Filter snapshot.json -File -Recurse |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
$Snapshot.FullName
Get-Content $Snapshot.FullName -Raw
Get-Content (Join-Path $Snapshot.DirectoryName "report.json") -Raw
```

确认以下条件：

- `product` 为 `wow`。
- `region` 为 `cn`，`locale` 为 `zhCN`。
- `completedAt` 非空。
- `report.failed` 为 `0`。
- 使用热修时 `hotfixBuild` 与 `build` 的末段一致。
- 使用热修时 `hotfixSha256` 非空，且 `hotfixFormatVersion` 有值。

### 8.3 读取 ZIP manifest

不需要解压重打包，可以临时解压到临时目录查看：

```powershell
$CheckDir = Join-Path $env:TEMP ("wow-db-check-" + [guid]::NewGuid().ToString("N"))
Expand-Archive -LiteralPath $Package.FullName -DestinationPath $CheckDir
Get-Content (Join-Path $CheckDir "transfer-manifest.json") -Raw
Get-Content (Join-Path $CheckDir "report.json") -Raw
Remove-Item $CheckDir -Recurse -Force
```

确认 `databaseSha256`、`databaseBytes`、`build`、`hotfixLayerIncluded` 与前一步一致。检查后删除临时目录。

## 9. 上传交接包

当前正式通道是个人 GitHub Release 资产。每个 Build 使用唯一 Tag、唯一文件名和 SHA-256，禁止复用 Tag 或覆盖同名资产。SFTP/SCP 仅作为人工恢复或临时交接方式，不是自动发布路径。

### 9.1 SFTP / SCP

适用于已有跳板机或文件服务器的情况。先由管理员提供 `<upload-host>`、`<upload-user>` 和目标目录；认证使用 SSH agent 或受管私钥。

```powershell
$Package = Get-ChildItem .\transfer\wow-db-*.zip |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
$Hash = Get-FileHash $Package.FullName -Algorithm SHA256
"$($Hash.Hash.ToLowerInvariant())  $($Package.Name)" |
  Set-Content ($Package.FullName + ".sha256") -Encoding ascii

scp $Package.FullName `
  ($Package.FullName + ".sha256") `
  "<upload-user>@<upload-host>:<upload-directory>/"
```

上传后要求接收方核对 ZIP 和 `.sha256`，不得只上传 ZIP。

### 9.2 阿里云 OSS（历史方案，当前不执行）

以下内容仅供未来重新评估云部署时参考；当前不申请、不上传、不把 OSS 对象当作本机导入来源。

适用于已经配置 `ossutil` 凭据或 RAM 角色的情况。不要把 AccessKey 写在命令行、PowerShell 历史或本文档中。

```powershell
$Package = Get-ChildItem .\transfer\wow-db-*.zip |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
$Hash = Get-FileHash $Package.FullName -Algorithm SHA256
"$($Hash.Hash.ToLowerInvariant())  $($Package.Name)" |
  Set-Content ($Package.FullName + ".sha256") -Encoding ascii

$Build = [regex]::Match($Package.BaseName, 'wow-db-(.+)-cn-zhCN').Groups[1].Value
$Sha256 = $Hash.Hash.ToLowerInvariant()
$ObjectPrefix = "releases/wow-db/$Build/$Sha256"
# 第一阶段要求对象不可覆盖；实际脚本应使用 If-None-Match: * 等价的创建条件。
# 以下为对象 key 示意。正式 CI 必须通过支持 If-None-Match: * 的上传封装，
# 已存在对象时直接失败，禁止使用普通覆盖上传替代。
ossutil cp $Package.FullName "oss://<bucket>/$ObjectPrefix/"
ossutil cp ($Package.FullName + ".sha256") "oss://<bucket>/$ObjectPrefix/"
```

推荐对象布局：

```text
oss://<bucket>/releases/wow-db/<build>/<sha256>/wow-db-<build>-cn-zhCN.zip
oss://<bucket>/releases/wow-db/<build>/<sha256>/transfer-manifest.json
```

上传完成后记录对象 key、build、文件大小和 SHA-256。OSS Bucket 必须私有并开启版本控制；对象 key 含 SHA-256 且禁止覆盖。`wow-db.lock.json` 只有在 GitHub Release 与 OSS 两端校验一致后才允许更新，失败时 ECS 继续使用旧 lock。

### 9.3 GitHub Release（当前正式来源）

使用已登录个人账号且有发布权限的 `gh` CLI；发布前确认 `gh auth status` 显示 `zoroperona`，不得使用公司账号：

```powershell
$Package = Get-ChildItem .\transfer\wow-db-*.zip |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
$Build = [regex]::Match($Package.BaseName, 'wow-db-(.+)-cn-zhCN').Groups[1].Value
$Tag = "wowdb-$Build-cn-zhCN"
gh release create $Tag $Package.FullName ($Package.FullName + ".sha256") `
  --title $Tag `
  --notes "WoW DB2 snapshot $Build; verify SHA-256 before import."
```

如果同名 Release 已存在，不要强制覆盖；先确认是否为同一文件和同一 SHA-256。

## 10. Mac / 应用侧导入

上传完成后，把 ZIP 和 `.sha256` 交给运行应用的机器。应用侧先校验再导入：

```bash
cd /path/to/wow-helper/loot-allocator
shasum -a 256 /path/to/wow-db-<build>-cn-zhCN.zip
npm run wowdb:import -- /path/to/wow-db-<build>-cn-zhCN.zip --check-only
```

`--check-only` 通过后，再停止应用并导入：

```bash
npm run wowdb:import -- /path/to/wow-db-<build>-cn-zhCN.zip
npm run build
node scripts/validate-runtime.mjs
```

导入脚本会拒绝降级、校验 SQLite 完整性、关键表、manifest 身份和热修 SHA-256。由于 Web 进程会缓存 wow-db SQLite 连接和目录数据，导入前必须停止 Web/current 和所有 wow-db 使用者；原子替换后必须重启 Web（或使用已经实现并测试的显式 reload），确认健康页/API meta 显示目标 Build、文件 SHA-256 和 Hotfix 信息。仅替换磁盘文件而不重启应用不算成功。

## 11. 失败处理

### 客户端 build 不对

停止流程，重新打开 Battle.net 完成更新，再执行 `doctor`。不要手工修改 snapshot 的 build。

### 找不到 `DBCache.bin`

可先生成基础 DB2 包，但必须明确知道这是无热修包。生产应用需要热修时，继续搜索客户端目录或等待客户端完成一次登录/更新后再重试。

### Hotfix build mismatch

这是热修文件和客户端不属于同一 build 的信号。不要强制跳过校验；重新定位当前客户端生成的 `DBCache.bin`。

### `report.failed` 大于零

不要上传。查看快照目录下 `state\tables\*.json` 和 `report.json`，记录失败表和错误。可以重复相同命令恢复；定义更新后可加 `-RefreshMetadata`，单表问题可用 `-Table` 和 `-Force` 重试。

### 磁盘空间不足或进程中断

先释放临时目录，确认没有 WoW/Battle.net 进程占用，再重复相同命令。工具支持 DB2 和 SQLite 的中断恢复，不要删除当前快照目录。

### 上传后 SHA-256 不一致

删除或隔离远端错误对象，重新上传同一个本地 ZIP。不要在远端重新压缩或修改 ZIP。

### 应用侧导入失败

保留当前线上 `wow.sqlite`，不要手工覆盖。应用侧先恢复上一版归档或上一版交接包，记录失败信息后再处理新包。

## 12. 回滚

每个 build 都是不可变包。回滚时选择上一个已验证的 ZIP，执行相同的 `--check-only` 和导入流程；不要从 Git 恢复 SQLite，也不要从 ZIP 中只抽取部分表。

## 13. 操作记录模板

每次更新完成后记录：

```text
执行日期（Asia/Shanghai）：
操作人：
客户端目录：
product / region / locale：
客户端 build：
DBCache.bin 路径：
hotfix build / HTFX version：
交接包文件名：
交接包大小：
交接包 SHA-256：
上传通道和远端对象：
Mac --check-only 结果：
应用导入时间：
导入后健康检查：
异常与处理：
```
