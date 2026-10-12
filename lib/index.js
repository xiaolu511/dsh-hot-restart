// ============================================================================
// dsh-hot-restart —— Host half（宿主半区）
// ============================================================================
// 职责只有三件事：
//   ① 往页面注入一个**内联 script 行**（桌面壳唯一有效的注入通道，见下方注释）；
//   ② 提供三条本地路由：状态、重启、客户端脚本本体；
//   ③ 真正执行「热重启」：先派一个**脱离 DSH 进程树**的重启助手（WMI Create），
//      再终结 Electron 外壳进程；助手负责在外壳退出后把 DSH 重新拉起来。
//
// 为什么必须走 WMI 创建助手进程：DSH 的 Tool 子进程与 Host 都在 Windows Job 对象里，
// 外壳一死，Job 内的进程会被一起收走；Win32_Process.Create 由 WmiPrvSE 持父，
// 天然在 Job 之外，才能活到「外壳已退出」之后再去启动新实例。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = '/dsh-hot-restart'
// 「刚重启过」的冷却时间：挡住连点，又不让人干等（主人 2026-10-12 定：5 秒）
const COOLDOWN_MS = 5000
const VERSION = '0.3.16'
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}
const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
)

// —— 桌面壳里的注入通道：结构化行 -------------------------------------------------
// 桌面端 index.html 直接从安装包静态 dist 读盘，`tapIndex` 永远不经过；
// 宿主启动时 `collectIndexInjections()` 把这张表经 IPC 交给渲染层，渲染层按 kind 逐行应用。
// 两种 script 行不对称：`script-src` 加载失败会 reject 掉整个 boot（应用起不来），
// 而 `script` 行是 createElement + textContent + append，也没有 await —— 不会连累宿主。
// 所以这里用**内联行自建 script 标签并吞掉 onerror**：路由在就加载，不在就静默失败。
const INLINE_BOOT_ROW =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="' + BASE + '/ui.js";s.async=true;'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

// —— 小工具 ---------------------------------------------------------------------
// 版本号以**磁盘上的 package.json**为准：模块被 Loader 按 URL 缓存，重装后运行中的
// 旧模块仍可能在跑，读盘能让 status.json / 日志始终报出真正装着的版本。
function installedVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
    if (parsed && typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
  } catch { /* 落到编译期常量 */ }
  return VERSION
}

function dshHome() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : path.join(process.env.HOME || '.', '.dsh'))
  return home
}

let stateDirCache = null
function stateDir() {
  if (stateDirCache !== null) return stateDirCache
  // 单测/自检要能把它指到临时目录，否则会把 mounted 之类写进用户真实的 restart.log
  const override = process.env.DSH_HOT_RESTART_HOME
  const dir = override ? path.resolve(override) : path.join(dshHome(), 'hot-restart')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 只读也不致命，日志降级为丢弃 */ }
  stateDirCache = dir
  return dir
}

