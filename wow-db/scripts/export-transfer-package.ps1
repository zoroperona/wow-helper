param(
    [Parameter(Mandatory = $true)]
    [string]$Client,
    [string]$Destination = (Join-Path $PSScriptRoot "..\transfer"),
    [string]$Product = "wow",
    [string]$Region = "cn",
    [string]$Locale = "zhCN",
    [switch]$RefreshMetadata,
    [switch]$VerifyExisting,
    [string]$Hotfix
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OutputRoot = Join-Path $Root "output"
$SnapshotArgs = @{
    Client = $Client
    Product = $Product
    Region = $Region
    Locale = $Locale
}
if ($RefreshMetadata) { $SnapshotArgs.RefreshMetadata = $true }
if ($VerifyExisting) { $SnapshotArgs.VerifyExisting = $true }
if ($Hotfix) { $SnapshotArgs.Hotfix = (Resolve-Path $Hotfix).Path }

& (Join-Path $PSScriptRoot "wow-db.ps1") @SnapshotArgs
if ($LASTEXITCODE -ne 0) { throw "wow-db snapshot failed with exit code $LASTEXITCODE" }

$Snapshot = Get-ChildItem -Path $OutputRoot -Filter snapshot.json -File -Recurse |
    ForEach-Object {
        $Metadata = Get-Content $_.FullName -Raw | ConvertFrom-Json
        [PSCustomObject]@{ Path = $_.FullName; Root = $_.DirectoryName; Metadata = $Metadata }
    } |
    Where-Object {
        $_.Metadata.product -eq $Product -and
        $_.Metadata.region -eq $Region -and
        $_.Metadata.locale -eq $Locale -and
        $_.Metadata.completedAt
    } |
    Sort-Object { [DateTimeOffset]$_.Metadata.completedAt } -Descending |
    Select-Object -First 1

if (-not $Snapshot) { throw "No completed $Product/$Region/$Locale snapshot was found under $OutputRoot" }
$ReportPath = Join-Path $Snapshot.Root "report.json"
$DatabasePath = Join-Path $Snapshot.Root "parsed\wow.sqlite"
if (-not (Test-Path $ReportPath)) { throw "Snapshot report is missing: $ReportPath" }
if (-not (Test-Path $DatabasePath)) { throw "Snapshot database is missing: $DatabasePath" }
$Report = Get-Content $ReportPath -Raw | ConvertFrom-Json
if ([int]$Report.failed -ne 0) { throw "Snapshot has $($Report.failed) failed tables and will not be packaged" }

$Build = [string]$Snapshot.Metadata.build
$SafeBuild = $Build -replace '[^0-9A-Za-z._-]', '_'
$PackageName = "wow-db-$SafeBuild-$Region-$Locale"
$Destination = [IO.Path]::GetFullPath($Destination)
$Stage = Join-Path $Destination $PackageName
$Archive = Join-Path $Destination "$PackageName.zip"
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage | Out-Null

Copy-Item $Snapshot.Path (Join-Path $Stage "snapshot.json")
Copy-Item $ReportPath (Join-Path $Stage "report.json")
Copy-Item $DatabasePath (Join-Path $Stage "wow.sqlite")
$DatabaseHash = (Get-FileHash (Join-Path $Stage "wow.sqlite") -Algorithm SHA256).Hash.ToLowerInvariant()
$Manifest = [ordered]@{
    schemaVersion = 1
    createdAt = [DateTimeOffset]::UtcNow.ToString("o")
    product = $Product
    region = $Region
    locale = $Locale
    build = $Build
    snapshotCompletedAt = [string]$Snapshot.Metadata.completedAt
    databaseFile = "wow.sqlite"
    databaseBytes = (Get-Item (Join-Path $Stage "wow.sqlite")).Length
    databaseSha256 = $DatabaseHash
    hotfixLayerIncluded = [bool]$Snapshot.Metadata.hotfixSha256
    hotfixBuild = [string]$Snapshot.Metadata.hotfixBuild
    hotfixFormatVersion = $Snapshot.Metadata.hotfixFormatVersion
    hotfixSha256 = [string]$Snapshot.Metadata.hotfixSha256
}
$Manifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Stage "transfer-manifest.json") -Encoding utf8
if (Test-Path $Archive) { Remove-Item $Archive -Force }
Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $Archive -CompressionLevel Optimal
Remove-Item $Stage -Recurse -Force

Write-Host "Transfer package: $Archive"
Write-Host "Build: $Build; locale: $Locale; SHA-256: $DatabaseHash"
if ($Snapshot.Metadata.hotfixSha256) {
    Write-Host "Hotfix: build $($Snapshot.Metadata.hotfixBuild); SHA-256: $($Snapshot.Metadata.hotfixSha256)"
} else {
    Write-Warning "This package contains base DB2 data only; DBCache.bin hotfixes are not included."
}
