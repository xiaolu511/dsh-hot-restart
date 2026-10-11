# ============================================================================
# dsh-hot-restart :: standalone restart (no plugin, no page needed)
# ----------------------------------------------------------------------------
# Double-click tools\restart-dsh.cmd (or run this script) to close the DSH
# desktop shell and bring it back automatically. Useful for the ONE restart
# needed right after installing the plugin, and as a rescue path.
#
# Same mechanism as the plugin: spawn the relaunch helper through WMI (outside
# the DSH Windows Job object), then terminate the Electron shell process.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
# ============================================================================
$ErrorActionPreference = "Continue"

$exeName = "DeepSeek Harness.exe"
$port = 19387

$procs = @(Get-CimInstance Win32_Process -Filter "Name='$exeName'" -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
  Write-Host "[dsh-hot-restart] DSH desktop shell is not running - just start it normally."
  exit 1
}

$shell = $procs | Where-Object {
  $_.CommandLine -notmatch '--type=' -and
  $_.CommandLine -notmatch 'dsh-desktop-host' -and
  $_.CommandLine -notmatch '--expose-internals'
} | Select-Object -First 1

if ($null -eq $shell) {
  Write-Host "[dsh-hot-restart] Could not identify the DSH browser process (only renderer/helper processes found)."
  exit 1
}

$helper = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\lib\relaunch.vbs'))
if (-not (Test-Path -LiteralPath $helper)) {
  Write-Host "[dsh-hot-restart] helper script missing: $helper"
  exit 2
}

$logDir = Join-Path $env:USERPROFILE '.dsh\hot-restart'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'restart.log'

# wscript.exe = GUI subsystem: the dispatched helper creates no console window at all.
$launcherExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
$argLine = '//B "{0}" {1} "{2}" "{3}" {4}' -f `
  $helper, $shell.ProcessId, $shell.ExecutablePath, $log, $port
$commandLine = '"{0}" {1}' -f $launcherExe, $argLine

$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
if ($created.ReturnValue -ne 0) {
  Write-Host "[dsh-hot-restart] failed to spawn the relaunch helper (Win32_Process.Create -> $($created.ReturnValue))."
  exit 3
}

Write-Host "[dsh-hot-restart] helper pid $($created.ProcessId); terminating DSH shell pid $($shell.ProcessId) ..."
Start-Sleep -Milliseconds 600

try {
  Stop-Process -Id $shell.ProcessId -Force -ErrorAction Stop
  Write-Host "[dsh-hot-restart] shell terminated. DSH should reappear in a few seconds."
  Write-Host "[dsh-hot-restart] log: $log"
  exit 0
} catch {
  Write-Host "[dsh-hot-restart] could not terminate the shell: $($_.Exception.Message)"
  Write-Host "[dsh-hot-restart] the helper will not start a second instance while the old one is alive."
  exit 4
}
