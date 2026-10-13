# ============================================================================
# dsh-hot-restart :: show the DSH window once its page is actually ready
# ----------------------------------------------------------------------------
# Measured 2026-10-13 with window-watch3.log (EnumWindows, hidden windows seen):
#
#   13:20:35  new instance starts
#   13:20:36  hwnd=788018 HIDDEN title=[DeepSeek Harness]   <- window exists, hidden
#   13:20:39  visible title=[DeepSeek Harness]              <- we showed it too early:
#                                                              a blank white window
#   13:20:41  HIDDEN                                        <- the shell hid it again
#   13:20:47  HIDDEN title=[dsh ... - DeepSeek Harness]      <- page finally ready
#   13:20:49  visible (foreground)                           <- only after a tray click
#
# Two lessons went into this version:
#   1. Do NOT show the window as soon as it exists: the page is not painted yet and the
#      user sees a white flash. Wait until the title carries the real page title.
#   2. Showing it once is not enough: the shell hides it again about two seconds later.
#      Keep watching for a while and re-show it whenever it goes back to hidden.
#
# Enumerates top-level windows with EnumWindows: Process.MainWindowHandle is 0 for a
# window that has never been shown, which is exactly the state we deal with here.
#
# ASCII only: PowerShell 5.1 reads BOM-less files as ANSI, and this file has no
# non-ASCII content to lose.
# ============================================================================
param(
  [int]$ReadyTimeoutSec = 45,
  [int]$HoldSec = 12,
  [string]$ProcessName = 'DeepSeek Harness'
)

$ErrorActionPreference = 'Continue'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class DshShow {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  private static List<IntPtr> _found;
  private static uint[] _pids;
  private static bool _wantReady;
  public static List<IntPtr> Find(uint[] pids, bool wantReady) {
    _found = new List<IntPtr>();
    _pids = pids;
    _wantReady = wantReady;
    EnumWindows(new EnumProc(Collect), IntPtr.Zero);
    return _found;
  }
  private static bool Collect(IntPtr h, IntPtr p) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    bool match = false;
    for (int i = 0; i < _pids.Length; i++) { if (_pids[i] == pid) { match = true; break; } }
    if (!match) { return true; }
    StringBuilder cls = new StringBuilder(256);
    GetClassNameW(h, cls, 256);
    // The shell's main window class. Tray host, IME and message-only windows differ.
    if (!cls.ToString().StartsWith("Chrome_WidgetWin_1")) { return true; }
    StringBuilder title = new StringBuilder(256);
    GetWindowTextW(h, title, 256);
    string t = title.ToString();
    if (_wantReady) {
      // Not ready while the title is empty or still the placeholder.
      if (t.Length == 0) { return true; }
      if (t == "DeepSeek Harness") { return true; }
    }
    _found.Add(h);
    return true;
  }
}
'@

$HWND_TOP = [IntPtr]::Zero
$SWP_NOMOVE = 0x0002
$SWP_NOSIZE = 0x0001
$SWP_SHOWWINDOW = 0x0040
$SW_SHOW = 5
$SW_RESTORE = 9

function DshMainWindow([bool]$readyOnly) {
  $pids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  if ($pids.Count -eq 0) { return $null }
  $hits = @([DshShow]::Find($pids, $readyOnly))
  if ($hits.Count -eq 0) { return $null }
  return $hits[0]
}

# 1) Wait until the page is actually painted (real title) before showing the window.
#    The blank stretch is covered by wait-panel.ps1 - our own little "restarting" window,
#    which the shell knows nothing about and therefore cannot hide. Showing the DSH window
#    early instead produced a white frame that the shell hid again two seconds later: the
#    flash the user complained about.
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
$hwnd = $null
while ((Get-Date) -lt $deadline) {
  $hwnd = DshMainWindow $true
  if ($null -ne $hwnd) { break }
  Start-Sleep -Milliseconds 300
}
if ($null -eq $hwnd) {
  # The page never announced itself; fall back to whatever main window exists so the user
  # is not left with nothing at all.
  $hwnd = DshMainWindow $false
  if ($null -eq $hwnd) { exit 1 }
}

# 2) Show it and keep it shown: the shell hides it again about two seconds later.
#    If the user minimises it themselves (IsIconic), stop - that is their choice, not ours.
$holdUntil = (Get-Date).AddSeconds($HoldSec)
$shownOnce = $false
while ((Get-Date) -lt $holdUntil) {
  $current = DshMainWindow $false
  if ($null -ne $current) {
    $hwnd = $current
    if ([DshShow]::IsIconic($hwnd)) { break }
    if (-not [DshShow]::IsWindowVisible($hwnd)) {
      [void][DshShow]::ShowWindow($hwnd, $SW_RESTORE)
      [void][DshShow]::ShowWindow($hwnd, $SW_SHOW)
      [void][DshShow]::SetWindowPos($hwnd, $HWND_TOP, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW))
      [DshShow]::SwitchToThisWindow($hwnd, $true)
      $shownOnce = $true
      Start-Sleep -Milliseconds 600
      continue
    }
  }
  Start-Sleep -Milliseconds 400
}
if ($shownOnce) { exit 0 }
exit 1