// 日志行别太长：父进程命令行可能有几 KB，写进去会淹掉真正有用的记录
function shorten(text, max = 300) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function log(line) {
  try {
    const file = path.join(stateDir(), 'restart.log')
    try {
      const stat = fs.statSync(file)
      if (stat.size > 256 * 1024) fs.writeFileSync(file, '')
    } catch { /* 不存在就新建 */ }
    fs.appendFileSync(file, `${new Date().toISOString()} [dsh-hot-restart] ${line}\n`)
  } catch { /* 日志失败绝不影响主流程 */ }
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function winArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`
}

// ⚠️ PowerShell 5.1 往管道写 stdout 时用的是控制台代码页。路径里带中文时，
// Node 按 UTF-8 解码就得到乱码，后面拿这个路径去 existsSync 会误判成文件不存在
// ——有位用户的 DSH 装在 D:\新建文件夹\ 下，就是这么踩到的。
// 这里统一强制 UTF-8 输出，调用方对含路径的结果再套一层 base64 双保险。
const PS_UTF8_PREFIX = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'

function runPowerShell(script, timeoutMs = 20000) {
  return execFileSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_UTF8_PREFIX + script],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
  )
}

// 查父进程。结果用 base64 送回来，绕开控制台代码页，中文路径能原样还原。
function queryParentProcess(pid) {
  const script = '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + String(Number(pid))
    + '" -ErrorAction SilentlyContinue; if ($p) {'
    + ' $j = $p | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress;'
    + ' [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)) }'
  const raw = String(runPowerShell(script)).trim()
  if (raw === '') return null
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8').trim()
    if (decoded.startsWith('{')) return JSON.parse(decoded)
  } catch { /* 落到下面的直接解析 */ }
  try { return JSON.parse(raw) } catch { return null }
}

// —— 识别「谁是我的外壳」----------------------------------------------------------
// Host 是 Electron 主进程 fork 出来的子进程，process.ppid 就是浏览器进程。
// 但必须 fail-closed：非桌面壳托管（例如 dsh web 跑在终端里）时绝不能去 kill 父进程。
let shellCache
function detectShell() {
  if (shellCache !== undefined) return shellCache
  shellCache = detectShellUncached()
  return shellCache
}

// 探测外壳要同步跑一次 PowerShell（约 1 秒）。**绝不能放在启动路径上** ——
// 挂载时做这件事会把 DSH 自己的启动和页面渲染一起拖慢（主人 2026-10-12 反馈「页面半天不出来」）。
// 改成挂载后空闲时预热一次：真正的请求打进来时缓存已经就绪，点击不用等。
function warmUpShellDetection() {
  const timer = setTimeout(() => {
    try { detectShell() } catch { /* 探测失败不影响任何东西 */ }
  }, 1200)
  if (typeof timer.unref === 'function') timer.unref()
}

// 只认「父进程是 DSH 桌面外壳」这一种情况，其余一律拒绝，绝不乱杀进程。
//
// 历史坑（三个用户报过三种）：
//   ① 早期要求 parent.ExecutablePath === process.execPath，打包方式不同时两者并非同一个，
//      真实的桌面壳被判成 parent-not-shell；
//   ② 又要求宿主 argv 里必须有字面量 `dsh-desktop-host`，但这只是某一份构建的写法，
//      别的 DSH 桌面版（例如 DSH Desktop 2.0.17）根本没有这个标记，直接 not-desktop-host；
//   ③ PowerShell 输出用控制台代码页，中文安装路径变乱码，误判成 shell-exe-missing。
//
// 现在的判据：父进程不是 Electron 的 --type= 子进程、不是控制台/终端，
// 并且 exe 名字像 DSH 应用（或者标记命中且宿主与外壳同一个 exe）。
// 名字不像就拒绝，并把 argv 一起带出去，方便用户回报、我们再补白名单。
const SHELL_NAME_PATTERN = /deepseek|harness|dsh|electron/i
// 各构建的宿主标记写法不一：dsh-desktop-host / --desktop-host / dsh_desktop_host …
const HOST_MARKER_PATTERN = /(?:dsh[-_.]?)?desktop[-_.]?host/i
// 这些父进程一旦被当成外壳就会误杀，必须排除
const CONSOLE_HOST_PATTERN = /^(cmd|conhost|powershell|pwsh|wt|windowsterminal|wsl|bash|sh|zsh|nu|fish|node|python|pythonw|deno|bun|explorer|git|Code|devenv)\.exe$/i

// 纯函数：把「父进程信息 + 宿主信息」判成一个原因码。抽出来是为了能单测，
// 每次用户报「无法热重启」都补一条用例，别再靠猜。
function classifyShellCandidate(parent, host) {
  const name = String((parent && parent.name) || '')
  const exe = String((parent && parent.exe) || '')
  const command = String((parent && parent.command) || '')
  if (/--type=/i.test(command)) return 'parent-is-child-process'
  if (CONSOLE_HOST_PATTERN.test(name)) return 'parent-is-console'
  const hostExe = String((host && host.exe) || '')
  const sameExe = exe !== '' && hostExe !== ''
    && path.resolve(exe).toLowerCase() === path.resolve(hostExe).toLowerCase()
  const looksLikeApp = SHELL_NAME_PATTERN.test(name) || SHELL_NAME_PATTERN.test(exe)
  if (!looksLikeApp && !((host && host.marker) && sameExe)) return 'parent-unrecognized'
  return 'desktop-shell'
}

function detectShellUncached() {
  const detail = {
    platform: process.platform,
    hostPid: process.pid,
    hostPpid: Number(process.ppid) || null,
    hostExe: process.execPath,
    hostArgv: process.argv.join(' '),
    hostMarker: false,
    parentPid: null,
    parentName: null,
    parentExe: null,
    parentCommand: null,
  }
  const unsupported = (reason) => ({ ok: false, reason, ...detail })
  if (process.platform !== 'win32') return unsupported('unsupported-platform')
  detail.hostMarker = process.argv.some(
    (arg) => typeof arg === 'string' && HOST_MARKER_PATTERN.test(arg),
  )
  let parent = null
  try {
    parent = queryParentProcess(Number(process.ppid))
  } catch (error) {
    log(`parent query failed: ${String((error && error.message) || error)}`)
  }
  if (!parent || !Number.isSafeInteger(Number(parent.ProcessId))) return unsupported('parent-unknown')

  detail.parentPid = Number(parent.ProcessId)
  detail.parentName = String(parent.Name || '')
  detail.parentExe = String(parent.ExecutablePath || '')
  detail.parentCommand = String(parent.CommandLine || '')
  detail.parentCreated = String(parent.CreationDate || '')

  const verdict = classifyShellCandidate(
    { name: detail.parentName, exe: detail.parentExe, command: detail.parentCommand },
    { exe: process.execPath, marker: detail.hostMarker },
  )
  if (verdict !== 'desktop-shell') return unsupported(verdict)

  let exePath = detail.parentExe || process.execPath
  // 兜底：父进程路径读出来可能被编码弄坏，而宿主自己的 exe 永远是对的。
  // 两边文件名相同就认定是同一个程序，直接用宿主路径。
  if (!fs.existsSync(exePath) && fs.existsSync(process.execPath)) {
    const hostBase = path.basename(process.execPath).toLowerCase()
    const parentBase = path.basename(detail.parentExe || '').toLowerCase()
    const parentName = String(detail.parentName || '').toLowerCase()
    if (parentBase === '' || parentBase === hostBase || parentName === hostBase) {
      exePath = process.execPath
      detail.exeSource = 'host-exe'
    }
  }
  if (!fs.existsSync(exePath)) return unsupported('shell-exe-missing')

  return {
    ok: true,
    reason: 'desktop-shell',
    ...detail,
    shellPid: detail.parentPid,
    // 外壳的创建时间：PID 会被复用，助手靠「exe 路径 + 创建时间」一起核对身份
    shellCreated: detail.parentCreated || '',
    exePath,
    commandLine: detail.parentCommand || `"${exePath}"`,
  }
}

// —— 热重启 ---------------------------------------------------------------------
let restartRecord = null

function delay(ms) {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); if (typeof timer.unref === 'function') timer.unref() })
}

// 用 WMI 派发一个**没有控制台**的助手（wscript.exe 是 GUI 子系统程序）。
// ⚠️ 不要退回 PowerShell：powershell.exe 是控制台程序，Win11 会把控制台交给 Windows Terminal
// 托管，即便加 -WindowStyle Hidden 也会弹出可见黑窗，被随后启动的 DSH 继承 —— 关掉它就等于杀掉 DSH。
async function spawnHelper(commandLine, label = 'helper') {
  const script = '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '
    + psLiteral(commandLine)
    + ' }; $r | Select-Object ReturnValue, ProcessId | ConvertTo-Json -Compress'
  let lastError = 'unknown'
  // 把实际派发的命令行原文写进日志：有用户机器上 WMI 和助手各自都正常，
  // 合起来却没动静，只有对比这条原文才能看出差在哪。
  log(`${label} dispatch (wmi): ${shorten(commandLine, 400)}`)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const created = JSON.parse(String(runPowerShell(script)).trim())
      const returnValue = Number(created && created.ReturnValue)
      const pid = Number(created && created.ProcessId)
      if (returnValue === 0 && Number.isSafeInteger(pid) && pid > 0) {
        return { pid, attempt, commandLine, how: 'wmi' }
      }
      lastError = `Win32_Process.Create 返回 ${String(returnValue)}`
    } catch (error) {
      lastError = String((error && error.message) || error)
    }
    log(`${label} spawn attempt ${attempt} failed: ${lastError}`)
    await delay(350)
  }
  throw new Error(`无法派发${label === 'helper' ? '重启助手' : label}（${lastError}）`)
}

// 备用派发：不经过 WMI，借已经跑着的 Explorer 打开一个包装脚本。
// explorer.exe 会把请求转交给现有实例，脚本因此运行在 Explorer 的进程树下 ——
// 既不在 DSH 的 Windows Job 里，也不受"从宿主派发的子进程会随外壳一起被收走"的限制。
//
// ⚠️ 包装脚本必须存成 **UTF-16LE + BOM**：
//    2026-10-12 一位用户把 DSH 装在 `C:\Users\-\新建文件夹\`，而这里原本按 'ascii' 写文件，
//    中文路径在写盘那一刻就被毁掉，助手拿到乱码 exe 路径后 fail-closed 拒绝动手，
//    宿主却把它的 ABORT 当成"助手就绪"，照样关了 DSH —— 表现就是"能关闭但拉不起来"。
//    WSH 认带 BOM 的 UTF-16 脚本，这样参数（路径）原样送达。
//
//    抽成独立函数是为了让单测能**实跑一次中文路径往返**（见 tests 里的编码金丝雀）：
//    编码这种事，只有真的写出去再读回来才算验证过，靠"我觉得对"必然翻车。
function writeExplorerWrapper(parts, wrapperPath = '') {
  const wrapper = wrapperPath || path.join(stateDir(), 'relaunch-wrapper.vbs')
  const inner = `wscript.exe //B ${parts.map((p) => `"${String(p).replace(/"/g, '""')}"`).join(' ')}`
  const text = [
    "' generated by dsh-hot-restart: hand the helper to the running Explorer",
    "' (keeps the helper out of the DSH job object without using WMI)",
    'Option Explicit',
    `CreateObject("WScript.Shell").Run "${inner.replace(/"/g, '""')}", 0, False`,
    '',
  ].join('\r\n')
  // \uFEFF 就是 BOM：Node 的 utf16le 写入不会自动加，必须自己带（也别加两次）
  fs.writeFileSync(wrapper, '\uFEFF' + text, 'utf16le')
  return wrapper
}

