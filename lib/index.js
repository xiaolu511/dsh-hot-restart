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
const VERSION = '0.3.1'
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
  const dir = path.join(dshHome(), 'hot-restart')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 只读也不致命，日志降级为丢弃 */ }
  stateDirCache = dir
  return dir
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

function runPowerShell(script, timeoutMs = 20000) {
  return execFileSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
  )
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

function detectShellUncached() {
  const unsupported = (reason) => ({ ok: false, reason, platform: process.platform })
  if (process.platform !== 'win32') return unsupported('unsupported-platform')
  const hostedByDesktopShell = process.argv.some(
    (arg) => typeof arg === 'string' && arg.includes('dsh-desktop-host'),
  )
  if (!hostedByDesktopShell) return unsupported('not-desktop-host')
  let parent = null
  try {
    const script = '$p = Get-CimInstance Win32_Process -Filter "ProcessId='
      + String(Number(process.ppid))
      + '" -ErrorAction SilentlyContinue; if ($p) { $p | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress }'
    const out = String(runPowerShell(script)).trim()
    if (out !== '') parent = JSON.parse(out)
  } catch (error) {
    log(`parent query failed: ${String((error && error.message) || error)}`)
  }
  if (!parent || !Number.isSafeInteger(Number(parent.ProcessId))) return unsupported('parent-unknown')
  const exePath = process.execPath
  const parentExe = String(parent.ExecutablePath || '')
  const sameExe = parentExe !== ''
    && path.resolve(parentExe).toLowerCase() === path.resolve(exePath).toLowerCase()
  const isBrowserProcess = !/--type=/i.test(String(parent.CommandLine || ''))
  if (!sameExe || !isBrowserProcess) return unsupported('parent-not-shell')
  return {
    ok: true,
    reason: 'desktop-shell',
    platform: process.platform,
    shellPid: Number(parent.ProcessId),
    exePath,
    commandLine: String(parent.CommandLine || `"${exePath}"`).trim(),
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
async function spawnHelper(commandLine) {
  const script = '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '
    + psLiteral(commandLine)
    + ' }; $r | Select-Object ReturnValue, ProcessId | ConvertTo-Json -Compress'
  let lastError = 'unknown'
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const created = JSON.parse(String(runPowerShell(script)).trim())
      const returnValue = Number(created && created.ReturnValue)
      const pid = Number(created && created.ProcessId)
      if (returnValue === 0 && Number.isSafeInteger(pid) && pid > 0) {
        return { pid, attempt, commandLine }
      }
      lastError = `Win32_Process.Create 返回 ${String(returnValue)}`
    } catch (error) {
      lastError = String((error && error.message) || error)
    }
    log(`helper spawn attempt ${attempt} failed: ${lastError}`)
    await delay(350)
  }
  throw new Error(`无法派发重启助手（${lastError}）`)
}

async function beginRestart(port) {
  if (restartRecord !== null && Date.now() - restartRecord.at < 30000) return restartRecord
  const shell = detectShell()
  if (!shell.ok) {
    throw new Error(`当前 DSH 不是由桌面壳托管（${shell.reason}），无法热重启；请手动重开 DSH`)
  }
  const logFile = path.join(stateDir(), 'restart.log')
  const portArg = String(port > 0 ? port : 0)

  // 首选：wscript + VBS（零窗口、零控制台）
  const vbs = path.join(HERE, 'relaunch.vbs')
  const wscriptExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
  const fallbackPs = path.join(HERE, 'relaunch.ps1')

  let helper = null
  let helperKind = 'wscript-vbs'
  if (fs.existsSync(vbs) && fs.existsSync(wscriptExe)) {
    try {
      helper = await spawnHelper([
        winArg(wscriptExe), '//B', winArg(vbs),
        winArg(String(shell.shellPid)), winArg(shell.exePath), winArg(logFile), winArg(portArg),
      ].join(' '))
    } catch (error) {
      log(`wscript helper unavailable: ${String((error && error.message) || error)}`)
    }
  }

  // 兜底：PowerShell 助手（旧机器上没有 wscript/VBScript 时）。它可能闪一个控制台窗口，
  // 但自己会立刻退出，DSH 由它用 WMI 拉起，不会继承控制台。
  if (helper === null && fs.existsSync(fallbackPs)) {
    helperKind = 'powershell-fallback'
    helper = await spawnHelper([
      winArg(POWERSHELL), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', winArg(fallbackPs),
      '-ShellPid', String(shell.shellPid), '-ExePath', shell.exePath, '-LogPath', logFile, '-Port', portArg,
    ].map((part) => part).join(' '))
  }
  if (helper === null) throw new Error('找不到可用的重启助手（relaunch.vbs / relaunch.ps1）')

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
  const timer = setTimeout(() => {
    try {
      const killer = spawn('taskkill', ['/F', '/PID', String(shell.shellPid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      })
      killer.on('error', (error) => log(`taskkill failed: ${String(error.message || error)}`))
      killer.unref()
      log(`taskkill issued for shellPid=${shell.shellPid}`)
    } catch (error) {
      log(`taskkill threw: ${String((error && error.message) || error)}`)
    }
  }, 700)
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
          const payload = {
            ok: true,
            version: installedVersion(),
            platform: process.platform,
            hostPid: process.pid,
            hostUptimeMs: Math.round(process.uptime() * 1000),
            port: webPort,
            canRestart: shell.ok === true,
            reason: shell.reason,
            shellPid: shell.ok ? shell.shellPid : null,
            shellExe: shell.ok ? shell.exePath : null,
            restarting: restartRecord !== null && Date.now() - restartRecord.at < 30000,
            lastRestart,
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
            res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
          }
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

      const shell = detectShell()
      log(`mounted v${installedVersion()}: hostPid=${process.pid} port=${webPort} shell=${shell.ok ? shell.shellPid : 'n/a(' + shell.reason + ')'}`)

      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* 忽略 */ }
        }
      })
    })
  },
}
