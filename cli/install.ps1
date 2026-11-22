# sigw の CLI を入れる(Windows)。
#   irm __SIGW_CLI_ORIGIN__/install.ps1 | iex
# 版を決めるときは、先に $env:SIGW_VERSION = "0.1.0" を設定する。
# cli.sigw.4rtofl.org の Worker(src/web/cli-dist.ts)が __…__ を埋めてから返す。

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repository = "__SIGW_RELEASE_REPOSITORY__"
$CliOrigin = "__SIGW_CLI_ORIGIN__"
$InstallDir = if ($env:SIGW_INSTALL_DIR) { $env:SIGW_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "sigw\bin" }
$Asset = "sigw-windows-x64.exe"

if (-not [Environment]::Is64BitOperatingSystem) {
	throw "64 ビット版の Windows だけに対応しています"
}

$Version = $env:SIGW_VERSION
if (-not $Version) {
	$Version = (Invoke-RestMethod "$CliOrigin/latest").Trim()
}

$Base = "https://github.com/$Repository/releases/download/cli-v$Version"
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("sigw-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
	Write-Host "sigw $Version($Asset)をダウンロードしています…"
	Invoke-WebRequest "$Base/$Asset" -OutFile (Join-Path $Temp "sigw.exe")
	$Sums = (Invoke-WebRequest "$Base/SHA256SUMS").Content -split "`n"
	$Expected = ($Sums | Where-Object { $_ -match "\s\*?$([regex]::Escape($Asset))$" } | ForEach-Object { ($_ -split "\s+")[0] })
	if (-not $Expected) { throw "SHA256SUMS に $Asset がありません" }
	$Actual = (Get-FileHash (Join-Path $Temp "sigw.exe") -Algorithm SHA256).Hash.ToLower()
	if ($Expected -ne $Actual) { throw "ダウンロードしたファイルのハッシュが合いません(期待 $Expected、実際 $Actual)" }

	New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
	$Target = Join-Path $InstallDir "sigw.exe"
	# 動いている exe は上書きできないが、名前は変えられる
	if (Test-Path $Target) { Move-Item -Force $Target "$Target.old" }
	Move-Item (Join-Path $Temp "sigw.exe") $Target
	Remove-Item -Force -ErrorAction SilentlyContinue "$Target.old"
} finally {
	Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($UserPath -split ";") -contains $InstallDir)) {
	[Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User")
	Write-Host "$InstallDir を PATH に足しました。新しいターミナルから使えます。"
}
Write-Host "sigw $Version を $Target に入れました。次に「sigw auth login」でログインしてください。"