function dispatchViaExplorer(parts) {
  const wrapper = writeExplorerWrapper(parts)
  log(`helper dispatch (explorer): ${shorten(wrapper, 300)}`)
  // explorer.exe 立刻返回；真正跑脚本的是那个已经在运行的 Explorer 实例
  const child = spawn('explorer.exe', [wrapper], { detached: true, stdio: 'ignore', windowsHide: true })
  if (typeof child.unref === 'function') child.unref()
  return { pid: 0, attempt: 1, commandLine: wrapper, how: 'explorer' }
}


// 助手跑起来的第一件事就是往日志写 [relaunch] helper started。
// 有些机器上 WSH 被安全策略禁用：wscript.exe 能被创建、但立刻死掉，
// //B 模式下一声不响，于是外壳被杀而没人把它拉回来 —— 用户只看到 DSH 消失。
// 所以杀之前必须确认助手真的在干活。
function logSize(logFile) {
  try { return fs.statSync(logFile).size } catch { return 0 }
}

function helperReported(logFile, sizeBefore) {
  return helperStatus(logFile, sizeBefore).state !== 'none'
}

// 助手在日志里的三种状态。**关键**：只看到「写了一行」是不够的 ——
// 2026-10-12 一位用户的机器上，助手因为拿到的 exe 路径是乱码而当场 ABORT，
// 宿主却把那行 ABORT 当成了「助手就绪」，照样把 DSH 关掉，于是"关闭了但没起来"。
// 现在必须等到助手明确写 helper ready（它做完路径与凭据校验之后才写）。
function helperStatus(logFile, sizeBefore) {
  try {
    const buf = fs.readFileSync(logFile)
    if (buf.length <= sizeBefore) return { state: 'none', abort: null }
    const text = buf.subarray(sizeBefore).toString('utf8')
    if (/\[relaunch\]\s+helper ready/.test(text) || /\[helper\]\s+ready/.test(text)) {
      return { state: 'ready', abort: null }
    }
    const abort = text.match(/\[relaunch\]\s+(ABORT:[^\r\n]*)/) || text.match(/\[helper\]\s+(ABORT:[^\r\n]*)/)
    if (abort) return { state: 'abort', abort: String(abort[1]).trim() }
    if (text.includes('[relaunch]') || text.includes('[helper]')) return { state: 'started', abort: null }
    return { state: 'none', abort: null }
  } catch { return { state: 'none', abort: null } }
}

