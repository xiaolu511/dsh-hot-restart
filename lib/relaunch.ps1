# ============================================================================
# dsh-hot-restart :: relaunch helper
# ----------------------------------------------------------------------------
# Spawned by the plugin through Win32_Process.Create (parent: WmiPrvSE), so it
# lives OUTSIDE the DSH process tree / Windows Job object and survives the
# Electron shell being terminated.
#
# Flow: wait for the shell PID to disappear -> (fallback) kill it ourselves ->
#       wait for the web port to be released -> start DSH again.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
# ============================================================================
param(
  [Parameter(Mandatory = $true)][int]$ShellPid,
  [Parameter(Mandatory = $true)][string]$ExePath,
  [string]$LogPath = "",
  [int]$Port = 0
)

$ErrorActionPreference = "Continue"

function Write-Log([string]$Message) {
  $line = "{0} [relaunch] {1}" -f (Get-Date).ToString("o"), $Message
  if ($LogPath -ne "") {
    try {
      if (Test-Path -LiteralPath $LogPath) {
        $info = Get-Item -LiteralPath $LogPath
        if ($info.Length -gt 262144) { Set-Content -LiteralPath $LogPath -Value "" -Encoding UTF8 }
      }
      Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    } catch { }
  }
}

function Test-Alive([int]$ProcessId) {
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $false }
    return $true
  } catch { return $false }
}

function Wait-Gone([int]$ProcessId, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Alive $ProcessId)) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return (-not (Test-Alive $ProcessId))
}

function Wait-PortFree([int]$PortNumber, [int]$TimeoutSeconds) {
  if ($PortNumber -le 0) { return $true }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $busy = $false
    try {
      $listeners = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue
      if ($listeners) { $busy = $true }
    } catch {
      $busy = $false
    }
    if (-not $busy) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

Write-Log ("helper started: shellPid={0} port={1} exe={2}" -f $ShellPid, $Port, $ExePath)

if (-not (Test-Path -LiteralPath $ExePath)) {
  Write-Log ("ABORT: executable not found: {0}" -f $ExePath)
  exit 2
}

# 1) normal path: the plugin already asked the shell to terminate
$gone = Wait-Gone $ShellPid 25
Write-Log ("shell gone after wait: {0}" -f $gone)

# 2) fallback: the plugin never got to run taskkill (or it failed)
if (-not $gone) {
  Write-Log "shell still alive; forcing termination from the helper"
  try { Stop-Process -Id $ShellPid -Force -ErrorAction Stop } catch { Write-Log ("force stop failed: {0}" -f $_.Exception.Message) }
  $gone = Wait-Gone $ShellPid 15
  Write-Log ("shell gone after force: {0}" -f $gone)
}

if (-not $gone) {
  Write-Log "ABORT: shell did not exit; not starting a second instance"
  exit 3
}

# 3) let file locks and the listening socket settle
Start-Sleep -Milliseconds 600
$free = Wait-PortFree $Port 25
Write-Log ("port free: {0}" -f $free)

# 4) relaunch
#    Use WMI so the new DSH inherits NO console. Plain Start-Process would hand it this
#    process's console, and on Windows 11 that console is hosted by Windows Terminal -
#    closing that window would then kill DSH.
$workDir = Split-Path -Parent $ExePath
Write-Log ("launching: {0} (cwd {1})" -f $ExePath, $workDir)
$launched = $false
for ($attempt = 1; $attempt -le 3 -and -not $launched; $attempt++) {
  try {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine = ('"{0}"' -f $ExePath)
      CurrentDirectory = $workDir
    }
    Write-Log ("create attempt {0} rv={1} pid={2}" -f $attempt, $result.ReturnValue, $result.ProcessId)
    if ($result.ReturnValue -eq 0) { $launched = $true }
  } catch {
    Write-Log ("create attempt {0} failed: {1}" -f $attempt, $_.Exception.Message)
  }
  if (-not $launched) { Start-Sleep -Milliseconds 500 }
}
if (-not $launched) {
  # Fallback: this PowerShell has a console, but the helper exits right after, and DSH is a
  # GUI app - it only keeps that console alive if it inherits it. Accept the trade-off so a
  # restart never silently fails.
  try {
    Start-Process -FilePath $ExePath -WorkingDirectory $workDir
    $launched = $true
    Write-Log "fallback Start-Process used"
  } catch {
    Write-Log ("LAUNCH FAILED: {0}" -f $_.Exception.Message)
  }
}
if ($launched) {
  Write-Log "launch issued"
  exit 0
} else {
  exit 4
}

