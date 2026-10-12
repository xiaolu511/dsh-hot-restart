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
  [int]$Port = 0,
  [string]$Ticket = ""
)

$ErrorActionPreference = "Continue"

# The host writes a ticket right before dispatching this helper and deletes it when
# it gives up. A missing or stale ticket means the restart was cancelled: do nothing.
# Without this, a stray helper force-terminates the shell 25 seconds later anyway.
function Test-Ticket {
  if ($Ticket -eq "") { return $true }
  try {
    $f = Get-Item -LiteralPath $Ticket -ErrorAction Stop
    return (((Get-Date) - $f.LastWriteTime).TotalSeconds -lt 180)
  } catch { return $false }
}

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

function Stop-Children([int]$ParentPid) {
  try {
    $kids = Get-CimInstance Win32_Process -Filter ("ParentProcessId={0}" -f $ParentPid) -ErrorAction SilentlyContinue
    foreach ($kid in $kids) {
      Write-Log ("terminating child pid={0} name={1}" -f $kid.ProcessId, $kid.Name)
      try { Stop-Process -Id $kid.ProcessId -Force -ErrorAction Stop } catch { }
    }
  } catch { }
}

function Get-PortOwner([int]$PortNumber) {
  if ($PortNumber -le 0) { return 0 }
  try {
    $conn = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
  } catch { }
  return 0
}

# Only ever stop something that belongs to our own DSH stack, so we never touch
# an unrelated process that happens to sit on the port.
function Test-OurStack([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction Stop
    $name = $p.ProcessName.ToLower()
    if ($name -eq ([System.IO.Path]::GetFileNameWithoutExtension($ExePath)).ToLower()) { return $true }
    if ($name -eq "node" -or $name -eq "electron") { return $true }
  } catch { }
  return $false
}

function Wait-Instance([int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $running = Get-CimInstance Win32_Process -Filter ("Name='{0}'" -f [System.IO.Path]::GetFileName($ExePath)) -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq $ExePath.ToLower() }
      if ($running) { return $true }
    } catch { }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# 1b) cancellation check, before anything destructive happens
if (-not (Test-Ticket)) {
  Write-Log "ABORT: restart ticket missing or stale; leaving DSH untouched"
  exit 5
}
if ($Ticket -ne "") {
  try { Remove-Item -LiteralPath $Ticket -Force -ErrorAction Stop } catch { }
}

# 2) fallback: the plugin never got to close it (or the close failed)
if (-not $gone) {
  Write-Log "shell still alive; forcing termination from the helper"
  try { Stop-Process -Id $ShellPid -Force -ErrorAction Stop } catch { Write-Log ("force stop failed: {0}" -f $_.Exception.Message) }
  $gone = Wait-Gone $ShellPid 15
  Write-Log ("shell gone after force: {0}" -f $gone)
}
# The host half is a child of the shell and holds the web port: if it lingers,
# the new instance would exit immediately with a bind error.
Stop-Children $ShellPid

if (-not $gone) {
  Write-Log "ABORT: shell did not exit; not starting a second instance"
  try { (New-Object -ComObject WScript.Shell).Popup("DSH was closed but could not be restarted automatically. Please start DSH manually.", 0, "dsh-hot-restart", 48) } catch { }
  exit 3
}

# 3) let file locks and the listening socket settle
Start-Sleep -Milliseconds 600
$free = Wait-PortFree $Port 25
Write-Log ("port free: {0}" -f $free)

# 3b) still busy: stop the leftover of our own stack that holds the port
if (-not $free) {
  $owner = Get-PortOwner $Port
  Write-Log ("port still busy; owner pid={0}" -f $owner)
  if (Test-OurStack $owner) {
    try { Stop-Process -Id $owner -Force -ErrorAction Stop; Write-Log ("terminated port holder {0}" -f $owner) } catch { Write-Log ("stopping port holder failed: {0}" -f $_.Exception.Message) }
    $free = Wait-PortFree $Port 10
    Write-Log ("port free after stopping owner: {0}" -f $free)
  }
}

# 4) relaunch
#    Use WMI so the new DSH inherits NO console. Plain Start-Process would hand it this
#    process's console, and on Windows 11 that console is hosted by Windows Terminal -
#    closing that window would then kill DSH.
$workDir = Split-Path -Parent $ExePath
Write-Log ("launching: {0} (cwd {1})" -f $ExePath, $workDir)
$launched = $false
for ($attempt = 1; $attempt -le 4 -and -not $launched; $attempt++) {
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
  if (-not $launched) { Start-Sleep -Milliseconds 700 }
}

# 5) verify it actually came up, then try the last resort and finally tell the user
if ($launched -and (Wait-Instance 20)) {
  Write-Log "new instance is up"
  exit 0
}
Write-Log "not up yet; trying Start-Process fallback"
try {
  Start-Process -FilePath $ExePath -WorkingDirectory $workDir
  if (Wait-Instance 15) {
    Write-Log "new instance is up after Start-Process"
    exit 0
  }
} catch {
  Write-Log ("fallback Start-Process failed: {0}" -f $_.Exception.Message)
}

Write-Log "FAILED: could not start DSH automatically"
try { (New-Object -ComObject WScript.Shell).Popup("DSH was closed but could not be restarted automatically. Please start DSH manually.", 0, "dsh-hot-restart", 48) } catch { }
exit 4

