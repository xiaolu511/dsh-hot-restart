# ============================================================================
# dsh-hot-restart :: 自检 / 诊断
# ----------------------------------------------------------------------------
# 目的：用户双击一次，产出一份**自包含**的诊断报告。作者拿到这一个文件，
#       不需要再问任何东西，就能判断「为什么这个按钮不好使 / 为什么 DSH 起不来」。
#
# 设计原则
#   1) 绝无副作用：不关 DSH、不重启、不杀进程、不动别人的文件。
#      需要验证「能不能派发进程」时，只创建临时目录里的一次性探针脚本，
#      写一个标记文件就退出，全程不接触 DSH。
#   2) 全程只读 + 探测，最坏情况也只是某个探针超时失败，报告照出。
#   3) 报告里先给「结论速览」，再给原始证据，最后附完整日志。
#
# 用法：双击 tools\diagnose.cmd（推荐），或
#       powershell -NoProfile -ExecutionPolicy Bypass -File tools\diagnose.ps1
#
# ⚠️ 本文件必须保存为 **UTF-8 带 BOM**：Windows PowerShell 5.1 读无 BOM 的 .ps1
#    会按 ANSI 解码，里面的中文会变成乱码（这是踩过的坑）。
# ============================================================================
[CmdletBinding()]
param(
  [string]$OutDir = [Environment]::GetFolderPath('Desktop'),
  [int]$ProbeTimeoutSec = 10,
  # 谁触发的这次自检：user-request / previous-startup-failed / restart-refused …
  # 手动双击 tools\diagnose.cmd 时不带这个参数，就是 manual —— 页面据此决定要不要
  # 弹「报告已生成」。手工测试的报告不该每次都推到用户脸上。
  [string]$Trigger = 'manual'
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$report = New-Object System.Collections.Generic.List[string]
$work = Join-Path $env:TEMP ('dsh-hr-diag-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Line([string]$text = '') { $script:report.Add($text) }
# 运行轨迹：被「隐藏窗口」启动时如果中途死掉，主报告是空的 —— 只有这条轨迹能定位死在哪一步。
# 它落在插件状态目录里，跟前缀 restart.log 放一起，方便远程判断。
$script:traceFile = Join-Path $env:USERPROFILE '.dsh\hot-restart\diagnose-run.log'
function Trace([string]$step) {
  try {
    $dir = Split-Path -Parent $script:traceFile
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $script:traceFile -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $step) -Encoding UTF8
  } catch { }
}
Trace ("start pid=$PID outDir=$OutDir runspace=$($PSVersionTable.PSVersion)")
function Head([string]$title) {
  Line ''
  Line ('-' * 76)
  Line "== $title"
  Line ('-' * 76)
}
function Mark([bool]$ok, [string]$label, [string]$detail = '') {
  $flag = if ($ok) { '[ OK ]' } else { '[FAIL]' }
  $suffix = if ($detail) { "   <- $detail" } else { '' }
  Line ("$flag $label$suffix")
}
function Note([string]$label, $value) {
  Line ("       {0,-22} {1}" -f $label, $(if ($null -eq $value) { '(空)' } else { [string]$value }))
}
function Say([string]$text) { Write-Host $text }

# ---------------------------------------------------------------- 结论速览 ----
$verdicts = New-Object System.Collections.Generic.List[string]
function Verdict([string]$text) { $script:verdicts.Add($text) }

Write-Host ''
Write-Host 'dsh-hot-restart 自检开始 —— 全程只读，不会关闭或重启 DSH' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------- 环境 ----
Say '[1/8] 环境'
Head '一、环境'
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $cs = Get-CimInstance Win32_ComputerSystem
  Note '采集时间' (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
  Note '计算机' $env:COMPUTERNAME
  Note '用户' "$env:USERDOMAIN\$env:USERNAME"
  Note 'Windows' ("{0} build {1}" -f $os.Caption, $os.BuildNumber)
  Note '架构' ("OS={0} 进程={1}" -f $os.OSArchitecture, $env:PROCESSOR_ARCHITECTURE)
  Note '控制台代码页' (chcp)
  Note '区域' (Get-Culture).Name
  Note '是否管理员' ([bool](New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
  Note 'USERPROFILE' $env:USERPROFILE
  Note 'DSH_HOME' $(if ($env:DSH_HOME) { $env:DSH_HOME } else { '(未设置)' })
  $nonAscii = [bool]($env:USERPROFILE -match '[^\x00-\x7F]')
  Note '路径含非 ASCII' $nonAscii
  if ($nonAscii) { Verdict '注意：用户目录含非 ASCII 字符，PowerShell 输出编码/pnpm 路径都要留意（历史上踩过）' }
  Note 'TEMP' $env:TEMP
  Note 'PowerShell' $PSVersionTable.PSVersion.ToString()
  Note '报告输出目录' $OutDir
} catch { Line "  环境采集出错: $($_.Exception.Message)" }

# ---------------------------------------------------------------- DSH 进程 ----
Say '[2/8] DSH 进程'
Head '二、DSH 进程'
$appPattern = 'dsh|harness|deepseek'
$procs = @()
try {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -and $_.Name -match $appPattern
  })
} catch { Line "  进程枚举出错: $($_.Exception.Message)" }
Note '匹配到的进程数' $procs.Count
$shellCandidates = @()
foreach ($p in $procs) {
  $isChild = $p.CommandLine -and ($p.CommandLine -match '--type=')
  Line ("  pid={0,-7} ppid={1,-7} {2}" -f $p.ProcessId, $p.ParentProcessId, $p.Name)
  Note '    exe' $p.ExecutablePath
  Note '    命令行' $p.CommandLine
  Note '    启动时间' $p.CreationDate
  Note '    内存' ("{0:N0} KB" -f ($p.WorkingSetSize / 1KB))
  Note '    子进程角色' $(if ($isChild) { '是（--type=，渲染/GPU/工具进程）' } else { '否' })
  if (-not $isChild -and $p.CommandLine -and $p.CommandLine -notmatch 'dsh-desktop-host' -and $p.CommandLine -notmatch '--expose-internals') {
    $shellCandidates += $p
  }
}
if ($shellCandidates.Count -eq 0) {
  Verdict '没有找到 DSH 外壳进程：DSH 当前没在运行（那按钮也点不了）'
} else {
  $shell = $shellCandidates | Select-Object -First 1
  Verdict ("识别到 DSH 外壳 pid={0}（{1}）" -f $shell.ProcessId, $shell.Name)
  Note '外壳命令行' $shell.CommandLine
  if ($shell.CommandLine -match '--no-sandbox' -or $shell.CommandLine -match 'compat') {
    Verdict '注意：DSH 以 --no-sandbox / 兼容模式启动，历史上怀疑这种受限启动会影响派发出去的助手进程'
  }
}
# 残留宿主：父进程已不在的 dsh-desktop-host
$hosts = @($procs | Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh-desktop-host' })
Note '宿主(dsh-desktop-host)进程数' $hosts.Count
foreach ($h in $hosts) {
  $parentAlive = Get-Process -Id $h.ParentProcessId -ErrorAction SilentlyContinue
  Note "  宿主 pid=$($h.ProcessId) 的父进程" $(if ($parentAlive) { "存活 pid=$($h.ParentProcessId)" } else { "已死 pid=$($h.ParentProcessId) —— 残留宿主！" })
  if (-not $parentAlive) { Verdict "存在残留宿主进程 pid=$($h.ProcessId)（父进程已死）：它会占着 web 端口，让新实例起来即退出" }
}

# ---------------------------------------------------------------- 插件状态 ----
Say '[3/8] 插件安装状态'
Head '三、插件安装状态'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$pluginDir = Join-Path $profileDir 'node_modules\dsh-hot-restart'
$stateDir = Join-Path $env:USERPROFILE '.dsh\hot-restart'
Note 'profile 目录' $profileDir
Note '插件目录' $pluginDir
Note '插件是否安装' (Test-Path $pluginDir)
try {
  $profPkg = Get-Content (Join-Path $profileDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Note '依赖写法' $profPkg.dependencies.'dsh-hot-restart'
  Note 'bundle 已启用' ([bool]($profPkg.dsh.profile.bundles -contains 'dsh-hot-restart'))
} catch { Line "  读取 profile package.json 失败: $($_.Exception.Message)" }
try {
  $pkg = Get-Content (Join-Path $pluginDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Note '磁盘上的版本' $pkg.version
} catch { Line "  读取插件 package.json 失败: $($_.Exception.Message)" }
Line ''
Line '  关键文件与哈希（用于判断安装是否被截断/篡改）：'
foreach ($rel in @('cordis.patch.yml','lib\index.js','lib\ui.js','lib\relaunch.vbs','lib\relaunch.ps1','tools\restart-dsh.vbs','tools\restart-dsh.cmd','package.json')) {
  $full = Join-Path $pluginDir $rel
  if (Test-Path $full) {
    $item = Get-Item $full
    $hash = (Get-FileHash $full -Algorithm SHA256).Hash.Substring(0, 16)
    Line ("    [ OK ] {0,-26} {1,8:N0} 字节  sha256:{2}…  改于 {3}" -f $rel, $item.Length, $hash, $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
  } else {
    Line ("    [FAIL] {0,-26} 缺失" -f $rel)
    Verdict "插件文件缺失：$rel（安装不完整，建议重装）"
  }
}
Line ''
Line '  插件状态目录 %USERPROFILE%\.dsh\hot-restart：'
if (Test-Path $stateDir) {
  Get-ChildItem $stateDir -Force | ForEach-Object { Line ("    {0,-26} {1,10:N0} 字节  改于 {2}" -f $_.Name, $_.Length, $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')) }
} else { Line '    (不存在)' }
$logPath = Join-Path $stateDir 'restart.log'
$ticketPath = Join-Path $stateDir 'restart-ticket.json'
if (Test-Path $ticketPath) {
  $t = Get-Item $ticketPath
  Note '重启凭据残留' ("{0}（改于 {1}）" -f $ticketPath, $t.LastWriteTime)
  Verdict '存在 restart-ticket.json：如果它不是刚刚写的，说明上一次重启可能被中断（新版助手会因凭据过期而拒绝动手，这是保护）'
} else { Note '重启凭据残留' '无（正常）' }

# ---------------------------------------------------------------- 能力矩阵 ----
Say '[4/8] 派发能力矩阵（关键）'
Trace 'matrix start'
Head '四、派发能力矩阵'
Line '  说明：这几条探针只创建临时目录里的一次性脚本，写个标记文件就退出，不接触 DSH。'
Line '  它们回答的是「这台机器上，哪条把助手送出去的通道真的能用」。'
Line ''

function New-Probe {
  param([string]$Name)
  $marker = Join-Path $script:work "$Name.marker"
  $scriptFile = Join-Path $script:work "$Name.vbs"
  $content = 'CreateObject("Scripting.FileSystemObject").CreateTextFile("' + $marker + '", True).WriteLine "' + $Name + ' ok"'
  Set-Content -LiteralPath $scriptFile -Value $content -Encoding ASCII
  return [pscustomobject]@{ Name = $Name; Marker = $marker; Script = $scriptFile }
}

function Wait-Marker {
  param([string]$Path, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $Path) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return (Test-Path -LiteralPath $Path)
}

# 经 WMI 派发一个探针，并把三件事分开报：进程创建了没有 / 它后来还活着吗 / 脚本产出没有。
# 分不清这三者，就会把「创建了但不干活」误判成别的毛病（第一版就吃过这个亏）。
function Probe-ViaWmi {
  param([string]$Label, [string]$CommandLine, [string]$Marker, [string]$Alias)
  try {
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $CommandLine }
    Note 'Win32_Process.Create 返回' ("ReturnValue={0}  pid={1}" -f $r.ReturnValue, $r.ProcessId)
    $createdPid = [int]$r.ProcessId
    Start-Sleep -Seconds 2
    $aliveEarly = $null -ne (Get-Process -Id $createdPid -ErrorAction SilentlyContinue)
    Note '创建后 2 秒进程是否还在' $(if ($aliveEarly) { '在' } else { '已经不在了' })
    $ok = Wait-Marker $Marker $ProbeTimeoutSec
    $aliveLate = $null -ne (Get-Process -Id $createdPid -ErrorAction SilentlyContinue)
    Note '等待结束时进程是否还在' $(if ($aliveLate) { '在' } else { '已退出' })
    Mark $ok $Label $(if ($ok) { '创建成功且脚本真的执行了' } else { "创建成功但脚本没产出（2 秒时进程$(if ($aliveEarly) { '还在' } else { '已消失' })）" })
    if (-not $ok) {
      if ($aliveEarly) {
        Verdict "$Alias：进程被创建、也活着，但脚本从不产出 —— 像是它的运行环境（控制台/会话）没建起来"
      } else {
        Verdict "$Alias：进程被创建后立刻消失 —— 像是脚本宿主被安全策略挡住了"
      }
    }
    return $ok
  } catch {
    Mark $false $Label $_.Exception.Message
    return $false
  }
}

$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Note 'wscript.exe' $(if (Test-Path $wscriptExe) { "存在 $wscriptExe" } else { '不存在！' })
Note 'powershell.exe' $(if (Test-Path $psExe) { "存在 $psExe" } else { '不存在！' })
Note 'explorer.exe' $(if (Test-Path (Join-Path $env:SystemRoot 'explorer.exe')) { '存在' } else { '不存在！' })

# 1) 直接跑 wscript
Line ''
Line '  ① 直接运行 wscript 脚本（用户双击时的路径）'
$p1 = New-Probe 'direct-wscript'
try {
  Start-Process -FilePath $wscriptExe -ArgumentList @('//B', $p1.Script) -Wait -WindowStyle Hidden
  $ok = Wait-Marker $p1.Marker 3
  Mark $ok 'wscript 直接执行' $(if ($ok) { '写出标记，正常' } else { '脚本没写出标记 —— WSH 可能被策略/杀软拦住' })
  if (-not $ok) { Verdict 'wscript 直接执行失败：脚本宿主被拦住，插件的零窗口助手在首选路径上就跑不起来' }
} catch { Mark $false 'wscript 直接执行' $_.Exception.Message }

# 2) 经 WMI 派发 wscript（插件首选路径）
Line ''
Line '  ② 经 WMI 创建 wscript（插件的首选派发路径，能跳出 DSH 的 Job）'
$p2 = New-Probe 'wmi-wscript'
Probe-ViaWmi -Label 'WMI + wscript' -Marker $p2.Marker -Alias 'WMI + wscript' `
  -CommandLine ('"{0}" //B "{1}"' -f $wscriptExe, $p2.Script) | Out-Null

# 3) 经 Explorer 派发（插件备用路径）
Line ''
Line '  ③ 经 Explorer 打开脚本（插件备用派发路径，绕开 WMI）'
$p3 = New-Probe 'explorer-wscript'
try {
  Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList @($p3.Script)
  $ok = Wait-Marker $p3.Marker ($ProbeTimeoutSec + 5)
  Mark $ok 'Explorer + wscript' $(if ($ok) { '脚本跑起来了，这条备用路可用' } else { '没产出标记，这条备用路也不通' })
} catch { Mark $false 'Explorer + wscript' $_.Exception.Message }

# 4) 直接跑 PowerShell
Line ''
Line '  ④ 直接运行 PowerShell（兜底助手用的宿主）'
$p4 = New-Probe 'direct-ps'
try {
  Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', ('Set-Content -LiteralPath ''' + $p4.Marker + ''' -Value ''direct-ps ok'' -Encoding ASCII')) -Wait -WindowStyle Hidden
  $ok = Wait-Marker $p4.Marker 5
  Mark $ok 'PowerShell 直接执行' $(if ($ok) { '正常' } else { '没写出标记 —— PowerShell 可能被策略拦住' })
  if (-not $ok) { Verdict 'PowerShell 直接执行失败：兜底助手也用不了' }
} catch { Mark $false 'PowerShell 直接执行' $_.Exception.Message }

# 5) 经 WMI 派发 PowerShell
Line ''
Line '  ⑤ 经 WMI 创建 PowerShell（兜底助手的派发方式）'
$p5 = New-Probe 'wmi-ps'
# 用 -File 指向临时 ps1，而不是把带引号的 -Command 塞进 WMI 命令行：
# 引号嵌套一旦写错就会得到「创建了却不干活」的假故障（本工具第一版就这么骗过我一次）。
$p5Script = Join-Path $work 'wmi-ps-probe.ps1'
Set-Content -LiteralPath $p5Script -Encoding ASCII -Value ("Set-Content -LiteralPath '{0}' -Value 'wmi-ps ok' -Encoding ASCII" -f $p5.Marker)
Probe-ViaWmi -Label 'WMI + PowerShell' -Marker $p5.Marker -Alias 'WMI + PowerShell' `
  -CommandLine ('"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}"' -f $psExe, $p5Script) | Out-Null

# ---------------------------------------------------------------- 阻塞项 ----
Say '[5/8] 启动阻塞项排查'
Head '五、启动阻塞项（DSH 自身）'
# 数据目录随构建而异：官方桌面版是 %APPDATA%\DSH Desktop，
# 而 Electron 的 user-data-dir 也可能落在 %APPDATA%\@deepseek-ai\dsh-desktop。
# 两处都要找，否则会给出「没有市场锁」这种误导性的结论。
$dataRoots = @()
foreach ($cand in @(
    (Join-Path $env:APPDATA 'DSH Desktop'),
    (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop'),
    (Join-Path $env:APPDATA '@deepseek-ai\DSH Desktop'),
    (Join-Path $env:LOCALAPPDATA 'DSH Desktop'),
    (Join-Path $env:LOCALAPPDATA '@deepseek-ai\dsh-desktop')
  )) {
  if ((Test-Path $cand) -and ($dataRoots -notcontains $cand)) { $dataRoots += $cand }
}
if ($dataRoots.Count -eq 0) { Line '  (没找到 DSH 数据目录，市场锁与日志都无法检查)' }
foreach ($root in $dataRoots) { Note 'DSH 数据目录' $root }

$lockFiles = @()
foreach ($root in $dataRoots) {
  $marketDir = Join-Path $root 'desktop-market'
  if (Test-Path $marketDir) {
    Line ''
    Line "  desktop-market 内容（$marketDir）"
    Get-ChildItem $marketDir -Force | ForEach-Object { Line ("    {0,-28} {1,10:N0} 字节  改于 {2}" -f $_.Name, $_.Length, $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')) }
    $lockFiles += @(Get-ChildItem $marketDir -Filter '*.lock' -File -Force -ErrorAction SilentlyContinue)
  }
}
if ($lockFiles.Count -eq 0) {
  Mark $true '市场锁 *.lock' '没有发现（正常）'
  Verdict '没有发现市场锁阻塞'
} else {
  foreach ($lockFile in $lockFiles) {
    $lockItem = Get-Item $lockFile.FullName
    $lockText = ''
    try { $lockText = (Get-Content $lockFile.FullName -Raw -ErrorAction Stop).Trim() } catch { }
    Line ''
    Line "  ⚠ 发现写锁 $($lockFile.FullName) —— DSH 启动写 market 选择时会先抢它"
    Note '锁文件内容' $lockText
    Note '锁文件修改时间' $lockItem.LastWriteTime
    $lockPid = 0
    if ([int]::TryParse(($lockText -split '\s+')[0], [ref]$lockPid) -and $lockPid -gt 0) {
      $holder = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
      if ($holder) {
        Note '持锁进程' ("pid={0} {1}  启动于 {2}" -f $holder.Id, $holder.ProcessName, $holder.StartTime)
        $holderIsDsh = $holder.ProcessName -match $appPattern
        Mark (-not $holderIsDsh) '锁的持有者' $(if ($holderIsDsh) { '是 DSH 自己的进程（正常，正在写状态）' } else { "是无关进程 $($holder.ProcessName)：PID 被复用，这把锁永远不会自己释放" })
        if (-not $holderIsDsh) { Verdict "市场锁被无关进程 pid=$lockPid ($($holder.ProcessName)) 占着：DSH 每次启动都会等锁超时进恢复模式。停掉所有 DSH 后删除 $($lockFile.FullName) 即可恢复" }
      } else {
        Note '持锁进程' "pid=$lockPid 已不存在"
        Mark $true '锁的持有者' '记录里的 PID 已经退出，DSH 下次启动应当能自行接管（若仍报超时再看别的）'
      }
    } else {
      Verdict "锁文件内容不可解析，可能需要人工删除：$($lockFile.FullName)"
    }
  }
}

Line ''
Line '  DSH 日志（找「上次没正常退出」与崩溃线索）'
$logCandidates = @()
foreach ($root in $dataRoots) {
  foreach ($dir in @((Join-Path $root 'logs'), $root)) {
    if (Test-Path $dir) {
      $logCandidates += @(Get-ChildItem $dir -Filter 'dsh-*.log' -File -ErrorAction SilentlyContinue)
      $logCandidates += @(Get-ChildItem $dir -Filter 'dsh-*.error.log' -File -ErrorAction SilentlyContinue)
    }
  }
}
$logCandidates = @($logCandidates | Sort-Object FullName -Unique)
if ($logCandidates.Count -eq 0) {
  Line '    (没找到 dsh-*.log，可用 DSH 恢复模式里的「诊断」导出更完整的数据)'
} else {
  foreach ($f in ($logCandidates | Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
    Line ''
    Line ("    --- {0}（{1:N0} 字节，改于 {2}）最后 30 行 ---" -f $f.FullName, $f.Length, $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
    try { Get-Content $f.FullName -Tail 30 -ErrorAction Stop | ForEach-Object { Line ("    | " + $_) } } catch { Line "    (读取失败: $($_.Exception.Message))" }
  }
  $unclean = @($logCandidates | ForEach-Object { Select-String -Path $_.FullName -Pattern 'did not shut down cleanly' -ErrorAction SilentlyContinue })
  Note '「上次没正常退出」出现次数' $unclean.Count
  if ($unclean.Count -ge 3) { Verdict "日志里有 $($unclean.Count) 次非正常退出：说明 DSH 被反复硬杀过，市场锁很可能就是这么留下的" }
  $gpu = @($logCandidates | ForEach-Object { Select-String -Path $_.FullName -Pattern 'child process gone.*GPU' -ErrorAction SilentlyContinue })
  Note 'GPU 子进程崩溃次数' $gpu.Count
  if ($gpu.Count -gt 0) { Verdict "GPU 子进程崩溃 $($gpu.Count) 次（DSH 自身问题，与插件无关，但会让『打不开』更乱）" }
}

Line ''
Line '  崩溃转储 / 恢复模式证据'
$crashDirs = @()
foreach ($root in $dataRoots) {
  $crashDirs += @((Join-Path $root 'crash-dumps'), (Join-Path $root 'Crashpad'), (Join-Path $root 'crash-dumps\reports'))
}
$dumps = @()
foreach ($d in $crashDirs) { if (Test-Path $d) { $dumps += @(Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue) } }
Note '崩溃转储数量' $dumps.Count
foreach ($d in ($dumps | Sort-Object LastWriteTime -Descending | Select-Object -First 5)) {
  Line ("    {0}  {1:N0} 字节  {2}" -f $d.Name, $d.Length, $d.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
}
$lifecycleDirs = @()
foreach ($root in $dataRoots) {
  $cand = Join-Path $root 'lifecycle-events'
  if (Test-Path $cand) { $lifecycleDirs += $cand }
}
if ($lifecycleDirs.Count -eq 0) { Line '    (没有 lifecycle-events 目录)' }
foreach ($lifecycle in $lifecycleDirs) {
  Line ''
  Line "  最近一次启动的阶段记录（$lifecycle）"
  $summaryFile = Join-Path $lifecycle 'summary.json'
  if (Test-Path $summaryFile) {
    try {
      $summary = Get-Content $summaryFile -Raw -Encoding UTF8 | ConvertFrom-Json
      Note '结果' $summary.finalOutcome
      Note '停在阶段' $summary.finalStage
      Note '总耗时' ("{0:N0} ms" -f $summary.totalDurationMs)
      foreach ($s in $summary.stages) { Note ("  阶段 $($s.stageId)") ("{0} / {1:N0} ms" -f $s.status, $s.durationMs) }
      if ($summary.finalStage -eq 'profile-composition') { Verdict '上次启动停在 profile-composition：插件加载与配置组合阶段，既可能是插件，也可能是市场锁，请对照上面两条结论' }
      if ($summary.finalOutcome -eq 'failed') { Verdict "上次启动是失败的（停在 $($summary.finalStage)）—— 用户说的『打不开』多半就是这个" }
    } catch { Line "    (解析失败: $($_.Exception.Message))" }
  } else { Line '    (没有 summary.json)' }
  $startupLog = Join-Path $lifecycle 'startup.jsonl'
  if (Test-Path $startupLog) {
    Line '    最近启动事件：'
    try { Get-Content $startupLog -Tail 12 -ErrorAction Stop | ForEach-Object { Line ("    | " + $_) } } catch { }
  }
}

# ---------------------------------------------------------------- 端口 ----
Say '[6/8] 端口与网络'
Head '六、web 端口'
$dshListeners = @()
$allListen = @()
try {
  $allListen = @(Get-CimInstance MSFT_NetTCPConnection -Namespace root\StandardCimv2 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 2 })
  foreach ($c in $allListen) {
    $owner = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $c.OwningProcess) -ErrorAction SilentlyContinue
    if ($owner -and ($owner.Name -match $appPattern -or ($owner.CommandLine -and $owner.CommandLine -match 'dsh-desktop-host'))) {
      $dshListeners += [pscustomobject]@{ Port = $c.LocalPort; Pid = $c.OwningProcess; Name = $owner.Name }
    }
  }
  if ($dshListeners.Count -eq 0) { Line '  没有 DSH 相关的监听端口（DSH 可能在跑但宿主还没起来）' }
  foreach ($l in $dshListeners) { Line ("  监听 {0,-6} pid={1}  {2}" -f $l.Port, $l.Pid, $l.Name) }
} catch { Line "  端口枚举出错: $($_.Exception.Message)" }

# ---------------------------------------------------------------- 路由 ----
Say '[7/8] 插件路由'
Head '七、插件本地路由'
# 只探 DSH 自己监听的端口：全量扫会去连一堆无关端口，每个卡 3 秒，纯浪费。
$checkPorts = @()
foreach ($l in $dshListeners) { if ($checkPorts -notcontains $l.Port) { $checkPorts += $l.Port } }
if ($checkPorts -notcontains 19387) { $checkPorts += 19387 }
if ($checkPorts -notcontains 43120) { $checkPorts += 43120 }
foreach ($port in $checkPorts) {
  foreach ($path in @('/dsh-hot-restart/status.json', '/dsh-hot-restart/ui.js')) {
    $url = "http://127.0.0.1:$port$path"
    try {
      $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      Line ("  {0,-44} HTTP {1}" -f $url, $resp.StatusCode)
      if ($path -like '*status.json*') { Line ("      正文: " + $resp.Content) }
    } catch {
      $code = $null
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      Line ("  {0,-44} {1}" -f $url, $(if ($code) { "HTTP $code（401/403 = 路由在，但被宿主信任栅栏挡着，属正常）" } else { "不可达（$($_.Exception.Message)）" }))
    }
  }
}

# ---------------------------------------------------------------- 日志全文 ----
Say '[8/8] 汇总并写出报告'
Head '八、插件完整日志 restart.log'
if (Test-Path $logPath) {
  $logItem = Get-Item $logPath
  Note '日志大小' ("{0:N0} 字节" -f $logItem.Length)
  Note '最后修改' $logItem.LastWriteTime
  Line ''
  try {
    Get-Content $logPath -ErrorAction Stop | ForEach-Object { Line ("| " + $_) }
  } catch { Line "  (读取失败: $($_.Exception.Message))" }
} else {
  Line '  (没有 restart.log，插件可能从未成功加载过)'
  Verdict '没有 restart.log：插件从未在宿主里成功挂载过（安装后没重启，或加载即失败）'
}

# ---------------------------------------------------------------- 出报告 ----
$envBlock = @()
$envBlock += 'dsh-hot-restart 诊断报告'
$envBlock += "生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
$envBlock += "报告版本: 自检 v3（对应插件 0.3.11 时代的能力矩阵）"
$envBlock += ''
$envBlock += '=' * 76
$envBlock += '结论速览（先看这一段）'
$envBlock += '=' * 76
if ($verdicts.Count -eq 0) { $envBlock += '(没有发现明显异常 —— 把下面原始证据一起发来即可)' }
foreach ($v in $verdicts) { $envBlock += "  · $v" }
$envBlock += ''
$envBlock += '阅读提示：'
$envBlock += '  [ OK ] = 这一项没问题；[FAIL] = 这一项不通过，通常就是症结'
$envBlock += '  「派发能力矩阵」五条探针决定按钮能不能真正重启 DSH：'
$envBlock += '     ① wscript 直接执行（用户双击 / 手动救急路径）'
$envBlock += '     ② WMI + wscript（插件首选）③ Explorer + wscript（插件备用）'
$envBlock += '     ④ PowerShell 直接执行　⑤ WMI + PowerShell（兜底助手的两条路）'
$envBlock += '  每条都分开报「进程创建了没有 / 它后来活没活着 / 脚本有没有产出」。'
$envBlock += '  报告本身不含隐私敏感内容，但会包含本机路径、进程命令行与插件日志。'

$outFile = Join-Path $OutDir ("dsh-hot-restart-诊断报告-$stamp.txt")
Trace 'writing report'
$all = @($envBlock) + @($script:report)
try {
  if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
  Set-Content -LiteralPath $outFile -Value $all -Encoding UTF8
  Write-Host ''
  Write-Host "报告已写出：$outFile" -ForegroundColor Green
} catch {
  $outFile = Join-Path $env:TEMP ("dsh-hot-restart-诊断报告-$stamp.txt")
  Set-Content -LiteralPath $outFile -Value $all -Encoding UTF8
  Write-Host "指定目录写不进去，已改写到：$outFile" -ForegroundColor Yellow
}

# 把报告路径记到一个固定的小文件里：页面和重启助手都靠它告诉用户「文件在哪」。
# 第一行是路径，第二行是触发来源（页面据此决定要不要弹提示：manual 的不弹）。
try {
  $pointerDir = Join-Path $env:USERPROFILE '.dsh\hot-restart'
  if (-not (Test-Path -LiteralPath $pointerDir)) { New-Item -ItemType Directory -Force -Path $pointerDir | Out-Null }
  Set-Content -LiteralPath (Join-Path $pointerDir 'last-report.txt') -Value @($outFile, $Trigger) -Encoding UTF8
} catch { }
Write-Host ''
Write-Host "报告位置会显示在 DSH 页面上，也可以直接看这个文件：" -ForegroundColor Cyan
Write-Host "  $outFile" -ForegroundColor Cyan

# 清理探针临时目录
try { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue } catch { }

Write-Host ''
Write-Host '结论速览：' -ForegroundColor Cyan
foreach ($v in $verdicts) { Write-Host "  · $v" }
Write-Host ''
Write-Host '把这个 txt 文件整个发出去就行，不需要再跑别的东西。' -ForegroundColor Cyan
try { Start-Process -FilePath 'notepad.exe' -ArgumentList @($outFile) } catch { }
