param([string]$RuntimeSource, [string]$Output)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scratch.ps1')
$repo = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
if (-not $Output) { $Output = Join-Path $repo ('codex-session-tracker-' + $package.version + '.vsix') }
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { throw "Output already exists: $Output" }
if (-not $RuntimeSource) { $RuntimeSource = $repo }
$runtimeBinary = Join-Path $RuntimeSource 'runtime\bin\windows-x86_64\codex.exe'
$manifest = Get-Content -LiteralPath (Join-Path $repo 'runtime\manifest.json') -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $runtimeBinary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw 'Runtime SHA256 differs from repository manifest.' }
$scratch = New-TrackerScratch 'package'
$archive = $null
$success = $false
try {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $files = @{}
    foreach ($pattern in @($package.files) + @('package.json', 'proxy_watchdog.js', 'proxy_recovery.js', 'runtime/manifest.json', 'runtime/LICENSE-Codex.txt', 'runtime/NOTICE-Codex.txt', 'runtime/tracker_hook.rs')) {
        foreach ($item in Get-ChildItem -Path (Join-Path $repo $pattern) -ErrorAction Stop) {
            $children = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $item.FullName -Recurse -File) } else { @($item) }
            foreach ($child in $children) {
                $relative = $child.FullName.Substring($repo.Length + 1).Replace('\', '/')
                if ($relative -eq 'LICENSE') { $relative = 'LICENSE.txt' }
                $files['extension/' + $relative] = $child.FullName
            }
        }
    }
    $files['extension/runtime/bin/windows-x86_64/codex.exe'] = $runtimeBinary
    $xmlEscape = { param($value) [Security.SecurityElement]::Escape([string]$value) }
    $display = & $xmlEscape $package.displayName
    $description = & $xmlEscape $package.description
    $engine = & $xmlEscape $package.engines.vscode
    $vsixManifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata>
<Identity Language="en-US" Id="codex-session-tracker" Version="$($package.version)" Publisher="local" />
<DisplayName>$display</DisplayName><Description xml:space="preserve">$description</Description><Tags>codex,tracker</Tags><Categories>Other</Categories>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="$engine" /><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" /></Properties>
<License>extension/LICENSE.txt</License></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation><Dependencies />
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" /><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" /></Assets></PackageManifest>
"@
    $contentTypes = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    foreach ($extension in @('json','js','css','md','html','svg','mp3','wav','txt','exe','py','rs','vsixmanifest')) { $contentTypes += '<Default Extension="' + $extension + '" ContentType="application/octet-stream" />' }
    $contentTypes += '</Types>'
    [IO.File]::WriteAllText((Join-Path $scratch 'extension.vsixmanifest'), $vsixManifest)
    [IO.File]::WriteAllText((Join-Path $scratch '[Content_Types].xml'), $contentTypes)
    $files['extension.vsixmanifest'] = Join-Path $scratch 'extension.vsixmanifest'
    $files['[Content_Types].xml'] = Join-Path $scratch '[Content_Types].xml'
    $archive = [IO.Compression.ZipFile]::Open($Output, [IO.Compression.ZipArchiveMode]::Create)
    foreach ($name in ($files.Keys | Sort-Object)) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $files[$name], $name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
    $archive.Dispose(); $archive = $null
    $archive = [IO.Compression.ZipFile]::OpenRead($Output)
    if ($archive.Entries.Count -ne $files.Count) { throw 'Package file count mismatch.' }
    foreach ($required in @('extension/package.json', 'extension/extension.js', 'extension/codex_context_watch.js', 'extension/codex_context_reader.js', 'extension/codex_context_handoff.js', 'extension/codex_new_chat.js', 'extension/codex_chat_context_store.js', 'extension/codex_new_chat_form.js', 'extension/media/new_chat_dialog.html', 'extension/media/new_chat_dialog.js', 'extension/media/attention_voice/approval_initial.wav', 'extension/media/attention_voice/input_initial.wav', 'extension/media/attention_voice/chat_completed.wav', 'extension/media/attention_voice/chat_failed.wav', 'extension/media/sound_settings.js', 'extension/media/sound_settings.css', 'extension/media/chat_list_layout.js', 'extension/codex_sound_settings.js', 'extension/codex_completion_sounds.js', 'extension/codex_plan_state.js', 'extension/codex_new_chat_context.js', 'extension/gateway/index.js', 'extension/runtime/bin/windows-x86_64/codex.exe')) {
        if (-not $archive.GetEntry($required)) { throw "Missing required archive entry: $required" }
    }
    foreach ($entry in $archive.Entries) {
        $stream = $entry.Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose(); $sha.Dispose() }
        if ($actual -ne (Get-FileHash -LiteralPath $files[$entry.FullName] -Algorithm SHA256).Hash) { throw "Package content mismatch: $($entry.FullName)" }
    }
    $archive.Dispose(); $archive = $null
    $success = $true
    [pscustomobject]@{ version=$package.version; entries=$files.Count; sha256=(Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLowerInvariant(); sourceAndRuntimeHashesVerified=$true; output=$Output } | ConvertTo-Json
} finally {
    if ($archive) { $archive.Dispose() }
    if (-not $success -and (Test-Path -LiteralPath $Output)) { Remove-Item -LiteralPath $Output }
    Remove-TrackerScratch $scratch
}
