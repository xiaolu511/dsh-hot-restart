# ============================================================================
# dsh-hot-restart :: standalone restart (no plugin, no page needed)
# ----------------------------------------------------------------------------
# Double-click tools\restart-dsh.cmd (or run this script) to close the DSH
# desktop shell and bring it back automatically. Useful for the ONE restart
# needed right after installing the plugin, and as a rescue path.
#
# Same mechanism as the plugin: spawn the relaunch helper through WMI (outside
# the DSH Windows Job object), then terminate the Electron shell process.
#
# Two hard lessons are baked in here:
#   1) Never look for a hard-coded exe name - builds differ ("DeepSeek
#      Harness.exe", "DSH Desktop.exe"). Match by name pattern instead.
#   2) Never kill the shell before the helper proved it is alive, otherwise a
#      silent helper leaves the user with no DSH at all.
#
# -Check compiles nothing but exits immediately: used by the test suite so it
# never touches a running DSH.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
# ============================================================================
param(
  [switch]$Check
)

$ErrorActionPreference = "Continue"

if ($Check) { exit 0 }

$candidates = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match 'dsh|harness|deepseek' -and
  $_.Name -notmatch '^(node|cmd|powershell|pwsh|wscript|cscript)\.exe$' -and
  $_.CommandLine -and
  $_.CommandLine -notmatch '--type=' -and
  $_.CommandLine -notmatch 'dsh-desktop-host' -and
  $_.CommandLine -notmatch '--expose-internals' -and
  $_.ExecutablePath
})

if ($candidates.Count -eq 0) {
  Write-Host "[dsh-hot-restart] no DSH desktop window found - if DSH is closed, just start it normally."
  exit 1
}

$shell = $candidates | Select-Object -First 1
Write-Host "[dsh-hot-restart] shell: $($shell.Name) pid $($shell.ProcessId)"

$helper = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\lib\relaunch.vbs'))
if (-not (Test-Path -LiteralPath $helper)) {
  Write-Host "[dsh-hot-restart] helper script missing: $helper"
  exit 2
}

$logDir = Join-Path $env:USERPROFILE '.dsh\hot-restart'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'restart.log'

function Get-LogSize {
  try { return (Get-Item -LiteralPath $log -ErrorAction Stop).Length } catch { return 0 }
}

# The web port belongs to the host half, which is a child of the shell.
$port = 0
try {
  $listen = Get-CimInstance MSFT_NetTCPConnection -Namespace root\StandardCimv2 -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 2 }
  foreach ($conn in $listen) {
    $owner = $conn.OwningProcess
    $isChild = Get-CimInstance Win32_Process -Filter ("ProcessId={0} AND ParentProcessId={1}" -f $owner, $shell.ProcessId) -ErrorAction SilentlyContinue
    if ($isChild) { $port = [int]$conn.LocalPort }
  }
} catch { }

function Start-Helper([string]$CommandLine) {
  try {
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $CommandLine }
    Write-Host "[dsh-hot-restart] helper pid $($created.ProcessId) rv $($created.ReturnValue)"
    return $created.ReturnValue -eq 0
  } catch {
    Write-Host "[dsh-hot-restart] helper dispatch failed: $($_.Exception.Message)"
    return $false
  }
}

function Wait-HelperReport([int]$Before, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Get-LogSize) -gt $Before) {
      try {
        $tail = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
        if ($tail -and $tail.Contains("[relaunch]")) { return $true }
      } catch { }
    }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

$launcherExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
$before = Get-LogSize
$cmd = '"{0}" //B "{1}" {2} "{3}" "{4}" {5}' -f $launcherExe, $helper, $shell.ProcessId, $shell.ExecutablePath, $log, $port
Start-Helper $cmd | Out-Null
$ok = Wait-HelperReport $before 8

if (-not $ok) {
  # VBS helper stayed silent (WSH blocked, sandbox, AV...): try the PowerShell helper.
  $psHelper = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\lib\relaunch.ps1'))
  if (Test-Path -LiteralPath $psHelper) {
    Write-Host "[dsh-hot-restart] the VBS helper did not report; trying the PowerShell helper"
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $psCmd = '"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -ShellPid {2} -ExePath "{3}" -LogPath "{4}" -Port {5}' -f `
      $psExe, $psHelper, $shell.ProcessId, $shell.ExecutablePath, $log, $port
    Start-Helper $psCmd | Out-Null
    $ok = Wait-HelperReport $before 12
  }
}

if (-not $ok) {
  Write-Host "[dsh-hot-restart] no relaunch helper came up, so DSH was left running."
  Write-Host "[dsh-hot-restart] nothing was closed. Restart DSH from the tray icon or the Start menu."
  exit 3
}

Write-Host "[dsh-hot-restart] helper is alive; terminating shell pid $($shell.ProcessId) ..."
Start-Sleep -Milliseconds 600

try {
  Stop-Process -Id $shell.ProcessId -Force -ErrorAction Stop
  Write-Host "[dsh-hot-restart] shell terminated. DSH should reappear in a few seconds."
  Write-Host "[dsh-hot-restart] log: $log"
  exit 0
} catch {
  Write-Host "[dsh-hot-restart] could not terminate the shell: $($_.Exception.Message)"
  exit 4
}
