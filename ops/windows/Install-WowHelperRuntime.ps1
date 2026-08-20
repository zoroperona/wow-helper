[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string] $RepoRoot,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $NodeExe,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $SimcExe,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string] $WowDbPath,

    [string] $HandleExe,
    [string] $PowerShellExe = "pwsh.exe",
    [string] $RuntimeUser = "WOWHELPER-RUNTIME\wowhelper-runtime",
    [string] $ProgramDataRoot = "$env:ProgramData\WowHelper",
    [switch] $SkipTaskRegistration
)

$ErrorActionPreference = "Stop"

function Invoke-Installation {
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$NodeExe = [System.IO.Path]::GetFullPath($NodeExe)
$SimcExe = [System.IO.Path]::GetFullPath($SimcExe)
$WowDbPath = [System.IO.Path]::GetFullPath($WowDbPath)
$ProgramDataRoot = [System.IO.Path]::GetFullPath($ProgramDataRoot)
$PowerShellCommand = Get-Command $PowerShellExe -ErrorAction Stop
$PowerShellExe = [System.IO.Path]::GetFullPath($PowerShellCommand.Source)
$manifestPath = Join-Path $ProgramDataRoot "runtime.json"
$wrapperPath = Join-Path $RepoRoot "ops\windows\Invoke-WowHelperTask.ps1"
$definitionsPath = Join-Path $RepoRoot "ops\windows\task-definitions.json"

Assert-Administrator
Assert-StandardRuntimeUser $RuntimeUser
Assert-File $wrapperPath "wrapper"
Assert-File $definitionsPath "task definitions"

$lootRoot = Join-Path $RepoRoot "loot-allocator"
$databasePath = Join-Path $lootRoot "data\loot-allocator.sqlite"
$wowDbDirectory = Split-Path -Parent $WowDbPath
$simcRunsPath = Join-Path $lootRoot "data\simc-runs"
$backupsPath = Join-Path $lootRoot "backups"
$dailyStatusPath = Join-Path $lootRoot "data\runtime\daily-sim-status.json"
$statusDirectory = Join-Path $lootRoot "data\runtime\task-status"

foreach ($directory in @($ProgramDataRoot, $simcRunsPath, $backupsPath, (Split-Path -Parent $dailyStatusPath), $statusDirectory, $wowDbDirectory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Set-RestrictedDirectoryAcl $directory $RuntimeUser
}

$paths = [ordered]@{
    repoRoot = $RepoRoot
    nodeExe = $NodeExe
    databasePath = $databasePath
    wowDbPath = $WowDbPath
    simcExe = $SimcExe
    simcRunsPath = $simcRunsPath
    backupsPath = $backupsPath
    dailyStatusPath = $dailyStatusPath
    statusDirectory = $statusDirectory
    pwshExe = $PowerShellExe
    wrapper = $wrapperPath
    taskDefinitions = $definitionsPath
}
if (-not [string]::IsNullOrWhiteSpace($HandleExe)) {
    $HandleExe = [System.IO.Path]::GetFullPath($HandleExe)
    Assert-File $HandleExe "Windows handle checker"
    $paths.handleExe = $HandleExe
}

$hashes = [ordered]@{
    nodeExe = (Get-FileHash -LiteralPath $NodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
    simcExe = (Get-FileHash -LiteralPath $SimcExe -Algorithm SHA256).Hash.ToLowerInvariant()
    pwshExe = (Get-FileHash -LiteralPath $PowerShellExe -Algorithm SHA256).Hash.ToLowerInvariant()
    wrapper = (Get-FileHash -LiteralPath $wrapperPath -Algorithm SHA256).Hash.ToLowerInvariant()
    taskDefinitions = (Get-FileHash -LiteralPath $definitionsPath -Algorithm SHA256).Hash.ToLowerInvariant()
}
if ($paths.handleExe) {
    $hashes.handleExe = (Get-FileHash -LiteralPath $paths.handleExe -Algorithm SHA256).Hash.ToLowerInvariant()
}

$manifest = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString("o")
    runAs = $RuntimeUser
    paths = $paths
    hashes = $hashes
}
$temporaryManifest = "$manifestPath.$PID.tmp"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryManifest -Encoding UTF8
Set-RestrictedFileAcl $temporaryManifest $RuntimeUser
Move-Item -LiteralPath $temporaryManifest -Destination $manifestPath -Force
Set-RestrictedFileAcl $manifestPath $RuntimeUser

if (-not $SkipTaskRegistration) {
    $credential = Get-Credential -UserName $RuntimeUser -Message "输入 $RuntimeUser 的 Task Scheduler 凭据（不会写入 runtime manifest）"
    $definitions = Get-Content -LiteralPath $definitionsPath -Raw | ConvertFrom-Json
    if ($definitions.schemaVersion -ne 1) { throw "不支持的任务定义 schema：$($definitions.schemaVersion)" }
    foreach ($definition in $definitions.tasks) {
        Register-WowHelperTask -Definition $definition -Credential $credential -WrapperPath $wrapperPath -ManifestPath $manifestPath -PowerShellExe $PowerShellExe -ExportDirectory (Join-Path $ProgramDataRoot "task-xml")
    }
}

Write-Host "runtime manifest 已安装：$manifestPath"
Write-Host "wrapper：$wrapperPath"
}

function Register-WowHelperTask($Definition, $Credential, [string] $WrapperPath, [string] $ManifestPath, [string] $PowerShellExe, [string] $ExportDirectory) {
    $argument = "-NoProfile -NonInteractive -File `"$WrapperPath`" -Task $($Definition.task) -ManifestPath `"$ManifestPath`""
    $action = New-ScheduledTaskAction -Execute $PowerShellExe -Argument $argument -WorkingDirectory (Split-Path -Parent $WrapperPath)
    if ($Definition.trigger -eq "startup") {
        $trigger = New-ScheduledTaskTrigger -AtStartup
    } elseif ($Definition.trigger -eq "daily") {
        $trigger = New-ScheduledTaskTrigger -Daily -At ([DateTime]::Today.Add([TimeSpan]::Parse($Definition.at)))
    } else {
        throw "未知任务触发器：$($Definition.trigger)"
    }
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 12)
    $principal = New-ScheduledTaskPrincipal -UserId $Credential.UserName -LogonType Password -RunLevel Limited
    Register-ScheduledTask -TaskName $Definition.name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -User $Credential.UserName -Password (ConvertFrom-SecureString $Credential.Password -AsPlainText) -Force | Out-Null
    New-Item -ItemType Directory -Path $ExportDirectory -Force | Out-Null
    Export-ScheduledTask -TaskName $Definition.name | Set-Content -LiteralPath (Join-Path $ExportDirectory "$($Definition.name).xml") -Encoding UTF8
    Write-Host "已注册任务：$($Definition.name)"
}

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "安装器必须从管理员 PowerShell 运行"
    }
}

function Assert-StandardRuntimeUser([string] $UserName) {
    if ($UserName -match "(?i)(SYSTEM|Administrator|Administrators)") {
        throw "runtime 用户不得是 SYSTEM、Administrator 或 Administrators：$UserName"
    }
}

function Assert-File([string] $Path, [string] $Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label 不存在：$Path"
    }
}

function Set-RestrictedFileAcl([string] $Path, [string] $RuntimeUser) {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($RuntimeUser, "Read", "Allow"))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new("Administrators", "FullControl", "Allow"))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Set-RestrictedDirectoryAcl([string] $Path, [string] $RuntimeUser) {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagate = [System.Security.AccessControl.PropagationFlags]::None
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($RuntimeUser, "Modify", $inherit, $propagate, "Allow"))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new("Administrators", "FullControl", $inherit, $propagate, "Allow"))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

Invoke-Installation
