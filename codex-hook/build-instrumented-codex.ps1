param(
  [string]$OutputDir = "",
  [string]$SourceDir = ""
)

$ErrorActionPreference = "Stop"

$Tag = "rust-v0.159.2"
$Commit = "ff6aec96948b70d94983af2641a6b67c94faeff5"
$RepoUrl = "https://github.com/openai/codex.git"
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

Require-Command "git"
Require-Command "node"
Require-Command "cargo"

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
  $Target = Join-Path $OutputDir "codex.exe"
  Copy-Item -Force $Built $Target

  $Hash = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToLowerInvariant()
  $Version = (& $Target --version 2>&1 | Out-String).Trim()

  $Manifest = [ordered]@{
    schemaVersion = 1
    sourceTag = $Tag
    sourceCommit = $Commit
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
    version = $Version
    sha256 = $Hash
    executable = "codex.exe"
  }
  $Manifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $OutputDir "manifest.json")

  Write-Host ""
  Write-Host "Instrumented Codex build complete:"
  Write-Host "  $Target"
  Write-Host "  $Version"
  Write-Host "  sha256=$Hash"
} finally {
  Pop-Location
}
