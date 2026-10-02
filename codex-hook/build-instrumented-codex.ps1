param(
  [string]$OutputDir = "",
  [string]$SourceDir = ""
)

$ErrorActionPreference = "Stop"

$Version = "0.159.2"
$Tag = "rust-v0.159.2"
$Commit = "ff6aec96948b70d94983af2641a6b67c94faeff5"
$Target = "x86_64-pc-windows-msvc"
$RepoUrl = "https://github.com/openai/codex.git"
$PackageAsset = "codex-package-$Target.tar.gz"
$ChecksumAsset = "codex-package_SHA256SUMS"
$ReleaseBase = "https://github.com/openai/codex/releases/download/$Tag"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

if (-not $SourceDir) {
  $SourceDir = Join-Path $env:LOCALAPPDATA "CodexSessionTracker\codex-src\0.159.2"
}
if (-not $OutputDir) {
  $OutputDir = Join-Path $RepoRoot "artifacts\codex-http-hook\0.159.2"
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Download-File([string]$Url, [string]$TargetPath) {
  Write-Host "Downloading $Url"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $TargetPath
}

function Get-ExpectedDigest([string]$ChecksumPath, [string]$AssetName) {
  $line = Get-Content -LiteralPath $ChecksumPath |
    Where-Object { $_ -match ("^[0-9a-fA-F]{64}\s+\*?" + [regex]::Escape($AssetName) + "$") } |
    Select-Object -First 1
  if (-not $line) {
    throw "Checksum manifest does not contain $AssetName"
  }
  return (($line -split "\s+")[0]).ToLowerInvariant()
}

Require-Command "git"
Require-Command "node"
Require-Command "cargo"
Require-Command "tar"

if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
  throw "This build is pinned to Windows x64 because the installed Codex runtime is win32-x64."
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SourceDir) | Out-Null

if (-not (Test-Path (Join-Path $SourceDir ".git"))) {
  Write-Host "Cloning OpenAI Codex $Tag..."
  git clone --filter=blob:none --branch $Tag --depth 1 $RepoUrl $SourceDir
}

Push-Location $SourceDir
try {
  git fetch --depth 1 origin "refs/tags/$Tag:refs/tags/$Tag"
  git reset --hard $Tag
  git clean -fdx

  $Head = (git rev-parse HEAD).Trim()
  if ($Head -ne $Commit) {
    throw "Unexpected Codex source revision. Expected $Commit, got $Head."
  }

  Write-Host "Applying Codex HTTP hook patch..."
  node (Join-Path $ScriptDir "apply_patch.js") $SourceDir

  Write-Host "Building instrumented codex.exe..."
  cargo build --manifest-path (Join-Path $SourceDir "codex-rs\Cargo.toml") -p codex-cli --release --bin codex

  $Built = Join-Path $SourceDir "codex-rs\target\release\codex.exe"
  if (-not (Test-Path $Built)) {
    throw "Instrumented codex.exe was not produced at $Built"
  }

  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
  $Temp = Join-Path $OutputDir ".download"
  $PackageDir = Join-Path $OutputDir "package"
  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PackageDir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Temp | Out-Null
  New-Item -ItemType Directory -Force -Path $PackageDir | Out-Null

  $ArchivePath = Join-Path $Temp $PackageAsset
  $ChecksumPath = Join-Path $Temp $ChecksumAsset
  Download-File "$ReleaseBase/$ChecksumAsset" $ChecksumPath
  Download-File "$ReleaseBase/$PackageAsset" $ArchivePath

  $ExpectedDigest = Get-ExpectedDigest $ChecksumPath $PackageAsset
  $ActualDigest = (Get-FileHash -Algorithm SHA256 $ArchivePath).Hash.ToLowerInvariant()
  if ($ActualDigest -ne $ExpectedDigest) {
    throw "Official Codex package checksum mismatch. Expected $ExpectedDigest, got $ActualDigest."
  }

  Write-Host "Extracting official complete Codex package..."
  tar -xzf $ArchivePath -C $PackageDir
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to extract $PackageAsset"
  }

  $PackageManifest = Join-Path $PackageDir "codex-package.json"
  if (-not (Test-Path $PackageManifest)) {
    throw "Official package is missing codex-package.json"
  }
  $Metadata = Get-Content -LiteralPath $PackageManifest -Raw | ConvertFrom-Json
  if ([string]$Metadata.version -ne $Version) {
    throw "Official package version mismatch. Expected $Version, got $($Metadata.version)."
  }
  if ([string]$Metadata.target -ne $Target) {
    throw "Official package target mismatch. Expected $Target, got $($Metadata.target)."
  }
  if ([string]$Metadata.entrypoint -ne "bin/codex.exe") {
    throw "Unexpected package entrypoint: $($Metadata.entrypoint)"
  }

  foreach ($Required in @(
    "bin\codex.exe",
    "bin\codex-code-mode-host.exe",
    "codex-path\rg.exe",
    "codex-resources\codex-command-runner.exe",
    "codex-resources\codex-windows-sandbox-setup.exe"
  )) {
    if (-not (Test-Path (Join-Path $PackageDir $Required))) {
      throw "Official package is incomplete: missing $Required"
    }
  }

  $TargetExe = Join-Path $PackageDir "bin\codex.exe"
  Copy-Item -Force $Built $TargetExe

  $VersionText = (& $TargetExe --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $VersionText -notmatch "0\.159\.2") {
    throw "Instrumented package entrypoint has unexpected version: $VersionText"
  }

  $Hash = (Get-FileHash -Algorithm SHA256 $TargetExe).Hash.ToLowerInvariant()
  $TrackerManifest = [ordered]@{
    schemaVersion = 2
    sourceTag = $Tag
    sourceCommit = $Commit
    target = $Target
    officialPackageAsset = $PackageAsset
    officialPackageSha256 = $ActualDigest
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
    version = $VersionText
    instrumentedEntrypointSha256 = $Hash
    packageDir = "package"
    entrypoint = "package/bin/codex.exe"
  }
  $TrackerManifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $OutputDir "tracker-manifest.json")

  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "Instrumented complete Codex package ready:"
  Write-Host "  $PackageDir"
  Write-Host "  $TargetExe"
  Write-Host "  $VersionText"
  Write-Host "  sha256=$Hash"
  Write-Host ""
  Write-Host "This is a complete official 0.159.2 package with only bin/codex.exe replaced by the instrumented build."
} finally {
  Pop-Location
}
