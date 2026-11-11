param([string]$TestFile = 'context_watch_ui.py')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scratch.ps1')
$scratch = New-TrackerScratch 'ui'
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
try {
    $env:TEMP = $scratch
    $env:TMP = $scratch
    $env:CST_UI_SCRATCH = $scratch
    if ($TestFile -notin @('context_watch_ui.py', 'new_chat_dialog_ui.py', 'sounds_layout_ui.py', 'plan_prompt_ui.py', 'handoff_dialog_ui.py', 'speed_proxy_ui.py', 'layout_controls_ui.py')) { throw 'Unsupported UI test.' }
    & python (Join-Path $PSScriptRoot ('../test/' + $TestFile))
    $testExit = $LASTEXITCODE
} finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    Remove-Item Env:CST_UI_SCRATCH -ErrorAction SilentlyContinue
    Remove-TrackerScratch $scratch
}
exit $testExit
