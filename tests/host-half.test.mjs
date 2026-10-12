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
import { readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// 单测绝不能往用户真实的 restart.log 里写东西：把插件状态目录指到临时目录。
// 之前没做这件事，测试加载模块时写的 mounted 行混进了 %USERPROFILE%\.dsh\hot-restart\restart.log。
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-hot-restart-test-'))
process.env.DSH_HOT_RESTART_HOME = sandbox

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const plugin = mod.default
// 编码金丝雀要拿产品自己的写法写包装脚本，所以直接用同一个函数
const encodeCanary = mod.__test.writeExplorerWrapper

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
  [
    '/dsh-hot-restart/diagnose',
    '/dsh-hot-restart/restart',
    '/dsh-hot-restart/status.json',
    '/dsh-hot-restart/ui.js',
  ],
  'four exact routes registered (self check included)',
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

  // 「关掉了但没起来」的防线：确认助手活着、清端口占用者、确认新实例真的起来了、失败要告知用户
  // 关外壳的契约（2026-10-12 事故之后定下的）：
  //   ① 先优雅关闭（taskkill 不带 /F = WM_CLOSE），让 DSH 收尾并释放文件锁；
  //   ② 绝不加 /T —— 整棵树一起收会杀掉正在写状态的子进程，留下 state.json.lock；
  //   ③ 只有确认助手活着之后才允许动手。
  assert.match(hostHalf, /function closeShell/, 'host closes the shell through closeShell')
  assert.match(hostHalf, /'\/PID'/, 'graceful close without /F comes first')
  assert.ok(!/'\/T'/.test(hostHalf), 'never kills the whole tree: that breaks DSH state locks')
  assert.ok(
    hostHalf.indexOf("run(['/PID'") < hostHalf.indexOf("run(['/F', '/PID'"),
    'forced kill is only the fallback after a graceful close',
  )
  // 助手没被确认活着之前，绝不能杀外壳：有用户机器上 WSH 被策略禁用，
  // wscript 进程静默死亡，结果外壳被关掉而没有任何东西把它拉回来。
  assert.match(hostHalf, /waitForHelper/, 'host confirms the helper actually runs')
  assert.match(hostHalf, /helper confirmed/, 'host logs a confirmed helper')
  assert.ok(
    hostHalf.indexOf('waitForHelper') > 0
      && hostHalf.indexOf("spawn('taskkill'") > hostHalf.indexOf('waitForHelper'),
    'helper confirmation happens before the shell is killed',
  )
  assert.match(hostHalf, /已放弃这次重启/, 'host refuses to restart when no helper can run')
  // 撤销通道：宿主放弃时删凭据，助手没有新鲜凭据就不许动手。
  // 没有这条通道时，一个已派发的助手会在 25 秒后照样强杀外壳（真实事故）。
  assert.match(hostHalf, /function issueTicket/, 'host issues a restart ticket')
  assert.match(hostHalf, /function revokeTicket/, 'host can revoke the restart ticket')
  assert.match(hostHalf, /revokeTicket\(\)/, 'abandoning a restart revokes the ticket')
  assert.match(hostHalf, /'-Ticket'/, 'the PowerShell helper receives the ticket path')
  assert.match(vbs, /Function TicketOk/, 'VBS helper checks the restart ticket before acting')
  assert.match(vbs, /restart ticket missing or stale/, 'VBS helper aborts on a revoked ticket')
  // 不经过 WMI 的备用派发：借已经跑着的 Explorer 打开包装脚本，跳出 DSH 的 Job。
  // 起因：某用户机器上 WMI 能建进程、助手手动跑也正常，两者合起来却没动静。
  assert.match(hostHalf, /dispatchViaExplorer/, 'host has a WMI-free dispatch fallback')
  assert.match(hostHalf, /dispatch \(wmi\)/, 'host logs the exact dispatched command line')
  assert.match(hostHalf, /wscript-explorer/, 'host records which dispatch route worked')
  // 自检派发的契约（2026-10-12 实测确认）：管道 stdio + 隐藏窗口 + 不 detached，
  // 并且在 1.5 秒内盯着它别立刻死掉 —— 早期用 stdio:'ignore' + detached 会一行都不执行。
  assert.match(hostHalf, /stdio: \['ignore', 'pipe', 'pipe'\]/, 'the self check is spawned with pipes')
  assert.ok(
    !/spawn\(POWERSHELL, \['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script\], \{\s*detached: true/.test(hostHalf),
    'the self check is not detached any more',
  )
  assert.match(hostHalf, /diagnostics exited immediately with code/, 'an instant exit is reported, not hidden')
  assert.ok(!/CreateTextFile\([^)]*\)\.WriteLine/.test(hostHalf), 'no VBScript method chaining in generated wrappers')

  // 2026-10-12：每次重启 56 秒 + 每次都弹报告提示。三条根因各一个断言。
  assert.match(hostHalf, /closeShell\(shell\)/, 'closeShell gets the whole shell object (it needs exePath to verify)')
  assert.ok(!/closeShell\(shell\.shellPid\)/.test(hostHalf), 'never pass a bare pid: that logged taskkill /PID undefined')
  assert.match(hostHalf, /'-Trigger', String\(trigger\)/, 'the self check records who triggered it')
  assert.match(hostHalf, /trigger: lines\[1\] \|\| 'manual'/, 'status.json exposes the report trigger')
  const uiSrc = await readFile(new URL('../lib/ui.js', import.meta.url), 'utf8')
  assert.match(uiSrc, /SHOWN_KEY/, 'a report is announced once only, across page loads')
  assert.match(uiSrc, /report\.trigger === 'manual'/, 'a manually run report is not pushed at the user')
  assert.match(vbs, /waited < 10000/, 'the helper only waits 10s for the host-side close')

  // 2026-10-12 主人提的三条：冷却 5 秒、冷却不跑自检、被拒之后必须撤掉遮罩
  assert.match(hostHalf, /const COOLDOWN_MS = 5000/, 'the cooldown is 5 seconds')
  assert.match(hostHalf, /error\.reason = 'cooldown'/, 'a cooldown refusal is marked as such')
  assert.match(hostHalf, /reason: \(error && error\.reason\) \|\| 'refused'/, 'the refusal response carries the reason')
  assert.match(uiSrc, /function hideOverlay/, 'the overlay can be taken down')
  assert.match(uiSrc, /reason === 'cooldown'/, 'a cooldown refusal gets a light dialog instead of a fault report')
  assert.match(uiSrc, /hideOverlay\(\)\s*\r?\n\s*renderButton\(\)/, 'a refused restart always removes the overlay')
  assert.match(uiSrc, /refused\.reason = /, 'the page keeps the refusal reason code')
  // 助手可能活着但写不进日志（用户报告里两种宿主都给了 PID、都没有日志行），
  // 所以确认逻辑不能只认日志：进程还活着同样算数
  assert.match(hostHalf, /function pidAlive/, 'host can verify a helper by its pid')
  assert.match(hostHalf, /waitForHelper\(logFile, before, \d+, candidate\.pid\)/, 'dispatch paths check the helper pid')
  assert.ok(
    !/readFileSync\(logFile, 'utf8'\)\.slice/.test(hostHalf),
    'log growth is sliced by bytes, never by UTF-16 string offsets',
  )
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
  // 右键菜单回来了，但只放排查入口（自检 / 复制诊断 / 版本），不放「仅重载页面」那种旧功能
  assert.ok(res.body.includes('dsh-hr-menu'), 'the right-click menu ships with the client half')
  assert.ok(res.body.includes('自检并生成诊断报告'), 'menu carries the self check entry')
  assert.ok(!res.body.includes('仅重载'), 'the old reload-page entry stays gone')
  // 深色模式：brand token 在深色下是浅色，必须有自己的深蓝填充，否则白底白字
  assert.ok(res.body.includes('body[data-ds-dark-theme] #dsh-hr-btn'), 'button has a dark-theme fill override')
  assert.ok(res.body.includes('#1e3a8a'), 'dark fill is deep blue')
}

// diagnose 路由：护栏与 restart 一致（这里只验拒绝路径，避免测试里真的启动自检）
{
  const getRes = await call('/dsh-hot-restart/diagnose', { method: 'GET' })
  assert.equal(getRes.statusCode, 405, 'GET rejected')

  const noHeader = await call('/dsh-hot-restart/diagnose', { method: 'POST' })
  assert.equal(noHeader.statusCode, 403, 'missing x-dsh-hot-restart rejected')

  const crossSite = await call('/dsh-hot-restart/diagnose', {
    method: 'POST',
    headers: { host: '127.0.0.1:19387', 'x-dsh-hot-restart': '1', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.statusCode, 403, 'cross-site rejected')
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

// 独立重启工具（tools/）：同样不能写死 exe 名、同样要先确认助手活着再动手
{
  const vbsTool = await readFile(new URL('../tools/restart-dsh.vbs', import.meta.url), 'utf8')
  const psTool = await readFile(new URL('../tools/restart-dsh.ps1', import.meta.url), 'utf8')
  for (const [name, text] of [['restart-dsh.vbs', vbsTool], ['restart-dsh.ps1', psTool]]) {
    assert.ok(!/DeepSeek Harness/.test(text), `${name} must not hard-code the shell exe name`)
    assert.match(text, /\[relaunch\]/, `${name} waits for the helper to report before killing`)
  }
  assert.match(vbsTool, /--check/, 'restart-dsh.vbs has a compile-only switch for tests')
  assert.match(psTool, /\[switch\]\$Check/, 'restart-dsh.ps1 has a check-only switch for tests')
  assert.ok(
    vbsTool.indexOf('[relaunch]') > 0
      && vbsTool.indexOf('taskkill /PID ') > vbsTool.indexOf('[relaunch]'),
    'restart-dsh.vbs closes the shell only after the helper reported',
  )
  assert.match(vbsTool, /taskkill \/F \/PID/, 'restart-dsh.vbs falls back to a forced close only if needed')
  assert.ok(!/\.Terminate\(\)/.test(vbsTool), 'restart-dsh.vbs never hard-terminates through WMI any more')
}

// 自检系统：右键菜单入口 + 失败时自动跑 + 助手在起不来时也跑
{
  const hostHalf = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  const ui = await readFile(new URL('../lib/ui.js', import.meta.url), 'utf8')
  const vbs = await readFile(new URL('../lib/relaunch.vbs', import.meta.url), 'utf8')

  assert.match(hostHalf, /function runDiagnostics/, 'host can start the self check')
  assert.match(hostHalf, /function failedStartupSignature/, 'host knows when the previous startup failed')
  assert.match(hostHalf, /claimAutoDiagnose/, 'auto diagnostics runs once per failure, not on every boot')
  assert.ok(
    hostHalf.indexOf("path: `${BASE}/diagnose`") > 0,
    'self check has its own route',
  )
  assert.match(hostHalf, /previous-startup-failed/, 'a failed previous startup triggers the self check')

  assert.match(ui, /addEventListener\('contextmenu'/, 'right-clicking the button opens a menu')
  assert.match(ui, /自检并生成诊断报告/, 'the menu offers the self check')
  assert.match(ui, /function runSelfCheck/, 'the page can ask the host for a self check')
  assert.match(ui, /autoDiagnose\('restart-refused'\)/, 'a refused restart runs the self check automatically')
  assert.match(ui, /autoDiagnose\('button-blocked'\)/, 'clicking a blocked button runs the self check too')

  assert.match(vbs, /Sub RunDiagnostics/, 'the helper starts the self check when DSH does not come back')
  assert.match(vbs, /instance disappeared within 12s/, 'the helper also catches an instance that dies right after start')

  // 报告位置必须明确告诉用户：脚本写 last-report.txt → 宿主读它 → 页面显示完整路径
  assert.match(hostHalf, /function readLastReport/, 'host reads the report pointer file')
  assert.match(hostHalf, /lastDiagnoseReport/, 'status.json exposes the report path')
  assert.match(ui, /noteDiagnoseReport/, 'the page shows the report path when it appears')
  assert.match(ui, /诊断报告已生成，位置/, 'the toast names the exact file')
  assert.match(vbs, /Function ReportPath/, 'the helper waits for the report path')
  assert.match(vbs, /Sub ReportAndTell/, 'the helper message names the report file')
  const diagScript = await readFile(new URL('../tools/diagnose.ps1', import.meta.url), 'utf8')
  assert.match(diagScript, /last-report\.txt/, 'the self check records where the report went')

  // 2026-10-12 反馈：页面几十秒才出来、点一下有概率又重启一次
  assert.match(hostHalf, /await delay\(1000\)/, 'graceful close gets 1 second: DSH hides to tray, it never quits on WM_CLOSE')
  assert.match(hostHalf, /identity = Promise.resolve\(\)/, 'the identity check runs in parallel with the wait, not after it')
  assert.match(hostHalf, /function warmUpShellDetection/, 'shell detection is warmed up off the startup path')
  assert.ok(
    !/^\s+const shell = detectShell\(\)\s*$/m.test(hostHalf.split('warmUpShellDetection()')[0].split('apply(root)').pop() || ''),
    'the mount path must not run detectShell synchronously',
  )
  // 存活判断必须是瞬时的：pidAlive 每次都同步起 PowerShell，会把等待拖成几十秒（实测 30 秒）
  assert.match(hostHalf, /process\.kill\(pid, 0\)/, 'liveness is checked with process.kill, not by spawning PowerShell')
  assert.ok(!/if \(!pidAlive\(shellPid\)\)/.test(hostHalf), 'closeShell must never call pidAlive in its wait loop')
  assert.match(hostHalf, /上一次重启刚发生过/, 'a restart within 90s is refused, so restarts cannot overlap')
  assert.match(hostHalf, /refusing to force-kill/, 'host verifies the pid still is the shell before force-killing')
  assert.match(hostHalf, /shellCreated/, 'the shell creation time travels with the restart record')
  assert.match(vbs, /Function Identified/, 'the helper verifies pid identity before terminating')
  assert.match(vbs, /is not the shell we were asked to restart/, 'the helper refuses a reused pid')
  assert.match(vbs, /Function Digits/, 'creation times are compared digits-only, across WMI formats')
  const psHelper = await readFile(new URL('../lib/relaunch.ps1', import.meta.url), 'utf8')
  assert.match(psHelper, /function Test-Identified/, 'the PowerShell helper verifies identity too')

  // 2026-10-12 实战（另一台机器、纯净 DSH）：助手拿到乱码 exe 路径 → ABORT，
  // 宿主却把它当成「助手就绪」，照样关了 DSH —— 表现就是「能关闭但拉不起来」。
  assert.match(vbs, /helper ready: shellPid=/, 'the VBS helper announces it is ready')
  assert.match(psHelper, /helper ready: shellPid=/, 'the PowerShell helper announces it is ready too')
  assert.match(hostHalf, /function helperStatus/, 'host tells ready / abort / started apart')
  assert.match(hostHalf, /outcome\.abort \|\| abortReason/, 'an abort reason is remembered and surfaced')
  assert.ok(
    !/if \(await waitForHelper\(logFile, before, \d+, candidate\.pid\)\)/.test(hostHalf),
    'never treat "the helper wrote one line" as success again',
  )
  // 非 ASCII 路径必须活下来：包装脚本改成 UTF-16LE + BOM
  //（实测：ASCII 写法会把 新建文件夹 变成 苞圅9，与那位用户的报告一字不差）
  assert.match(hostHalf, /'\\uFEFF' \+ text, 'utf16le'/, 'the explorer wrapper is written as UTF-16LE with a BOM')
  assert.ok(!/writeFileSync\(wrapper, text, 'ascii'\)/.test(hostHalf), 'the ASCII wrapper write is gone')
  const diag = await readFile(new URL('../tools/diagnose.ps1', import.meta.url), 'utf8')
  assert.match(diag, /Get-Content \$logPath -Encoding UTF8/, 'the report reads restart.log as UTF-8')

  // 自检进度 + 默认不起进程（2026-10-12：杀软会拦进程创建，探针实测能磨二十多秒）
  assert.match(diag, /\[switch\]\$DeepProbe/, 'the five real probes are opt-in only')
  assert.match(diag, /function Show-SecurityContext/, 'default mode explains blockers by reading policy')
  assert.match(diag, /-Encoding Unicode/, 'progress is written as UTF-16LE (the reader must match)')
  assert.match(hostHalf, /function readDiagnoseProgress/, 'host reads the progress file')
  assert.match(hostHalf, /diagnoseProgress: readDiagnoseProgress\(\)/, 'status.json exposes the progress')
  assert.match(hostHalf, /readFileSync\(file, 'utf16le'\)/, 'progress is read as UTF-16LE, matching the writer')
  const uiSrc2 = await readFile(new URL('../lib/ui.js', import.meta.url), 'utf8')
  assert.match(uiSrc2, /showProgressOverlay/, 'the page shows a progress overlay while checking')
  assert.match(uiSrc2, /payload\.diagnoseProgress/, 'the page polls the progress from status.json')
}

// 卸载：所有 disposer 都是函数且可安全调用
{
  assert.ok(disposers.length > 0, 'disposers registered')
  for (const dispose of disposers) assert.equal(typeof dispose, 'function')
  for (const dispose of disposers) dispose()
}

// —— 编码合同（自动抓住"我又忘了编码"这类错误）--------------------------------
// 2026-10-12 主人指出：这个项目的编码事故是同一个错误反复犯。所以不再靠记性，
// 改成三条机器可查的规矩：非 ASCII 的 .ps1 必须带 UTF-8 BOM；.vbs/.cmd 必须纯 ASCII；
// 跨进程传路径的地方必须**实跑一次中文往返**（下面那条金丝雀）。
{
  const scripts = [
    '../lib/relaunch.ps1',
    '../lib/relaunch.vbs',
    '../tools/diagnose.ps1',
    '../tools/diagnose.cmd',
    '../tools/restart-dsh.ps1',
    '../tools/restart-dsh.vbs',
  ]
  for (const rel of scripts) {
    const bytes = readFileSync(new URL(rel, import.meta.url))
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    const nonAscii = [...bytes].filter((b) => b > 127).length
    const name = rel.replace('../', '')
    if (rel.endsWith('.ps1')) {
      // PowerShell 5.1 把没有 BOM 的文件按 ANSI 读：里面只要有中文，语法就会被读坏
      if (nonAscii > 0) assert.ok(hasBom, `${name} contains non-ASCII and must keep its UTF-8 BOM`)
    } else {
      // WSH / cmd 按 ANSI 读：.vbs 与 .cmd 必须保持纯 ASCII
      assert.equal(nonAscii, 0, `${name} must stay pure ASCII`)
      assert.ok(!hasBom, `${name} must not carry a BOM`)
    }
  }
}

// —— 编码金丝雀：真的写出去、真的跑一遍、真的读回来 -----------------------------
// 用户那台机器上，包装脚本按 ASCII 写盘，把 `新建文件夹` 毁成了 `苞圅9`，
// 助手于是拒绝动手、DSH 关闭后再没起来。光看源码是发现不了的：必须实跑。
{
  const canary = mkdtempSync(join(tmpdir(), 'dsh-hr-canary-'))
  const chineseDir = join(canary, '新建文件夹')
  await mkdir(chineseDir, { recursive: true })
  const fakeExe = join(chineseDir, 'DeepSeek Harness.exe')
  writeFileSync(fakeExe, 'x')
  const resultFile = join(canary, 'result.txt')
  const probe = join(canary, 'probe.vbs')
  writeFileSync(probe, [
    'Option Explicit',
    'Dim fso, ts',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `Set ts = fso.CreateTextFile("${resultFile}", True, True)`,
    'ts.WriteLine "arg1=" & WScript.Arguments(0)',
    'ts.WriteLine "exists=" & fso.FileExists(WScript.Arguments(0))',
    'ts.Close',
    '',
  ].join('\r\n'), 'ascii')

  const wrapper = encodeCanary([probe, fakeExe])
  const head = readFileSync(wrapper).subarray(0, 2)
  assert.deepEqual([...head], [0xff, 0xfe], 'wrapper starts with exactly one UTF-16LE BOM')
  const third = readFileSync(wrapper).subarray(2, 4)
  assert.ok(!(third[0] === 0xff && third[1] === 0xfe), 'and not a second BOM right after it')

  execFileSync('wscript.exe', ['//B', wrapper], { timeout: 20000 })
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const result = readFileSync(resultFile, 'utf16le')
  assert.ok(
    result.includes(`arg1=${fakeExe}`),
    `a non-ASCII path must survive the wrapper intact (got: ${result.trim()})`,
  )
  assert.ok(result.includes('exists=True'), 'the helper must be able to find the exe it was told about')
  await rm(canary, { recursive: true, force: true })
}

// 日志必须落在沙箱状态目录里 —— 不能污染用户真实的 restart.log
{
  const sandboxLog = await readFile(join(sandbox, 'restart.log'), 'utf8').catch(() => '')
  assert.ok(sandboxLog.includes('mounted'), 'plugin log is written into the overridden state dir')
  assert.ok(sandboxLog.length < 2048, 'log line stays short even with a long parent command')
  await rm(sandbox, { recursive: true, force: true })
}

console.log('dsh-hot-restart host-half: all assertions passed')
