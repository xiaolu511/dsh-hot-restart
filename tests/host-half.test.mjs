// ============================================================================
// dsh-hot-restart :: host-half test (runs outside DSH, no side effects)
// ----------------------------------------------------------------------------
//   node tests/host-half.test.mjs
//
// 用一个假的 Cordis root/ctx 驱动宿主半区，验证：
//   ① index-inject 行只推一次、内容是内联 script 行（不会连累 boot）；
//   ② 三条路由的路径与 POST/自定义头/护栏语义；
//   ③ fail-closed：不是桌面壳托管时 canRestart=false。
// ============================================================================

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const plugin = mod.default

assert.equal(plugin.name, 'dsh-hot-restart', 'plugin name')

// —— 假的 Cordis 运行时 -------------------------------------------------------
let injectRowListener = null
let tapIndex = null
const routes = new Map()
const disposers = []

const fakeCtx = {
  get(name) { return name === 'connection' ? undefined : undefined },
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  webServer: {
    port: 19387,
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
    tapIndex(transform) { tapIndex = transform; return () => { tapIndex = null } },
  },
}

const root = {
  on(event, listener) {
    if (event === 'webserver/index-inject') injectRowListener = listener
    return () => { injectRowListener = null }
  },
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  inject(names, callback) {
    assert.deepEqual(names, ['webServer'], 'inject list')
    callback(fakeCtx)
    return () => {}
  },
}

plugin.apply(root)
assert.ok(injectRowListener, 'index-inject listener registered synchronously in apply()')

// —— ① 注入行 ----------------------------------------------------------------
{
  const table = []
  injectRowListener(table)
  assert.equal(table.length, 1, 'one row pushed')
  assert.equal(table[0].kind, 'script', 'row kind is script (never script-src: its failure rejects boot)')
  assert.equal(table[0].placement, 'body')
  assert.ok(typeof table[0].text === 'string' && table[0].text.includes('/dsh-hot-restart/ui.js'), 'row points at ui.js')
  assert.ok(!table[0].src, 'inline row has no src of its own')

  // 重复触发（同一个表 / 新表）都不应重复推
  injectRowListener(table)
  assert.equal(table.length, 1, 'idempotent on the same table')
  const second = []
  injectRowListener(second)
  assert.equal(second.length, 1, 'new table still gets exactly one row')
  const withForeignRow = [{ kind: 'script', text: 'x' }]
  injectRowListener(withForeignRow)
  assert.equal(withForeignRow.length, 2, 'foreign rows preserved, ours appended')
}

// —— ② 路由 ------------------------------------------------------------------
assert.deepEqual(
  [...routes.keys()].sort(),
  ['/dsh-hot-restart/restart', '/dsh-hot-restart/status.json', '/dsh-hot-restart/ui.js'],
  'three exact routes registered',
)
assert.ok(typeof tapIndex === 'function', 'tapIndex also installed (browser form)')
{
  const html = '<html><body></body></html>'
  const out = tapIndex(html)
  assert.ok(out.includes('/dsh-hot-restart/ui.js'), 'tapIndex injects the script tag')
  assert.equal(tapIndex(out), out, 'tapIndex idempotent')
}

function fakeRequest(options = {}) {
  return {
    method: options.method || 'GET',
    url: options.url || '/',
    headers: options.headers || { host: '127.0.0.1:19387' },
    async *[Symbol.asyncIterator]() {
      if (options.body) yield Buffer.from(options.body)
    },
  }
}

function fakeResponse() {
  const res = { statusCode: 0, headers: null, body: '' }
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers }
  res.end = (body) => { res.body = body === undefined ? '' : String(body) }
  return res
}

