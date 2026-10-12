/* ============================================================================
 * dsh-hot-restart :: Client half (browser side)
 * ----------------------------------------------------------------------------
 * 只做一件事：在**固定位置**放一个显眼的按钮，点它 → 确认 → 热重启 DSH。
 * 没有拖动、没有菜单、没有轮询、没有位置记忆。
 *
 * 由宿主半区通过 index-inject 的结构化行注入（<script src="/dsh-hot-restart/ui.js">），
 * 不依赖任何构建步骤或客户端插件运行时。
 *
 *   GET  /dsh-hot-restart/status.json   状态（外壳 PID / 端口 / 能否重启）——加载时问一次
 *   POST /dsh-hot-restart/restart       发起热重启（关闭外壳，助手自动重新拉起）
 *   GET  /dsh-hot-restart/ui.js         本文件
 * ========================================================================== */
(function () {
  'use strict'

  if (window.__DSH_HOT_RESTART_UI__) return
  window.__DSH_HOT_RESTART_UI__ = true

  var API = '/dsh-hot-restart'
  var VERSION = '0.3.16'
  var PENDING_KEY = 'dsh-hot-restart:pending'
  var SHOWN_KEY = 'dsh-hot-restart:report-shown' // 已经提示过位置的报告，跨刷新去重
  var Z_BTN = 2147482000
  var Z_MODAL = 2147482200

  var ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">'
    + '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" '
    + 'd="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/></svg>'

  var CSS = [
    // 固定位置：主区域左下角（左侧留出侧边栏宽度），小鲸鱼在右下角，互不遮挡
    '#dsh-hr-btn{--dsh-hr-fill:#4d6bfe;position:fixed;left:calc(var(--dsh-windows-sidebar-width, 280px) + 16px);bottom:14px;z-index:' + Z_BTN + ';',
    'display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 15px 0 12px;border:0;border-radius:9px;box-sizing:border-box;',
    'background:var(--dsh-hr-fill);color:#fff;cursor:pointer;',
    'font:600 13px/1 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;letter-spacing:.2px;',
    'box-shadow:0 6px 18px rgba(41,72,220,.32),0 1px 3px rgba(0,0,0,.18);',
    'user-select:none;-webkit-user-select:none;',
    'transition:filter .15s ease,box-shadow .15s ease,transform .06s ease}',
    '#dsh-hr-btn:hover{filter:brightness(1.08);box-shadow:0 8px 22px rgba(41,72,220,.42),0 1px 3px rgba(0,0,0,.2)}',
    '#dsh-hr-btn:active{transform:translateY(1px)}',
    '#dsh-hr-btn:focus-visible{outline:2px solid #fff;outline-offset:2px}',
    // 深色模式：`--dsw-alias-brand-primary` 在深色主题下是**浅色**，照用会变成白底白字（就是他截图那样）。
    // 所以这里不走 token，显式给深蓝 + 一圈浅描边，保证白字始终压得住。
    'body[data-ds-dark-theme] #dsh-hr-btn{--dsh-hr-fill:#1e3a8a;border:1px solid rgba(255,255,255,.16);',
    'box-shadow:0 6px 18px rgba(0,0,0,.5),0 1px 3px rgba(0,0,0,.35)}',
    'body[data-ds-dark-theme] #dsh-hr-btn:hover{box-shadow:0 8px 22px rgba(0,0,0,.58),0 1px 3px rgba(0,0,0,.4)}',
    '#dsh-hr-btn[data-state="busy"]{--dsh-hr-fill:#c2740a;box-shadow:0 6px 18px rgba(180,120,0,.32)}',
    'body[data-ds-dark-theme] #dsh-hr-btn[data-state="busy"]{--dsh-hr-fill:#a35a06}',
    '#dsh-hr-btn[data-state="blocked"]{--dsh-hr-fill:#8b93a1;box-shadow:0 4px 12px rgba(0,0,0,.18)}',
    'body[data-ds-dark-theme] #dsh-hr-btn[data-state="blocked"]{--dsh-hr-fill:#4b5563}',
    '#dsh-hr-btn svg{flex:0 0 auto}',
    '#dsh-hr-btn .dsh-hr-btn-label{white-space:nowrap}',

    '.dsh-hr-mask{position:fixed;inset:0;z-index:' + Z_MODAL + ';display:flex;align-items:center;justify-content:center;',
    'background:rgba(15,17,22,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);',
    'font:13px/1.5 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-primary,#111827)}',
    '.dsh-hr-dialog{width:min(420px,92vw);padding:18px 18px 14px;border-radius:12px;box-sizing:border-box;',
    'background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));',
    'box-shadow:0 24px 60px rgba(0,0,0,.3)}',
    '.dsh-hr-dialog h3{margin:0 0 8px;font-size:15px}',
    '.dsh-hr-dialog p{margin:0 0 10px;color:var(--dsw-alias-label-secondary,#4b5563);white-space:pre-wrap}',
    '.dsh-hr-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}',
    '.dsh-hr-act{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:transparent;color:inherit;',
    'font:inherit;padding:6px 14px;border-radius:7px;cursor:pointer}',
    '.dsh-hr-act:hover{background:rgba(128,128,128,.12)}',
    '.dsh-hr-act[data-primary="1"]{border-color:transparent;background:#4d6bfe;color:#fff}',
    '.dsh-hr-act[data-primary="1"]:hover{filter:brightness(1.06)}',
    'body[data-ds-dark-theme] .dsh-hr-act[data-primary="1"]{background:#1e3a8a}',

    '.dsh-hr-overlay{position:fixed;inset:0;z-index:' + Z_MODAL + ';display:flex;align-items:center;justify-content:center;',
    'background:rgba(15,17,22,.55);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);',
    'font:13px/1.6 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#fff;text-align:center}',
    '.dsh-hr-overlay .dsh-hr-spin{width:26px;height:26px;margin:0 auto 12px;border-radius:50%;',
    'border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:dsh-hr-spin .9s linear infinite}',
    '@keyframes dsh-hr-spin{to{transform:rotate(360deg)}}',

    '.dsh-hr-toast{position:fixed;z-index:' + Z_MODAL + ';left:calc(var(--dsh-windows-sidebar-width, 280px) + 16px);bottom:58px;',
    'max-width:min(420px,90vw);padding:9px 13px;border-radius:8px;box-sizing:border-box;',
    'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));background:var(--dsw-alias-bg-overlay,#fff);',
    'box-shadow:0 10px 26px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary,#111827);',
    'font:12px/1.5 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;white-space:pre-wrap}',

    // 按钮右键菜单
    '.dsh-hr-menu{position:fixed;z-index:' + Z_MODAL + ';min-width:230px;padding:4px;border-radius:10px;box-sizing:border-box;',
    'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));background:var(--dsw-alias-bg-overlay,#fff);',
    'box-shadow:0 12px 30px rgba(0,0,0,.22);font:12px/1.4 "Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif}',
    '.dsh-hr-menu-item{display:block;width:100%;text-align:left;padding:7px 10px;border:0;border-radius:7px;cursor:pointer;',
    'background:transparent;color:var(--dsw-alias-label-primary,#111827)}',
    '.dsh-hr-menu-item:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.14))}',
    '.dsh-hr-menu-label{display:block;font-weight:500}',
    '.dsh-hr-menu-hint{display:block;margin-top:1px;opacity:.6;font-size:11px}',
  ].join('')

  var dom = { btn: null, label: null, mask: null, overlay: null, toast: null, menu: null }
  var busy = false
  var canRestart = null // null=未知，true/false=已确认
  var reason = ''
  var detect = null // 宿主报回来的识别细节，用于用户回报诊断
  var runningVersion = '' // 宿主此刻真正在跑的模块版本
  var restartRequired = false // 磁盘上的版本与运行中的版本不一致
  var reportShown = '' // 已经提示过位置的诊断报告，别重复弹
  var diagnoseRequestedAt = 0 // 本次自检是什么时候发起的

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function lsGet(key) {
    try { return window.localStorage.getItem(key) } catch (e) { return null }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value) } catch (e) { /* 忽略 */ }
  }
  function lsDel(key) {
    try { window.localStorage.removeItem(key) } catch (e) { /* 忽略 */ }
  }
  function jsonGet(key) {
    var raw = lsGet(key)
    if (!raw) return null
    try { return JSON.parse(raw) } catch (e) { return null }
  }

  /* ------------------------------------------------------------------ 按钮 */

  function renderButton() {
    if (!dom.btn) return
    dom.btn.dataset.state = busy ? 'busy' : (canRestart === false ? 'blocked' : 'ready')
    dom.label.textContent = busy ? '正在重启…' : '热重启 DSH'
    var tip = ['点一下热重启 DSH：关闭并自动重新打开（运行中的任务会中断）', '版本 v' + VERSION]
    if (canRestart === false) tip.push('当前不可用：' + reason)
    if (canRestart === true) tip.push('已就绪：桌面壳 / 宿主都识别到了')
    if (restartRequired) tip.push(pendingUpgradeLine())
    dom.btn.title = tip.join('\n')
  }

  // 装完新版本但没重启 DSH 时，宿主跑的还是旧模块 —— 这是最容易让人误会的一种情况
  function pendingUpgradeLine() {
    return '已安装 v' + VERSION + '，运行中的宿主还是 v' + runningVersion + '：重启一次 DSH 才会生效'
  }

  function buildButton() {
    var btn = el('button')
    btn.id = 'dsh-hr-btn'
    btn.type = 'button'
    btn.setAttribute('aria-label', '热重启 DSH（右键有菜单）')
    btn.innerHTML = ICON
    var label = el('span', 'dsh-hr-btn-label', '热重启 DSH')
    btn.appendChild(label)
    btn.addEventListener('click', onClick)
    btn.addEventListener('contextmenu', function (event) {
      event.preventDefault()
      event.stopPropagation()
      openMenu(event)
    })
    document.body.appendChild(btn)
    dom.btn = btn
    dom.label = label
    renderButton()
  }

  /* ------------------------------------------------------- 按钮右键菜单 */

  function closeMenu() {
    closeMenuListeners()
    if (dom.menu && dom.menu.parentNode) dom.menu.parentNode.removeChild(dom.menu)
    dom.menu = null
  }

  function openMenu(event) {
    closeMenu()
    var menu = el('div', 'dsh-hr-menu')
    var items = [
      { label: '自检并生成诊断报告', hint: '只读排查，报告写到桌面', run: runSelfCheck },
      { label: '复制诊断信息', hint: '把状态信息复制到剪贴板', run: copyDiagnostics },
      { label: '查看版本', hint: '插件与宿主版本', run: showVersions },
    ]
    items.forEach(function (item) {
      var row = el('button', 'dsh-hr-menu-item')
      row.type = 'button'
      row.appendChild(el('span', 'dsh-hr-menu-label', item.label))
      row.appendChild(el('span', 'dsh-hr-menu-hint', item.hint))
      row.addEventListener('click', function () {
        closeMenu()
        item.run()
      })
      menu.appendChild(row)
    })
    document.body.appendChild(menu)
    // 贴着按钮弹出来，尽量不出界
    var rect = dom.btn.getBoundingClientRect()
    var width = menu.offsetWidth || 240
    var height = menu.offsetHeight || 120
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    var top = rect.top - height - 8
    if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 8)
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
    dom.menu = menu
    setTimeout(function () {
      document.addEventListener('pointerdown', onMenuOutside, true)
      document.addEventListener('keydown', onMenuKey, true)
    }, 0)
  }

  function onMenuOutside(event) {
    if (dom.menu && !dom.menu.contains(event.target)) closeMenu()
  }

  function onMenuKey(event) {
    if (event.key === 'Escape') closeMenu()
  }

  function closeMenuListeners() {
    document.removeEventListener('pointerdown', onMenuOutside, true)
    document.removeEventListener('keydown', onMenuKey, true)
  }

  function showVersions() {
    dialog('版本', [
      '插件代码版本 v' + VERSION,
      '运行中的宿主 v' + (runningVersion || VERSION),
      restartRequired ? pendingUpgradeLine() : '磁盘版本与运行版本一致',
      '',
      '页面地址 ' + location.origin,
    ], [{ label: '知道了', primary: true, onClick: function () {} }])
  }

  // 自检：宿主在后台启动 tools/diagnose.ps1；报告写到桌面并自动用记事本打开，
  // 生成后本页会把**完整路径**显示出来。
  function runSelfCheck(trigger) {
    diagnoseRequestedAt = Date.now()
    toast('自检已启动：报告会写到桌面，生成后这里会显示完整路径', 8000)
    var payload = null
    return fetch(API + '/diagnose', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'x-dsh-hot-restart': '1', 'x-dsh-hot-restart-trigger': trigger || 'user-request' },
    })
      .then(function (response) { return response.json().catch(function () { return {} }) })
      .then(function (result) {
        payload = result
        if (result && result.ok) {
          toast('自检正在跑（约 30 秒）：报告放桌面，路径稍后显示在页面上', 9000)
          watchForReport()
        } else {
          toast('自检没能启动：' + String((result && result.error) || '宿主拒绝了请求'), 9000)
        }
        return result
      })
      .catch(function (error) {
        toast('自检没能启动：' + String((error && error.message) || error), 9000)
        return null
      })
  }

  // 报告是异步生成的：轮询宿主几次，拿到路径就提示
  var reportWatch = null
  function watchForReport() {
    if (reportWatch) return
    var tries = 0
    reportWatch = setInterval(function () {
      tries += 1
      refreshStatus()
      if (reportShown || tries >= 12) {
        clearInterval(reportWatch)
        reportWatch = null
        if (!reportShown) {
          toast('报告应该已经生成：桌面找 dsh-hot-restart-诊断报告-*.txt\n（也可以点按钮右键菜单里的「查看版本」再自检一次）', 12000)
        }
      }
    }, 8000)
  }

  // 重启失败时自动跑一次自检（一次页面生命周期只跑一次，别刷屏）
  var autoDiagnosed = false
  function autoDiagnose(why) {
    if (autoDiagnosed) return
    autoDiagnosed = true
    runSelfCheck(why)
  }

  function onClick() {
    if (busy) return
    if (canRestart === false) {
      // 按钮不可用时也自动自检一次：用户点它就是想解决问题
      autoDiagnose('button-blocked')
      var lines = []
      // 最常见的误会：装完了没重启，宿主还在跑旧模块
      if (restartRequired) {
        lines.push(pendingUpgradeLine())
        lines.push('先重启一次 DSH，按钮多半就正常了。')
        lines.push('')
      }
      lines.push('原因代码：' + (reason || 'unknown'))
      if (detect) {
        if (detect.parentName) lines.push('父进程：' + detect.parentName + '  pid ' + detect.parentPid)
        if (detect.parentExe) lines.push('父进程 exe：' + detect.parentExe)
        if (detect.hostExe) lines.push('宿主 exe：' + detect.hostExe)
      }
      lines.push('')
      lines.push('已经自动开始自检：几十秒后桌面会出现一份诊断报告。')
      lines.push('用的是桌面客户端：把那份报告（或「复制诊断信息」的内容）发给作者就行。')
      lines.push('是在浏览器里直接打开 DSH：这个按钮本来就不能用，用浏览器自己的刷新即可。')
      dialog('现在无法热重启', lines, [
        { label: '再自检一次', onClick: function () { runSelfCheck('user-request') } },
        { label: '复制诊断信息', onClick: copyDiagnostics },
        { label: '知道了', primary: true, onClick: function () {} },
      ])
      return
    }
    confirm()
  }

  function writeClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { return true }, function () { return false })
      }
    } catch (e) { /* 落到兜底 */ }
    try {
      var area = el('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      var ok = document.execCommand('copy')
      document.body.removeChild(area)
      return Promise.resolve(!!ok)
    } catch (e2) { return Promise.resolve(false) }
  }

  function copyDiagnostics() {
    fetch(API + '/status.json', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (response) { return response.json() })
      .then(function (payload) {
        var text = 'dsh-hot-restart 诊断信息\n' + new Date().toISOString() + '\n'
          + navigator.userAgent + '\n\n' + JSON.stringify(payload, null, 2)
        return writeClipboard(text)
      })
      .then(function (ok) {
        toast(ok ? '诊断信息已复制，直接发给作者' : '复制失败，请手动抄下原因代码：' + (reason || 'unknown'), 9000)
      })
      .catch(function () {
        toast('复制失败，请手动抄下原因代码：' + (reason || 'unknown'), 9000)
      })
  }

  /* --------------------------------------------------------------- 弹层 */

  function closeModal() {
    if (dom.mask && dom.mask.parentNode) dom.mask.parentNode.removeChild(dom.mask)
    dom.mask = null
  }

  function dialog(title, bodyParts, buttons) {
    closeModal()
    var mask = el('div', 'dsh-hr-mask')
    var box = el('div', 'dsh-hr-dialog')
    box.appendChild(el('h3', null, title))
    for (var i = 0; i < bodyParts.length; i++) box.appendChild(el('p', null, bodyParts[i]))
    var actions = el('div', 'dsh-hr-actions')
    for (var j = 0; j < buttons.length; j++) {
      ;(function (spec) {
        var button = el('button', 'dsh-hr-act', spec.label)
        button.type = 'button'
        if (spec.primary) button.dataset.primary = '1'
        button.addEventListener('click', function () {
          closeModal()
          spec.onClick()
        })
        actions.appendChild(button)
      })(buttons[j])
    }
    box.appendChild(actions)
    mask.appendChild(box)
    mask.addEventListener('pointerdown', function (event) { if (event.target === mask) closeModal() })
    document.body.appendChild(mask)
    dom.mask = mask
  }

  function confirm() {
    dialog('热重启 DSH？', [
      '将立即关闭 DSH（Electron 外壳 + 宿主进程），随后由重启助手自动重新打开。',
      '正在运行的任务会被中断；会话与项目文件都已落盘，重新打开后可继续。',
      '预计 5–15 秒后窗口重新出现。',
    ], [
      { label: '取消', onClick: function () {} },
      { label: '立即热重启', primary: true, onClick: startRestart },
    ])
  }

  function hideOverlay() {
    if (dom.overlay && dom.overlay.parentNode) dom.overlay.parentNode.removeChild(dom.overlay)
    dom.overlay = null
  }

  function showOverlay() {
    if (dom.overlay) return
    var overlay = el('div', 'dsh-hr-overlay')
    var box = el('div')
    box.appendChild(el('div', 'dsh-hr-spin'))
    var title = el('div', null, '正在热重启 DSH…')
    title.style.fontWeight = '600'
    title.style.fontSize = '15px'
    box.appendChild(title)
    var hint = el('div', null, '外壳正在退出，重启助手会稍后自动拉起新实例。\n若 20 秒后窗口仍未恢复，请手动重新打开 DSH。')
    hint.style.marginTop = '8px'
    hint.style.opacity = '.85'
    box.appendChild(hint)
    overlay.appendChild(box)
    document.body.appendChild(overlay)
    dom.overlay = overlay
  }

  function toast(text, ms) {
    try {
      if (dom.toast && dom.toast.parentNode) dom.toast.parentNode.removeChild(dom.toast)
      var node = el('div', 'dsh-hr-toast', text)
      document.body.appendChild(node)
      dom.toast = node
      setTimeout(function () {
        if (dom.toast === node && node.parentNode) node.parentNode.removeChild(node)
        if (dom.toast === node) dom.toast = null
      }, ms || 7000)
    } catch (e) { /* 忽略 */ }
  }

  /* --------------------------------------------------------------- 重启 */

  function startRestart() {
    busy = true
    renderButton()
    var requestedAt = Date.now()
    lsSet(PENDING_KEY, JSON.stringify({ at: requestedAt }))
    showOverlay()
    fetch(API + '/restart', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-dsh-hot-restart': '1' },
      body: JSON.stringify({ at: requestedAt, ua: navigator.userAgent }),
    }).then(function (response) {
      return response.json().catch(function () { return {} }).then(function (payload) {
        if (!response.ok || payload.ok !== true) {
          var refused = new Error((payload && payload.error) || ('HTTP ' + response.status))
          refused.reason = (payload && payload.reason) || 'refused'
          throw refused
        }
        // 外壳通常几百毫秒后消失；它还在就把用户从遮罩里放出来
        setTimeout(function () {
          hideOverlay()
          busy = false
          renderButton()
          toast('已下发重启指令，但窗口还在。\n请手动退出并重新打开 DSH，或稍后再点一次。', 10000)
        }, 20000)
      })
    }).catch(function (error) {
      busy = false
      lsDel(PENDING_KEY)
      // 无论什么原因被拒，遮罩都必须撤掉 —— 否则弹窗关掉了，那个「正在热重启」的画面还赖着
      hideOverlay()
      renderButton()
      var reason = (error && error.reason) || 'refused'
      var text = String((error && error.message) || error)
      if (reason === 'cooldown') {
        // 冷却期只是让你等几秒，不是故障：不自动跑自检，也不摆出排查的架势
        dialog('稍等一下再试', [
          text,
          '',
          '这不是出错 —— 上一次重启刚发生过，等几秒再点一次就好。',
        ], [{ label: '好', primary: true, onClick: function () {} }])
        return
      }
      // 真的被拒才是需要答案的时候：自动跑一次自检，把报告准备好
      autoDiagnose('restart-refused')
      dialog('无法发起热重启', [
        '宿主拒绝了这次重启请求：',
        text,
        '',
        '已自动开始自检，几十秒后桌面会出现诊断报告，可以直接发给作者。',
      ], [
        { label: '立即自检', onClick: function () { runSelfCheck('user-request-after-refusal') } },
        { label: '好', primary: true, onClick: function () {} },
      ])
    })
  }

  function showRestartedToast() {
    var pending = jsonGet(PENDING_KEY)
    if (!pending || typeof pending.at !== 'number') return
    lsDel(PENDING_KEY)
    var ageMs = Date.now() - pending.at
    if (ageMs > 10 * 60 * 1000 || ageMs < 1500) return
    toast('DSH 已热重启完成（约 ' + Math.round(ageMs / 1000) + ' 秒）', 8000)
  }

  function refreshStatus() {
    return fetch(API + '/status.json', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (payload) {
        canRestart = !!(payload && payload.canRestart)
        reason = String((payload && payload.reason) || '')
        detect = (payload && payload.detect) || null
        runningVersion = String((payload && payload.runningVersion) || VERSION)
        restartRequired = !!(payload && payload.restartRequired)
        noteDiagnoseReport(payload && payload.lastDiagnoseReport)
      })
      .catch(function () {
        canRestart = null
        reason = '宿主路由不可达'
        detect = null
        runningVersion = ''
        restartRequired = false
      })
      .then(function () { renderButton() })
  }

  // 报告生成后，把**完整路径**明确显示出来 —— 用户只要照着找那个文件就行。
  // 两个闸门缺一不可：
  //   ① 只提示用户自己触发的那种（manual = 手工双击跑的，不该弹）
  //   ② 同一份报告**一辈子只提示一次**（记在 localStorage，刷新/重启都不会再弹）
  function noteDiagnoseReport(report) {
    if (!report || !report.path) return
    if (report.trigger === 'manual' || !report.trigger) return
    if (report.path === reportShown) return
    if (lsGet(SHOWN_KEY) === report.path) return
    // 只提示最近半小时内的报告，避免翻旧账
    if (!report.at || (Date.now() - report.at) > 30 * 60 * 1000) return
    reportShown = report.path
    lsSet(SHOWN_KEY, report.path)
    toast('诊断报告已生成，位置：\n' + report.path + '\n\n把这个文件发给作者即可。', 15000)
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && dom.mask) {
      closeModal()
      event.stopPropagation()
    }
  }

  function boot() {
    try {
      if (!document.body) return
      var style = el('style')
      style.textContent = CSS
      ;(document.head || document.documentElement).appendChild(style)
      buildButton()
      showRestartedToast()
      refreshStatus()
      document.addEventListener('keydown', onKeydown, true)
    } catch (error) {
      try { console.error('[dsh-hot-restart] ui boot failed:', error) } catch (e) { /* 忽略 */ }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()