// 派发回来的 PID 还活着，就是「助手真的在跑」最硬的证据，而且不依赖日志能不能写。
// 用户报告：wscript 与 PowerShell 两种助手都在、都给了 PID，却一行日志都没有 ——
// 日志通道不可用时，只认日志会把能用的助手误判成死的，于是按钮白拒。
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    const out = String(runPowerShell(
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`,
      8000,
    )).trim()
    return out.includes('alive')
  } catch { return false }
}

// 等助手明确就绪。返回 { ok, abort }：
//   ok=true          助手已经写好 helper ready，可以动手
//   ok=false+abort   助手自己放弃了（比如路径读不对），必须原样上报，绝不能杀外壳
async function waitForHelper(logFile, sizeBefore, timeoutMs, pid = 0) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = helperStatus(logFile, sizeBefore)
    if (status.state === 'ready') return { ok: true, abort: null }
    if (status.state === 'abort') return { ok: false, abort: status.abort }
    // 日志写不进去时，活着的 PID 也算数（用户报告里出现过两种助手都写不进日志的情况）
    if (pid > 0 && pidAlive(pid)) return { ok: true, abort: null }
    if (Date.now() >= deadline) break
    await delay(250)
  }
  const last = helperStatus(logFile, sizeBefore)
  if (last.state === 'ready') return { ok: true, abort: null }
  if (last.state === 'abort') return { ok: false, abort: last.abort }
  if (pid > 0 && pidAlive(pid)) return { ok: true, abort: null }
  return { ok: false, abort: null }
}

// 「这次重启还算数吗」的凭据。宿主派发助手前写下它，决定放弃时删掉它；
// 助手动手前必须确认凭据还在且够新。没有这条通道时，一个已经派发出去的助手
// 会在 25 秒后无条件强杀外壳 —— 哪怕宿主早就放弃了这次重启。
function ticketPath() {
  return path.join(stateDir(), 'restart-ticket.json')
}

function issueTicket(shellPid) {
  try {
    fs.writeFileSync(ticketPath(), JSON.stringify({ at: Date.now(), shellPid }), 'utf8')
    return true
  } catch { return false }
}

function revokeTicket() {
  try { fs.rmSync(ticketPath(), { force: true }) } catch { /* 忽略 */ }
}

// 关掉外壳：先请它自己退出，超时就强杀。
//   · taskkill 不带 /F 等于发 WM_CLOSE。但 DSH 有托盘，「关窗」往往只是收进托盘，
//     所以这一步只给它 **5 秒**：之前等 12 秒、助手再等 25 秒，用户体感就是页面卡几十秒
//     （2026-10-12 的真实反馈：后台很快回来、界面半天不出来）。
//   · 强杀之前**核对身份**：PID 会被复用，只看 PID 动手可能杀掉无关进程。
//   · 绝不加 /T：整棵树一起收会连带杀掉正在写状态的子进程。
async function closeShell(shell) {
  const shellPid = shell.shellPid
  const expectedExe = String(shell.exePath || '').toLowerCase()
  const run = (args, note) => {
    try {
      const child = spawn('taskkill', args, { stdio: 'ignore', detached: true, windowsHide: true })
      child.on('error', (error) => log(`taskkill ${note} failed: ${String(error.message || error)}`))
      child.unref()
      log(`taskkill ${note}: taskkill ${args.join(' ')}`)
    } catch (error) {
      log(`taskkill ${note} threw: ${String((error && error.message) || error)}`)
    }
  }
  // ⚠️ 存活判断必须用瞬时的方式：process.kill(pid, 0) 是零成本的系统调用。
  //    千万别在这里调 pidAlive() —— 它每次同步起一个 PowerShell（超时 8 秒），
  //    5 次轮询把「等 5 秒」拖成了 10～45 秒，每次都输给助手的兜底，
  //    于是 2026-10-12 实测重启要 30 秒。DSH 有托盘，WM_CLOSE 只会收进托盘，
  //    所以这里也不值得多等：跑一次 WM_CLOSE，给它 3 秒收尾，然后强杀。
  const alive = (pid) => {
    try { process.kill(pid, 0); return true } catch (error) { return !!(error && error.code === 'EPERM') }
  }
  // 身份核对要跑一次 PowerShell（约 1.5 秒）：**跟等待并行做**，别串在关键路径上。
  let identity = Promise.resolve(null)
  if (expectedExe !== '') {
    identity = Promise.resolve().then(() => {
      try { return queryParentProcess(shellPid) } catch { return null }
    })
  }
  run(['/PID', String(shellPid)], 'graceful close requested')
  // DSH 有托盘，WM_CLOSE 只会把它收进托盘（实测两次都是这样），所以只给它 1 秒面子。
  await delay(1000)
  if (!alive(shellPid)) {
    log('shell exited gracefully')
    return
  }
  const current = await identity
  const currentExe = String((current && current.ExecutablePath) || '').toLowerCase()
  if (currentExe !== '' && currentExe !== expectedExe) {
    log(`refusing to force-kill pid=${shellPid}: that PID now belongs to ${currentExe}, not our shell`)
    return
  }
  run(['/F', '/PID', String(shellPid)], 'forced, graceful close timed out')
}

// —— 自检 ---------------------------------------------------------------------
// 三种触发：① 用户右键按钮点「自检」；② 页面在重启失败后自动请求；
// ③ 宿主启动时发现「上一次启动是失败的」就自动跑一次。
// 报告由 tools/diagnose.ps1 产出：只读探测，写到桌面并自动用记事本打开。
function diagnoseScript() {
  for (const candidate of [
    path.join(HERE, '..', 'tools', 'diagnose.ps1'),
    path.join(HERE, 'tools', 'diagnose.ps1'),
  ]) {
    try { if (fs.existsSync(candidate)) return candidate } catch { /* 试下一个 */ }
  }
  return ''
}

// 自检的派发姿势（2026-10-12 实测确认）：
//   · 用**管道 stdio**。DSH 自己的工具运行器就是这么跑 PowerShell 的，最稳；
//     早期版本用 `stdio: 'ignore'` + detached，实测子进程可能一行都不执行就退出。
//   · 不要 detached：自检是用户当场发起的短任务，不需要活过宿主。
//   · 1.5 秒内就退出且非 0 → 直接把 stderr 带回去，别只回一个「已启动」骗人。
// 正在跑的自检进程：取消按钮要能把它连同它的探针子进程一起收掉。
// ⚠️ 这里可以放心用 /T —— 收的是自检自己的进程树，跟 DSH 一点关系都没有。
let diagnoseChild = null

function cancelDiagnostics() {
  if (diagnoseChild === null) return { ok: false, error: '当前没有在跑的自检' }
  const pid = diagnoseChild.pid
  try {
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore', detached: true, windowsHide: true,
    })
    if (typeof killer.unref === 'function') killer.unref()
    log(`diagnostics cancelled by user: taskkill /F /T /PID ${pid}`)
  } catch (error) {
    log(`diagnostics cancel failed: ${String((error && error.message) || error)}`)
  }
  try { diagnoseChild.kill() } catch { /* 忽略 */ }
  diagnoseChild = null
  // 把进度文件抹掉，免得页面下次读到上一次的卡片
  try { fs.rmSync(path.join(stateDir(), 'diagnose-progress.txt'), { force: true }) } catch { /* 忽略 */ }
  return { ok: true, pid }
}

function runDiagnostics(trigger) {
  const script = diagnoseScript()
  if (script === '') {
    log(`diagnostics unavailable: tools/diagnose.ps1 not found (trigger=${trigger})`)
    return Promise.resolve({ ok: false, error: '找不到自检脚本 tools/diagnose.ps1' })
  }
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    let child = null
    try {
      child = spawn(POWERSHELL, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Trigger', String(trigger),
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, error: String((error && error.message) || error) })
      return
    }
    child.stdout.on('data', () => { /* 排空即可 */ })
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000) })
    diagnoseChild = child
    child.on('error', (error) => {
      if (settled) return
      settled = true
      log(`diagnostics spawn error: ${String((error && error.message) || error)}`)
      resolve({ ok: false, error: String((error && error.message) || error) })
    })
    child.on('exit', (code) => {
      if (diagnoseChild === child) diagnoseChild = null
      if (settled) return
      settled = true
      const detail = shorten(stderr, 300)
      log(`diagnostics exited immediately with code=${code}: ${detail}`)
      resolve({ ok: false, error: `自检脚本启动后立刻退出（code=${code}）${detail ? '：' + detail : ''}` })
    })
    setTimeout(() => {
      if (settled) return
      settled = true
      log(`diagnostics started (trigger=${trigger}) pid=${child.pid} script=${shorten(script, 200)}`)
      resolve({ ok: true, pid: child.pid, how: 'direct' })
    }, 1500)
  })
}

// DSH 把每次启动的阶段结果写进 lifecycle-events/summary.json。上一次是失败的，
// 就说明用户多半正卡在恢复模式里 —— 这时自动给出一份报告，别等人来问。
function failedStartupSignature() {
  const roots = []
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (!base) continue
    roots.push(
      path.join(base, 'DSH Desktop'),
      path.join(base, '@deepseek-ai', 'dsh-desktop'),
      path.join(base, '@deepseek-ai', 'DSH Desktop'),
    )
  }
  for (const root of roots) {
    const summary = path.join(root, 'lifecycle-events', 'summary.json')
    try {
      const stat = fs.statSync(summary)
      if (Date.now() - stat.mtimeMs > 12 * 60 * 60 * 1000) continue
      const parsed = JSON.parse(fs.readFileSync(summary, 'utf8'))
      if (parsed && parsed.finalOutcome === 'failed') {
        return `${stat.mtimeMs}:${String(parsed.finalStage || 'unknown')}`
      }
    } catch { /* 没有这个文件就算了 */ }
  }
  return ''
}

// 同一份失败只自动诊断一次，免得每次重启都弹一堆报告
function claimAutoDiagnose(signature) {
  const marker = path.join(stateDir(), 'last-auto-diagnose.txt')
  try {
    if (fs.readFileSync(marker, 'utf8').trim() === signature) return false
  } catch { /* 首次 */ }
  try { fs.writeFileSync(marker, signature, 'utf8') } catch { /* 忽略 */ }
  return true
}

// 最近一份诊断报告在哪？自检脚本会把它写进 last-report.txt，
// 页面与助手都靠它把「文件位置」明确告诉用户，而不是让人自己找。
// 文件第一行是路径，第二行是触发来源（manual = 手工跑的，页面不该弹提示）。
function readLastReport() {
  try {
    const pointer = path.join(stateDir(), 'last-report.txt')
    const lines = fs.readFileSync(pointer, 'utf8').split(/\r?\n/).map((line) => line.trim())
    const target = lines[0] || ''
    if (target === '') return null
    const stat = fs.statSync(target)
    return { path: target, at: Math.round(stat.mtimeMs), bytes: stat.size, trigger: lines[1] || 'manual' }
  } catch { return null }
}

// 自检进度：脚本每走一步就写一行 "步号|总步数|说明"，跑完补一行 "done|<报告路径>"。
// 页面拿它显示进度条 —— 用户在页面上点的自检，就在页面上给他反馈。
// ⚠️ 脚本写的是 **UTF-16LE**（-Encoding Unicode），读的时候必须按 utf16le 解。
function readDiagnoseProgress() {
  try {
    const file = path.join(stateDir(), 'diagnose-progress.txt')
    const stat = fs.statSync(file)
    // 超过 5 分钟没动静就当没有：别把上一次的进度条当成这次的
    if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) return null
    const text = fs.readFileSync(file, 'utf16le').replace(/^\uFEFF/, '')
    const out = { step: 0, total: 8, label: '', done: false, report: '', at: Math.round(stat.mtimeMs) }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '') continue
      if (line.startsWith('done|')) { out.done = true; out.report = line.slice(5).trim(); continue }
      const parts = line.split('|')
      if (parts.length >= 3) {
        const step = Number(parts[0])
        const total = Number(parts[1])
        if (Number.isFinite(step) && Number.isFinite(total) && total > 0) {
          out.step = step; out.total = total; out.label = parts[2]
        }
      }
    }
    return out
  } catch { return null }
}

async function beginRestart(port) {
  if (restartRecord !== null && Date.now() - restartRecord.at < 30000) return restartRecord
  // 落盘的「刚重启过」标记：内存里的记录在外壳被换掉之后就没了，
  // 于是用户看到窗口没立刻消失、隔几十秒再点一次，就会开出**重叠的第二次重启**
  // （两个助手同时在场）。冷却期主人定的是 5 秒：够挡住连点，又不至于让人等。
  // 冷却被拒**不算故障**，页面按 reason='cooldown' 走轻提示，不跑自检。
  try {
    const previous = JSON.parse(fs.readFileSync(path.join(stateDir(), 'last-restart.json'), 'utf8'))
    const at = Number(previous && previous.at)
    if (Number.isFinite(at) && at > 0 && Date.now() - at < COOLDOWN_MS) {
      const seconds = Math.max(1, Math.ceil((COOLDOWN_MS - (Date.now() - at)) / 1000))
      const error = new Error(`上一次重启刚发生过（${Math.round((Date.now() - at) / 1000)} 秒前），请等 ${seconds} 秒后再试`)
      error.reason = 'cooldown'
      throw error
    }
  } catch (error) {
    if (error && error.reason === 'cooldown') throw error
    // 没有标记文件/读不了都当第一次
  }
  const shell = detectShell()
  if (!shell.ok) {
    throw new Error(`当前 DSH 不是由桌面壳托管（${shell.reason}），无法热重启；请手动重开 DSH`)
  }
  // 杀之前先确认拿得到能重新拉起的 exe，否则只会有「关掉了但回不来」
  if (!shell.exePath || !fs.existsSync(shell.exePath)) {
    throw new Error(`找不到外壳可执行文件（${String(shell.exePath || '空')}），为避免关掉后起不来，已放弃重启`)
  }
  const logFile = path.join(stateDir(), 'restart.log')
  const portArg = String(port > 0 ? port : 0)

  // 首选：wscript + VBS（零窗口、零控制台）
  const vbs = path.join(HERE, 'relaunch.vbs')
  const wscriptExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
  const fallbackPs = path.join(HERE, 'relaunch.ps1')

  // 凭据先写好：助手要靠它判断「这次重启还算不算数」。
  // 宿主一旦放弃重启就删掉它，游荡的助手才不会过 25 秒后强杀外壳。
  const ticket = issueTicket(shell.shellPid) ? ticketPath() : ''

  let helper = null
  let helperKind = 'wscript-vbs'
  let abortReason = ''
  if (fs.existsSync(vbs) && fs.existsSync(wscriptExe)) {
    const before = logSize(logFile)
    try {
      const candidate = await spawnHelper([
        winArg(wscriptExe), '//B', winArg(vbs),
        winArg(String(shell.shellPid)), winArg(shell.exePath), winArg(logFile), winArg(portArg), winArg(ticket),
        winArg(shell.shellCreated || ''),
      ].join(' '))
      const outcome = await waitForHelper(logFile, before, 6000, candidate.pid)
      if (outcome.ok) {
        helper = candidate
      } else {
        abortReason = outcome.abort || abortReason
        log(`wscript helper pid=${candidate.pid} did not report ready${outcome.abort ? ' (' + outcome.abort + ')' : ''}; WSH may be blocked`)
      }
    } catch (error) {
      log(`wscript helper unavailable: ${String((error && error.message) || error)}`)
    }
  }

  // 兜底一：绕开 WMI，借已运行的 Explorer 打开包装脚本。
  // 有用户机器上「WMI 能建进程」且「助手手动跑正常」，两者合起来却没动静，
  // 所以这条不经过 WMI 的路有独立价值。
  if (helper === null && fs.existsSync(vbs)) {
    const before = logSize(logFile)
    try {
      const candidate = dispatchViaExplorer([
        vbs, String(shell.shellPid), shell.exePath, logFile, portArg, ticket, shell.shellCreated || '',
      ])
      const outcome = await waitForHelper(logFile, before, 10000)
      if (outcome.ok) {
        helper = candidate
        helperKind = 'wscript-explorer'
      } else {
        abortReason = outcome.abort || abortReason
        log(`explorer-dispatched helper did not report ready${outcome.abort ? ' (' + outcome.abort + ')' : ''}`)
      }
    } catch (error) {
      log(`explorer dispatch failed: ${String((error && error.message) || error)}`)
    }
  }

  // 兜底二：PowerShell 助手（没有 wscript/VBScript，或上面两条都不通时）。
  // 它可能闪一个控制台窗口，但自己会立刻退出，DSH 由它用 WMI 拉起，不会继承控制台。
  if (helper === null && fs.existsSync(fallbackPs)) {
    helperKind = 'powershell-fallback'
    const before = logSize(logFile)
    try {
      const candidate = await spawnHelper([
        winArg(POWERSHELL), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', winArg(fallbackPs),
        '-ShellPid', String(shell.shellPid), '-ExePath', shell.exePath, '-LogPath', logFile, '-Port', portArg,
        '-Ticket', winArg(ticket), '-Created', winArg(shell.shellCreated || ''),
      ].map((part) => part).join(' '))
      const outcome = await waitForHelper(logFile, before, 8000, candidate.pid)
      if (outcome.ok) {
        helper = candidate
      } else {
        abortReason = outcome.abort || abortReason
        log(`powershell helper did not report ready either${outcome.abort ? ' (' + outcome.abort + ')' : ''}`)
      }
    } catch (error) {
      log(`powershell helper unavailable: ${String((error && error.message) || error)}`)
    }
  }

  // 三条路都不通：宁可不重启，也不能把用户的 DSH 关掉没人管。
  if (helper === null) {
    // 关键：撤销凭据。否则已经派发出去的那个助手过 25 秒照样会强杀外壳。
    revokeTicket()
    log('restart abandoned; ticket revoked so no stray helper kills the shell')
    throw new Error('这台机器上重启助手没能就绪'
      + (abortReason ? `（助手报：${abortReason}）` : '，可能是脚本宿主被安全策略拦住了')
      + '。为避免关掉 DSH 之后无法自动打开，已放弃这次重启，DSH 没有被关闭；'
      + '可以双击插件目录里的 tools\\restart-dsh.cmd 手动重启')
  }
  log(`helper confirmed: pid=${helper.pid} kind=${helperKind}`)

  restartRecord = {
    at: Date.now(),
    shellPid: shell.shellPid,
    helperPid: helper.pid,
    helperKind,
    exePath: shell.exePath,
    commandLine: shell.commandLine,
  }
  log(`restart requested: shellPid=${shell.shellPid} helperPid=${helper.pid} helper=${helperKind} port=${portArg} exe=${shell.exePath}`)

  // 先把响应刷回页面，再终结外壳；助手那边还有一层「迟迟等不到退出就自己动手」的兜底。
  // ⚠️ 这里必须传**整个 shell 对象**：closeShell 需要 exePath 去核对身份。
  //    0.3.16 漏改了这一个字（还在传 shell.shellPid），结果日志里是 `taskkill /PID undefined`，
  //    优雅关闭从来没生效过，每次重启都白等助手兜底的 40 多秒 —— 2026-10-12 实测 56 秒。
  const timer = setTimeout(() => {
    closeShell(shell)
  }, 250)
  if (typeof timer.unref === 'function') timer.unref()

  // 状态文件：即使 Host 很快被杀，助手与用户也能从磁盘看到这次重启的意图。
  try {
    fs.writeFileSync(path.join(stateDir(), 'last-restart.json'), JSON.stringify(restartRecord, null, 2))
  } catch { /* 忽略 */ }
  return restartRecord
}

// —— 路由护栏 -------------------------------------------------------------------
function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (h === '' ) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  return Number(m[1]) === 127 && [m[2], m[3], m[4]].every((part) => Number(part) <= 255)
}

function deny(res, code, message) {
  try {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(message || '')
  } catch { /* 忽略 */ }
  return true
}

// 自校验（永远先跑）+ 委托宿主信任栅栏（它自带一层浏览器鉴权 401）。
function rejected(ctx, req, res) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try { hostUrl = new URL(`http://${String(headers.host || '')}`) } catch { return deny(res, 400, 'bad host') }
    if (!isLoopbackHostname(hostUrl.hostname)) return deny(res, 403, 'loopback only')
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return deny(res, 403, 'cross-site rejected')
    const origin = headers.origin
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      let originUrl = null
      try { originUrl = new URL(origin) } catch { return deny(res, 403, 'bad origin') }
      if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return deny(res, 403, 'cross-origin rejected')
    }
    let connection = null
    try { connection = ctx.get('connection') } catch { connection = null }
    if (connection && typeof connection.requestRejection === 'function') {
      let code
      try { code = connection.requestRejection(req) } catch { return deny(res, 403, 'fence failed') }
      if (code !== undefined && code !== null && code !== false) {
        return deny(res, typeof code === 'number' ? code : 403, 'unauthorized')
      }
    }
    return false
  } catch {
    return deny(res, 403, 'rejected')
  }
}

