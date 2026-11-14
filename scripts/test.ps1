param([Parameter(ValueFromRemainingArguments=$true)][string[]]$TestFiles)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scratch.ps1')
$scratch = New-TrackerScratch 'test'
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$previousLocation = Get-Location
try {
    $env:TEMP = $scratch
    $env:TMP = $scratch
    Set-Location (Split-Path -Parent $PSScriptRoot)
    if (-not $TestFiles) { $TestFiles = @('test/unit/*.test.js') }
    & node --require ./scripts/test-scratch.js --test @TestFiles
    $testExit = $LASTEXITCODE
} finally {
    Set-Location $previousLocation
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    Remove-TrackerScratch $scratch
}
exit $testExit
