param([int]$Jobs = 6, [switch]$KeepBuildCache, [switch]$UseExistingBuild, [string]$BuildCacheDirectory = '')
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
Push-Location $repository
try {
  $source = Join-Path $repository '.runtime-build/codex'
  if (-not (Test-Path -LiteralPath $source)) {
    & git clone --depth 1 --branch rust-v0.159.2 --single-branch https://github.com/openai/codex.git $source
    if ($LASTEXITCODE -ne 0) { throw 'Runtime source clone failed.' }
  }
  $cargo = Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
  $rustc = Join-Path $env:USERPROFILE '.cargo/bin/rustc.exe'
  $env:CARGO_NET_GIT_FETCH_WITH_CLI = 'true'
  $env:CARGO_TARGET_DIR = if ($BuildCacheDirectory) { [IO.Path]::GetFullPath($BuildCacheDirectory) } else { Join-Path $repository '.runtime-build/target' }
  $env:CARGO_INCREMENTAL = '0'
  if (-not $UseExistingBuild) {
    & node scripts/patch-runtime.js $source
    if ($LASTEXITCODE -ne 0) { throw 'Runtime source patch failed.' }
    & $cargo +stable build --manifest-path (Join-Path $source 'codex-rs/Cargo.toml') --profile dev-small -p codex-cli -p codex-websocket-client --bin codex --example tracker_client_fixture -j $Jobs
    if ($LASTEXITCODE -ne 0) { throw 'Runtime build failed.' }
  } else {
    $compiledHookHash=(Get-FileHash -LiteralPath (Join-Path $source 'codex-rs/http-client/src/tracker_hook.rs') -Algorithm SHA256).Hash
    if ($compiledHookHash -ne (Get-FileHash -LiteralPath 'runtime/tracker_hook.rs' -Algorithm SHA256).Hash) { throw 'Existing runtime hook source differs.' }
  }
  $verification = & node test/client_runtime_integration.js
  if ($LASTEXITCODE -ne 0) { throw 'Client runtime integration failed.' }
  New-Item -ItemType Directory -Path 'artifacts/verification' -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $repository 'artifacts/verification/client-runtime.json'),($verification -join [Environment]::NewLine),(New-Object Text.UTF8Encoding($false)))
  $destination = Join-Path $repository 'runtime/bin/windows-x86_64'
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'dev-small/codex.exe') -Destination (Join-Path $destination 'codex.exe')
  Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination 'runtime/LICENSE-Codex.txt'
  Copy-Item -LiteralPath (Join-Path $source 'NOTICE') -Destination 'runtime/NOTICE-Codex.txt'
  $version = (& (Join-Path $destination 'codex.exe') --version).Trim()
  if ($version -ne 'codex-cli 0.159.2') { throw 'Unexpected runtime version.' }
  $manifest = [ordered]@{
    schemaVersion = 1; cliVersion = '0.159.2'; instrumentationVersion = 2
    httpCaptureBoundary = 'http-client-body-frame'; websocketCaptureBoundary = 'websocket-message'; trackerResegmentation = $false
    sourceRevision = (& git -C $source rev-parse HEAD).Trim()
    sourceTag = 'rust-v0.159.2'; profile = 'dev-small'; platform = 'windows-x86_64'
    rustc = (& $rustc +stable --version).Trim(); cargo = (& $cargo +stable --version).Trim()
    node = (& node --version).Trim(); builtAt = [DateTime]::UtcNow.ToString('o')
    hookSha256 = (Get-FileHash -LiteralPath 'runtime/tracker_hook.rs' -Algorithm SHA256).Hash.ToLowerInvariant()
    patchSha256 = (Get-FileHash -LiteralPath 'scripts/patch-runtime.js' -Algorithm SHA256).Hash.ToLowerInvariant()
    sha256 = (Get-FileHash -LiteralPath (Join-Path $destination 'codex.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  [IO.File]::WriteAllText((Join-Path $repository 'runtime/manifest.json'),($manifest | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  $extensionRoot = (& code --locate-extension openai.chatgpt).Trim()
  if (-not $extensionRoot) { throw 'VS Code did not discover the installed Codex Extension.' }
  & node scripts/checkpoint.js --extension-root $extensionRoot --label client-runtime-build --output artifacts/checkpoints/client-runtime-build.json
  if ($LASTEXITCODE -ne 0) { throw 'Runtime checkpoint collection failed.' }
  if (-not $KeepBuildCache) {
    & $cargo +stable clean --manifest-path (Join-Path $source 'codex-rs/Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw 'Build cache cleanup failed.' }
  }
} finally { Pop-Location }