async function readBody(req, limit = 8192) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function loadUiScript() {
  const candidates = [
    path.join(HERE, 'ui.js'),
    path.join(HERE, '..', 'lib', 'ui.js'),
  ]
  let newest = null
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate)
      if (newest === null || stat.mtimeMs > newest.mtimeMs) {
        newest = { mtimeMs: stat.mtimeMs, text: fs.readFileSync(candidate, 'utf8') }
      }
    } catch { /* 尝试下一个 */ }
  }
  return newest === null ? '' : newest.text
}

// —— 插件本体 -------------------------------------------------------------------
// 单测用出口：把外壳判定规则放出来，每个用户遇到的构建都补一条用例
export const __test = {
  classifyShellCandidate,
  SHELL_NAME_PATTERN,
  HOST_MARKER_PATTERN,
  CONSOLE_HOST_PATTERN,
  // 给编码金丝雀用：单测会拿它写一次带中文路径的包装脚本，再用 wscript 实跑，验证参数没被毁
  writeExplorerWrapper,
}

export default {
  name: 'dsh-hot-restart',
  apply(root) {
    // ① 注入行必须**第一时间**进表：桌面壳的注入表是启动时一次性收集的，
    //    晚一步注册就永远进不去（这是鲸鱼挂件 issue #152/#153 的根因）。
    root.effect(() => {
      const off = root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === `${BASE}/ui.js`) return
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(`${BASE}/ui.js`) >= 0) return
          }
          table.push({ kind: 'script', placement: 'body', text: INLINE_BOOT_ROW })
        } catch { /* 注入失败不影响宿主 */ }
      })
      return () => { try { off() } catch { /* 忽略 */ } }
    })

    // ② 其余逻辑等 webServer 就绪。
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      const register = (route) => {
        const inner = route.handler
        return ctx.webServer.register({
          kind: 'exact',
          path: route.path,
          handler: async (req, res) => {
            if (rejected(ctx, req, res)) return undefined
            try {
              return await inner(req, res)
            } catch (error) {
              log(`route ${route.path} failed: ${String((error && error.message) || error)}`)
              try {
                res.writeHead(500, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
              } catch { /* 忽略 */ }
              return undefined
            }
          },
        })
      }

      const webPort = (() => {
        try {
          if (ctx.webServer && Number.isSafeInteger(ctx.webServer.port)) return ctx.webServer.port
        } catch { /* 忽略 */ }
        try {
          const match = /:(\d+)/.exec(String(process.env.DSH_WEB_URL || ''))
          if (match) return Number(match[1])
        } catch { /* 忽略 */ }
        return 0
      })()

      disposers.push(register({
        path: `${BASE}/status.json`,
        handler: (req, res) => {
          const shell = detectShell()
          let lastRestart = null
          try { lastRestart = JSON.parse(fs.readFileSync(path.join(stateDir(), 'last-restart.json'), 'utf8')) } catch { lastRestart = null }
          const installed = installedVersion()
          const payload = {
            ok: true,
            // version 是磁盘上装的那份；runningVersion 是此刻真正在跑的宿主模块。
            // 两者不一致就说明装完还没重启 DSH —— 宿主代码按模块 URL 缓存，不重启不会换。
            version: installed,
            runningVersion: VERSION,
            restartRequired: String(installed) !== String(VERSION),
            platform: process.platform,
            hostPid: process.pid,
            hostUptimeMs: Math.round(process.uptime() * 1000),
            port: webPort,
            canRestart: shell.ok === true,
            reason: shell.reason,
            shellPid: shell.ok ? shell.shellPid : null,
            shellExe: shell.ok ? shell.exePath : null,
            // 诊断用：父进程是谁、宿主跑在哪个可执行文件上。
            // 用户回报「无法热重启」时，这段信息就能直接定位是哪一步不认。
            detect: {
              hostPid: shell.hostPid ?? null,
              hostPpid: shell.hostPpid ?? null,
              hostExe: shell.hostExe ?? null,
              // 宿主启动参数：不同 DSH 桌面构建的标记不一样，回报时靠它对齐
              hostArgv: shell.hostArgv ?? null,
              hostMarker: shell.hostMarker === true,
              exeSource: shell.exeSource ?? null,
              parentPid: shell.parentPid ?? null,
              parentName: shell.parentName ?? null,
              parentExe: shell.parentExe ?? null,
              parentCommand: shell.parentCommand ?? null,
            },
            restarting: restartRecord !== null && Date.now() - restartRecord.at < 30000,
            lastRestart,
            // 让页面能直接告诉用户「报告在哪」
            lastDiagnoseReport: readLastReport(),
            // 自检进行中时页面拿它画进度条（脚本不起任何新进程，这条链路也不起）
            diagnoseProgress: readDiagnoseProgress(),
          }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(payload))
        },
      }))

      disposers.push(register({
        path: `${BASE}/ui.js`,
        handler: (req, res) => {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(loadUiScript())
        },
      }))

      disposers.push(register({
        path: `${BASE}/restart`,
        handler: async (req, res) => {
          const headers = (req && req.headers) || {}
          if (String(req.method || 'GET').toUpperCase() !== 'POST') {
            return deny(res, 405, 'POST only')
          }
          // 自定义头：跨站表单/简单请求无法伪造（预检会被上面的同源校验挡掉）。
          if (String(headers['x-dsh-hot-restart'] || '') !== '1') {
            return deny(res, 403, 'missing x-dsh-hot-restart header')
          }
          try { await readBody(req) } catch { /* body 无内容也没关系 */ }
          try {
            const record = await beginRestart(webPort)
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify({
              ok: true,
              acceptedAt: record.at,
              shellPid: record.shellPid,
              helperPid: record.helperPid,
              note: '外壳即将终止，助手会在进程退出后自动重新拉起 DSH',
            }))
          } catch (error) {
            res.writeHead(409, JSON_HEADERS)
            res.end(JSON.stringify({
              ok: false,
              error: String((error && error.message) || error),
              // cooldown = 只是等几秒，页面不该摆出「出故障了」的架势
              reason: (error && error.reason) || 'refused',
            }))
          }
          return undefined
        },
      }))

      disposers.push(register({
        path: `${BASE}/diagnose`,
        handler: async (req, res) => {
          const headers = (req && req.headers) || {}
          if (String(req.method || 'GET').toUpperCase() !== 'POST') {
            return deny(res, 405, 'POST only')
          }
          if (String(headers['x-dsh-hot-restart'] || '') !== '1') {
            return deny(res, 403, 'missing x-dsh-hot-restart header')
          }
          const trigger = String(headers['x-dsh-hot-restart-trigger'] || 'user-request')
          const result = await runDiagnostics(trigger)
          res.writeHead(result.ok ? 200 : 500, JSON_HEADERS)
          res.end(JSON.stringify({
            ok: result.ok === true,
            pid: result.pid ?? null,
            error: result.error ?? null,
            note: result.ok === true
              ? '自检已启动：大约十秒后生成诊断报告并自动打开'
              : '自检脚本没能启动',
          }))
          return undefined
        },
      }))

      // 取消自检：用户在进度卡片上点「取消」时，把那个脚本进程（和它的探针子进程）收掉。
      // 收的是自检自己的进程树，不碰 DSH —— 所以这里的 /T 是安全的。
      disposers.push(register({
        path: `${BASE}/diagnose/cancel`,
        handler: (req, res) => {
          const headers = (req && req.headers) || {}
          if (String(req.method || 'GET').toUpperCase() !== 'POST') {
            return deny(res, 405, 'POST only')
          }
          if (String(headers['x-dsh-hot-restart'] || '') !== '1') {
            return deny(res, 403, 'missing x-dsh-hot-restart header')
          }
          const result = cancelDiagnostics()
          res.writeHead(result.ok ? 200 : 409, JSON_HEADERS)
          res.end(JSON.stringify(result))
          return undefined
        },
      }))

      // 非桌面壳（浏览器里直接开 dsh web）走 tapIndex，两条通道并存、各自去重。
      disposers.push(ctx.webServer.tapIndex((html) => {
        if (typeof html !== 'string') return html
        if (html.indexOf(`${BASE}/ui.js`) !== -1) return html
        const tag = `<script defer src="${BASE}/ui.js"></script>`
        return html.indexOf('</body>') !== -1 ? html.replace('</body>', `${tag}</body>`) : html + tag
      }))

      // 外壳探测放到挂载之后空闲时做：它要同步跑一次 PowerShell，放在这里会把
      // DSH 自己的启动和页面渲染一起拖慢。日志仍然照写，只是写成异步的。
      warmUpShellDetection()
      const logTimer = setTimeout(() => {
        const shell = detectShell()
        log(
          `mounted v${installedVersion()}: hostPid=${process.pid} port=${webPort}`
          + ` shell=${shell.ok ? shell.shellPid : 'n/a(' + shell.reason + ')'}`
          + ` hostExe=${shorten(shell.hostExe, 200)}`
          + ` parent=${String(shell.parentName || '')}#${String(shell.parentPid ?? '')}`
          + ` parentExe=${shorten(shell.parentExe, 200)}`
          + ` parentCmd=${shorten(shell.parentCommand, 200)}`,
        )
      }, 1300)
      if (typeof logTimer.unref === 'function') logTimer.unref()

      // 上一次启动是失败的？那就自动给用户一份诊断报告（同一份失败只跑一次）
      try {
        const signature = failedStartupSignature()
        if (signature !== '' && claimAutoDiagnose(signature)) {
          log(`previous startup failed (${signature}); starting diagnostics automatically`)
          // 不阻塞挂载：自检要跑几十秒，等它会把启动拖慢
          Promise.resolve()
            .then(() => runDiagnostics('previous-startup-failed'))
            .catch((error) => log(`auto diagnostics failed: ${String((error && error.message) || error)}`))
        }
      } catch (error) {
        log(`auto diagnostics check failed: ${String((error && error.message) || error)}`)
      }

      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* 忽略 */ }
        }
      })
    })
  },
}
