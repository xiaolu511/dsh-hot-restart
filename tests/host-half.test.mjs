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
  // 测试进程不是被 dsh-desktop-host 拉起的 → 必须 fail-closed
  assert.equal(payload.canRestart, false, 'fail-closed outside the desktop host')
  assert.equal(payload.reason, 'not-desktop-host')
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

  const ps = await readFile(new URL('../lib/relaunch.ps1', import.meta.url), 'utf8')
  assert.match(ps, /Win32_Process/, 'PowerShell fallback also launches DSH through WMI')
  assert.ok(
    ps.indexOf('Win32_Process') < ps.indexOf('Start-Process -FilePath $ExePath -WorkingDirectory $workDir'),
    'WMI launch is tried before the console-inheriting Start-Process fallback',
  )
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

// 卸载：所有 disposer 都是函数且可安全调用
{
  assert.ok(disposers.length > 0, 'disposers registered')
  for (const dispose of disposers) assert.equal(typeof dispose, 'function')
  for (const dispose of disposers) dispose()
}

console.log('dsh-hot-restart host-half: all assertions passed')
