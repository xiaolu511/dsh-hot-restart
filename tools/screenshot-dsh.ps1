# ============================================================================
# dsh-hot-restart :: 截 DSH 窗口 / 屏幕，给市场详情页和宣传用
# ----------------------------------------------------------------------------
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File tools\screenshot-dsh.ps1 -Region button
#   powershell -ExecutionPolicy Bypass -File tools\screenshot-dsh.ps1 -Region window -Out assets\shot.png
#
# -Region button  右下角那块（按钮所在，不带中间对话内容）—— 默认
# -Region window 整个 DSH 窗口（PrintWindow，能抓被遮住的窗口）
# -Region full   整屏
#
# 说明：只读屏幕内容，不改动任何东西。截图会存到 assets\ 下。
# ============================================================================
param(
  [ValidateSet('button', 'window', 'full')][string]$Region = 'button',
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshShot {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@ -ReferencedAssemblies System.Drawing

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$assets = Join-Path $repoRoot 'assets'
if (-not (Test-Path -LiteralPath $assets)) { New-Item -ItemType Directory -Force -Path $assets | Out-Null }
if ($Out -eq '') { $Out = Join-Path $assets "screenshot-$Region.png" }

function Save-Cropped($full, $x, $y, $w, $h, $path) {
  $x = [Math]::Max(0, [Math]::Min($x, $full.Width - 1))
  $y = [Math]::Max(0, [Math]::Min($y, $full.Height - 1))
  $w = [Math]::Max(1, [Math]::Min($w, $full.Width - $x))
  $h = [Math]::Max(1, [Math]::Min($h, $full.Height - $y))
  $rect = New-Object System.Drawing.Rectangle $x, $y, $w, $h
  $crop = $full.Clone($rect, $full.PixelFormat)
  $crop.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose()
  Write-Output ("  saved {0}  ({1}x{2})  {3} bytes" -f $path, $w, $h, (Get-Item $path).Length)
}

if ($Region -eq 'window') {
  # 找 DSH 主窗口，用 PrintWindow 抓（被遮住也能抓）
  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $proc) { throw '没有找到带主窗口的 DSH 进程' }
  $hWnd = $proc.MainWindowHandle
  if ([DshShot]::IsIconic($hWnd)) { [void][DshShot]::ShowWindow($hWnd, 9); Start-Sleep -Milliseconds 900 }
  $r = New-Object DshShot+RECT
  [void][DshShot]::GetWindowRect($hWnd, [ref]$r)
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][DshShot]::PrintWindow($hWnd, $hdc, 2)   # 2 = PW_RENDERFULLCONTENT
  $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("  saved {0}  ({1}x{2})  {3} bytes" -f $Out, $w, $h, (Get-Item $Out).Length)
  return
}

# 屏幕抓取（button / full 两种都从这里裁）
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$full = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($screen.X, $screen.Y, 0, 0, $full.Size)
$g.Dispose()

if ($Region -eq 'full') {
  $full.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("  saved {0}  ({1}x{2})  {3} bytes" -f $Out, $screen.Width, $screen.Height, (Get-Item $Out).Length)
} else {
  # 按钮固定在主区域左下角（left ≈ 侧栏宽 + 16、bottom ≈ 58），
  # 这里裁左下角一块：带上按钮和一点输入框做上下文，但**不含中间的对话内容**。
  $cropW = [Math]::Min(840, $screen.Width)
  $cropH = [Math]::Min(240, $screen.Height)
  $x = 0
  $y = $screen.Height - $cropH
  Save-Cropped $full $x $y $cropW $cropH $Out
}
$full.Dispose()
