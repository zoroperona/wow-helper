[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("daily", "daily-check", "backup", "validate")]
    [string] $Task,

    [string] $ManifestPath = "$env:ProgramData\WowHelper\runtime.json"
)

$ErrorActionPreference = "Stop"
$startedAt = [DateTime]::UtcNow
$statusDirectory = $null
$statusPath = $null
$exitCode = 1

try {
    $manifest = Read-Manifest $ManifestPath
    $statusDirectory = [string]$manifest.paths.statusDirectory
    if ([string]::IsNullOrWhiteSpace($statusDirectory)) {
        throw "runtime manifest 缺少 paths.statusDirectory"
    }
    $statusPath = Join-Path $statusDirectory "$Task.json"
    Write-Status -Path $statusPath -Task $Task -StartedAt $startedAt -Status "running" -ExitCode $null

    Assert-RunAs $manifest
    Assert-PathAndHashes $manifest

    $node = [string]$manifest.paths.nodeExe
    $repo = [string]$manifest.paths.repoRoot
    $script = Join-Path $repo "scripts\run-daily-pipeline.mjs"
    $arguments = @()
    switch ($Task) {
        "daily" { }
        "daily-check" { $arguments = @("--check") }
        "backup" {
            $script = Join-Path $repo "scripts\backup-database.mjs"
        }
        "validate" {
            $script = Join-Path $repo "scripts\validate-runtime.mjs"
        }
    }
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
        throw "任务脚本不存在：$script"
    }

    $env:LOOT_ALLOCATOR_DB = [string]$manifest.paths.databasePath
    $env:WOW_DB_PATH = [string]$manifest.paths.wowDbPath
    $env:SIMC_PATH = [string]$manifest.paths.simcExe
    $env:SIMC_RUNS_PATH = [string]$manifest.paths.simcRunsPath
    $env:BACKUPS_PATH = [string]$manifest.paths.backupsPath
    $env:DAILY_TASK_STATUS_PATH = [string]$manifest.paths.dailyStatusPath
    $env:WOWHELPER_RUNTIME_MANIFEST = $ManifestPath
    if ($manifest.paths.handleExe) {
        $env:WOWHELPER_HANDLE_PATH = [string]$manifest.paths.handleExe
    }

    & $node $script @arguments
    $exitCode = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
    if ($exitCode -eq 0) {
        Write-Status -Path $statusPath -Task $Task -StartedAt $startedAt -Status "succeeded" -ExitCode $exitCode
    } else {
        Write-Status -Path $statusPath -Task $Task -StartedAt $startedAt -Status "failed" -ExitCode $exitCode
    }
    exit $exitCode
} catch {
    Write-Error $_
    if ($statusPath) {
        Write-Status -Path $statusPath -Task $Task -StartedAt $startedAt -Status "failed" -ExitCode 40
    }
    exit 40
}

function Read-Manifest([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "runtime manifest 不存在：$Path"
    }
    $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($value.schemaVersion -ne 1) {
        throw "不支持的 runtime manifest schema：$($value.schemaVersion)"
    }
    foreach ($name in @("repoRoot", "nodeExe", "databasePath", "wowDbPath", "simcExe", "simcRunsPath", "backupsPath", "dailyStatusPath", "statusDirectory")) {
        if ([string]::IsNullOrWhiteSpace([string]$value.paths.$name)) {
            throw "runtime manifest 缺少绝对路径：paths.$name"
        }
        if (-not [System.IO.Path]::IsPathRooted([string]$value.paths.$name)) {
            throw "runtime manifest 只接受绝对路径：paths.$name"
        }
    }
    return $value
}

function Assert-RunAs($Manifest) {
    if ([string]::IsNullOrWhiteSpace([string]$Manifest.runAs)) {
        throw "runtime manifest 缺少 runAs"
    }
    $actual = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($actual -ine [string]$Manifest.runAs) {
        throw "运行账号不符：实际 $actual，要求 $($Manifest.runAs)"
    }
}

function Assert-PathAndHashes($Manifest) {
    foreach ($property in $Manifest.hashes.psobject.Properties) {
        $pathName = [string]$property.Name
        $expected = ([string]$property.Value).ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace([string]$Manifest.paths.$pathName)) {
            throw "hash 指向未知路径：$pathName"
        }
        $path = [string]$Manifest.paths.$pathName
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "runtime 文件不存在：$path"
        }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            throw "runtime 文件 hash 不匹配：$path"
        }
    }
}

function Write-Status([string] $Path, [string] $Task, [DateTime] $StartedAt, [string] $Status, [Nullable[int]] $ExitCode) {
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.tmp"
    $value = [ordered]@{
        schemaVersion = 1
        task = $Task
        status = $Status
        startedAt = $StartedAt.ToString("o")
        finishedAt = if ($Status -eq "running") { $null } else { [DateTime]::UtcNow.ToString("o") }
        exitCode = $ExitCode
    }
    $value | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}
