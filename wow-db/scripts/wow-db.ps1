param(
    [Parameter(Mandatory = $true)]
    [string]$Client,
    [string]$Product = "wow",
    [string]$Region = "cn",
    [string]$Locale = "zhCN",
    [ValidateSet("all", "raw", "sqlite")]
    [string]$Phase = "all",
    [string[]]$Table = @(),
    [switch]$Offline,
    [switch]$VerifyExisting,
    [switch]$RefreshMetadata,
    [switch]$Force,
    [string]$Hotfix
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Executable = Join-Path $Root "artifacts/win-x64/wow-db.exe"
$Project = Join-Path $Root "src/WowDb.Cli/WowDb.Cli.csproj"
$Arguments = @(
    "snapshot",
    "--client", (Resolve-Path $Client).Path,
    "--product", $Product,
    "--region", $Region,
    "--locale", $Locale,
    "--phase", $Phase,
    "--output", (Join-Path $Root "output"),
    "--cache", (Join-Path $Root "cache")
)

if ($Table.Count -gt 0) { $Arguments += @("--table", ($Table -join ",")) }
if ($Offline) { $Arguments += "--offline" }
if ($VerifyExisting) { $Arguments += "--verify-existing" }
if ($RefreshMetadata) { $Arguments += "--refresh-metadata" }
if ($Force) { $Arguments += "--force" }
if ($Hotfix) { $Arguments += @("--hotfix", (Resolve-Path $Hotfix).Path) }

if ((Test-Path $Executable) -and -not $Hotfix) {
    & $Executable @Arguments
} else {
    & dotnet run --project $Project --configuration Release -- @Arguments
}
exit $LASTEXITCODE
