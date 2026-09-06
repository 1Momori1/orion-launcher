param(
	[switch]$NoAdmin,
	[switch]$Test,
	[string]$Root = "$env:TEMP\orion-clean-env"
)

$ErrorActionPreference = "Stop"
if (Test-Path $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $Root "games") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Root "versions") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Root "cache") -Force | Out-Null

$env:ORION_DATA_ROOT = $Root
$env:ORION_CLEAN_ENV = "1"
if ($NoAdmin) { $env:ORION_NO_SYMLINK = "1" }

Write-Host "clean-env root=$Root noAdmin=$NoAdmin"
Write-Host "Developer Mode / admin rights are host settings; this sandbox never creates symlinks when -NoAdmin is set."

if ($Test) {
	Push-Location (Split-Path $PSScriptRoot -Parent)
	try {
		node scripts/run-tests.js
		if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
	} finally {
		Pop-Location
	}
}
