$script:TrackerUserSid = 'S-1-5-21-1313641305-1280216474-2821017480-1001'
$script:TrackerScratchBase = [IO.Path]::GetFullPath((Join-Path $env:TEMP 'AHUST-Work\codex-session-tracker'))

function Assert-TrackerUserToken {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($identity.User.Value -ne $script:TrackerUserSid -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Scratch verification must run with the ordinary LEGION\SP3 token, not an elevated or agent identity.'
    }
}
function Assert-NoReparseParents([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse path refused: $current" }
        }
        $parent = Split-Path -Parent $current
        if ($parent -eq $current) { break }
        $current = $parent
    }
}
function Grant-TrackerScratch([string]$Path) {
    Assert-NoReparseParents $Path
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($false, $true)
    $sid = New-Object Security.Principal.SecurityIdentifier($script:TrackerUserSid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Test-TrackerScratchAccess([string]$Path) {
    Assert-TrackerUserToken
    Assert-NoReparseParents $Path
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.AreAccessRulesProtected) { throw "Inheritance disabled: $Path" }
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    $full = $rules | Where-Object { $_.IdentityReference.Value -eq $script:TrackerUserSid -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl }
    if (-not $full) { throw "Missing user FullControl: $Path" }
    $probe = Join-Path $Path ('access-probe-' + [guid]::NewGuid().ToString('N'))
    try {
        [IO.Directory]::CreateDirectory($probe) | Out-Null
        $file = Join-Path $probe 'create.txt'
        [IO.File]::WriteAllText($file, 'create')
        if ([IO.File]::ReadAllText($file) -ne 'create') { throw 'Read probe failed.' }
        [IO.File]::AppendAllText($file, '-edit')
        if ([IO.File]::ReadAllText($file) -ne 'create-edit') { throw 'Edit probe failed.' }
        Rename-Item -LiteralPath $file -NewName 'renamed.txt'
        Remove-Item -LiteralPath (Join-Path $probe 'renamed.txt')
        $renamed = $probe + '-renamed'
        Move-Item -LiteralPath $probe -Destination $renamed
        $probe = $renamed
    } finally {
        if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Recurse -Force }
        if (Test-Path -LiteralPath $probe) { throw "Probe cleanup failed: $probe" }
    }
}
function New-TrackerScratch([string]$Purpose) {
    Assert-TrackerUserToken
    Assert-NoReparseParents $script:TrackerScratchBase
    [IO.Directory]::CreateDirectory($script:TrackerScratchBase) | Out-Null
    Grant-TrackerScratch $script:TrackerScratchBase
    $root = Join-Path $script:TrackerScratchBase ($Purpose + '-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($root) | Out-Null
    try { Grant-TrackerScratch $root; Test-TrackerScratchAccess $root; return $root }
    catch { Remove-Item -LiteralPath $root -Recurse -Force; throw }
}
function Remove-TrackerScratch([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($script:TrackerScratchBase + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Outside owned scratch: $resolved" }
    Assert-NoReparseParents $resolved
    if (-not (Test-Path -LiteralPath $resolved)) { return }
    $directories = [Collections.Generic.Queue[string]]::new()
    $directories.Enqueue($resolved)
    while ($directories.Count) {
        $directory = $directories.Dequeue()
        Test-TrackerScratchAccess $directory
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse item refused: $($item.FullName)" }
            if ($item.PSIsContainer) { $directories.Enqueue($item.FullName) }
        }
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    if (Test-Path -LiteralPath $resolved) { throw "Scratch cleanup failed: $resolved" }
    Write-Host 'Scratch: ordinary-user ACL/probes passed; owned run directory removed.'
}
