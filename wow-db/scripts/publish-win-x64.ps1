param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Project = Join-Path $Root "src/WowDb.Cli/WowDb.Cli.csproj"
$Destination = Join-Path $Root "artifacts/win-x64"

dotnet publish $Project `
    --configuration $Configuration `
    --runtime win-x64 `
    --self-contained true `
    --output $Destination

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-ChildItem $Destination -Filter "*.pdb" | Remove-Item -Force
Write-Host "Published: $(Join-Path $Destination 'wow-db.exe')"
