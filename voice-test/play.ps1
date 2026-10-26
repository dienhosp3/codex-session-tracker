param([int]$Percent = 42, [switch]$Large)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$args = @($root + '\test-voice.js', '-p', $Percent)
if ($Large) { $args += '--large' }
node @args
$name = if ($Large) { "large-$Percent.wav" } else { "$Percent.wav" }
$file = Join-Path $root ("output\" + $name)
Start-Process -FilePath $file -Wait
