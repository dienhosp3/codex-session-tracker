param([Parameter(Mandatory=$true)][string]$File)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'scratch.ps1')
Assert-TrackerUserToken
$source=(Get-Item -LiteralPath $File -Force)
if($source.PSIsContainer -or $source.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Preview must be a regular image file.'}
if($source.Extension.ToLowerInvariant() -notin @('.png','.jpg','.jpeg','.webp','.gif')){throw 'Unsupported preview image.'}
$directory=Join-Path $env:APPDATA 'Code/User/globalStorage/local.codex-session-tracker/retained-images'
Assert-NoReparseParents $directory
[IO.Directory]::CreateDirectory($directory)|Out-Null
Grant-TrackerScratch $directory
Test-TrackerScratchAccess $directory
$hash=(Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$target=Join-Path $directory ($hash+$source.Extension.ToLowerInvariant())
if(-not(Test-Path -LiteralPath $target)){Copy-Item -LiteralPath $source.FullName -Destination $target}
if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash){throw 'Retained preview differs from source.'}
# View this returned path, then dispose the original scratch. The retained image
# is a conversation artifact and is excluded from automatic log retention.
Write-Output $target