async function call(path, options) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} exists`)
  const res = fakeResponse()
  await route.handler(fakeRequest(options), res)
  return res
}

// 护栏：非回环 Host / 跨站 / 跨源 / 自查失败
{
  const bad = await call('/dsh-hot-restart/status.json', { headers: { host: 'evil.example.com' } })
  assert.equal(bad.statusCode, 403, 'non-loopback host rejected')

  const crossSite = await call('/dsh-hot-restart/status.json', {
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.statusCode, 403, 'cross-site rejected')

  const crossOrigin = await call('/dsh-hot-restart/status.json', {
    headers: { host: '127.0.0.1:19387', origin: 'https://evil.example.com' },
  })
  assert.equal(crossOrigin.statusCode, 403, 'cross-origin rejected')

  const localhostOk = await call('/dsh-hot-restart/status.json', {
    headers: { host: 'localhost:19387', origin: 'http://localhost:19387' },
  })
  assert.equal(localhostOk.statusCode, 200, 'loopback + same origin allowed')
}

// status.json 内容
{
  const res = await call('/dsh-hot-restart/status.json')
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.port, 19387)
  assert.equal(payload.hostPid, process.pid)
  // 测试进程不是被 DSH 桌面壳拉起的 → 必须 fail-closed。
  // 具体原因随环境而变（parent-unknown / parent-unrecognized / parent-is-console…），
  // 这里只要求「拒绝 + 给出非空原因」，别再写死某个原因码。
  assert.equal(payload.canRestart, false, 'fail-closed outside the desktop host')
  assert.equal(typeof payload.reason, 'string')
  assert.ok(payload.reason.length > 0, 'refusal carries a reason code')
  assert.notEqual(payload.reason, 'desktop-shell', 'never claims a shell it cannot verify')
  // 用户回报「无法热重启」时要能拿到识别细节，所以 status 必须带 detect 块
  assert.ok(payload.detect && typeof payload.detect === 'object', 'status carries detection details')
  assert.equal(payload.detect.hostPid, process.pid, 'detect reports the host pid')
  assert.ok(payload.detect.hostExe, 'detect reports the host executable')
  assert.ok(typeof payload.detect.hostArgv === 'string' && payload.detect.hostArgv.length > 0, 'detect reports host argv')
  assert.equal(typeof payload.detect.hostMarker, 'boolean', 'detect reports whether a host marker was seen')
  for (const key of ['parentPid', 'parentName', 'parentExe', 'parentCommand']) {
    assert.ok(key in payload.detect, `detect exposes ${key}`)
  }
  // 「装完没重启」是最容易让人误会的情况：磁盘版本与运行中的模块版本要分别报出来
  assert.equal(typeof payload.runningVersion, 'string', 'status reports the running host module version')
  assert.ok(payload.runningVersion.length > 0, 'running host version is not empty')
  assert.equal(
    payload.restartRequired,
    String(payload.version) !== String(payload.runningVersion),
    'restartRequired is derived from installed vs running',
  )
}

// 重启助手必须「零控制台窗口」：wscript(GUI) 派发 VBS，且由 WMI 拉起 DSH
{
  const hostHalf = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(hostHalf, /relaunch\.vbs/, 'host half dispatches the console-free VBS helper')
  assert.match(hostHalf, /wscript\.exe/, 'helper goes through wscript (GUI subsystem: no console)')
  assert.ok(
    hostHalf.indexOf("'relaunch.vbs'") < hostHalf.indexOf("'relaunch.ps1'"),
    'VBS helper is preferred, PowerShell only a logged fallback',
  )

  const vbs = await readFile(new URL('../lib/relaunch.vbs', import.meta.url), 'utf8')
  assert.match(vbs, /Win32_Process/, 'VBS helper launches DSH through WMI')
  assert.match(vbs, /MSFT_NetTCPConnection/, 'VBS helper waits for the port to be released')
  assert.ok(!/Start-Process/.test(vbs), 'VBS helper never uses a console-inheriting launcher')

  // 「关掉了但没起来」的防线：杀子树、清端口占用者、确认新实例真的起来了、失败要告知用户
  assert.match(hostHalf, /'\/F', '\/T', '\/PID'/, 'host half kills the whole process tree, not just the shell')
  assert.match(vbs, /KillChildren/, 'helper also stops leftover children of the shell')
  assert.match(vbs, /Function PortOwner/, 'helper can find whatever still holds the web port')
  assert.match(vbs, /Function IsOurStack/, 'helper only stops processes that belong to our own stack')
  assert.match(vbs, /Function WaitForInstance/, 'helper verifies the new instance actually came up')
  assert.match(vbs, /ShellExecute/, 'helper has a second launch method before giving up')
  assert.match(vbs, /MsgBox/, 'helper tells the user if it could not restart DSH')

  const ps = await readFile(new URL('../lib/relaunch.ps1', import.meta.url), 'utf8')
  assert.match(ps, /Win32_Process/, 'PowerShell fallback also launches DSH through WMI')
  assert.ok(
    ps.indexOf('Win32_Process') < ps.indexOf('Start-Process -FilePath $ExePath -WorkingDirectory $workDir'),
    'WMI launch is tried before the console-inheriting Start-Process fallback',
  )
  assert.match(ps, /Stop-Children/, 'PowerShell fallback also stops leftover children')
  assert.match(ps, /Test-OurStack/, 'PowerShell fallback only stops our own processes')
  assert.match(ps, /Wait-Instance/, 'PowerShell fallback verifies the new instance')
  assert.match(ps, /Popup/, 'PowerShell fallback tells the user on failure')
}

// VBS 助手必须保持纯 ASCII：WSH 按 ANSI 读取 .vbs，UTF-8 中文会吃掉字符串结尾的引号
{
  for (const file of ['../lib/relaunch.vbs', '../tools/restart-dsh.vbs']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8')
    assert.ok(!/[^\x00-\x7F]/.test(text), `${file} must stay pure ASCII for Windows Script Host`)
  }
}

// ui.js 路由真的吐出脚本
{
  const res = await call('/dsh-hot-restart/ui.js')
  assert.equal(res.statusCode, 200)
  assert.ok(res.body.length > 1500, 'ui.js served')
  assert.ok(res.body.includes('__DSH_HOT_RESTART_UI__'), 'ui.js content looks right')
  assert.ok(res.body.includes('dsh-hr-btn'), 'ui.js carries the single-button markup')
  assert.ok(res.body.includes('position:fixed'), 'button is pinned (fixed), not laid out in the flow')
  assert.ok(!res.body.includes('pointermove'), 'no drag handling left in the client half')
  assert.ok(!res.body.includes('dsh-hr-menu'), 'no context menu left in the client half')
  // 深色模式：brand token 在深色下是浅色，必须有自己的深蓝填充，否则白底白字
  assert.ok(res.body.includes('body[data-ds-dark-theme] #dsh-hr-btn'), 'button has a dark-theme fill override')
  assert.ok(res.body.includes('#1e3a8a'), 'dark fill is deep blue')
}

// restart 路由：方法 / 自定义头 / 非桌面壳一律拒绝，且不会真的去杀进程
{
  const getRes = await call('/dsh-hot-restart/restart', { method: 'GET' })
  assert.equal(getRes.statusCode, 405, 'GET rejected')

  const noHeader = await call('/dsh-hot-restart/restart', { method: 'POST' })
  assert.equal(noHeader.statusCode, 403, 'missing x-dsh-hot-restart rejected')

  const withHeader = await call('/dsh-hot-restart/restart', {
    method: 'POST',
    headers: { host: '127.0.0.1:19387', 'x-dsh-hot-restart': '1', 'content-type': 'application/json' },
    body: '{"reason":"test"}',
  })
  assert.equal(withHeader.statusCode, 409, 'refused outside the desktop host')
  const payload = JSON.parse(withHeader.body)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /不是由桌面壳托管|desktop/, 'explains why')
}

// 中文路径必须活下来：PowerShell 输出要强制 UTF-8，父进程查询走 base64 往返。
// 起因：有用户把 DSH 装在 D:\新建文件夹\ 下，路径被控制台代码页弄坏成乱码，
// 宿主拿乱码去 existsSync 判定失败，报 shell-exe-missing。
{
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(
    source.includes('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8'),
    'PowerShell stdout pinned to UTF-8',
  )
  assert.ok(
    source.includes('ToBase64String([Text.Encoding]::UTF8.GetBytes($j))'),
    'parent query returns base64 encoded UTF-8',
  )
  assert.ok(source.includes("exeSource = 'host-exe'"), 'falls back to the host exe path')

  if (process.platform === 'win32') {
    const { execFileSync } = await import('node:child_process')
    const ps = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const probe = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
      + '$s = "D:\\新建文件夹\\DeepSeek Harness.exe"; '
      + '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))'
    const out = String(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', probe], { encoding: 'utf8' })).trim()
    const decoded = Buffer.from(out, 'base64').toString('utf8')
    assert.equal(decoded, 'D:\\新建文件夹\\DeepSeek Harness.exe', 'non-ASCII path survives the PowerShell round-trip')
  }
}

// 外壳判定规则：把每个真实用户遇到的构建写法钉成用例，别再靠猜
{
  const { __test } = await import(new URL('../lib/index.js', import.meta.url).href)
  const classify = __test.classifyShellCandidate
  const cases = [
    // 用户 A：DSH Desktop 2.0.17，装在 D:\Tool\DSH Desktop\，宿主没有 desktop-host 标记
    [
      'DSH Desktop 2.0.17',
      { name: 'DSH Desktop.exe', exe: 'D:\\Tool\\DSH Desktop\\DSH Desktop.exe', command: '"D:\\Tool\\DSH Desktop\\DSH Desktop.exe" ' },
      { exe: 'D:\\Tool\\DSH Desktop\\DSH Desktop.exe', marker: false },
      'desktop-shell',
    ],
    // 开发机：DeepSeek Harness，宿主路径与外壳同一个 exe
    [
      'DeepSeek Harness',
      { name: 'DeepSeek Harness.exe', exe: 'D:\\ai\\DeepSeek Harness.exe', command: '"D:\\ai\\DeepSeek Harness.exe"' },
      { exe: 'D:\\ai\\DeepSeek Harness.exe', marker: true },
      'desktop-shell',
    ],
    // 渲染/工具进程不是外壳
    [
      'renderer child',
      { name: 'DeepSeek Harness.exe', exe: 'D:\\ai\\DeepSeek Harness.exe', command: '"x.exe" --type=renderer' },
      { exe: 'D:\\ai\\DeepSeek Harness.exe', marker: true },
      'parent-is-child-process',
    ],
    // dsh web 跑在终端里：绝不能杀终端
    [
      'terminal host',
      { name: 'pwsh.exe', exe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', command: 'pwsh -c dsh web' },
      { exe: 'C:\\node\\node.exe', marker: false },
      'parent-is-console',
    ],
    // 手工用 node 起宿主：不能把 node 当外壳
    [
      'manual node host',
      { name: 'node.exe', exe: 'C:\\node\\node.exe', command: 'node dsh/lib/bin.js' },
      { exe: 'C:\\node\\node.exe', marker: false },
      'parent-is-console',
    ],
    // 名字完全不像 DSH，又没有标记：拒绝
    [
      'unknown gui parent',
      { name: 'unknown.exe', exe: 'C:\\x\\unknown.exe', command: '"C:\\x\\unknown.exe"' },
      { exe: 'C:\\y\\host.exe', marker: false },
      'parent-unrecognized',
    ],
  ]
  for (const [label, parent, host, expected] of cases) {
    assert.equal(classify(parent, host), expected, `shell verdict for ${label}`)
  }
}

// 卸载：所有 disposer 都是函数且可安全调用
{
  assert.ok(disposers.length > 0, 'disposers registered')
  for (const dispose of disposers) assert.equal(typeof dispose, 'function')
  for (const dispose of disposers) dispose()
}

console.log('dsh-hot-restart host-half: all assertions passed')
